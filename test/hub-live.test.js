// The hub's live side, with a hub of its own: what a lane's hello must be, the limits it keeps, and the states hooks set.
// GitHub identity is faked: the token "tok-<name>" belongs to <name>.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { startHub } = require('../src/hub');

const SECRET = 'a-test-hook-secret';
let hub, url, team;
const verifyUser = async token => { const login = /^tok-(\w+)$/.exec(token)?.[1]; return login ? { login, name: login, avatar: '' } : null; };
const api = async (token, method, route, body) => {
  const res = await fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
// A lane over the socket. Resolves once it's in the hub's state, or with the close code if the hub turns it away.
const lane = (hello, token = 'tok-alice') => new Promise(resolve => {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/lane`);
  const full = { t: 'hello', token, team: team.id, id: `l-${Math.random().toString(36).slice(2, 10)}`, hookSecret: SECRET, session: 's', cmd: 'claude', root: '/r', ...hello };
  ws.on('open', () => ws.send(JSON.stringify(full)));
  ws.on('close', code => resolve({ code }));
  const poll = setInterval(async () => {
    if ((await state()).lanes.some(l => l.id === full.id)) { clearInterval(poll); resolve({ ws, id: full.id }); }
  }, 30);
  ws.on('close', () => clearInterval(poll));
});
// The team's state as a watcher sees it right now.
const state = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/watch`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', token: 'tok-alice', team: team.id })));
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'state') { ws.close(); resolve(m); } });
  ws.on('error', reject);
});
const hook = async (id, body) => {
  const res = await fetch(`${url}/hooks/${id}`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ cwd: '/r', ...body }) });
  return res.json().catch(() => null);
};
const closed = ws => new Promise(resolve => { ws.on('close', resolve); ws.close(); });

before(async () => {
  hub = await startHub({ port: 0, host: '127.0.0.1', owners: ['alice'], verifyUser });
  url = `http://127.0.0.1:${hub.port}`;
  team = (await api('tok-alice', 'POST', '/teams', { name: 'Live' })).body;
  await api('tok-alice', 'POST', `/teams/${team.id}/members`, { login: 'bob' });
});
after(() => hub.close());

test('a lane\'s hello is checked before it joins', async () => {
  for (const [bad, why] of [[{ id: '../x' }, 'an id that isn\'t a plain name'], [{ id: 'x'.repeat(65) }, 'too long an id'],
    [{ hookSecret: 'short' }, 'a short hook secret'], [{ hookSecret: 42 }, 'a hook secret that isn\'t text'],
    [{ session: '..' }, 'a session made of dots'], [{ session: '   ' }, 'no session name']]) {
    assert.equal((await lane(bad)).code, 4000, why);
  }
  const mine = await lane({ id: 'alices-agent' });
  assert.ok(mine.ws, 'a good hello joins');
  assert.equal((await lane({ id: 'alices-agent' }, 'tok-bob')).code, 4000, 'an id held by someone else');
  assert.equal((await lane({ id: 'x' }, 'tok-carol')).code, 4003, 'someone not on the team');
  await closed(mine.ws);
});

test('terminal sizes are kept within bounds', async () => {
  const l = await lane({ cols: 99999, rows: 1 });
  let mine = (await state()).lanes.find(x => x.id === l.id);
  assert.deepEqual([mine.cols, mine.rows], [500, 5]);
  l.ws.send(JSON.stringify({ t: 'size', cols: 3, rows: 9999 }));
  for (let i = 0; i < 50 && !(mine.cols === 20 && mine.rows === 200); i++) mine = (await state()).lanes.find(x => x.id === l.id);
  assert.deepEqual([mine.cols, mine.rows], [20, 200]);
  await closed(l.ws);
});

test('hooks set an agent working, waiting on a person, and idle', async () => {
  const l = await lane({});
  const status = async want => { for (let i = 0; i < 50; i++) { const s = (await state()).lanes.find(x => x.id === l.id)?.status; if (s === want) return s; } return null; };
  await hook(l.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  assert.equal(await status('working'), 'working');
  await hook(l.id, { hook_event_name: 'PermissionRequest' });
  assert.equal(await status('needs you'), 'needs you');
  await hook(l.id, { hook_event_name: 'Stop' });
  assert.equal(await status('idle'), 'idle');
  assert.equal((await fetch(`${url}/hooks/${l.id}`, { method: 'POST', headers: { authorization: 'Bearer wrong-secret-here' }, body: '{}' })).status, 401);
  await closed(l.ws);
});

test('team context names at most 15 of a teammate\'s files', async () => {
  const theirs = await lane({ repo: 'acme/app', root: '/bob' }, 'tok-bob');
  const changed = Array.from({ length: 20 }, (_, i) => `src/f${i}.ts`);
  theirs.ws.send(JSON.stringify({ t: 'git', branch: 'session/x', added: 20, removed: 0, files: 20, behind: 0, ahead: 0, changed }));
  const mine = await lane({ repo: 'acme/app', root: '/alice' });
  let context = '';
  for (let i = 0; i < 50 && !/and 5 more/.test(context); i++) context = (await hook(mine.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }))?.hookSpecificOutput?.additionalContext || '';
  assert.match(context, /src\/f14\.ts and 5 more/);
  assert.doesNotMatch(context, /src\/f15\.ts/);
  await Promise.all([closed(theirs.ws), closed(mine.ws)]);
});

test('the last 20 stopped agents are kept per team, newest first', async () => {
  const ids = [];
  for (let i = 0; i < 22; i++) { const l = await lane({ id: `stopped-${i}` }); ids.push(l.id); await closed(l.ws); }
  let stopped = [];
  for (let i = 0; i < 50 && stopped[0]?.id !== 'stopped-21'; i++) stopped = (await state()).stopped;
  assert.equal(stopped.length, 20);
  assert.equal(stopped[0].id, 'stopped-21');
  assert.ok(!stopped.some(s => s.id === 'stopped-0' || s.id === 'stopped-1'), 'the oldest went');
});

test('an id made from a hook secret only connects with that secret', async () => {
  const { laneIdOf } = require('../src/shared');
  assert.equal((await lane({ id: laneIdOf('someone-elses-hook-secret') })).code, 4000, 'another secret, even with no agent holding the id');
  const mine = await lane({ id: laneIdOf(SECRET) });
  assert.ok(mine.ws, 'its own secret');
  await closed(mine.ws);
});

test('edits reported by hooks stay within a git report\'s limits', async () => {
  const l = await lane({});
  await hook(l.id, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: `/r/${'x'.repeat(400)}.ts` } });
  for (let i = 0; i < 205; i++) await hook(l.id, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: `/r/f${i}.ts` } });
  const files = (await state()).lanes.find(x => x.id === l.id).files;
  assert.equal(files.length, 200);
  assert.ok(files.every(f => f.length <= 300));
  await closed(l.ws);
});

test('an edit counts from its PreToolUse, which also shows the agent working again after a permission', async () => {
  const l = await lane({});
  await hook(l.id, { hook_event_name: 'PermissionRequest' });
  await hook(l.id, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/r/new.ts' } });
  const mine = (await state()).lanes.find(x => x.id === l.id);
  assert.deepEqual([mine.status, mine.files], ['working', ['new.ts']]);
  await closed(l.ws);
});

// An agent's status as the hub has it, waited for (each look is a round trip).
const statusOf = async id => (await state()).lanes.find(x => x.id === id)?.status;
const reaches = async (id, want) => { for (let i = 0; i < 50; i++) if (await statusOf(id) === want) return want; return statusOf(id); };
// Once the hub has handled everything this agent sent before: a size change is handled in order, and shows in the state.
const handled = async (l, cols) => {
  l.ws.send(JSON.stringify({ t: 'size', cols, rows: 30 }));
  for (let i = 0; i < 50 && (await state()).lanes.find(x => x.id === l.id)?.cols !== cols; i++);
};

test('a question from the agent, or a plan to approve, shows as needing you', async () => {
  const l = await lane({});
  for (const tool of ['AskUserQuestion', 'ExitPlanMode', 'request_user_input']) {
    await hook(l.id, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/a.ts' } });
    assert.equal(await reaches(l.id, 'working'), 'working');
    await hook(l.id, { hook_event_name: 'PreToolUse', tool_name: tool });
    assert.equal(await reaches(l.id, 'needs you'), 'needs you', tool);
  }
  await closed(l.ws);
});

test('what the screen did after a person\'s key ends a stale status, only for an agent with hooks', async () => {
  const l = await lane({});
  const key = moving => l.ws.send(JSON.stringify({ t: 'key', moving }));
  l.ws.send(JSON.stringify({ t: 'status', status: 'working' })); // no hooks yet: its own word counts
  assert.equal(await reaches(l.id, 'working'), 'working');
  key(false);
  await handled(l, 101);
  assert.equal(await statusOf(l.id), 'working', 'nothing without hooks');
  await hook(l.id, { hook_event_name: 'PermissionRequest' });
  assert.equal(await reaches(l.id, 'needs you'), 'needs you');
  key(true); // approved, and the command prints on: no hook says so until it ends
  assert.equal(await reaches(l.id, 'working'), 'working');
  key(false); // Esc, then a quiet screen: interrupted, which runs no Stop hook
  assert.equal(await reaches(l.id, 'idle'), 'idle');
  key(true);
  await handled(l, 102);
  assert.equal(await statusOf(l.id), 'idle', 'printing alone doesn\'t make an idle agent work');
  await hook(l.id, { hook_event_name: 'PermissionRequest' });
  key(false); // Esc at the question
  assert.equal(await reaches(l.id, 'idle'), 'idle');
  await hook(l.id, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  await hook(l.id, { hook_event_name: 'Interrupt' }); // Codex says so itself
  assert.equal(await reaches(l.id, 'idle'), 'idle');
  await closed(l.ws);
});

test('an agent that comes back after the hub saw it go still has its status from its hooks', async () => {
  const first = await lane({ id: 'sleepy', cmd: 'codex' });
  await hook('sleepy', { hook_event_name: 'PermissionRequest' });
  await closed(first.ws);
  for (let i = 0; i < 50 && !(await state()).stopped.some(s => s.id === 'sleepy'); i++);
  const back = await lane({ id: 'sleepy', cmd: 'codex' }); // a Mac waking up
  back.ws.send(JSON.stringify({ t: 'status', status: 'idle' })); // its guess from a quiet screen
  await handled(back, 101);
  assert.equal(await statusOf('sleepy'), 'needs you', 'still waiting on the person');
  await closed(back.ws);
});

test('only the session creator\'s (or the owner\'s) agent sets a session\'s repo', async () => {
  await api('tok-alice', 'POST', `/teams/${team.id}/sessions`, { name: 'alices-work', task: 'x' });
  const theirs = await lane({ session: 'alices-work', repo: 'bob/evil' }, 'tok-bob');
  const repoOf = async () => (await state()).sessions.find(x => x.name === 'alices-work').repo;
  assert.equal(await repoOf(), undefined, 'a teammate\'s agent doesn\'t');
  const mine = await lane({ session: 'alices-work', repo: 'alice/real' });
  assert.equal(await repoOf(), 'alice/real');
  await Promise.all([closed(theirs.ws), closed(mine.ws)]);
});

test('a stopped agent\'s id can\'t be taken on another team, where it would turn the agent away when it\'s back', async () => {
  const other = (await api('tok-alice', 'POST', '/teams', { name: 'Other' })).body;
  await api('tok-alice', 'POST', `/teams/${other.id}/members`, { login: 'bob' });
  assert.equal((await lane({ id: 'stopped-21', team: other.id }, 'tok-bob')).code, 4000);
});

// Last: its 30 stopped agents push everyone else's out of the team's stopped list.
test('one person runs at most 30 agents in a team, since every teammate\'s app keeps a terminal for each', async () => {
  const mine = await Promise.all(Array.from({ length: 30 }, () => lane({}, 'tok-bob')));
  assert.ok(mine.every(l => l.ws), 'thirty join');
  assert.equal((await lane({}, 'tok-bob')).code, 4000, 'the next is refused');
  await Promise.all(mine.map(l => closed(l.ws)));
});

// A watcher that stays open. Resolves once the hub has sent it the team's state.
const watcher = token => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/watch`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', token, team: team.id })));
  ws.on('message', function first(raw) { if (JSON.parse(raw).t === 'state') { ws.off('message', first); resolve(ws); } });
  ws.on('error', reject);
});

test('a branch that would conflict with main is shown to the team, and its agent is told', async () => {
  const l = await lane({ branch: 'session/x' });
  l.ws.send(JSON.stringify({ t: 'git', branch: 'session/x', mainBranch: 'main', added: 1, removed: 1, files: 1, behind: 1, ahead: 1, changed: ['a.ts'], conflicts: ['src/a.ts', 42, 'x'.repeat(400)] }));
  let mine;
  for (let i = 0; i < 50 && !mine?.conflicts?.length; i++) mine = (await state()).lanes.find(x => x.id === l.id);
  assert.deepEqual(mine.conflicts, ['src/a.ts', 'x'.repeat(300)], 'names only, and no longer than a path');
  const context = (await hook(l.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).hookSpecificOutput.additionalContext;
  assert.match(context, /Your branch "session\/x" would conflict with main if it were merged today \(from Protoplasma\), in: src\/a\.ts/);
  l.ws.send(JSON.stringify({ t: 'git', branch: 'session/x', mainBranch: 'main', added: 1, removed: 1, files: 1, behind: 0, ahead: 1, changed: ['a.ts'], conflicts: [] }));
  for (let i = 0; i < 50 && mine.conflicts.length; i++) mine = (await state()).lanes.find(x => x.id === l.id);
  assert.deepEqual(mine.conflicts, [], 'and it goes once they are settled');
  await closed(l.ws);
});

test('a window gets agents\' output only for the sessions it shows, and their screens as one comes into view', async () => {
  const a = await lane({ session: 'in-view' }), b = await lane({ session: 'elsewhere' });
  a.ws.send(JSON.stringify({ t: 'out', d: 'A-before ' }));
  b.ws.send(JSON.stringify({ t: 'out', d: 'B-before ' }));
  // A window that says which sessions it shows (none yet), and one that doesn't say, as apps before this.
  const open = hello => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/watch`), got = [];
    ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', token: 'tok-bob', team: team.id, ...hello })));
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'out' && [a.id, b.id].includes(m.lane)) got.push(`${m.lane === a.id ? 'A' : 'B'}:${m.d}`); if (m.t === 'state') resolve({ ws, got }); });
    ws.on('error', reject);
  });
  const picky = await open({ sees: [] }), plain = await open({});
  await handled(a, 101);
  await handled(b, 101);
  assert.deepEqual(picky.got, [], 'nothing until it shows a session');
  assert.ok(plain.got.some(x => x.startsWith('A:')) && plain.got.some(x => x.startsWith('B:')), 'a window that doesn\'t say gets everything, as before');
  picky.ws.send(JSON.stringify({ t: 'look', session: 'in-view', sees: ['in-view'] }));
  a.ws.send(JSON.stringify({ t: 'out', d: 'A-live' }));
  b.ws.send(JSON.stringify({ t: 'out', d: 'B-live' }));
  for (let i = 0; i < 100 && !picky.got.includes('A:A-live'); i++) await new Promise(r => setTimeout(r, 20));
  await handled(b, 102);
  assert.match(picky.got[0], /^A:\x1bc[\s\S]*A-before /, 'the agent\'s screen so far, when its session comes into view');
  assert.ok(picky.got.includes('A:A-live') && !picky.got.some(x => x.startsWith('B:')), 'then its output, and none from the session it doesn\'t show');
  await api('tok-alice', 'POST', `/teams/${team.id}/sessions/in-view`, { rename: 'renamed-in-view' });
  a.ws.send(JSON.stringify({ t: 'out', d: 'A-renamed' }));
  for (let i = 0; i < 100 && !picky.got.includes('A:A-renamed'); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(picky.got.includes('A:A-renamed'), 'a renamed session stays in view');
  await Promise.all([closed(picky.ws), closed(plain.ws), closed(a.ws), closed(b.ws)]);
});

test('a file request the agent\'s app never answers fails after 10 s', { timeout: 20_000 }, async () => {
  const agent = await lane({});
  const alice = await watcher('tok-alice'), bob = await watcher('tok-bob');
  const asked = new Promise(resolve => alice.on('message', raw => { if (JSON.parse(raw).t === 'file:get') resolve(); }));
  const answer = new Promise(resolve => bob.on('message', raw => { const m = JSON.parse(raw); if (m.t === 'file:put') resolve(m); }));
  const started = Date.now();
  bob.send(JSON.stringify({ t: 'file:get', ask: 'q1', lane: agent.id, path: 'a.js' }));
  await asked; // alice's app got it and says nothing
  const m = await answer;
  assert.equal(m.ask, 'q1');
  assert.match(m.error, /didn't answer/);
  assert.ok(Date.now() - started >= 9_500, 'it waits the full 10 s');
  await Promise.all([closed(alice), closed(bob), closed(agent.ws)]);
});

test('a viewer that stops reading is dropped instead of buffering without limit', { timeout: 30_000 }, async () => {
  const agent = await lane({});
  const slow = await watcher('tok-bob');
  slow._socket.pause(); // stop reading, as a stalled network would
  const dropped = new Promise(resolve => slow.on('close', resolve));
  const chunk = 'x'.repeat(1024 * 1024);
  for (let i = 0; i < 80; i++) { // 80 MB of output, well past the hub's 16 MB per viewer
    agent.ws.send(JSON.stringify({ t: 'out', d: chunk }));
    await new Promise(r => setTimeout(r, 10));
  }
  slow._socket.resume();
  await dropped;
  assert.ok((await state()).lanes.some(l => l.id === agent.id), 'the agent itself is unaffected');
  await closed(agent.ws);
});

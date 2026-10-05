// Integration tests: a real hub and real lanes running shell commands in place of agents.
// GitHub identity is faked: the token "tok-<name>" belongs to <name>.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');
const { startHub } = require('../src/hub');
const { repoFromRemote, startLane: startLaneHere } = require('../src/lane');
const { appendScrollback, SCROLLBACK } = require('../src/shared');

const LANE = path.join(__dirname, '../src/lane.js');
const root = path.join(__dirname, '..'); // lanes started here report this as their git root
// "tok-slow-<name>" takes a moment to verify, to exercise connections that drop mid-check.
const verifyUser = async token => {
  const [, slow, login] = /^tok-(slow-)?(\w+)$/.exec(token) || [];
  if (slow) await sleep(300);
  return login ? { login, name: login[0].toUpperCase() + login.slice(1), avatar: '' } : null;
};

let hub, url, team, watcher, alice, bob;
const outputs = [];
const processes = [];

const api = async (token, method, route, body) => {
  const res = await fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const connectWatcher = (token, teamId, onMessage = () => {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/watch`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', token, team: teamId })));
  ws.on('message', raw => onMessage(JSON.parse(raw)));
  ws.once('message', () => resolve(ws));
  ws.on('close', code => reject(Object.assign(new Error(`closed ${code}`), { code })));
});
const nextState = match => new Promise(resolve => watcher.on('message', function onMessage(raw) {
  const m = JSON.parse(raw);
  if (m.t === 'state' && match(m.lanes)) { watcher.off('message', onMessage); resolve(m.lanes); }
}));
const startLane = (login, ...args) => processes.push(spawn('node', [LANE, url, team.id, 's1', ...args],
  { cwd: root, env: { ...process.env, PROTO_TOKEN: `tok-${login}` }, stdio: ['ignore', 'ignore', 'inherit'] }));
const outputOf = lane => outputs.filter(m => m.lane === lane.id).map(m => m.d).join('');
const hookSecret = lane => /secret:(\w+)/.exec(outputOf(lane))?.[1];
const postHook = (lane, body, secret = hookSecret(lane)) => fetch(`${url}/hooks/${lane.id}`,
  { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ cwd: root, ...body }) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const printSecretThenCat = ['sh', '-c', 'echo "secret:$PROTO_HOOK_SECRET"; cat'];

before(async () => {
  hub = await startHub({ port: 0, host: '127.0.0.1', owners: ['alice'], verifyUser });
  url = `http://127.0.0.1:${hub.port}`;
  team = (await api('tok-alice', 'POST', '/teams', { name: 'Lobby' })).body;
  await api('tok-alice', 'POST', `/teams/${team.id}/members`, { login: '@Bob' });

  watcher = await connectWatcher('tok-alice', team.id, m => { if (m.t === 'out') outputs.push(m); });
  const ready = nextState(lanes => lanes.length === 2);
  startLane('alice', '--open', ...printSecretThenCat); // prints before it can reach the hub
  startLane('bob', ...printSecretThenCat);
  const lanes = await ready;
  alice = lanes.find(l => l.login === 'alice');
  bob = lanes.find(l => l.login === 'bob');
  while (!hookSecret(alice) || !hookSecret(bob)) await sleep(20);
});

after(async () => {
  for (const p of processes) p.kill();
  watcher.close();
  await hub.close();
});

test('only owners create teams, and only members see them', async () => {
  assert.equal((await api('nope', 'GET', '/teams')).status, 401);
  assert.equal((await api('tok-bob', 'POST', '/teams', { name: 'Mine' })).status, 403);
  assert.deepEqual((await api('tok-bob', 'GET', '/teams')).body.map(t => t.name), ['Lobby']);
  assert.deepEqual((await api('tok-carol', 'GET', '/teams')).body, []);
  assert.equal((await api('tok-bob', 'POST', `/teams/${team.id}/members`, { login: 'carol' })).status, 403, 'only the owner invites');
});

test('refuses people who are not signed in or not on the team', async () => {
  await assert.rejects(connectWatcher('nope', team.id), { code: 4001 });
  await assert.rejects(connectWatcher('tok-carol', team.id), { code: 4003 });
});

test('agents show up under their GitHub identity', () => {
  assert.equal(alice.name, 'Alice');
  assert.equal(bob.name, 'Bob');
});

test('shows output an agent printed before it connected', () => {
  assert.match(outputOf(alice), /secret:/);
});

test('teammates can type into open agents only', async () => {
  watcher.send(JSON.stringify({ t: 'in', lane: alice.id, d: 'ping\r' }));
  watcher.send(JSON.stringify({ t: 'in', lane: bob.id, d: 'nope\r' }));
  await sleep(500);
  assert.match(outputOf(alice), /ping/);
  assert.doesNotMatch(outputOf(bob), /nope/);
});

test('hooks only accept the agent\'s own secret', async () => {
  assert.equal((await postHook(alice, { hook_event_name: 'Stop' }, 'wrong')).status, 401);
  assert.equal((await postHook(alice, { hook_event_name: 'Stop' }, hookSecret(bob))).status, 401);
});

test('asks before an agent edits a file a teammate already edited', async () => {
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') } };
  await postHook(alice, { hook_event_name: 'PostToolUse', ...edit });

  const { hookSpecificOutput: pre } = await (await postHook(bob, { hook_event_name: 'PreToolUse', ...edit })).json();
  assert.equal(pre.permissionDecision, 'ask');
  assert.match(pre.permissionDecisionReason, /Alice.*src\/x\.ts/);

  const own = await postHook(alice, { hook_event_name: 'PreToolUse', ...edit });
  assert.equal(await own.text(), '', 'no warning for your own file');
});

test('tells each agent what its teammates are doing', async () => {
  const { hookSpecificOutput } = await (await postHook(bob, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).json();
  assert.match(hookSpecificOutput.additionalContext, /Alice.*src\/x\.ts/);
});

test('shared memory: anyone on the team adds notes; only the author or owner removes them', async () => {
  const route = `/teams/${team.id}/memories`;
  assert.equal((await api('tok-bob', 'POST', route, { text: 'Totals recompute on promo change, do not cache', file: './src/cart/totals.ts' })).status, 200);
  const notes = (await api('tok-alice', 'POST', route, { text: 'Use pnpm, not npm' })).body;
  assert.equal(notes.length, 2);
  assert.equal(notes[0].file, 'src/cart/totals.ts');
  assert.equal((await api('tok-carol', 'POST', route, { text: 'hi' })).status, 404, 'not on the team');
  assert.equal((await api('tok-bob', 'POST', route, { text: ' ' })).status, 400);
  const alices = notes.find(n => n.author === 'alice');
  assert.equal((await api('tok-bob', 'DELETE', `${route}/${alices.id}`)).status, 403, 'bob is neither author nor owner');
});

test('agents get general notes with each prompt, and a file\'s notes before touching it', async () => {
  const { hookSpecificOutput: prompt } = await (await postHook(bob, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).json();
  assert.match(prompt.additionalContext, /Use pnpm/);
  assert.doesNotMatch(prompt.additionalContext, /do not cache/, 'pinned notes wait for their file');

  const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/cart/totals.ts') } };
  const { hookSpecificOutput: pre } = await (await postHook(alice, read)).json();
  assert.match(pre.additionalContext, /src\/cart\/totals\.ts[\s\S]*do not cache/);
  assert.equal(pre.permissionDecision, undefined, 'notes alone never block');
});

test('shows who is watching which session', async () => {
  const looked = new Promise(resolve => watcher.on('message', function onMessage(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'state' && m.watchers.some(w => w.login === 'alice' && w.session === 's1')) { watcher.off('message', onMessage); resolve(m); }
  }));
  watcher.send(JSON.stringify({ t: 'look', session: 's1' }));
  const state = await looked;
  assert.equal(state.watchers.find(w => w.session === 's1').name, 'Alice');
});

test('connections that drop while being verified leave no ghosts', async () => {
  const lane = new WebSocket(`${url.replace('http', 'ws')}/lane`);
  await new Promise(resolve => lane.on('open', resolve));
  lane.send(JSON.stringify({ t: 'hello', token: 'tok-slow-alice', team: team.id, id: 'ghost-lane', hookSecret: 'x', session: 's1', cmd: 'sh' }));
  const viewer = new WebSocket(`${url.replace('http', 'ws')}/watch`);
  await new Promise(resolve => viewer.on('open', resolve));
  viewer.send(JSON.stringify({ t: 'watch', token: 'tok-slow-bob', team: team.id }));
  await sleep(50);
  lane.terminate();
  viewer.terminate();
  await sleep(500);

  let state;
  const snapshot = await connectWatcher('tok-alice', team.id, m => { state ??= m; });
  snapshot.close();
  assert.ok(!state.lanes.some(l => l.id === 'ghost-lane'), 'no ghost lane');
  assert.ok(!state.watchers.some(w => w.login === 'bob'), 'no ghost watcher');
});

test('sessions outlive their agents, carry a goal, and can be finished', async () => {
  const route = `/teams/${team.id}/sessions`;
  const sessions = (await api('tok-alice', 'POST', route, { name: 's1', task: 'Fix the lobby race' })).body;
  assert.equal(sessions.find(x => x.name === 's1').task, 'Fix the lobby race');
  const { hookSpecificOutput } = await (await postHook(bob, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).json();
  assert.match(hookSpecificOutput.additionalContext, /goal: Fix the lobby race/);

  await api('tok-alice', 'POST', route, { name: 'planning', task: 'Plan the next release' });
  assert.equal((await api('tok-bob', 'POST', `${route}/planning`, { done: true })).status, 403, 'only its creator or the owner');
  const done = (await api('tok-alice', 'POST', `${route}/planning`, { done: true })).body;
  assert.equal(done.find(x => x.name === 'planning').done, true);
  assert.equal((await api('tok-alice', 'DELETE', `${route}/s1`)).status, 409, 'agents still running');
  const left = (await api('tok-alice', 'DELETE', `${route}/planning`)).body;
  assert.ok(!left.some(x => x.name === 'planning'));
});

test('git progress and branch switches reach teammates', async () => {
  const lane = new WebSocket(`${url.replace('http', 'ws')}/lane`);
  await new Promise(resolve => lane.on('open', resolve));
  const joined = nextState(lanes => lanes.some(l => l.id === 'git-lane'));
  lane.send(JSON.stringify({ t: 'hello', token: 'tok-alice', team: team.id, id: 'git-lane', hookSecret: 'x', session: 's1', cmd: 'sh', branch: 'main' }));
  await joined;
  const updated = nextState(lanes => lanes.some(l => l.id === 'git-lane' && l.git?.added === 3));
  lane.send(JSON.stringify({ t: 'git', branch: 'fix/lobby', added: 3, removed: 1, files: 2 }));
  const gitLane = (await updated).find(l => l.id === 'git-lane');
  assert.deepEqual(gitLane.git, { added: 3, removed: 1, files: 2, behind: 0, ahead: 0 });
  assert.equal(gitLane.branch, 'fix/lobby');
  const gone = nextState(lanes => !lanes.some(l => l.id === 'git-lane'));
  lane.close();
  await gone;
});

// A lane driven directly over the socket, so its repo, branch and git stats are whatever the test needs.
async function rawLane(id, hello = {}) {
  const lane = new WebSocket(`${url.replace('http', 'ws')}/lane`);
  await new Promise(resolve => lane.on('open', resolve));
  const joined = nextState(lanes => lanes.some(l => l.id === id));
  lane.send(JSON.stringify({ t: 'hello', token: 'tok-alice', team: team.id, id, hookSecret: 'x', session: 's1', cmd: 'claude', root: '/r', ...hello }));
  await joined;
  const hook = async body => {
    const res = await fetch(`${url}/hooks/${id}`, { method: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ cwd: '/r', ...body }) });
    return (await res.json().catch(() => null))?.hookSpecificOutput ?? null;
  };
  const close = async () => { const gone = nextState(lanes => !lanes.some(l => l.id === id)); lane.close(); await gone; };
  return { socket: lane, hook, close };
}

test('pushing to main or force-pushing needs a person to confirm', async () => {
  const onMain = await rawLane('push-main', { branch: 'main', repo: 'acme/app' });
  const onBranch = await rawLane('push-branch', { branch: 'session/fix', repo: 'acme/app' });
  const push = (lane, command) => lane.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

  for (const command of ['git push', 'git push -u origin', 'git push origin HEAD', 'git add . && git commit -m x && git push']) {
    assert.equal((await push(onMain, command))?.permissionDecision, 'ask', `on main: ${command}`);
  }
  for (const command of ['git push origin main', 'git push origin HEAD:main', 'git push origin session/fix:refs/heads/master']) {
    assert.match((await push(onBranch, command)).permissionDecisionReason, /straight to (main|master)/, command);
  }
  for (const command of ['git push -f origin session/fix', 'git push --force', 'git push origin +session/fix']) {
    assert.match((await push(onBranch, command)).permissionDecisionReason, /force-push/, command);
  }
  for (const command of ['git push', 'git push -u origin session/fix', 'git push --force-with-lease origin session/fix', 'git status', 'echo push main']) {
    assert.equal(await push(onBranch, command), null, `fine: ${command}`);
  }
  await onMain.close();
  await onBranch.close();
});

test('overlap warnings, notes and teammate context stay within a repo', async () => {
  const app = await rawLane('repo-app', { repo: 'acme/app', session: 'app-work' });
  const other = await rawLane('repo-other', { repo: 'acme/other' });
  const appToo = await rawLane('repo-app-2', { repo: 'acme/app' });
  const edit = { tool_name: 'Edit', tool_input: { file_path: '/r/README.md' } };
  await app.hook({ hook_event_name: 'PostToolUse', ...edit });
  assert.equal(await other.hook({ hook_event_name: 'PreToolUse', ...edit }), null, 'a different repo\'s README is not an overlap');
  assert.equal((await appToo.hook({ hook_event_name: 'PreToolUse', ...edit })).permissionDecision, 'ask');

  await api('tok-alice', 'POST', `/teams/${team.id}/memories`, { text: 'The app uses yarn', repo: 'acme/app' });
  const prompt = { hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
  const sameRepo = (await appToo.hook(prompt)).additionalContext;
  assert.match(sameRepo, /README\.md/, 'sees its repo-mate\'s edits');
  assert.match(sameRepo, /The app uses yarn/);
  assert.doesNotMatch((await other.hook(prompt))?.additionalContext || '', /The app uses yarn|README\.md/, 'another repo\'s notes and agents stay out');

  const sessions = (await api('tok-alice', 'POST', `/teams/${team.id}/sessions`, { name: 'app-work' })).body;
  assert.equal(sessions.find(x => x.name === 'app-work').repo, 'acme/app', 'the session remembers its repo');
  await Promise.all([app.close(), other.close(), appToo.close()]);
});

test('sessions have comments, and agents show their latest prompt', async () => {
  const route = `/teams/${team.id}/sessions/s1/comments`;
  assert.equal((await api('tok-carol', 'POST', route, { text: 'hi' })).status, 404, 'not on the team');
  assert.equal((await api('tok-alice', 'POST', route, { text: ' ' })).status, 400);
  const sessions = (await api('tok-alice', 'POST', route, { text: 'I take the auth part' })).body;
  const comment = sessions.find(x => x.name === 's1').comments[0];
  assert.equal(comment.text, 'I take the auth part');
  assert.equal(comment.author, 'alice');
  assert.equal((await api('tok-alice', 'DELETE', `${route}/${comment.id}`)).status, 200);
  assert.equal((await api('tok-alice', 'POST', `/teams/${team.id}/members/bob/comments`, { text: 'x' })).status, 404, 'comments only exist on sessions');

  const shown = nextState(lanes => lanes.find(l => l.id === alice.id)?.prompt === 'make the lobby faster');
  await postHook(alice, { hook_event_name: 'UserPromptSubmit', prompt: 'make the lobby\n  faster' });
  await shown;
});

test('session names that differ only in case or punctuation are the same session', async () => {
  const a = await rawLane('same-a', { session: 'Fix Login', repo: 'acme/app' });
  const joined = nextState(lanes => lanes.some(l => l.id === 'same-b'));
  const b = await rawLane('same-b', { session: 'fix-login', repo: 'acme/app' });
  assert.equal((await joined).find(l => l.id === 'same-b').session, 'Fix Login', 'it joins the existing session');
  const sessions = (await api('tok-alice', 'GET', '/teams')).status === 200 && (await api('tok-alice', 'POST', `/teams/${team.id}/sessions`, { name: 'FIX  login!' })).body;
  assert.equal(sessions.filter(x => /fix.*login/i.test(x.name)).length, 1);
  await Promise.all([a.close(), b.close()]);
});

test('uncommitted changes count as edits, whoever or whatever made them', async () => {
  // Two checkouts of one repo. Neither agent edited through Claude's tools; git reports the changes.
  const one = await rawLane('git-one', { repo: 'acme/git', root: '/one' });
  const two = await rawLane('git-two', { repo: 'acme/git', root: '/two' });
  const git = changed => ({ t: 'git', branch: 'session/x', added: 1, removed: 0, files: changed.length, behind: 0, ahead: 0, changed });
  one.socket.send(JSON.stringify(git(['src/a.ts'])));
  await nextState(lanes => lanes.find(l => l.id === 'git-one')?.files.includes('src/a.ts'));
  const edit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/two/src/a.ts' }, cwd: '/two' };
  const res = await fetch(`${url}/hooks/git-two`, { method: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(edit) });
  assert.equal((await res.json()).hookSpecificOutput.permissionDecision, 'ask', 'Claude is asked before touching a file changed in another checkout');
  const both = nextState(lanes => ['git-one', 'git-two'].every(id => lanes.find(l => l.id === id)?.overlaps.includes('src/a.ts')));
  two.socket.send(JSON.stringify(git(['src/a.ts'])));
  await both;

  // Agents sharing one checkout share its changes, so they don't overlap with each other.
  const twin = await rawLane('git-twin', { repo: 'acme/git', root: '/one' });
  twin.socket.send(JSON.stringify(git(['src/b.ts'])));
  one.socket.send(JSON.stringify(git(['src/a.ts', 'src/b.ts'])));
  const after = await nextState(ls => ls.find(l => l.id === 'git-one')?.files.includes('src/b.ts') && ls.find(l => l.id === 'git-twin')?.files.includes('src/b.ts'));
  assert.ok(!after.find(l => l.id === 'git-one').overlaps.includes('src/b.ts'));
  const twinEdit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/one/src/b.ts' }, cwd: '/one' };
  const twinRes = await fetch(`${url}/hooks/git-twin`, { method: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(twinEdit) });
  assert.equal((await twinRes.json().catch(() => null))?.hookSpecificOutput?.permissionDecision, undefined,
    "a change in its own folder isn't blamed on the other agent there");
  await Promise.all([one.close(), two.close(), twin.close()]);
});

test('a Codex or OpenCode agent is working while it prints and idle once it goes quiet', async () => {
  const dir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'protoplasma-codex-'));
  const codex = path.join(dir, 'codex');
  require('node:fs').writeFileSync(codex, '#!/bin/sh\nfor i in 1 2 3; do echo step $i; sleep 0.3; done\nexec cat\n', { mode: 0o755 });
  const working = nextState(lanes => lanes.some(l => l.session === 'activity' && l.status === 'working'));
  processes.push(spawn('node', [LANE, url, team.id, 'activity', codex], { cwd: root, env: { ...process.env, PROTO_TOKEN: 'tok-alice' }, stdio: ['ignore', 'ignore', 'inherit'] }));
  const lane = (await working).find(l => l.session === 'activity');
  await nextState(lanes => lanes.find(l => l.id === lane.id)?.status === 'idle');
  const gone = nextState(lanes => !lanes.some(l => l.id === lane.id));
  processes.pop().kill();
  await gone;
});

test('agents without hooks report working and idle themselves', async () => {
  const lane = await rawLane('no-hooks', { cmd: 'codex', repo: 'acme/app' });
  for (const status of ['working', 'idle']) {
    const seen = nextState(lanes => lanes.find(l => l.id === 'no-hooks')?.status === status);
    lane.socket.send(JSON.stringify({ t: 'status', status }));
    await seen;
  }
  lane.socket.send(JSON.stringify({ t: 'status', status: 'hacked' }));
  await lane.close();
});

test('an agent waiting on its folder trust prompt needs you until someone answers', async () => {
  const asking = nextState(lanes => lanes.some(l => l.session === 'trust' && l.status === 'needs you'));
  processes.push(spawn('node', [LANE, url, team.id, 'trust', '--open', 'sh', '-c', 'printf "Is this a project you trust?\\n  Yes, I trust this folder"; cat'],
    { cwd: root, env: { ...process.env, PROTO_TOKEN: 'tok-alice' }, stdio: ['ignore', 'ignore', 'inherit'] }));
  const lane = (await asking).find(l => l.session === 'trust');
  const answered = nextState(lanes => lanes.find(l => l.id === lane.id)?.status === 'idle');
  watcher.send(JSON.stringify({ t: 'in', lane: lane.id, d: '\r' }));
  await answered;
  const gone = nextState(lanes => !lanes.some(l => l.id === lane.id));
  processes.pop().kill();
  await gone;
});

test('an agent is told when its branch has fallen behind', async () => {
  const lane = await rawLane('behind-lane', { branch: 'session/fix', repo: 'acme/app' });
  lane.socket.send(JSON.stringify({ t: 'git', branch: 'session/fix', added: 0, removed: 0, files: 0, behind: 2, ahead: 1 }));
  await nextState(lanes => lanes.some(l => l.id === 'behind-lane' && l.git?.behind === 2));
  const out = await lane.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.match(out.additionalContext, /2 commits behind/);
  await lane.close();
});

test('removes an agent when its process exits, keeping its last screen to look back at', async () => {
  const joined = nextState(lanes => lanes.some(l => l.session === 's1' && l.login === 'alice' && l.id !== alice.id));
  startLane('alice', 'sh', '-c', 'echo farewell-from-the-agent; sleep 0.5');
  const extra = (await joined).find(l => l.login === 'alice' && l.id !== alice.id);
  const ended = new Promise(resolve => watcher.on('message', function onMessage(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'state' && !m.lanes.some(l => l.id === extra.id) && m.stopped?.some(x => x.id === extra.id)) { watcher.off('message', onMessage); resolve(m.stopped); }
  }));
  const record = (await ended).find(x => x.id === extra.id);
  assert.equal(record.session, 's1');
  assert.equal(record.history, undefined, 'the screen itself is only sent on request');
  const replay = new Promise(resolve => watcher.on('message', function onMessage(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'replay') { watcher.off('message', onMessage); resolve(m); }
  }));
  watcher.send(JSON.stringify({ t: 'replay', id: extra.id }));
  assert.match((await replay).d, /farewell-from-the-agent/);
});

test('a session can be renamed while nothing runs in it, keeping its branch name', async () => {
  const route = `/teams/${team.id}/sessions`;
  await api('tok-alice', 'POST', route, { name: 'old-name' });
  assert.equal((await api('tok-alice', 'POST', `${route}/s1`, { rename: 'busy' })).status, 409, 's1 has agents running');
  let sessions = (await api('tok-alice', 'POST', `${route}/old-name`, { rename: 'New Name' })).body;
  const renamed = sessions.find(x => x.name === 'New Name');
  assert.equal(renamed.key, 'old-name', 'the branch and folders keep the original name');
  sessions = (await api('tok-alice', 'POST', route, { name: 'old-name' })).body;
  assert.equal(sessions.filter(x => /old-name|New Name/.test(x.name)).length, 1, 'the old name still finds it');
  assert.equal((await api('tok-alice', 'POST', `${route}/New%20Name`, { rename: 'S1' })).status, 409, 'names stay unique');
  assert.equal((await api('tok-bob', 'POST', `${route}/New%20Name`, { rename: 'x' })).status, 403);
});

test('removing someone from the team disconnects their agents', async () => {
  const gone = nextState(lanes => !lanes.some(l => l.login === 'bob'));
  assert.equal((await api('tok-alice', 'DELETE', `/teams/${team.id}/members/bob`)).status, 200);
  await gone;
  assert.deepEqual((await api('tok-bob', 'GET', '/teams')).body, []);
});

test('members can leave, and the owner deletes a team once its agents have stopped', async () => {
  const members = `/teams/${team.id}/members`;
  assert.equal((await api('tok-alice', 'POST', members, { login: 'carol' })).status, 200);
  assert.equal((await api('tok-alice', 'POST', members, { login: 'Carol' })).status, 409, 'already on the team');
  assert.equal((await api('tok-carol', 'DELETE', `${members}/alice`)).status, 403, 'only yourself');
  assert.equal((await api('tok-carol', 'DELETE', `${members}/carol`)).status, 200);
  assert.deepEqual((await api('tok-carol', 'GET', '/teams')).body, []);

  assert.equal((await api('tok-alice', 'DELETE', `/teams/${team.id}`)).status, 409, 'alice still has an agent running');
  const spare = (await api('tok-alice', 'POST', '/teams', { name: 'Spare' })).body;
  assert.equal((await api('tok-alice', 'DELETE', `/teams/${spare.id}`)).status, 200);
  assert.deepEqual((await api('tok-alice', 'GET', '/teams')).body.map(t => t.name), ['Lobby']);
});

test('a missing agent command is an error, not a lane that vanishes', () => {
  assert.throws(() => startLaneHere({ hub: url, team: team.id, token: 'tok-alice', session: 's1', cmd: 'no-such-agent-cli' }), /isn't installed/);
});

test('reads the GitHub repo from a clone\'s remote', () => {
  assert.equal(repoFromRemote('https://github.com/dw8-ro/protoplasma-ide.git'), 'dw8-ro/protoplasma-ide');
  assert.equal(repoFromRemote('git@github.com:dw8-ro/protoplasma-ide.git'), 'dw8-ro/protoplasma-ide');
  assert.equal(repoFromRemote('https://github.com/a-b/c.d'), 'a-b/c.d');
  assert.equal(repoFromRemote('https://gitlab.com/a/b.git'), '');
});

test('scrollback keeps the latest output within its limit', () => {
  let buf = '';
  for (let i = 0; i < 5000; i++) buf = appendScrollback(buf, `line ${i}\n`.padEnd(200, '.'));
  assert.ok(buf.length <= 2 * SCROLLBACK);
  assert.ok(buf.endsWith(`line 4999\n`.padEnd(200, '.')));
});

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

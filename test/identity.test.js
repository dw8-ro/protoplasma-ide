// Teams know people by GitHub's numeric id, so a renamed account keeps its place and whoever takes the old login
// doesn't get it. GitHub is faked: each token is a person with a login and an id.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { startHub } = require('../src/hub');

const people = {
  'tok-alice': { login: 'alice', id: 1 },
  'tok-bob': { login: 'bob', id: 2 },
  'tok-bobby': { login: 'bobby', id: 2 }, // Bob, after renaming his account
  'tok-newbob': { login: 'bob', id: 3 },  // someone else, who then took the login "bob"
  'tok-carol': { login: 'carol', id: 4 },
  'tok-fakecarol': { login: 'carol', id: 5 },
  'tok-constructor': { login: 'constructor', id: 6 }, // a login that's also a property every JavaScript object has
  [`ghp_${'d'.repeat(36)}`]: { login: 'dana', id: 7 }, // shaped like a real GitHub token, so the sign-in budget applies
};
const DANA = `ghp_${'d'.repeat(36)}`;
const asked = []; // tokens the hub asked "GitHub" about
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-identity-'));
// A team saved before ids were kept: Carol is on it by login only.
fs.writeFileSync(path.join(tmp, 'teams.json'), JSON.stringify([{ id: 'old', name: 'Old', owner: 'alice', members: ['carol'], memories: [], sessions: [] }]));
let hub, url;
const api = async (token, method, route, body) => {
  const res = await fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const names = async token => (await api(token, 'GET', '/teams')).body.map(t => t.name);

const start = async () => {
  hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: tmp,
    verifyUser: async token => { asked.push(token); return people[token] ? { ...people[token], name: people[token].login, avatar: '' } : null; } });
  url = `http://127.0.0.1:${hub.port}`;
};
before(start);
after(async () => {
  await hub.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('someone who takes a member\'s old login doesn\'t get their place, and the renamed member keeps it', async () => {
  const team = (await api('tok-alice', 'POST', '/teams', { name: 'Lobby' })).body;
  assert.equal((await api('tok-alice', 'POST', `/teams/${team.id}/members`, { login: 'bob', id: 2 })).status, 200);
  assert.deepEqual(await names('tok-bob'), ['Lobby']);
  assert.deepEqual(await names('tok-newbob'), [], 'the same login with another id');
  assert.equal((await api('tok-newbob', 'GET', `/teams/${team.id}/sessions`)).status, 404);
  assert.deepEqual(await names('tok-bobby'), ['Lobby'], 'Bob under his new login');
  assert.deepEqual((await api('tok-alice', 'GET', '/teams')).body.find(t => t.id === team.id).members, ['bobby']);
  assert.deepEqual(await names('tok-newbob'), []);
  assert.equal((await api('tok-alice', 'POST', `/teams/${team.id}/members`, { login: 'robert', id: 2 })).status, 409, 'the same person twice');
  // The live connection is refused the same way.
  const code = await new Promise(resolve => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/watch`);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', token: 'tok-newbob', team: team.id })));
    ws.on('close', resolve);
  });
  assert.equal(code, 4003);
});

test('people on teams from before ids are recorded at their first sign-in', async () => {
  assert.deepEqual(await names('tok-carol'), ['Old']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'teams.json'), 'utf8')).find(t => t.id === 'old').ids.carol, 4);
  assert.deepEqual(await names('tok-fakecarol'), [], 'after that, the login alone isn\'t enough');
  assert.deepEqual(await names('tok-alice'), ['Old', 'Lobby'], 'the owner too');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'teams.json'), 'utf8')).find(t => t.id === 'old').ids.alice, 1);
});

test('a login that is also a JavaScript property name is a person like any other', async () => {
  const team = (await api('tok-alice', 'POST', '/teams', { name: 'Props' })).body;
  assert.equal((await api('tok-alice', 'POST', `/teams/${team.id}/members`, { login: 'constructor' })).status, 200); // no id yet
  assert.deepEqual(await names('tok-constructor'), ['Props']);
  assert.equal((await api('tok-constructor', 'POST', '/hubs', { fp: 'c'.repeat(43) })).status, 200);
});

// Last: it uses up this hub's budget of new GitHub checks for a minute.
test('made-up GitHub tokens get at most a minute\'s budget of GitHub checks, sent at once or not', async () => {
  assert.equal((await api(DANA, 'GET', '/teams')).status, 200, 'Dana signs in before the flood');
  for (let i = 0; i < 70; i++) assert.equal((await api(`tok-junk-${i}`, 'GET', '/teams')).status, 401, 'not shaped like a token: free, not counted');
  const before = asked.length;
  const madeUp = i => `ghp_${String(i).padStart(36, '0')}`;
  const answers = await Promise.all(Array.from({ length: 80 }, (_, i) => api(madeUp(i), 'GET', '/teams'))); // all in parallel
  assert.equal(answers.filter(a => a.status === 401).length, 59, 'the rest of the minute\'s 60 (Dana\'s used one)');
  assert.equal(answers.filter(a => a.status === 503).length, 21, 'the others are told to try again');
  assert.equal(asked.length - before, 59, 'GitHub was asked 59 times, not 80');
  assert.deepEqual(await names('tok-alice'), ['Old', 'Lobby', 'Props'], 'a sign-in already checked still works');
  // After a restart (a redeploy) during the flood, someone who signed in within the day still isn't held up.
  await hub.close();
  await start();
  await Promise.all(Array.from({ length: 61 }, (_, i) => api(madeUp(100 + i), 'GET', '/teams')));
  assert.equal((await api(madeUp(200), 'GET', '/teams')).status, 503, 'the budget is used up again');
  assert.equal((await api(DANA, 'GET', '/teams')).status, 200);
});

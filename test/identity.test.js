// Teams know people by GitHub's numeric id, so a renamed account keeps its place and whoever takes the old login
// doesn't get it. GitHub is faked: each token is a person with a login and an id.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { startHub, githubUser } = require('../src/hub');

const people = {
  'tok-alice': { login: 'alice', id: 1 },
  'tok-bob': { login: 'bob', id: 2 },
  'tok-bobby': { login: 'bobby', id: 2 }, // Bob, after renaming his account
  'tok-newbob': { login: 'bob', id: 3 },  // someone else, who then took the login "bob"
  'tok-carol': { login: 'carol', id: 4 },
  'tok-fakecarol': { login: 'carol', id: 5 },
  'tok-constructor': { login: 'constructor', id: 6 }, // a login that's also a property every JavaScript object has
  [`ghp_${'d'.repeat(36)}`]: { login: 'dana', id: 7 }, // shaped like a real GitHub token, so the sign-in budget applies
  [`ghp_${'f'.repeat(36)}`]: { login: 'fay', id: 9 }, // the same, signing in for the first time during a flood
};
const FAY = `ghp_${'f'.repeat(36)}`;
const DANA = `ghp_${'d'.repeat(36)}`;
const asked = []; // tokens the hub asked "GitHub" about
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-identity-'));
// A team saved before ids were kept: Carol is on it by login only.
fs.writeFileSync(path.join(tmp, 'teams.json'), JSON.stringify([{ id: 'old', name: 'Old', owner: 'alice', members: ['carol'], memories: [], sessions: [] }]));
let hub, url;
const api = async (token, method, route, body, from = '10.0.0.1') => {
  const res = await fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'x-real-ip': from }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const names = async token => (await api(token, 'GET', '/teams')).body.map(t => t.name);

const start = async () => {
  hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: tmp, addressHeader: 'x-real-ip',
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

test('a hub on a Mac stays registered to the person, not the login, when someone takes their old login', async () => {
  const fp = c => c.repeat(43);
  assert.equal((await api('tok-bob', 'POST', '/hubs', { fp: fp('a') })).status, 200);
  assert.deepEqual((await api('tok-carol', 'POST', '/passes', { aud: fp('a') })).body.owners, ['bob']);
  assert.equal((await api('tok-bobby', 'POST', '/hubs', { fp: fp('b') })).status, 200, 'Bob, renamed, registers again');
  assert.equal((await api('tok-newbob', 'POST', '/hubs', { fp: fp('n') })).status, 409, 'the new holder of "bob" can\'t, for now');
  assert.equal((await api('tok-carol', 'POST', '/passes', { aud: fp('n') })).status, 404, 'so no pass names "bob" for their hub');
  assert.equal((await api('tok-carol', 'POST', '/passes', { aud: fp('a') })).status, 404, 'Bob\'s old registration went with his old login');
  assert.deepEqual((await api('tok-carol', 'POST', '/passes', { aud: fp('b') })).body.owners, ['bobby']);
});

test('a hub\'s owners are the people who first created teams under those logins, not whoever holds them later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-owners-'));
  const other = await startHub({ port: 0, host: '127.0.0.1', dataDir: dir, owners: ['bob'], verifyUser: async t => people[t] && { ...people[t], name: people[t].login, avatar: '' } });
  const create = async token => (await fetch(`http://127.0.0.1:${other.port}/teams`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"name":"T"}' })).status;
  try {
    assert.equal(await create('tok-bob'), 201);
    assert.equal(await create('tok-newbob'), 403, 'the same login with another id');
    assert.equal(await create('tok-carol'), 403, 'not an owner at all');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'owners.json'), 'utf8')), { bob: 2 });
  } finally { await other.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Last: it uses up this hub's budget of new GitHub checks for a minute.
test('made-up GitHub tokens only hold up the address sending them, and the hub has a budget for all of them', async () => {
  assert.equal((await api(DANA, 'GET', '/teams')).status, 200, 'Dana signs in before the flood');
  for (let i = 0; i < 70; i++) assert.equal((await api(`tok-junk-${i}`, 'GET', '/teams')).status, 401, 'not shaped like a token: free, not counted');
  const madeUp = i => `ghp_${String(i).padStart(36, '0')}`;
  let before = asked.length;
  const answers = await Promise.all(Array.from({ length: 80 }, (_, i) => api(madeUp(i), 'GET', '/teams', undefined, '6.6.6.6'))); // all at once
  assert.equal(answers.filter(a => a.status === 401).length, 10, 'one address gets 10 checks a minute');
  assert.equal(answers.filter(a => a.status === 503).length, 70, 'the others are told to try again');
  assert.equal(asked.length - before, 10, 'GitHub was asked 10 times, not 80');
  assert.equal((await api(FAY, 'GET', '/teams', undefined, '7.7.7.7')).status, 200, 'a newcomer elsewhere still signs in');
  assert.deepEqual(await names('tok-alice'), ['Old', 'Lobby', 'Props'], 'a sign-in already checked still works');
  // From many addresses, the hub-wide budget (300 a minute; Dana, Fay and the flood used 12) still caps what GitHub is asked.
  before = asked.length;
  for (let n = 0; n < 300; n += 50) { // in batches: hundreds of sockets at once is the test's problem, not the hub's
    await Promise.all(Array.from({ length: 50 }, (_, i) => api(madeUp(1000 + n + i), 'GET', '/teams', undefined, `10.1.${(n + i) >> 3}.${(n + i) & 7}`)));
  }
  assert.equal(asked.length - before, 288);
  assert.equal((await api(madeUp(5000), 'GET', '/teams', undefined, '8.8.8.8')).status, 503, 'the hub-wide budget is used up');
  // After a restart (a redeploy) during the flood, someone who signed in within the day still isn't held up.
  await hub.close();
  await start();
  await Promise.all(Array.from({ length: 11 }, (_, i) => api(madeUp(100 + i), 'GET', '/teams', undefined, '6.6.6.6')));
  assert.equal((await api(madeUp(200), 'GET', '/teams', undefined, '6.6.6.6')).status, 503, 'that address is held up again');
  assert.equal((await api(DANA, 'GET', '/teams', undefined, '6.6.6.6')).status, 200, 'even from there');
});

test('only a token Protoplasma\'s own GitHub app issued signs someone in', async () => {
  const real = globalThis.fetch, token = `gho_${'e'.repeat(36)}`;
  globalThis.fetch = async () => new Response(JSON.stringify({ login: 'erin', id: 8 }), { headers: { 'x-oauth-client-id': 'ours' } });
  try {
    assert.equal((await githubUser(token, 'ours')).login, 'erin');
    assert.equal(await githubUser(token, 'another-app'), null);
    assert.equal((await githubUser(token)).login, 'erin'); // no app named (the app checking its own sign-in): any token
    globalThis.fetch = async () => new Response(JSON.stringify({ login: 'erin', id: 8 })); // a personal token: no app at all
    assert.equal(await githubUser(token, 'ours'), null);
  } finally { globalThis.fetch = real; }
});

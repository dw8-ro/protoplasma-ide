// Teams hosted on someone's Mac, reached over the local network: encrypted, pinned to the hub's certificate, and signed
// in to with a pass from the online hub, never the GitHub token. GitHub identity is faked: "tok-<name>" is <name>.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const WebSocket = require('ws');
const { startHub, signPass, readPass } = require('../src/hub');
const { startLane } = require('../src/lane');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-lan-'));
const verifyUser = async token => {
  const login = /^tok-(\w+)$/.exec(token)?.[1];
  return login ? { login, id: login.length, name: login, avatar: '' } : null;
};
const githubAsked = []; // tokens that reached a Mac's hub's GitHub check: there should be none
const sleep = ms => new Promise(r => setTimeout(r, ms));
const as = login => ({ token: `tok-${login}`, user: { login, name: login } });
const alice = as('alice'), bob = as('bob'), mallory = as('mallory');

let online, teams, aliceHub, aliceUrl, aliceCert, malloryHub, malloryUrl, malloryCert;
const macHub = async (owner, dir, teamsJson) => {
  const cert = teams.hubCert(path.join(tmp, dir));
  if (teamsJson) fs.writeFileSync(path.join(tmp, dir, 'teams.json'), JSON.stringify(teamsJson));
  const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: path.join(tmp, dir), owners: [owner], tls: cert, passIssuer: online.url,
    verifyUser: async token => { githubAsked.push(token); return verifyUser(token); } });
  return { hub, url: `https://127.0.0.1:${hub.port}`, cert: String(cert.cert) };
};
// A request with whatever token and pinned certificate the test chooses.
const raw = (url, token, ca, method = 'GET', route = '/teams') => new Promise((resolve, reject) => {
  https.request(`${url}${route}`, { method, ca, checkServerIdentity: () => undefined, headers: { authorization: `Bearer ${token}` } }, r => {
    let text = '';
    r.on('data', d => { text += d; }).on('end', () => resolve({ status: r.statusCode, text }));
  }).on('error', reject).end();
});

before(async () => {
  const hub = await startHub({ port: 0, host: '127.0.0.1', dataDir: path.join(tmp, 'online'), verifyUser });
  online = { hub, url: `http://127.0.0.1:${hub.port}` };
  process.env.PROTO_ONLINE_HUB = online.url; // read by teams.js when it loads
  teams = require('../app/teams');
  ({ hub: aliceHub, url: aliceUrl, cert: aliceCert } = await macHub('alice', 'alice-mac'));
  // A look-alike: its own certificate, registered by its own owner, claiming a team of Alice's that Bob is on.
  ({ hub: malloryHub, url: malloryUrl, cert: malloryCert } = await macHub('mallory', 'mallory-mac',
    [{ id: 'fake', name: 'Garage', owner: 'alice', members: ['bob'], memories: [], sessions: [] }]));
});

after(async () => {
  await Promise.all([online.hub.close(), aliceHub.close(), malloryHub.close()]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a hub on another Mac is only signed in to with a pass, once its owner registered it', async () => {
  await assert.rejects(teams.access(bob, aliceUrl), /isn't registered with the online hub/);
  await teams.hubApi(alice, online.url, 'POST', '/hubs', { fp: aliceHub.fingerprint });
  await teams.hubApi(mallory, online.url, 'POST', '/hubs', { fp: malloryHub.fingerprint });

  const garage = await teams.hubApi(alice, aliceUrl, 'POST', '/teams', { name: 'Garage' });
  await teams.hubApi(alice, aliceUrl, 'POST', `/teams/${garage.id}/members`, { login: 'bob' });
  assert.deepEqual((await teams.teamsAt(bob, aliceUrl)).map(t => t.name), ['Garage']);
  const { token, ca, owners } = await teams.access(bob, aliceUrl);
  assert.match(token, /^p1\./);
  assert.equal(ca, aliceCert, 'pinned to the certificate the hub presented');
  assert.deepEqual(owners, ['alice'], 'the online hub says whose hub it is');
  assert.deepEqual(githubAsked, [], 'no GitHub token ever reached a hub on a Mac');
});

test('a pass is good only at the hub it was issued for, and only as issued', async () => {
  const forMallory = (await teams.access(bob, malloryUrl)).token;
  assert.equal((await raw(aliceUrl, forMallory, aliceCert)).status, 401, 'a pass for another hub');
  const forAlice = (await teams.access(bob, aliceUrl)).token;
  assert.equal((await raw(aliceUrl, forAlice, aliceCert)).status, 200);
  const [v, body, sig] = forAlice.split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), login: 'alice' })).toString('base64url');
  assert.equal((await raw(aliceUrl, `${v}.${changed}.${sig}`, aliceCert)).status, 401, 'a pass changed after signing');
  // A pass for a hub nobody registered isn't issued at all.
  await assert.rejects(teams.hubApi(bob, online.url, 'POST', '/passes', { aud: 'x'.repeat(43) }), /isn't registered/);
  // Expiry and audience, with a key of the test's own.
  const { privateKey, publicKey } = require('node:crypto').generateKeyPairSync('ed25519');
  const pass = signPass({ login: 'bob', name: 'Bob' }, 'hub-a', privateKey, Date.now() + 1000);
  assert.equal(readPass(pass, publicKey, 'hub-a')?.login, 'bob');
  assert.equal(readPass(pass, publicKey, 'hub-b'), null, 'another hub');
  assert.equal(readPass(pass, publicKey, 'hub-a', Date.now() + 2000), null, 'expired');
  assert.equal(readPass(pass, require('node:crypto').generateKeyPairSync('ed25519').publicKey, 'hub-a'), null, 'another issuer');
});

test('a hub only lists teams owned by whoever the online hub says runs it', async () => {
  // Mallory's hub claims Alice's team "Garage" with Bob on it; it's registered to Mallory, so it isn't listed.
  assert.equal((await raw(malloryUrl, (await teams.access(bob, malloryUrl)).token, malloryCert)).text.includes('Garage'), true);
  assert.deepEqual(await teams.teamsAt(bob, malloryUrl), []);
});

test('an agent connects to a hub on a Mac only through the certificate it pinned', async () => {
  const garage = (await teams.teamsAt(bob, aliceUrl))[0];
  const lanesOn = async () => {
    const { token } = await teams.access(alice, aliceUrl);
    const ws = new WebSocket(`${aliceUrl.replace('https', 'wss')}/watch`, { ca: aliceCert, checkServerIdentity: () => undefined });
    return new Promise((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', token, team: garage.id })));
      ws.on('message', m => { const msg = JSON.parse(m); if (msg.t === 'state') { ws.close(); resolve(msg.lanes); } });
      ws.on('error', reject);
    });
  };
  const start = ca => startLane({ hub: aliceUrl, team: garage.id, session: 'pinned', cmd: 'sh', args: ['-c', 'cat'],
    credentials: async () => ({ token: (await teams.access(bob, aliceUrl)).token, ca }) });
  const imposter = start(malloryCert), lane = start(aliceCert); // another hub's certificate: refused before anything is sent
  try {
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) { seen = (await lanesOn()).some(l => l.id === lane.id && l.login === 'bob'); if (!seen) await sleep(100); }
    assert.ok(seen, 'the agent joined, as Bob');
    assert.ok(!(await lanesOn()).some(l => l.id === imposter.id), 'the one pinned to another certificate didn\'t');
  } finally { imposter.term.kill(); lane.term.kill(); }
});

test('an agent only takes typing from the hub when it was started open', async () => {
  // A hub that types into every agent that connects, whatever it was told.
  const fake = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  fake.on('connection', ws => ws.on('message', raw => { if (JSON.parse(raw).t === 'hello') ws.send(JSON.stringify({ t: 'in', d: 'zz-typed\r' })); }));
  await new Promise(r => fake.on('listening', r));
  const hub = `http://127.0.0.1:${fake.address().port}`;
  const closed = startLane({ hub, team: 't', token: 'tok-bob', session: 's', cmd: 'sh', args: ['-c', 'cat'] });
  const opened = startLane({ hub, team: 't', token: 'tok-bob', session: 's', cmd: 'sh', args: ['-c', 'cat'], open: true });
  const typed = lane => { let out = ''; lane.term.onData(d => { out += d; }); return () => out; };
  const [closedOut, openOut] = [typed(closed), typed(opened)];
  await sleep(1000).finally(() => { closed.term.kill(); opened.term.kill(); fake.close(); });
  assert.ok(!closedOut().includes('zz-typed'), 'not typed into an agent that isn\'t open');
  assert.ok(openOut().includes('zz-typed'), 'typed into an open one');
});

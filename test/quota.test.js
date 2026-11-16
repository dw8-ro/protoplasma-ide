// On a hub that lets anyone create teams (no owners), each person owns a few at most; listed owners have no limit.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startHub } = require('../src/hub');

const verifyUser = async token => { const login = /^tok-(\w+)$/.exec(token)?.[1]; return login ? { login, name: login, avatar: '' } : null; };
const hubs = [];
after(() => Promise.all(hubs.map(h => h.close())));
const make = async (url, token, name) => {
  const res = await fetch(`${url}/teams`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) });
  return { status: res.status, body: await res.json() };
};

test('anyone may create teams on an open hub, up to three each', async () => {
  const hub = await startHub({ port: 0, host: '127.0.0.1', verifyUser });
  hubs.push(hub);
  const url = `http://127.0.0.1:${hub.port}`;
  for (const name of ['one', 'two', 'three']) assert.equal((await make(url, 'tok-carol', name)).status, 201, name);
  const fourth = await make(url, 'tok-carol', 'four');
  assert.equal(fourth.status, 403);
  assert.match(fourth.body.error, /already own 3 teams/);
  assert.equal((await make(url, 'tok-dave', 'his own')).status, 201, 'the limit is per person');
});

test('a hub with owners lets them create as many as they like', async () => {
  const hub = await startHub({ port: 0, host: '127.0.0.1', owners: ['erin'], verifyUser });
  hubs.push(hub);
  const url = `http://127.0.0.1:${hub.port}`;
  for (let i = 0; i < 5; i++) assert.equal((await make(url, 'tok-erin', `t${i}`)).status, 201);
  assert.equal((await make(url, 'tok-frank', 'nope')).status, 403, 'and nobody else any');
});

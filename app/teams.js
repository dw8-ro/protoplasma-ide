// Hub discovery, so users never deal with addresses:
// - Online: the hosted hub from config.json.
// - This Mac: an in-process hub, advertised over Bonjour.
// - Nearby: other teammates' hubs discovered over Bonjour. Only asked when the user turns it on: asking a hub means
//   showing it your GitHub sign-in, and anything on the network can claim to be one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { Bonjour } = require('bonjour-service');
const { startHub } = require('../src/hub');

const SERVICE = 'protoplasma';
// Made when first needed (hosting a team, or looking for teams), so macOS asks about the local network only then.
// A failed send (a Wi-Fi change, waking up) is logged; bonjour-service would otherwise throw in the main process.
let bonjour = null;
const mdns = () => (bonjour ||= new Bonjour({}, err => console.error(`Bonjour: ${err?.message || err}`)));
const nearby = new Map(); // Bonjour name -> { url, host }
let local;                // { url, name, hub } once this Mac hosts a hub
let hosting;              // the in-flight start, so concurrent callers share one hub

// bonjour-service writes the dots of a name ("alice on Mac.local") as dashes, so this Mac's own ad is recognised by both.
const isOwn = name => !!local && (name === local.name || name === local.name.replace(/\./g, '-'));
let browsing = false;
function browse() {
  if (browsing) return;
  browsing = true;
  mdns().find({ type: SERVICE }, svc => {
    const ip = svc.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (ip && !isOwn(svc.name)) nearby.set(svc.name, { url: `http://${ip}:${svc.port}`, host: svc.txt?.host || svc.name });
  }).on('down', svc => nearby.delete(svc.name));
}

const localDataDir = () => path.join(app.getPath('userData'), 'hub');
const hostsTeamsHere = () => {
  try { return JSON.parse(fs.readFileSync(path.join(localDataDir(), 'teams.json'), 'utf8')).length > 0; } catch { return false; }
};

/** Starts the in-process hub (once) and advertises it on the local network. */
function hostHere(user) {
  hosting ??= startHub({ port: 0, host: process.env.PROTO_BIND, dataDir: localDataDir(), owners: [user.login] }).then(hub => {
    local = { url: `http://127.0.0.1:${hub.port}`, name: `${user.login} on ${os.hostname()}`, hub };
    mdns().publish({ name: local.name, type: SERVICE, port: hub.port, txt: { host: user.name } });
    return local.url;
  }, err => { hosting = null; throw err; });
  return hosting;
}
/** Stops hosting (signing out): the next person to sign in on this Mac starts the hub as its owner. */
async function stopHosting() {
  const was = local;
  hosting = local = null;
  if (!was) return;
  await new Promise(resolve => { mdns().unpublishAll(resolve); setTimeout(resolve, 1000); });
  await was.hub.close();
}

async function hubApi(url, token, method, route, body) {
  // The online hub may be waking up, so it gets longer than a hub on this network.
  const res = await fetch(url + route, { method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(url.startsWith('https:') ? 15_000 : 5000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } })
    .catch(() => { throw new Error('Couldn\'t reach the team\'s hub. Check your connection and try again.'); });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(typeof data?.error === 'string' ? data.error : `The hub answered ${res.status}.`);
  return data;
}

/** Teams the user belongs to across all known hubs. Hubs that fail to respond are listed in `unreachable`. */
async function listTeams({ token, user }, onlineUrl, { nearby: lookNearby = false } = {}) {
  let localFailed = false;
  if (!local && hostsTeamsHere()) await hostHere(user).catch(() => { localFailed = true; }); // resume hosting saved local teams
  if (lookNearby) browse();
  const hubs = [
    onlineUrl && { url: onlineUrl, where: 'Online' },
    local && { url: local.url, where: 'This Mac' },
    ...(lookNearby ? [...nearby.values()].map(n => ({ url: n.url, where: `${n.host}'s Mac`, nearby: true })) : []),
  ].filter(Boolean);
  const results = await Promise.allSettled(hubs.map(h => hubApi(h.url, token, 'GET', '/teams')));
  // Only well-formed teams: a hub on the network could answer anything.
  const valid = t => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.owner === 'string' && Array.isArray(t.members);
  const answered = r => r.status === 'fulfilled' && Array.isArray(r.value);
  return {
    teams: results.flatMap((r, i) => (answered(r) ? r.value.filter(valid)
      .map(t => ({ ...t, members: t.members.filter(m => typeof m === 'string'), agents: t.agents | 0, hub: hubs[i].url, where: hubs[i].where, nearby: !!hubs[i].nearby })) : [])),
    unreachable: [...(localFailed ? ['This Mac'] : []), ...hubs.filter((_, i) => !answered(results[i])).map(h => h.where)],
  };
}

async function createTeam({ token, user }, onlineUrl, { name, online }) {
  if (online && !onlineUrl) throw new Error('No online hub is set up yet.');
  const url = online ? onlineUrl : await hostHere(user);
  return { ...await hubApi(url, token, 'POST', '/teams', { name }), hub: url, where: online ? 'Online' : 'This Mac' };
}

const invite = ({ token }, team, login) => hubApi(team.hub, token, 'POST', `/teams/${encodeURIComponent(team.id)}/members`, { login });
const removeMember = ({ token }, team, login) =>
  hubApi(team.hub, token, 'DELETE', `/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(login)}`);
const deleteTeam = ({ token }, team) => hubApi(team.hub, token, 'DELETE', `/teams/${encodeURIComponent(team.id)}`);

const addMemory = ({ token }, team, note) => hubApi(team.hub, token, 'POST', `/teams/${encodeURIComponent(team.id)}/memories`, note);
const removeMemory = ({ token }, team, id) =>
  hubApi(team.hub, token, 'DELETE', `/teams/${encodeURIComponent(team.id)}/memories/${encodeURIComponent(id)}`);

// "." and ".." would vanish from the URL (and ".." would point at the team itself), so they're never sent.
const sessionRoute = (team, name = '') => {
  if (/^\.+$/.test(name)) throw new Error('A session name needs a letter or a number.');
  return `/teams/${encodeURIComponent(team.id)}/sessions${name && `/${encodeURIComponent(name)}`}`;
};
const saveSession = ({ token }, team, session) => hubApi(team.hub, token, 'POST', sessionRoute(team), session);
const setSessionDone = ({ token }, team, name, done) => hubApi(team.hub, token, 'POST', sessionRoute(team, name), { done });
const renameSession = ({ token }, team, name, rename) => hubApi(team.hub, token, 'POST', sessionRoute(team, name), { rename });
const deleteSession = ({ token }, team, name) => hubApi(team.hub, token, 'DELETE', sessionRoute(team, name));
const commentRoute = (team, name, id = '') => `${sessionRoute(team, name)}/comments${id && `/${encodeURIComponent(id)}`}`;
const addComment = ({ token }, team, name, text, ref = {}) => hubApi(team.hub, token, 'POST', commentRoute(team, name), { text, ...ref });
const stepRoute = (team, name, id = '') => `${sessionRoute(team, name)}/steps${id && `/${encodeURIComponent(id)}`}`;
const addStep = ({ token }, team, name, step) => hubApi(team.hub, token, 'POST', stepRoute(team, name), step);
const updateStep = ({ token }, team, name, id, change) => hubApi(team.hub, token, 'POST', stepRoute(team, name, id), change);
const removeStep = ({ token }, team, name, id) => hubApi(team.hub, token, 'DELETE', stepRoute(team, name, id));
const removeComment = ({ token }, team, name, id) => hubApi(team.hub, token, 'DELETE', commentRoute(team, name, id));

// At quit: the goodbye goes out before the socket closes, so other Macs stop listing this one at once.
const stopAnnouncing = () => new Promise(resolve => {
  if (!bonjour) return resolve();
  let finished = false;
  const done = () => { if (finished) return; finished = true; bonjour.destroy(); resolve(); };
  bonjour.unpublishAll(done);
  setTimeout(done, 1000);
});

module.exports = { listTeams, stopHosting, createTeam, invite, removeMember, deleteTeam, addMemory, removeMemory, saveSession, setSessionDone, renameSession, deleteSession, addComment, removeComment, addStep, updateStep, removeStep, stopAnnouncing };

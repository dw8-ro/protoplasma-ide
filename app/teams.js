// Hub discovery, so users never deal with addresses:
// - Online: the hosted hub from config.json.
// - This Mac: an in-process hub, advertised over Bonjour.
// - Nearby: other teammates' hubs discovered over Bonjour.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { Bonjour } = require('bonjour-service');
const { startHub } = require('../src/hub');

const SERVICE = 'protoplasma';
const bonjour = new Bonjour();
const nearby = new Map(); // Bonjour name -> { url, host }
let local;                // { url, name } once this Mac hosts a hub
let hosting;              // the in-flight start, so concurrent callers share one hub

bonjour.find({ type: SERVICE }, svc => {
  const ip = svc.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  if (ip && svc.name !== local?.name) nearby.set(svc.name, { url: `http://${ip}:${svc.port}`, host: svc.txt?.host || svc.name });
}).on('down', svc => nearby.delete(svc.name));

const localDataDir = () => path.join(app.getPath('userData'), 'hub');
const hostsTeamsHere = () => {
  try { return JSON.parse(fs.readFileSync(path.join(localDataDir(), 'teams.json'), 'utf8')).length > 0; } catch { return false; }
};

/** Starts the in-process hub (once) and advertises it on the local network. */
function hostHere(user) {
  hosting ??= startHub({ port: 0, host: process.env.PROTO_BIND, dataDir: localDataDir(), owners: [user.login] }).then(hub => {
    local = { url: `http://127.0.0.1:${hub.port}`, name: `${user.login} on ${os.hostname()}` };
    bonjour.publish({ name: local.name, type: SERVICE, port: hub.port, txt: { host: user.name } });
    return local.url;
  }, err => { hosting = null; throw err; });
  return hosting;
}

async function hubApi(url, token, method, route, body) {
  const res = await fetch(url + route, { method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `The hub answered ${res.status}.`);
  return data;
}

/** Teams the user belongs to across all known hubs. Hubs that fail to respond are listed in `unreachable`. */
async function listTeams({ token, user }, onlineUrl) {
  if (!local && hostsTeamsHere()) await hostHere(user); // resume hosting saved local teams
  const hubs = [
    onlineUrl && { url: onlineUrl, where: 'Online' },
    local && { url: local.url, where: 'This Mac' },
    ...[...nearby.values()].map(n => ({ url: n.url, where: `${n.host}'s Mac` })),
  ].filter(Boolean);
  const results = await Promise.allSettled(hubs.map(h => hubApi(h.url, token, 'GET', '/teams')));
  return {
    teams: results.flatMap((r, i) => r.status === 'fulfilled' ? r.value.map(t => ({ ...t, hub: hubs[i].url, where: hubs[i].where })) : []),
    unreachable: hubs.filter((_, i) => results[i].status === 'rejected').map(h => h.where),
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

const sessionRoute = (team, name = '') => `/teams/${encodeURIComponent(team.id)}/sessions${name && `/${encodeURIComponent(name)}`}`;
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

const stopAnnouncing = () => { bonjour.unpublishAll(); bonjour.destroy(); };

module.exports = { listTeams, createTeam, invite, removeMember, deleteTeam, addMemory, removeMemory, saveSession, setSessionDone, renameSession, deleteSession, addComment, removeComment, addStep, updateStep, removeStep, stopAnnouncing };

// Hub discovery, so users never deal with addresses:
// - Online: the hosted hub from config.json.
// - This Mac: an in-process hub, advertised over Bonjour.
// - Nearby: other teammates' hubs discovered over Bonjour, only when the user turns it on.
// The GitHub token only ever goes to the online hub and to this Mac's own. A hub on another Mac is reached over TLS,
// pinned to the certificate it presented, and gets a pass instead (see signPass in src/hub.js): the online hub's word
// for who you are, good only at that one hub. The online hub also says whose hub it is, and only that person's teams are
// listed from it, so a look-alike on the network gets nothing it can use and can't pass for a teammate.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Bonjour } = require('bonjour-service');
const { startHub } = require('../src/hub');
const { fingerprint } = require('../src/shared');
const config = require('./config.json');

const onlineHub = process.env.PROTO_ONLINE_HUB ?? config.onlineHub;
const PASS_RENEW_MS = 60 * 60_000; // a pass this close to expiring is replaced before use

const SERVICE = 'protoplasma';
// Made when first needed (hosting a team, or looking for teams), so macOS asks about the local network only then.
// A failed send (a Wi-Fi change, waking up) is logged; bonjour-service would otherwise throw in the main process.
let bonjour = null;
const mdns = () => (bonjour ||= new Bonjour({}, err => console.error(`Bonjour: ${err?.message || err}`)));
const nearby = new Map(); // Bonjour name -> { url, host }
let local;                // { url, name, hub, pem, fp, registered } once this Mac hosts a hub
let hosting;              // the in-flight start, so concurrent callers share one hub

// bonjour-service writes the dots of a name ("alice on Mac.local") as dashes, so this Mac's own ad is recognised by both.
const isOwn = name => !!local && (name === local.name || name === local.name.replace(/\./g, '-'));
let browsing = false;
function browse() {
  if (browsing) return;
  browsing = true;
  mdns().find({ type: SERVICE }, svc => {
    const ip = svc.addresses?.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (ip && !isOwn(svc.name)) nearby.set(svc.name, { url: `https://${ip}:${svc.port}`, host: svc.txt?.host || svc.name });
  }).on('down', svc => nearby.delete(svc.name));
}

const localDataDir = () => path.join(require('electron').app.getPath('userData'), 'hub'); // loaded late: tests use this file
const hostsTeamsHere = () => {
  try { return JSON.parse(fs.readFileSync(path.join(localDataDir(), 'teams.json'), 'utf8')).length > 0; } catch { return false; }
};

/** This Mac's hub certificate, made once: self-signed, since the online hub vouches for it instead of a CA. */
function hubCert(dir) {
  const key = path.join(dir, 'tls-key.pem'), cert = path.join(dir, 'tls-cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    // The key is made here: macOS's openssl writes explicit curve parameters, which Electron's TLS refuses to load.
    fs.rmSync(key, { force: true });
    fs.writeFileSync(key, crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    try {
      execFileSync('/usr/bin/openssl', ['req', '-new', '-x509', '-key', key, '-sha256', '-days', '3650', '-subj', '/CN=Protoplasma hub', '-out', cert],
        { stdio: 'ignore', timeout: 20_000 });
    } catch { throw new Error('Couldn\'t make a certificate for this Mac\'s hub (macOS\'s openssl failed), so it can\'t host teams.'); }
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

/** Starts the in-process hub (once), registers its certificate with the online hub, and advertises it. */
function hostHere(s) {
  hosting ??= Promise.resolve().then(() => {
    const dir = localDataDir(), cert = hubCert(dir);
    // On this Mac alone until a team here has someone else on it (share), unless PROTO_BIND says where.
    return startHub({ port: 0, host: process.env.PROTO_BIND || '127.0.0.1', dataDir: dir, owners: [s.user.login], tls: cert, passIssuer: onlineHub })
      .then(hub => ({ hub, pem: String(cert.cert) }));
  }).then(({ hub, pem }) => {
    local = { url: `https://127.0.0.1:${hub.port}`, name: `${s.user.login} on ${os.hostname()}`, host: s.user.name, hub, pem, fp: hub.fingerprint,
      registered: null, shared: null };
    register(s);
    if (process.env.PROTO_BIND && !/^(127\.|::1$|localhost$)/.test(process.env.PROTO_BIND)) advertise(); // told where: already on the network
    return local.url;
  }, err => { hosting = null; throw err; });
  return hosting;
}
const advertise = () => mdns().publish({ name: local.name, type: SERVICE, port: local.hub.port, txt: { host: local.host } });
/**
 * Opens this Mac's hub to the network and advertises it, once one of its teams has someone besides the owner: until
 * then nobody else needs to reach it. ponytail: it stays open until the app restarts, even if everyone else leaves.
 */
function share() {
  const was = local;
  if (!was || was.shared || process.env.PROTO_BIND) return;
  was.shared = was.hub.listenOn('0.0.0.0').then(() => { if (local === was) advertise(); }, e => { was.shared = null; console.error(`Couldn't share this Mac's hub: ${e.message}`); });
}
// Teammates only get passes for a hub its owner registered. Tried again at each listing until it works (offline at start).
function register(s) {
  const was = local;
  if (!onlineHub || !was || was.registered) return;
  was.registered = hubApi(s, onlineHub, 'POST', '/hubs', { fp: was.fp }).catch(() => { was.registered = null; });
}
/** Stops hosting (signing out): the next person to sign in on this Mac starts the hub as its owner. */
async function stopHosting() {
  await hosting?.catch(() => {}); // a hub still starting is stopped too, not left running as the signed-out user's
  const was = local;
  hosting = local = null;
  passes.clear(); // the next person signs in as themselves

  if (!was) return;
  if (bonjour) await new Promise(resolve => { bonjour.unpublishAll(resolve); setTimeout(resolve, 1000); });
  await was.hub.close();
}

const unreachable = () => new Error('Couldn\'t reach the team\'s hub. Check your connection and try again.');
const pins = new Map();   // hub url -> { host, fp, pem }: the certificate a hub on another Mac presented
const passes = new Map(); // "<login> <fingerprint>" -> { pass, owners, expires } from the online hub

/** The certificate a hub on another Mac presents, read without trusting it: a pass for it is good at no other. */
const certOf = url => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(url);
  const sock = tls.connect({ host: hostname, port, rejectUnauthorized: false, timeout: 5000 }, () => {
    const cert = sock.getPeerX509Certificate();
    sock.destroy();
    if (cert) resolve({ host: hostname, fp: fingerprint(cert.raw), pem: cert.toString() }); else reject(unreachable());
  });
  sock.on('error', () => reject(unreachable())).on('timeout', () => sock.destroy(new Error('timed out')));
});

/**
 * How to sign in to the hub at `url`: `token` to send, plus `ca`, the one certificate it must present (this Mac's or
 * another Mac's hub), and for another Mac's hub `owners`, who the online hub says runs it.
 */
async function access(s, url) {
  if (url === onlineHub) return { token: s.token };
  if (local && url === local.url) return { token: s.token, ca: local.pem };
  if (!url.startsWith('https:')) throw new Error('That hub isn\'t encrypted, so Protoplasma won\'t sign in to it.');
  if (!onlineHub) throw new Error('Teams on other Macs are signed in to through the online hub, which isn\'t set up.');
  if (!pins.has(url)) pins.set(url, await certOf(url));
  const pin = pins.get(url), key = `${s.user.login} ${pin.fp}`;
  if (!(passes.get(key)?.expires - Date.now() > PASS_RENEW_MS)) {
    const got = await hubApi(s, onlineHub, 'POST', '/passes', { aud: pin.fp });
    if (typeof got?.pass !== 'string' || !Array.isArray(got.owners)) throw new Error('The online hub didn\'t give a pass for that hub.');
    passes.set(key, { pass: got.pass, owners: got.owners.map(o => String(o).toLowerCase()), expires: Number(got.expires) || 0 });
  }
  const { pass, owners } = passes.get(key);
  return { token: pass, ca: pin.pem, owners };
}

/**
 * Where Claude Code sends its hooks when its hub is on a Mac: an http address on 127.0.0.1 that passes each hook on to
 * the hub, pinned to the certificate that hub presented. Claude Code can't pin a self-signed certificate itself, so
 * without this every hook to such a hub fails (and fails open). `hubFor(laneId)` resolves to { url, ca } for one of this
 * Mac's agents, or to nothing. The relay adds no credentials: a hook still carries only its own agent's secret.
 */
let relaying = null, relayTo = () => null;
function hookRelay(hubFor) {
  relayTo = hubFor;
  relaying ??= new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const id = /^\/hooks\/([\w-]{1,64})$/.exec(req.url)?.[1];
      const to = id && req.method === 'POST' ? await Promise.resolve(relayTo(id)).catch(() => null) : null;
      if (!to) return res.writeHead(404).end();
      // Claude Code waits 3 s for a hook, so the hub gets a little less.
      const out = https.request(`${to.url}/hooks/${id}`, { method: 'POST', ca: to.ca, checkServerIdentity: () => undefined,
        signal: AbortSignal.timeout(2500), headers: { authorization: String(req.headers.authorization || ''), 'content-type': 'application/json' } }, r => {
        res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json' });
        r.pipe(res);
      });
      out.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
      req.pipe(out);
    });
    server.on('error', reject).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    server.unref();
  });
  return relaying;
}

/** Whether `pem` is the certificate of a hub this app signs in to at `hostname`. Chromium asks, for the hub socket. */
function isPinned(hostname, pem) {
  let fp;
  try { fp = fingerprint(new crypto.X509Certificate(pem).raw); } catch { return false; }
  return [...pins.values(), ...(local ? [{ host: '127.0.0.1', fp: local.fp }] : [])].some(p => p.host === hostname && p.fp === fp);
}

async function hubApi(s, url, method, route, body) {
  const { token, ca } = await access(s, url);
  // A kept-alive connection the hub has just closed (this Mac's hub moving to the network at an invite closes its idle
  // ones) fails at once; the request never reached the hub, so it's sent again on a new connection.
  const send = () => new Promise((resolve, reject) => {
    const target = new URL(url + route);
    // The online hub may be waking up, so it gets longer than a hub on this network.
    const req = (target.protocol === 'https:' ? https : http).request(target, { method, signal: AbortSignal.timeout(url === onlineHub ? 15_000 : 5000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(ca && { ca, checkServerIdentity: () => undefined }) }, r => {
      let text = '';
      // A hub on the network could answer anything, at any length.
      r.setEncoding('utf8').on('data', d => { if ((text += d).length > 5e6) req.destroy(new Error('too long')); })
        .on('end', () => resolve({ status: r.statusCode, text })).on('error', reject);
    });
    req.on('error', e => reject(Object.assign(e, { retry: req.reusedSocket && e.code === 'ECONNRESET' }))).end(body && JSON.stringify(body));
  });
  const res = await send().catch(e => (e.retry ? send() : Promise.reject(e))).catch(() => {
    pins.delete(url); // a hub that came back with a new certificate is read again next time
    throw unreachable();
  });
  let data = null;
  try { data = JSON.parse(res.text); } catch {}
  if (res.status < 200 || res.status > 299) throw new Error(typeof data?.error === 'string' ? data.error : `The hub answered ${res.status}.`);
  return data;
}

/** Teams the user belongs to across all known hubs. Hubs that fail to respond are listed in `unreachable`. */
async function listTeams(s, { nearby: lookNearby = false } = {}) {
  let localFailed = false;
  if (!local && hostsTeamsHere()) await hostHere(s).catch(() => { localFailed = true; }); // resume hosting saved local teams
  register(s);
  if (lookNearby) browse();
  const hubs = [
    onlineHub && { url: onlineHub, where: 'Online' },
    local && { url: local.url, where: 'This Mac' },
    ...(lookNearby ? [...nearby.values()].map(n => ({ url: n.url, where: `${n.host}'s Mac`, nearby: true })) : []),
  ].filter(Boolean);
  const results = await Promise.allSettled(hubs.map(h => (h.nearby ? teamsAt(s, h.url) : hubApi(s, h.url, 'GET', '/teams'))));
  // Only well-formed teams: a hub on the network could answer anything.
  const valid = t => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.owner === 'string' && Array.isArray(t.members);
  const answered = r => r.status === 'fulfilled' && Array.isArray(r.value);
  if (local && results.some((r, i) => hubs[i].url === local.url && answered(r) && r.value.some(t => t?.members?.length))) share();
  return {
    teams: results.flatMap((r, i) => (answered(r) ? r.value.filter(valid)
      .map(t => ({ ...t, members: t.members.filter(m => typeof m === 'string'), agents: t.agents | 0, hub: hubs[i].url,
        where: hubs[i].nearby ? `${t.owner}'s Mac` : hubs[i].where, nearby: !!hubs[i].nearby })) : [])),
    unreachable: [...(localFailed ? ['This Mac'] : []), ...hubs.filter((_, i) => !answered(results[i])).map(h => h.where)],
  };
}

/** The teams a hub on another Mac lists, keeping only those owned by whoever the online hub says runs it. */
async function teamsAt(s, url) {
  const list = await hubApi(s, url, 'GET', '/teams');
  const { owners } = await access(s, url);
  return Array.isArray(list) ? list.filter(t => owners.includes(String(t?.owner).toLowerCase())) : list;
}

async function createTeam(s, { name, online }) {
  if (online && !onlineHub) throw new Error('No online hub is set up yet.');
  const url = online ? onlineHub : await hostHere(s);
  return { ...await hubApi(s, url, 'POST', '/teams', { name }), hub: url, where: online ? 'Online' : 'This Mac' };
}

const invite = async (s, team, { login, id }) => {
  const result = await hubApi(s, team.hub, 'POST', `/teams/${encodeURIComponent(team.id)}/members`, { login, id });
  if (local && team.hub === local.url) share(); // they'll need to reach it
  return result;
};
const removeMember = (s, team, login) =>
  hubApi(s, team.hub, 'DELETE', `/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(login)}`);
const deleteTeam = (s, team) => hubApi(s, team.hub, 'DELETE', `/teams/${encodeURIComponent(team.id)}`);

const addMemory = (s, team, note) => hubApi(s, team.hub, 'POST', `/teams/${encodeURIComponent(team.id)}/memories`, note);
const removeMemory = (s, team, id) =>
  hubApi(s, team.hub, 'DELETE', `/teams/${encodeURIComponent(team.id)}/memories/${encodeURIComponent(id)}`);

// "." and ".." would vanish from the URL (and ".." would point at the team itself), so they're never sent.
const sessionRoute = (team, name = '') => {
  if (/^\.+$/.test(name)) throw new Error('A session name needs a letter or a number.');
  return `/teams/${encodeURIComponent(team.id)}/sessions${name && `/${encodeURIComponent(name)}`}`;
};
const saveSession = (s, team, session) => hubApi(s, team.hub, 'POST', sessionRoute(team), session);
const setSessionDone = (s, team, name, done) => hubApi(s, team.hub, 'POST', sessionRoute(team, name), { done });
const renameSession = (s, team, name, rename) => hubApi(s, team.hub, 'POST', sessionRoute(team, name), { rename });
const deleteSession = (s, team, name) => hubApi(s, team.hub, 'DELETE', sessionRoute(team, name));
const commentRoute = (team, name, id = '') => `${sessionRoute(team, name)}/comments${id && `/${encodeURIComponent(id)}`}`;
const addComment = (s, team, name, text, ref = {}) => hubApi(s, team.hub, 'POST', commentRoute(team, name), { text, ...ref });
const stepRoute = (team, name, id = '') => `${sessionRoute(team, name)}/steps${id && `/${encodeURIComponent(id)}`}`;
const addStep = (s, team, name, step) => hubApi(s, team.hub, 'POST', stepRoute(team, name), step);
const updateStep = (s, team, name, id, change) => hubApi(s, team.hub, 'POST', stepRoute(team, name, id), change);
const removeStep = (s, team, name, id) => hubApi(s, team.hub, 'DELETE', stepRoute(team, name, id));
const removeComment = (s, team, name, id) => hubApi(s, team.hub, 'DELETE', commentRoute(team, name, id));

// At quit: the goodbye goes out before the socket closes, so other Macs stop listing this one at once.
const stopAnnouncing = () => new Promise(resolve => {
  if (!bonjour) return resolve();
  let finished = false;
  const done = () => { if (finished) return; finished = true; bonjour.destroy(); resolve(); };
  bonjour.unpublishAll(done);
  setTimeout(done, 1000);
});

module.exports = { onlineHub, access, hookRelay, isPinned, hubApi, hubCert, teamsAt, listTeams, stopHosting, createTeam, invite, removeMember, deleteTeam, addMemory, removeMemory, saveSession, setSessionDone, renameSession, deleteSession, addComment, removeComment, addStep, updateStep, removeStep, stopAnnouncing };

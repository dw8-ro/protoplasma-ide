// Coordination server. Hosts teams (an owner plus invited GitHub users), relays agent terminals to teammates,
// and answers Claude Code hooks with team context. It never runs agents or stores files; it does relay terminal output,
// prompts and (when their owner shares them) changed files, and keeps sessions, notes and comments.
// Protocol: see the README.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { SCROLLBACK, EDIT_TOOLS, appendScrollback, slug, fingerprint, laneIdOf } = require('./shared');

const HEARTBEAT_MS = 15_000;
const IDENTITY_TTL_MS = 2 * 60_000; // how long a verified GitHub token is trusted before GitHub is asked again
const MAX_CHANGED = 200; // uncommitted files a lane reports
const MAX_API_BODY = 64 * 1024;
const MAX_HOOK_BODY = 5 * 1024 * 1024;
const GITHUB_LOGIN = /^(?=.{1,39}$)[a-z\d](?:-?[a-z\d])*$/i; // letters, digits and single hyphens inside
const MAX_MEMORIES = 200;
const MAX_MEMORY = 500;
const MAX_SESSIONS = 200; // per team; the oldest finished ones are dropped first
const MAX_COMMENTS = 100; // per session; the oldest go first
const MAX_EARLY_BYTES = 1024 * 1024; // what a socket may send while its sign-in is checked
const MAX_STOPPED = 20; // stopped agents whose last screen is kept, per team (in memory only)
const MAX_COMMENT = 500;
const MAX_STEPS = 50;            // per session plan
const MAX_SHARED_FILE = 1_000_000; // a teammate's file passed through for viewing
const PROTECTED_BRANCHES = ['main', 'master'];
const MAX_BUFFERED = 16 * 1024 * 1024; // unsent bytes to one viewer before it's dropped as too slow
const MAX_CONTEXT_FILES = 15; // per teammate, in an agent's prompt context
const STATE_REFRESH_MS = 30_000; // rebroadcast at least this often so "last active" times stay fresh
const PASS_TTL_MS = 12 * 60 * 60_000; // how long a pass lasts; the app gets a new one well before then
const MAX_HUB_PRINTS = 5; // hub certificates kept per person (one per Mac they host teams on), newest first
const MAX_LANES = 30; // live agents per person per team
const MAX_LOOKUPS = 60; // a minute's GitHub checks of tokens the hub hasn't seen check out (made-up ones)
const KNOWN_MS = 24 * 60 * 60_000; // how long a token that checked out skips that limit
const GITHUB_TOKEN = /^(gh[opusr]_|github_pat_)\w{20,255}$|^[0-9a-f]{40}$/;

/** Resolves a GitHub token to its user. Only reads the public profile, so a token with no scopes works. */
async function githubUser(token) {
  if (!GITHUB_TOKEN.test(token)) return null; // not a GitHub token: no need to ask
  const res = await fetch('https://api.github.com/user', { signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'protoplasma' },
  });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}.`); // down or rate-limited: not a verdict on the token
  const u = await res.json();
  return { login: u.login, id: u.id, name: u.name || u.login, avatar: u.avatar_url };
}

/**
 * A pass: the online hub's word that its holder is a GitHub user, good only at the one hub whose certificate it names
 * (`aud`, a fingerprint) and only until it expires. Hubs on people's Macs get passes instead of GitHub tokens, so a
 * teammate's Mac, or anything on the network pretending to be one, never holds a sign-in that works anywhere else.
 * Signed with Ed25519: `p1.<payload>.<signature>`, both base64url.
 */
function signPass(user, aud, key, exp) {
  const body = Buffer.from(JSON.stringify({ login: user.login, id: user.id, name: String(user.name || '').slice(0, 100),
    avatar: String(user.avatar || '').slice(0, 200), aud, exp })).toString('base64url');
  return `p1.${body}.${crypto.sign(null, Buffer.from(`p1.${body}`), key).toString('base64url')}`;
}
/** Who a pass vouches for at the hub whose certificate fingerprint is `aud`, or null: forged, expired, or another hub's. */
function readPass(pass, key, aud, now = Date.now()) {
  const [v, body, sig, ...rest] = String(pass).split('.');
  if (v !== 'p1' || !body || !sig || rest.length) return null;
  let p;
  try {
    if (!crypto.verify(null, Buffer.from(`p1.${body}`), key, Buffer.from(sig, 'base64url'))) return null;
    p = JSON.parse(Buffer.from(body, 'base64url'));
  } catch { return null; }
  if (!aud || p?.aud !== aud || !(p.exp > now) || typeof p.login !== 'string' || !GITHUB_LOGIN.test(p.login)) return null;
  return { login: p.login, id: p.id, name: String(p.name || p.login), avatar: String(p.avatar || ''), until: p.exp };
}

/**
 * Starts a hub.
 * @param {object} [o]
 * @param {number} [o.port] 0 picks a free port
 * @param {string} [o.dataDir] where teams are saved; omit to keep them in memory
 * @param {string[]} [o.owners] GitHub logins allowed to create teams; omit to let anyone signed in
 * @param {(token: string) => Promise<{login: string, name: string, avatar: string} | null>} [o.verifyUser]
 * @param {{key: Buffer|string, cert: Buffer|string}} [o.tls] serve https/wss with this certificate (a hub on someone's Mac)
 * @param {string} [o.passIssuer] the online hub whose passes this hub accepts (needs `tls`: a pass names the certificate)
 * @returns {Promise<{ port: number, close: () => Promise<void>, listenOn: (host: string) => Promise<void>, fingerprint?: string }>}
 */
function startHub({ port = 7681, host = '0.0.0.0', dataDir, owners, tls, passIssuer, verifyUser = token => module.exports.githubUser(token) } = {}) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : ''); // a number or object sent where text belongs is nothing
  const onlyDots = name => /^\.+$/.test(name); // "." and ".." vanish from a URL, so a session can't be called that

  // ---- Teams (persisted) ----
  const teamsFile = dataDir && path.join(dataDir, 'teams.json');
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  let saved = [];
  try {
    saved = teamsFile && fs.existsSync(teamsFile) ? JSON.parse(fs.readFileSync(teamsFile, 'utf8')) : [];
    if (!Array.isArray(saved) || !saved.every(t => t && typeof t.id === 'string' && typeof t.owner === 'string')) throw new Error('not a list of teams');
  } catch (e) {
    // A damaged or unexpected file is kept aside for a person to look at; the hub starts empty rather than not at all.
    fs.renameSync(teamsFile, `${teamsFile}.bad-${Date.now()}`);
    console.error(`teams.json couldn't be read (${e.message}), so it was moved aside and the hub started empty.`);
    saved = [];
  }
  const list = v => (Array.isArray(v) ? v : []);
  const idsOf = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, id]) => Number.isSafeInteger(id))) : {});
  const teams = new Map(saved.map(t => [t.id, { ...t, members: list(t.members), memories: list(t.memories), sessions: list(t.sessions), ids: idsOf(t.ids) }]));
  // Written to a temporary file first, so a crash mid-write can't leave a half-written teams.json behind. A failed write
  // (full disk) is logged and retried on the next change; the teams stay in memory meanwhile.
  const saveTeams = () => {
    if (!teamsFile) return;
    try {
      fs.writeFileSync(`${teamsFile}.tmp`, JSON.stringify([...teams.values()], null, 2));
      fs.renameSync(`${teamsFile}.tmp`, teamsFile);
    } catch (e) { console.error(`Couldn't save teams: ${e.message}`); }
  };
  const hasLogin = (team, login) => same(team.owner, login) || team.members.some(m => same(m, login));
  // People are matched by GitHub's numeric id (`team.ids`, login in lower case -> id), not only by login: a login can be
  // renamed and then taken by someone else. A place's id is recorded the first time its person signs in (teams from
  // before ids, or an invite made while GitHub couldn't be asked). After that a login held by another id is refused,
  // and someone who renamed their account keeps their place under the new login.
  function onTeam(team, user) {
    if (user.id != null) {
      const mine = [team.owner, ...team.members].find(l => team.ids[l.toLowerCase()] === user.id);
      if (mine && !same(mine, user.login)) renamePerson(team, mine, user.login);
      if (mine) return true;
    }
    const place = [team.owner, ...team.members].find(l => same(l, user.login));
    if (!place) return false;
    const known = Object.hasOwn(team.ids, place.toLowerCase()) ? team.ids[place.toLowerCase()] : null; // a login like "constructor"
    if (known != null) return known === user.id; // the login is now someone else's
    if (user.id != null) { team.ids[place.toLowerCase()] = user.id; saveTeams(); }
    return true;
  }
  function renamePerson(team, from, to) {
    team.ids[to.toLowerCase()] = team.ids[from.toLowerCase()];
    delete team.ids[from.toLowerCase()];
    if (same(team.owner, from)) team.owner = to;
    // A stale place already under the new login goes: it can't be anyone else's now.
    team.members = team.members.map(m => (same(m, from) ? to : m)).filter((m, i, all) => !same(m, team.owner) && all.findIndex(x => same(x, m)) === i);
    saveTeams();
  }
  // "Fix Login" and "fix-login" would get the same branch and folder, so they're the same session.
  // A renamed session keeps its original key, which names its branch and folders; that key still finds it.
  const keyOf = x => x.key || slug(x.name);
  // A session answers to its name written any way, its original key, and names it had before a rename (running agents
  // keep the name they started with).
  const findSession = (team, name) => {
    const want = slug(name); // once per lookup, not once per session: slug() on a long name is the costly part
    return team.sessions.find(x => x.name === name)
      || team.sessions.find(x => slug(x.name) === want || keyOf(x) === want || (x.aliases || []).some(a => slug(a) === want));
  };
  // Past the cap the oldest finished session without running agents goes. If there's none, the team is full: the API
  // and agents' hellos refuse new sessions then (agents joining an existing one still get theirs).
  const running = (team, x) => teamLanes(team.id).some(l => l.session === x.name);
  const full = team => team.sessions.length >= MAX_SESSIONS && !team.sessions.some(x => x.done && !running(team, x));
  function ensureSession(team, name, login, task = '') {
    let session = findSession(team, name);
    if (!session) {
      session = { name, task, createdBy: login, createdAt: new Date().toISOString(), done: false };
      team.sessions.push(session);
      while (team.sessions.length > MAX_SESSIONS) {
        const drop = team.sessions.findIndex(x => x.done && !running(team, x));
        if (drop === -1) break;
        team.sessions.splice(drop, 1);
      }
    }
    return session;
  }

  // ---- Passes: checking them (a hub on someone's Mac) ----
  const ownPrint = tls && fingerprint(new crypto.X509Certificate(tls.cert).raw);
  // The issuer's public key, fetched when first needed, and again (at most once a minute) when a pass doesn't check out
  // against it: the online hub may have a new key.
  let issuerKey = null, keyAsked = 0;
  async function passUser(pass) {
    if (!ownPrint || !passIssuer) return null;
    for (const again of [false, true]) {
      if (again && Date.now() - keyAsked < 60_000) break;
      if (!issuerKey || again) {
        keyAsked = Date.now();
        const res = await fetch(`${passIssuer}/passes/key`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`The online hub answered ${res.status}.`); // down: not a verdict on the pass
        issuerKey = crypto.createPublicKey({ key: Buffer.from(String((await res.json()).key), 'base64url'), format: 'der', type: 'spki' });
      }
      const user = readPass(pass, issuerKey, ownPrint);
      if (user) return user;
    }
    return null;
  }

  // ---- Passes: issuing them (the online hub) ----
  // Each person's app registers the certificate of the hub it runs (POST /hubs). A pass is only issued for a registered
  // hub, and the app asking for it learns whose hub that is, so a look-alike on the network can't pass itself off as a
  // teammate's.
  const hubsFile = dataDir && path.join(dataDir, 'hubs.json');
  let hubPrints = {}; // login (lower case) -> certificate fingerprints, newest first
  try {
    const read = hubsFile && fs.existsSync(hubsFile) ? JSON.parse(fs.readFileSync(hubsFile, 'utf8')) : {};
    if (read && typeof read === 'object' && Object.values(read).every(v => Array.isArray(v) && v.every(p => typeof p === 'string'))) hubPrints = read;
  } catch {} // a damaged file only means owners register their hubs again, which their apps do on their own
  const saveHubs = () => {
    if (!hubsFile) return;
    try {
      fs.writeFileSync(`${hubsFile}.tmp`, JSON.stringify(hubPrints));
      fs.renameSync(`${hubsFile}.tmp`, hubsFile);
    } catch (e) { console.error(`Couldn't save hubs: ${e.message}`); }
  };
  let passKey = null; // made when first needed, so a hub that never issues passes has no key
  function issuingKey() {
    if (passKey) return passKey;
    const file = dataDir && path.join(dataDir, 'pass-key.pem');
    if (file && fs.existsSync(file)) return (passKey = crypto.createPrivateKey(fs.readFileSync(file)));
    passKey = crypto.generateKeyPairSync('ed25519').privateKey;
    if (file) fs.writeFileSync(file, passKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    return passKey;
  }

  // ---- Identity (GitHub tokens and passes, cached by hash) ----
  const identities = new Map(); // sha256(token) -> { user, expires }; a rejected token is remembered briefly too
  const lookups = new Map();    // sha256(token) -> the GitHub lookup under way, shared by everyone presenting it
  // Every new GitHub-shaped token is a request to GitHub, so made-up ones could make the hub hammer it. At most
  // MAX_LOOKUPS a minute are made for tokens that haven't checked out before; past that they're answered like a GitHub
  // outage (try again soon). Tokens that checked out in the last day skip the budget, across restarts too (their hashes
  // are kept in known.json), and no address is trusted, so none can be forged.
  // ponytail: one budget for the whole hub, so during a flood new sign-ins (and anyone away for a day) wait; per-address
  // budgets (X-Real-IP behind Railway) if that happens.
  const knownFile = dataDir && path.join(dataDir, 'known.json');
  let known; // sha256(token) -> until when it skips the budget
  try { known = new Map(Object.entries(knownFile && fs.existsSync(knownFile) ? JSON.parse(fs.readFileSync(knownFile, 'utf8')) : {}).filter(([, until]) => until > Date.now())); } catch { known = new Map(); }
  const saveKnown = () => {
    if (!knownFile) return;
    try {
      fs.writeFileSync(`${knownFile}.tmp`, JSON.stringify(Object.fromEntries(known)));
      fs.renameSync(`${knownFile}.tmp`, knownFile);
    } catch (e) { console.error(`Couldn't save known sign-ins: ${e.message}`); }
  };
  let asked = { n: 0, since: 0 };
  async function identify(token) {
    if (typeof token !== 'string' || !token || token.length > 2000) return null;
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const hit = identities.get(key);
    if (hit?.expires > Date.now()) return hit.user;
    if (!lookups.has(key)) {
      if (GITHUB_TOKEN.test(token) && !(known.get(key) > Date.now())) { // counted before the wait, so parallel ones count too
        if (Date.now() - asked.since > 60_000) asked = { n: 0, since: Date.now() };
        if (++asked.n > MAX_LOOKUPS) throw new Error('Too many new sign-ins at once.');
      }
      const check = () => (token.startsWith('p1.') ? passUser(token) : verifyUser(token));
      lookups.set(key, Promise.resolve().then(check).finally(() => lookups.delete(key)));
    }
    const user = await lookups.get(key); // throws when GitHub (or, for a pass, the online hub) couldn't be asked
    identities.set(key, { user, expires: Math.min(Date.now() + (user ? IDENTITY_TTL_MS : 10_000), user?.until ?? Infinity) });
    if (user && GITHUB_TOKEN.test(token)) {
      const was = known.get(key);
      known.set(key, Date.now() + KNOWN_MS);
      if (!(was > Date.now() + KNOWN_MS - 60 * 60_000)) saveKnown(); // new, or last saved over an hour ago
    }
    return user;
  }

  // ---- Live state ----
  const stopped = new Map();  // team id -> recently stopped agents, newest first, with the last of their output
  const stoppedViews = teamId => (stopped.get(teamId) || []).map(({ id, session, login, name, avatar, cmd, cols, rows, endedAt }) => ({ id, session, login, name, avatar, cmd, cols, rows, endedAt }));
  const lanes = new Map();    // id -> { id, team, login, name, avatar, session, cmd, root, repo, branch, cols, rows, open, status, lastActive, files: Set, history, hookSecret, ws }
  const watchers = new Set(); // app windows: ws.team, ws.login, ws.user, ws.session
  const teamLanes = teamId => [...lanes.values()].filter(l => l.team === teamId);
  // Which codebase a lane works in: its GitHub repo, or its own checkout when the folder has no GitHub remote.
  const repoKey = l => (l.repo || l.tree).toLowerCase();
  const inSameRepo = lane => teamLanes(lane.team).filter(o => o !== lane && repoKey(o) === repoKey(lane));
  // Files a lane has touched: edits Claude reported through its hooks, plus whatever its checkout has that main doesn't
  // (which also covers shell commands, Codex, OpenCode and people).
  const filesOf = l => new Set([...l.files, ...l.changed]);
  // What another lane has touched, as `lane` should see it. A lane in the same folder only counts for the edits it made
  // itself, since that folder's changes could just as well be `lane`'s own. Checkouts of the same branch share its
  // pushed commits, so between them only what isn't pushed yet counts.
  // (An agent's own edits come first: they're the freshest, and the list an agent is told about is cut at 15.)
  const touchedBy = (o, lane) => (o.tree === lane.tree ? o.files
    : o.branch && o.branch === lane.branch ? new Set([...[...o.files].filter(f => !o.changed.has(f)), ...o.local]) : filesOf(o));
  const notesFor = (lane, file = '') => teams.get(lane.team).memories.filter(m => m.file === file && (!m.repo || same(m.repo, lane.repo)));
  function views(teamId) {
    const ls = teamLanes(teamId);
    // An overlap is a file both of two checkouts of the same repo have changed, as each sees the other (touchedBy).
    const overlaps = l => [...filesOf(l)].filter(f => ls.some(o => o.tree !== l.tree && repoKey(o) === repoKey(l)
      && touchedBy(o, l).has(f) && touchedBy(l, o).has(f)));
    return ls.map(l => ({ id: l.id, login: l.login, name: l.name, avatar: l.avatar, session: l.session, cmd: l.cmd, repo: l.repo, branch: l.branch,
      git: l.git, tree: l.tree, cols: l.cols, rows: l.rows, open: l.open, status: l.status, lastActive: l.lastActive, prompt: l.prompt || '',
      typedBy: l.typedBy || '', typedAt: l.typedAt || null, startedAt: l.startedAt, local: [...l.local],
      files: [...filesOf(l)], overlaps: overlaps(l) }));
  }
  const toTeam = (teamId, msg) => {
    const data = JSON.stringify(msg);
    for (const w of watchers) {
      if (w.team !== teamId || w.readyState !== w.OPEN) continue;
      if (w.bufferedAmount > MAX_BUFFERED) w.terminate();
      else w.send(data);
    }
  };
  // One entry per person and session they're viewing.
  const presence = teamId => [...new Map([...watchers].filter(w => w.team === teamId)
    .map(w => [`${w.login}|${w.session}`, { ...w.user, session: w.session }])).values()];
  const lastBroadcast = new Map(); // team id -> time of the last state broadcast
  const broadcastState = teamId => {
    lastBroadcast.set(teamId, Date.now());
    const team = teams.get(teamId);
    toTeam(teamId, { t: 'state', lanes: views(teamId), watchers: presence(teamId), members: team?.members || [], memories: team?.memories || [], sessions: team?.sessions || [], stopped: stoppedViews(teamId) });
  };
  const teamView = t => ({ id: t.id, name: t.name, owner: t.owner, members: t.members, agents: teamLanes(t.id).length });

  // ---- Claude Code hooks ----
  const notes = list => list.map(m => `- ${m.text} (${m.author})`).join('\n');
  function teamContext(lane) {
    const others = inSameRepo(lane);
    const general = notesFor(lane);
    const record = findSession(teams.get(lane.team), lane.session);
    const goal = record?.task;
    const parts = goal ? [`You're working in the Protoplasma session "${lane.session}". Its goal: ${goal}`] : [];
    if (record?.steps?.length) {
      parts.push(['The session\'s plan (from Protoplasma; teammates tick steps off in the app):',
        ...record.steps.map(s => `- [${s.done ? 'x' : ' '}] ${s.text}${s.owner ? ` (${s.owner})` : ''}`)].join('\n'));
    }
    if (others.length) {
      parts.push(['Other agents working in this repo right now (from Protoplasma):',
        ...others.map(o => { const files = [...touchedBy(o, lane)], more = files.length - MAX_CONTEXT_FILES;
          return `- ${same(o.login, lane.login) ? 'Your own' : `${o.name}'s`} ${o.cmd} agent, session "${o.session}", ${o.status}`
            + (files.length ? `, has changed: ${files.slice(0, MAX_CONTEXT_FILES).join(', ')}${more > 0 ? ` and ${more} more` : ''}` : ''); }),
        'Check with the user before editing files another agent has edited.'].join('\n'));
    }
    if (general.length) parts.push(`Team notes for this repo (from Protoplasma):\n${notes(general)}`);
    if (lane.git?.behind) {
      parts.push(`Your branch "${lane.branch}" is ${lane.git.behind} commit${lane.git.behind === 1 ? '' : 's'} behind: main or its pushed copy has ` +
        'commits it doesn\'t (from Protoplasma). Pull or rebase before making more changes, and before pushing.');
    }
    return parts.join('\n\n') || null;
  }

  // The commands in a piece of shell text: split at ; | & and line ends outside quotes, with # comments and heredoc
  // bodies left out (a commit message that mentions a push is not a push).
  function partsOf(text) {
    const parts = [];
    let cur = '', quote = null, heredoc = null;
    for (const line of text.split('\n')) {
      if (heredoc) { if (line.trim() === heredoc) heredoc = null; continue; }
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) { cur += c; if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
        if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
        if (c === '|' || c === ';' || c === '&') { parts.push(cur); cur = ''; continue; }
        // Not heredocs: a here-string (<<<word), and a shift inside arithmetic ($((1<<2)), (( n << 2 ))), kept as is.
        if (line.startsWith('<<<', i)) { cur += '<<<'; i += 2; continue; }
        const math = line.startsWith('((', i) && line.indexOf('))', i + 2);
        if (math > 0) { cur += line.slice(i, math + 2); i = math + 1; continue; }
        const doc = c === '<' && /^<<-?\s*(['"]?)(\w+)\1/.exec(line.slice(i));
        if (doc) { heredoc = doc[2]; i += doc[0].length - 1; cur += ' '; continue; }
        cur += c;
      }
      if (quote) cur += '\n'; else { parts.push(cur); cur = ''; }
    }
    parts.push(cur);
    return parts.filter(p => p.trim());
  }
  // A shell command as the commands it runs, plus what's inside quotes that something runs (bash -lc "...", eval,
  // ssh host "..."), $( ) and backticks, each read again on its own. Words keep quoted spaces together.
  const commandsIn = (command, wanted) => {
    // ponytail: the first 20,000 characters; a longer command is generated, and reading all of it would hold up the hub.
    const text = command.slice(0, 20_000).replace(/\\\r?\n/g, ' ').replace(/\d*>&\d+/g, ' '); // continuations, and 2>&1 (not an &)
    const runs = before => { const part = before.split(/[|;&\n]/).pop(); return /(^|\s)(-\w*c|eval)\s*$/.test(part) || /^\s*(sudo\s+)?ssh\s/.test(part); };
    const inner = [...text.matchAll(/"([^"]*)"|'([^']*)'|\$\(([^)]*)\)|`([^`]*)`/g)]
      .filter(m => m[3] !== undefined || m[4] !== undefined || runs(text.slice(0, m.index)))
      .map(m => m[1] ?? m[2] ?? m[3] ?? m[4]).filter(t => wanted.test(t));
    return [...partsOf(text), ...inner.flatMap(t => commandsIn(t, wanted))];
  };
  const wordsOf = text => (text.match(/(?:[^\s"']+|"[^"]*"|'[^']*'|["'])+/g) || []).map(w => w.replace(/^[$('"`]+|[)'"`]+$/g, '')).filter(Boolean);
  // Where git's subcommand is, after options like -C <dir> or -c <key=value>: `git -C repo push`, not `git commit -m "push"`.
  const VALUED = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source'];
  const subcommandAt = (words, at) => {
    let i = at + 1;
    while (i < words.length && words[i].startsWith('-')) i += VALUED.includes(words[i]) ? 2 : 1;
    return i;
  };
  const isGit = w => (w === 'git' || w.endsWith('/git')) && !w.includes('='); // not GIT_DIR=/srv/git
  // Why a `git push` needs a person's confirmation, or null if it's fine. Only applies when the team has other people.
  // ponytail: a reading of the words, not a shell parser; a script that pushes without saying so isn't caught.
  function pushRisk(lane, command) {
    if (!teams.get(lane.team).members.length) return null;
    let branch = lane.branch; // what HEAD is: switching earlier in the same command (git checkout main && git push) counts
    for (const part of commandsIn(command, /\bgit\b/)) {
      const words = wordsOf(part);
      // An inline alias that expands to a push hides it from the subcommand check: `git -c alias.p=push p origin main`.
      if (words.some((w, i) => w === '-c' && /^alias\.[^=]+=.*push/i.test(words[i + 1] || ''))) {
        return 'this runs git through an inline alias (-c alias.…), which can slip a push past the usual check. Confirm it\'s intended.';
      }
      for (let at = 0; at < words.length; at++) { // every git in it: sudo -u git git push, submodule foreach git push
        if (!isGit(words[at])) continue;
        const sub = subcommandAt(words, at), next = words.slice(sub + 1).find(w => !w.startsWith('-'));
        if (['checkout', 'switch'].includes(words[sub]) && next && !words.includes('--')) branch = next;
        const reason = words[sub] === 'push' && pushRiskOf(lane, words.slice(sub + 1), branch);
        if (reason) return reason;
      }
    }
    return null;
  }
  function pushRiskOf(lane, words, branch = lane.branch) {
    const shared = [...new Set([...PROTECTED_BRANCHES, lane.mainBranch].filter(Boolean))]; // main, master, and the repo's default
    const flags = words.filter(w => w.startsWith('-'));
    const refspecs = words.filter(w => !w.startsWith('-')).slice(1); // after the remote
    if (!refspecs.length && flags.includes('--tags')) return null; // only tags
    // --force-with-lease too: lanes fetch in the background, so the lease rarely protects a teammate's commits.
    if (flags.some(f => /^--force(-with-lease)?(=|$)/.test(f) || /^-[a-zA-Z]*f/.test(f)) || refspecs.some(r => r.startsWith('+'))) {
      return 'this force-push can overwrite commits your teammates pushed. Confirm it\'s intended.';
    }
    if (flags.some(f => f === '--all' || f === '--mirror')) {
      return `this pushes every branch, ${shared.join(' and ')} included, which your team shares. Push just your branch, or confirm.`;
    }
    // No refspec pushes the current branch; otherwise the part after ":" (or the name itself) is the destination.
    const deleting = flags.some(f => f === '--delete' || f === '-d');
    const targets = (refspecs.length ? refspecs : ['HEAD']).map(r => r.split(':').pop().replace(/^refs\/heads\//, '')).map(t => (t === 'HEAD' ? branch : t));
    const target = targets.find(t => shared.includes(t));
    if (deleting || refspecs.some(r => r.startsWith(':'))) {
      if (target) return `this deletes ${target} on the remote, which your team shares. Confirm it's intended.`;
      const theirs = inSameRepo(lane).filter(o => targets.includes(o.branch)), names = [...new Set(theirs.map(o => o.name))];
      if (names.length) return `this deletes ${theirs[0].branch} on the remote, which ${names.join(' and ')} also ${names.length === 1 ? 'works' : 'work'} on. Confirm it's intended.`;
      // Even a session branch: everyone in a session pushes to it, so deleting it can take a teammate's work with it.
      return `this deletes ${targets[0]} on the remote, and teammates may have pushed to it. Confirm it's intended.`;
    }
    return target ? `this pushes straight to ${target}, which your team shares. Push a branch and open a pull request instead, or confirm.` : null;
  }

  // Who else touched a file (or, for a folder, anything in it; '' is the whole checkout), as `lane` sees them.
  const othersOn = (lane, rel) => inSameRepo(lane).filter(o => [...touchedBy(o, lane)].some(f => !rel || f === rel || f.startsWith(`${rel}/`)));
  const whoOn = (lane, others) => [...new Map(others.map(o => [`${o.login}|${o.session}`, same(o.login, lane.login)
    ? `your agent in session "${o.session}"` : `${o.name} (session "${o.session}")`])).values()].join(', ');
  // The files and folders one shell command writes: redirect targets, what rm/mv/cp/tee/truncate act on, files edited in
  // place (sed -i, perl -i, formatters with --write/--fix/-w), download targets, and what git checkout/restore/reset/
  // stash/clean put back ('.' is everything; marked `here`: undoing work only matters to another agent in this same
  // folder). Commands that only read (node x.js 2>&1, cat x > /dev/null) write nothing.
  const FORMATTERS = ['prettier', 'eslint', 'gofmt', 'goimports', 'black', 'rustfmt', 'rubocop', 'stylelint', 'biome', 'ruff'];
  function writtenBy(words) {
    const out = [], plain = [], write = p => out.push({ path: p }), undo = p => out.push({ path: p, here: true });
    for (let i = 0; i < words.length; i++) {
      const redirect = /^\d*>>?(.*)$/.exec(words[i]);
      if (!redirect) { plain.push(words[i]); continue; }
      const target = redirect[1] || words[++i];
      if (target && !target.startsWith('&') && !target.startsWith('/dev/')) write(target);
    }
    while (plain.length && (/^\w+=/.test(plain[0]) || ['sudo', 'npx', 'command', 'xargs', 'env'].includes(plain[0]))) plain.shift();
    const cmd = (plain[0] || '').split('/').pop(), rest = plain.slice(1), args = rest.filter(w => !w.startsWith('-'));
    const after = flag => { const at = rest.findIndex(w => w === flag); return at >= 0 && rest[at + 1] ? [rest[at + 1]] : []; };
    if (['rm', 'mv', 'tee', 'truncate', 'shred', 'unlink', 'rmdir'].includes(cmd)) args.forEach(write);
    else if (['cp', 'install', 'ln', 'rsync'].includes(cmd) && args.length > 1) write(args.at(-1));
    else if ((cmd === 'sed' || cmd === 'perl') && rest.some(w => w.startsWith('--in-place') || /^-(?![Mm])[a-zA-Z]*i/.test(w))) args.slice(1).forEach(write); // the first is the script
    else if (FORMATTERS.includes(cmd) && rest.some(w => /^(--write|--fix|-w|--in-place|-i)$/.test(w))) args.forEach(write);
    else if (cmd === 'curl') [...after('-o'), ...after('--output')].forEach(write);
    else if (cmd === 'wget') after('-O').forEach(write);
    else if (cmd === 'dd') rest.filter(w => w.startsWith('of=')).forEach(w => write(w.slice(3)));
    else if (isGit(cmd)) {
      const at = subcommandAt(plain, 0), sub = plain[at], subArgs = plain.slice(at + 1).filter(w => !w.startsWith('-'));
      if (sub === 'checkout' || sub === 'restore') (plain.includes('--') ? plain.slice(plain.indexOf('--') + 1) : subArgs).forEach(undo);
      else if ((sub === 'reset' && plain.includes('--hard')) || (sub === 'stash' && !['list', 'show'].includes(subArgs[0])) || sub === 'clean') undo('.');
    }
    return out;
  }
  // A shell command that writes a file a teammate has changed (or a folder holding one).
  function shellWriteRisk(lane, command, cwd) {
    // ponytail: the first 300 written paths; a longer command is generated and not worth the hub's time.
    const targets = commandsIn(command, /./).flatMap(part => writtenBy(wordsOf(part))).slice(0, 300);
    for (const target of targets) {
      const full = path.resolve(cwd || lane.root, target.path);
      const root = lane.roots.find(r => full === r || full.startsWith(r + path.sep)) || lane.root;
      const rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // outside the checkout
      const others = othersOn(lane, rel).filter(o => !target.here || o.tree === lane.tree);
      if (others.length) return `${whoOn(lane, others)} already edited ${rel || 'files in this folder'}, and this command changes ${rel ? 'it' : 'them'}. Coordinate before running it.`;
    }
    return null;
  }

  // Within the limits a git report has, since every teammate's state and agent context carries these.
  const recordEdit = (lane, rel) => { if (rel.length <= 300 && lane.files.size < MAX_CHANGED) lane.files.add(rel); };

  // A JSON reply steers the agent; an empty one lets it continue.
  function onHook(lane, ev) {
    const file = ev.tool_input?.file_path || ev.tool_input?.notebook_path;
    const full = file && path.resolve(ev.cwd || lane.root, file);
    const root = full && (lane.roots.find(r => full === r || full.startsWith(r + path.sep)) || lane.root);
    const relative = full && path.relative(root, full);
    const rel = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null; // outside the checkout: not its file
    lane.lastActive = new Date().toISOString();
    switch (ev.hook_event_name) {
      case 'UserPromptSubmit': {
        lane.status = 'working';
        lane.prompt = str(ev.prompt, 300).replace(/\s+/g, ' ').trim(); // shown to the team beside the agent
        const ctx = teamContext(lane);
        return ctx && { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } };
      }
      case 'PreToolUse': {
        lane.status = 'working'; // also after a permission was answered: the agent has gone on to its next tool
        if (ev.tool_name === 'Bash') {
          const command = String(ev.tool_input?.command || '');
          const reason = pushRisk(lane, command) || shellWriteRisk(lane, command, ev.cwd);
          return reason && { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Protoplasma: ${reason}` } };
        }
        // Attach the file's team notes, and require confirmation if a teammate's agent already edited it.
        if (!rel) return null;
        const pinned = notesFor(lane, rel);
        const others = EDIT_TOOLS.includes(ev.tool_name) ? othersOn(lane, rel) : [];
        // An edit counts from here, so agents needn't send PostToolUse, which carries every tool's whole output. Not when
        // a person is asked first: they may say no (one they allow shows in the agent's next git report, as does any
        // edit refused later that isn't there).
        if (EDIT_TOOLS.includes(ev.tool_name) && !others.length) recordEdit(lane, rel);
        if (!pinned.length && !others.length) return null;
        const out = { hookEventName: 'PreToolUse' };
        if (pinned.length) out.additionalContext = `Team notes about ${rel} (from Protoplasma):\n${notes(pinned)}`;
        if (others.length) {
          Object.assign(out, { permissionDecision: 'ask', permissionDecisionReason: `Protoplasma: ${whoOn(lane, others)} already edited ${rel}. Coordinate before changing it.` });
        }
        return { hookSpecificOutput: out };
      }
      case 'PostToolUse': // from apps before 0.5.3, which still send it
        lane.status = 'working';
        if (rel && EDIT_TOOLS.includes(ev.tool_name)) recordEdit(lane, rel);
        return null;
      case 'PermissionRequest': lane.status = 'needs you'; return null;
      case 'Stop': lane.status = 'idle'; return null;
      default: return null;
    }
  }

  // ---- HTTP: team API and hooks ----
  const readBody = (req, max) => new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > max) { chunks.length = 0; req.pause(); reject(Object.assign(new Error('Too large.'), { status: 413 })); } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  const bearer = req => str(req.headers.authorization, 600).replace(/^Bearer /, '');
  const secretMatches = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  async function handle(req, res) {
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
    let parts;
    try { parts = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return json(400, { error: 'Bad address.' }); }
    const [resource, id, sub, subId, leaf, leafId, ...rest] = parts;
    // No real id or session name is this long (names are capped at 60 where they're made). A long one is only ever an
    // attempt to make slug()/findSession churn on the single-threaded hub, so it's refused before any of that runs.
    if (parts.some(p => p.length > 200)) return json(404, { error: 'Not found.' });
    if (rest.length || (leaf && !(sub === 'sessions' && ['comments', 'steps'].includes(leaf)))) return json(404, { error: 'Not found.' });
    if (!resource && req.method === 'GET') return json(200, { app: 'protoplasma-hub' });

    // Hook events from Claude Code, authenticated with the lane's own secret.
    if (resource === 'hooks' && id && !sub && req.method === 'POST') {
      const lane = lanes.get(id);
      if (!lane || !secretMatches(bearer(req), lane.hookSecret)) return json(401);
      const ev = parse(await readBody(req, MAX_HOOK_BODY));
      const snapshot = () => `${lane.status}|${lane.files.size}|${lane.prompt}`;
      const before = snapshot();
      const out = ev && onHook(lane, ev);
      if (snapshot() !== before || Date.now() - (lastBroadcast.get(lane.team) || 0) > STATE_REFRESH_MS) {
        broadcastState(lane.team);
      }
      return json(200, out || undefined);
    }

    // Only the online hub issues passes; a hub on someone's Mac (tls) only checks them.
    if (!tls && resource === 'passes' && id === 'key' && !sub && req.method === 'GET') {
      return json(200, { key: crypto.createPublicKey(issuingKey()).export({ type: 'spki', format: 'der' }).toString('base64url') });
    }
    if (!(tls ? ['teams'] : ['teams', 'passes', 'hubs']).includes(resource)) return json(404, { error: 'Not found.' });
    const user = await identify(bearer(req)).catch(e => { throw Object.assign(e, { github: true }); });
    if (!user) return json(401, { error: 'Sign in with GitHub first.' });
    const raw = req.method === 'POST' ? await readBody(req, MAX_API_BODY) : '';
    const body = raw.trim() ? parse(raw) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'That request wasn\'t valid JSON.' });

    // POST /hubs {fp}: "the hub on my Mac has this certificate". POST /passes {aud}: a pass for that hub.
    if (resource !== 'teams') {
      if (id || req.method !== 'POST') return json(404, { error: 'Not found.' });
      const print = str(resource === 'hubs' ? body.fp : body.aud, 100);
      if (!/^[\w-]{43}$/.test(print)) return json(400, { error: 'That isn\'t a hub certificate fingerprint.' });
      if (resource === 'hubs') {
        const login = user.login.toLowerCase();
        hubPrints[login] = [print, ...(Object.hasOwn(hubPrints, login) ? hubPrints[login] : []).filter(p => p !== print)].slice(0, MAX_HUB_PRINTS);
        saveHubs();
        return json(200, {});
      }
      const hubOwners = Object.keys(hubPrints).filter(login => hubPrints[login].includes(print));
      if (!hubOwners.length) return json(404, { error: 'That Mac\'s hub isn\'t registered with the online hub yet. Its owner\'s Protoplasma registers it when it\'s open and online.' });
      const expires = Date.now() + PASS_TTL_MS;
      return json(200, { pass: signPass(user, print, issuingKey(), expires), owners: hubOwners, expires });
    }

    if (!id && req.method === 'GET') return json(200, [...teams.values()].filter(t => onTeam(t, user)).map(teamView));
    if (!id && req.method === 'POST') {
      if (owners && !owners.some(o => same(o, user.login))) return json(403, { error: 'This hub only lets its owners create teams.' });
      const name = str(body.name, 60).trim();
      if (!name) return json(400, { error: 'Give the team a name.' });
      const team = { id: crypto.randomBytes(6).toString('base64url'), name, owner: user.login, members: [], memories: [], sessions: [],
        ids: user.id != null ? { [user.login.toLowerCase()]: user.id } : {} };
      teams.set(team.id, team);
      saveTeams();
      return json(201, teamView(team));
    }

    const team = teams.get(id);
    if (!team || !onTeam(team, user)) return json(404, { error: 'No such team.' });

    // Deleting a team is the owner's call, and only once nobody has an agent running in it.
    if (!sub && req.method === 'DELETE') {
      if (!same(team.owner, user.login)) return json(403, { error: 'Only the team owner can delete it.' });
      if (teamLanes(team.id).length) return json(409, { error: 'Stop the team\'s agents first.' });
      teams.delete(team.id);
      stopped.delete(team.id);
      saveTeams();
      for (const w of watchers) if (w.team === team.id) w.close(4003, 'This team was deleted.');
      return json(200, {});
    }

    // Shared memory: any member can add a note; only its author or the team owner can remove it.
    if (sub === 'memories') {
      if (!subId && req.method === 'POST') {
        const text = str(body.text, MAX_MEMORY).trim();
        const file = str(body.file, 300).trim().replace(/^\.?\//, '');
        if (!text) return json(400, { error: 'Write the note first.' });
        if (team.memories.length >= MAX_MEMORIES) return json(400, { error: `A team can keep ${MAX_MEMORIES} notes. Remove some first.` });
        const memory = { id: crypto.randomBytes(6).toString('base64url'), text, file, repo: str(body.repo, 200).trim(), author: user.login, at: new Date().toISOString() };
        team.memories.push(memory);
      } else if (subId && req.method === 'DELETE') {
        const memory = team.memories.find(m => m.id === subId);
        if (!memory) return json(404, { error: 'That note is already gone.' });
        if (!same(memory.author, user.login) && !same(team.owner, user.login)) return json(403, { error: 'Only its author or the team owner can remove a note.' });
        team.memories = team.memories.filter(m => m !== memory);
      } else return json(404, { error: 'Not found.' });
      saveTeams();
      broadcastState(team.id);
      return json(200, team.memories);
    }

    // Sessions: anyone on the team can start one; its creator or the team owner can finish or delete it.
    if (sub === 'sessions') {
      const running = name => teamLanes(team.id).some(l => l.session === name);
      // Comments are for the people in a session: anyone on the team adds one; its author or the team owner removes it.
      if (leaf === 'comments') {
        const session = findSession(team, subId);
        if (!session) return json(404, { error: 'No such session.' });
        session.comments ||= [];
        if (!leafId && req.method === 'POST') {
          const text = str(body.text, MAX_COMMENT).trim();
          if (!text) return json(400, { error: 'Write the comment first.' });
          const lineOf = v => Math.min(10_000_000, Math.max(0, Math.floor(Number(v)) || 0));
          const file = str(body.file, 300).trim(), line = lineOf(body.line), endLine = Math.max(line, lineOf(body.endLine));
          session.comments.push({ id: crypto.randomBytes(6).toString('base64url'), author: user.login, text, at: new Date().toISOString(),
            ...(file && line ? { file, line, endLine, snippet: str(body.snippet, 300) } : {}) });
          session.comments.splice(0, session.comments.length - MAX_COMMENTS);
        } else if (leafId && req.method === 'DELETE') {
          const comment = session.comments.find(c => c.id === leafId);
          if (!comment) return json(404, { error: 'That comment is already gone.' });
          if (!same(comment.author, user.login) && !same(team.owner, user.login)) return json(403, { error: 'Only its author or the team owner can remove a comment.' });
          session.comments = session.comments.filter(c => c !== comment);
        } else return json(404, { error: 'Not found.' });
        saveTeams();
        broadcastState(team.id);
        return json(200, team.sessions);
      }
      // A plan: steps anyone on the team adds, ticks off, gives an owner, or removes.
      if (leaf === 'steps') {
        const session = findSession(team, subId);
        if (!session) return json(404, { error: 'No such session.' });
        session.steps ||= [];
        const step = leafId && session.steps.find(s => s.id === leafId);
        if (leafId && !step) return json(404, { error: 'That step is gone.' });
        if (!leafId && req.method === 'POST') {
          const text = str(body.text, 200).trim();
          if (!text) return json(400, { error: 'Write the step first.' });
          if (session.steps.length >= MAX_STEPS) return json(400, { error: `A plan holds up to ${MAX_STEPS} steps.` });
          session.steps.push({ id: crypto.randomBytes(6).toString('base64url'), text, owner: str(body.owner, 40).replace(/^@/, ''), done: false });
        } else if (step && req.method === 'POST') {
          if (typeof body.done === 'boolean') Object.assign(step, { done: body.done, doneBy: body.done ? user.login : undefined });
          if (typeof body.text === 'string' && body.text.trim()) step.text = str(body.text, 200).trim();
          if (typeof body.owner === 'string') step.owner = str(body.owner, 40).replace(/^@/, '');
        } else if (step && req.method === 'DELETE') {
          session.steps = session.steps.filter(s => s !== step);
        } else return json(404, { error: 'Not found.' });
        saveTeams();
        broadcastState(team.id);
        return json(200, team.sessions);
      }
      if (!subId && req.method === 'POST') {
        const name = str(body.name, 60).trim();
        if (!name) return json(400, { error: 'Name the session.' });
        if (onlyDots(name)) return json(400, { error: 'A session name needs a letter or a number.' });
        const existed = findSession(team, name);
        if (!existed && full(team)) {
          return json(409, { error: `A team holds ${MAX_SESSIONS} sessions. Mark some done or delete them first.` });
        }
        const session = ensureSession(team, name, user.login);
        if (typeof body.task === 'string' && (!existed || same(session.createdBy, user.login) || same(team.owner, user.login))) session.task = str(body.task, 300).trim();
      } else if (subId) {
        const session = findSession(team, subId);
        if (!session) return json(404, { error: 'No such session.' });
        if (!same(session.createdBy, user.login) && !same(team.owner, user.login)) {
          return json(403, { error: 'Only whoever started the session, or the team owner, can change it.' });
        }
        if (req.method === 'POST' && typeof body.done === 'boolean') {
          session.done = body.done;
          session.doneAt = body.done ? new Date().toISOString() : undefined;
        } else if (req.method === 'POST' && typeof body.rename === 'string') {
          // Running agents move with it, and its old name keeps finding it (they rejoin under the name they started with).
          const name = str(body.rename, 60).trim();
          if (!name) return json(400, { error: 'Give the session a name.' });
          if (onlyDots(name)) return json(400, { error: 'A session name needs a letter or a number.' });
          const clash = team.sessions.find(x => x !== session && (x.name === name || slug(x.name) === slug(name) || keyOf(x) === slug(name)
            || (x.aliases || []).some(a => slug(a) === slug(name))));
          if (clash) return json(409, { error: `There's already a session called ${clash.name}.` });
          for (const s of stopped.get(team.id) || []) if (s.session === session.name) s.session = name;
          for (const l of teamLanes(team.id)) if (l.session === session.name) l.session = name;
          session.aliases = [...new Set([...(session.aliases || []), session.name])].slice(-50);
          session.key = keyOf(session); // its branch and folders keep the original name
          session.name = name;
        } else if (req.method === 'DELETE') {
          if (running(session.name)) return json(409, { error: 'Stop its agents first.' });
          team.sessions = team.sessions.filter(x => x !== session);
          stopped.set(team.id, (stopped.get(team.id) || []).filter(s => s.session !== session.name));
        } else return json(404, { error: 'Not found.' });
      } else return json(404, { error: 'Not found.' });
      saveTeams();
      broadcastState(team.id);
      return json(200, team.sessions);
    }

    // Members: the owner invites and removes people; anyone else can only remove themselves (leave).
    if (sub !== 'members') return json(404, { error: 'Not found.' });
    const leaving = subId && req.method === 'DELETE' && same(subId, user.login);
    if (!same(team.owner, user.login) && !leaving) return json(403, { error: 'Only the team owner can change who is on it.' });

    if (!subId && req.method === 'POST') {
      const login = str(body.login, 40).trim().replace(/^@/, '');
      if (!GITHUB_LOGIN.test(login)) return json(400, { error: 'That isn\'t a GitHub username.' });
      // The app looks the person up on GitHub first and sends their id; without one, it's recorded at their first sign-in.
      const id = Number.isSafeInteger(body.id) && body.id > 0 ? body.id : null;
      if (hasLogin(team, login) || (id && Object.values(team.ids).includes(id))) return json(409, { error: `${login} is already on the team.` });
      team.members.push(login);
      if (id) team.ids[login.toLowerCase()] = id;
      saveTeams();
      broadcastState(team.id); // everyone's People page shows them
      return json(200, teamView(team));
    }
    if (subId && req.method === 'DELETE') {
      if (same(subId, team.owner)) return json(400, { error: 'The owner can\'t leave. Delete the team instead.' });
      if (!team.members.some(m => same(m, subId))) return json(404, { error: `${subId} isn't on the team.` });
      team.members = team.members.filter(m => !same(m, subId));
      delete team.ids[subId.toLowerCase()];
      saveTeams();
      // Disconnect them now rather than on their next reconnect.
      for (const w of watchers) if (w.team === team.id && same(w.login, subId)) w.close(4003, 'Removed from the team.');
      for (const l of teamLanes(team.id)) if (same(l.login, subId)) l.ws.close(4003, 'Removed from the team.');
      broadcastState(team.id);
      return json(200, teamView(team));
    }
    return json(404, { error: 'Not found.' });
  }

  // GitHub being unreachable while checking a sign-in is a 503 (try again), not a 401 (sign in again).
  const onRequest = (req, res) => handle(req, res).catch(e => {
    if (res.headersSent) return;
    const [status, error] = e.status === 413 ? [413, 'That\'s too much at once.'] : e.github ? [503, 'The hub couldn\'t reach GitHub (or the online hub) to check who you are. Try again in a moment.'] : [500, 'The hub hit an error.'];
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({ error }));
  });
  // A hub on someone's Mac is reached over the local network, so everything to and from it is encrypted.
  const server = tls ? https.createServer({ key: tls.key, cert: tls.cert }, onRequest) : http.createServer(onRequest);
  server.headersTimeout = 15_000; // drop a client that dribbles its headers (slow-loris)
  server.requestTimeout = 30_000; // and one that holds a connection open with a slow body; requests here are small

  // ---- WebSockets: agents (/lane) and app windows (/watch) ----
  const gitStats = g => g && typeof g === 'object'
    ? { added: g.added | 0, removed: g.removed | 0, files: g.files | 0, behind: g.behind | 0, ahead: g.ahead | 0, unpushed: g.unpushed | 0 } : null;
  const changedFiles = g => new Set(Array.isArray(g?.changed) ? g.changed.slice(0, MAX_CHANGED).map(f => str(f, 300)).filter(Boolean) : []);
  const size = (v, min, max, fallback) => Math.min(max, Math.max(min, v | 0 || fallback)); // terminal cols and rows
  function onLane(ws, user, team, hello) {
    const existing = lanes.get(hello.id);
    // A recently stopped agent's id stays its owner's, so nobody else can take it while it reconnects (on any team: an id
    // taken on another would turn the agent away when it's back).
    const before = existing || [...stopped.values()].flat().find(s => s.id === hello.id);
    const name = str(hello.session, 60).trim();
    // An id made from the agent's hook secret (laneIdOf) is only ever its holder's, even after the hub restarts or
    // forgets a stopped agent. Older apps' random ids rely on `before` alone.
    if (typeof hello.id !== 'string' || !/^[\w-]{1,64}$/.test(hello.id) || typeof hello.hookSecret !== 'string' || hello.hookSecret.length < 16
      || (hello.id.startsWith('h-') && hello.id !== laneIdOf(hello.hookSecret))
      || !name || onlyDots(name) || (before && !same(before.login, user.login))) {
      return ws.close(4000, 'Bad hello.');
    }
    if (!findSession(team, name) && full(team)) return ws.close(4000, `This team holds ${MAX_SESSIONS} sessions. Mark some done or delete them first.`);
    // Every teammate's app keeps a terminal for each agent on the team, so one person can't start without limit.
    if (!existing && teamLanes(team.id).filter(l => same(l.login, user.login)).length >= MAX_LANES) {
      return ws.close(4000, `You have ${MAX_LANES} agents running in this team. Stop some first.`);
    }
    existing?.ws.terminate(); // the same agent reconnecting before its old connection timed out
    const lane = { id: hello.id, team: team.id, login: user.login, name: user.name, avatar: user.avatar,
      session: str(hello.session, 60).trim(), cmd: str(hello.cmd, 40), root: str(hello.root, 1000),
      repo: typeof hello.repo === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(hello.repo) ? hello.repo : '', // owner/name, as lane.js reads it from a remote
      branch: str(hello.git?.branch || hello.branch, 100),
      mainBranch: str(hello.git?.mainBranch, 100),
      roots: (Array.isArray(hello.roots) ? hello.roots.slice(0, 4) : []).map(r => str(r, 1000)).filter(Boolean),
      cols: size(hello.cols, 20, 500, 120), rows: size(hello.rows, 5, 200, 36), open: !!hello.open, status: str(hello.cmd, 40) === 'claude' ? 'idle' : 'running', lastActive: new Date().toISOString(), startedAt: before?.startedAt || new Date().toISOString(), files: new Set(), changed: changedFiles(hello.git), local: changedFiles(hello.git?.local ? { changed: hello.git.local } : hello.git),
      git: gitStats(hello.git), history: typeof hello.history === 'string' ? hello.history.slice(-SCROLLBACK) : '', hookSecret: hello.hookSecret, ws };
    // One per checkout: the same path on two of someone's Macs is two checkouts.
    lane.tree = crypto.createHash('sha256').update(`${lane.login}\n${str(hello.machine, 64)}\n${lane.root}`).digest('hex').slice(0, 12);
    // Back after a dropped connection: it's still doing what it was (its next hook or report updates it).
    if (before) Object.assign(lane, { status: before.status || lane.status, prompt: before.prompt, typedBy: before.typedBy, typedAt: before.typedAt,
      files: new Set([...(before.files || [])].filter(f => lane.changed.has(f))) });
    lanes.set(lane.id, lane);
    stopped.set(team.id, (stopped.get(team.id) || []).filter(s => s.id !== lane.id)); // it reconnected
    const session = ensureSession(team, lane.session, user.login);
    lane.session = session.name; // a differently written name joins the existing session
    if (session.done) { session.done = false; session.doneAt = undefined; }
    // So its pull requests and issues stay reachable after the agents stop. Only an agent of whoever started the session
    // (or the team owner) sets it: another teammate's can't pick the repo others' one-click "Add an agent" clones and
    // runs. `repoBy` says whose it was, so the app can tell one set before this rule (by anyone's agent) and ignore it.
    if (lane.repo && (same(session.createdBy, user.login) || same(team.owner, user.login))) Object.assign(session, { repo: lane.repo, repoBy: user.login });
    saveTeams();
    broadcastState(team.id);
    toTeam(team.id, { t: 'out', lane: lane.id, d: `\x1bc${lane.history}` }); // a reset first: watchers may hold its screen already

    ws.on('message', raw => {
      const m = parse(raw);
      if (m?.t === 'out' && typeof m.d === 'string') {
        lane.history = appendScrollback(lane.history, m.d);
        toTeam(team.id, { t: 'out', lane: lane.id, d: m.d });
      } else if (m?.t === 'size') {
        const was = `${lane.cols}x${lane.rows}`;
        lane.cols = size(m.cols, 20, 500, lane.cols);
        lane.rows = size(m.rows, 5, 200, lane.rows);
        if (`${lane.cols}x${lane.rows}` !== was) broadcastState(team.id);
      } else if (m?.t === 'git') {
        lane.git = gitStats(m);
        lane.changed = changedFiles(m);
        lane.local = Array.isArray(m.local) ? changedFiles({ changed: m.local }) : lane.changed;
        lane.files = new Set([...lane.files].filter(f => lane.changed.has(f))); // edits since committed to main, or undone, no longer count
        lane.branch = str(m.branch, 100) || lane.branch;
        lane.mainBranch = str(m.mainBranch, 100) || lane.mainBranch;
        broadcastState(team.id);
      } else if (m?.t === 'status' && ['needs you', 'idle', 'working'].includes(m.status)) { // trust prompts, and agents without hooks
        lane.status = m.status;
        lane.lastActive = new Date().toISOString();
        broadcastState(team.id);
      }
    });
    // A stopped agent's last screen stays viewable for a while, so teammates can see what it did.
    ws.on('close', () => {
      if (lanes.get(lane.id) !== lane) return;
      lanes.delete(lane.id);
      const { id, session, login, name, avatar, cmd, cols, rows, history, startedAt, status, prompt, typedBy, typedAt, files } = lane;
      const list = [{ id, session, login, name, avatar, cmd, cols, rows, history, endedAt: new Date().toISOString(), startedAt, status, prompt, typedBy, typedAt, files: [...files] },
        ...(stopped.get(team.id) || []).filter(s => s.id !== id)];
      stopped.set(team.id, list.slice(0, MAX_STOPPED));
      broadcastState(team.id);
    });
  }

  // A teammate's file, for viewing: the request goes to the app of whoever runs the agent, which answers only if they
  // share files (it's their setting) and only for files that agent's checkout has changed. Passed through, never kept.
  const fileAsks = new Map(); // request id -> { from: requester's socket, ask, owner: login, waiting: owner windows not yet answered, timer }
  const fileRate = new Map(); // login (lower case) -> { n, since }: file requests in the current minute
  function relayFile(ws, user, team, m) {
    if (m.t === 'file:get') {
      // Per person, whatever windows they open: a few at a time, and as many a minute as two windows following a file
      // (the code view asks every 1.5 s), so a teammate can't keep someone's Mac busy answering.
      const who = user.login.toLowerCase(), rate = fileRate.get(who);
      if (rate && Date.now() - rate.since < 60_000) rate.n++; else fileRate.set(who, { n: 1, since: Date.now() });
      if (fileRate.get(who).n > 120 || [...fileAsks.values()].filter(a => same(a.from.login, who)).length >= 4) {
        return send(ws, { t: 'file:put', ask: m.ask, error: 'Too many files asked for at once. Try again in a moment.' });
      }
      const found = lanes.get(m.lane), lane = found?.team === team.id ? found : null; // another team's agent is no agent here
      const req = crypto.randomBytes(8).toString('base64url');
      const owners = lane ? [...watchers].filter(w => w.team === team.id && same(w.login, lane.login)) : [];
      if (!owners.length) return send(ws, { t: 'file:put', ask: m.ask, error: lane ? `${lane.name}'s app isn't open.` : 'That agent has stopped.' });
      const timer = setTimeout(() => { if (fileAsks.delete(req)) send(ws, { t: 'file:put', ask: m.ask, error: `${lane.name}'s app didn't answer.` }); }, 10_000);
      timer.unref();
      fileAsks.set(req, { from: ws, ask: m.ask, owner: lane.login, waiting: new Set(owners), timer });
      for (const w of owners) send(w, { t: 'file:get', req, lane: lane.id, path: str(m.path, 300), from: user.name || user.login });
      return;
    }
    const ask = fileAsks.get(m.req);
    if (!ask || !same(ask.owner, user.login)) return; // only the agent's owner answers
    // An error from one of their windows waits only for their other windows that are still open (one may have the agent).
    ask.waiting.delete(ws);
    if (typeof m.text !== 'string' && [...ask.waiting].some(w => w.readyState === w.OPEN)) return;
    fileAsks.delete(m.req);
    clearTimeout(ask.timer);
    const text = typeof m.text === 'string' && m.text.length <= MAX_SHARED_FILE ? m.text : undefined;
    send(ask.from, { t: 'file:put', ask: ask.ask, text, error: text === undefined ? str(m.error || 'That file is too big to share.', 300) : undefined });
  }

  function onWatcher(ws, user, team) {
    Object.assign(ws, { team: team.id, login: user.login, user, session: null });
    watchers.add(ws);
    broadcastState(team.id); // doubles as the newcomer's first message
    for (const l of teamLanes(team.id)) send(ws, { t: 'out', lane: l.id, d: l.history });
    // A window drives look (switching session) and replay (opening a stopped agent) from clicks, so a handful a second is
    // plenty. Each look that changes session runs broadcastState (rebuild + a fan-out to every teammate), so a tight loop
    // of them would peg the single-threaded hub: they get a per-socket budget. file:get has its own (fileRate).
    let acts = 0, actsSince = Date.now();
    const flooding = () => { if (Date.now() - actsSince >= 1000) { acts = 0; actsSince = Date.now(); } return ++acts > 30; };
    ws.on('message', raw => {
      const m = parse(raw);
      if (m?.t === 'look') {
        if (flooding()) return;
        const session = typeof m.session === 'string' ? str(m.session, 60) : null;
        if (session !== ws.session) { ws.session = session; broadcastState(team.id); }
        return;
      }
      if (m?.t === 'replay') { // the last screen of a stopped agent
        if (flooding()) return;
        const agent = (stopped.get(team.id) || []).find(s => s.id === m.id);
        return agent && send(ws, { t: 'replay', id: agent.id, d: agent.history });
      }
      if (m?.t === 'file:get' || m?.t === 'file:put') return relayFile(ws, user, team, m);
      const lane = m?.t === 'in' && typeof m.d === 'string' && lanes.get(m.lane);
      if (!lane?.open || lane.team !== team.id) return; // only open lanes accept remote input
      send(lane.ws, { t: 'in', d: m.d });
      // The agent's owner sees who typed into it. Kept fresh without a broadcast for every keystroke.
      if (same(user.login, lane.login)) return;
      const quiet = !lane.typedAt || Date.now() - Date.parse(lane.typedAt) > 5000 || lane.typedBy !== user.name;
      Object.assign(lane, { typedBy: user.name || user.login, typedAt: new Date().toISOString() });
      if (quiet) broadcastState(team.id);
    });
    ws.on('close', () => { watchers.delete(ws); broadcastState(team.id); });
  }

  // The first message carries the token and team. Messages that arrive while it's being verified are queued and replayed.
  // Too much sent before then closes the socket (1013, so an agent reconnects and resends its screen in its hello)
  // rather than dropping some of it.
  function authenticate(ws, role) {
    const early = [];
    let first = true, earlyBytes = 0, checking = false;
    const timer = setTimeout(() => ws.close(checking ? 1013 : 4001, checking ? 'GitHub is slow to answer. Trying again.' : 'Sign-in timed out.'), 10_000);
    ws.on('message', async function gate(raw) {
      if (!first) {
        earlyBytes += raw.length;
        if (earlyBytes > MAX_EARLY_BYTES) return ws.close(1013, 'Too much before signing in. Trying again.');
        return early.push(raw);
      }
      first = false;
      checking = true;
      try {
        const m = parse(raw);
        const user = await identify(m?.token).catch(() => undefined);
        const team = teams.get(m?.team);
        clearTimeout(timer);
        ws.off('message', gate);
        if (ws.readyState !== ws.OPEN) return; // closed during verification
        if (user === undefined) return ws.close(1013, 'GitHub didn\'t answer. Trying again.');
        if (!user) return ws.close(4001, 'Sign in with GitHub first.');
        if (!team || !onTeam(team, user)) return ws.close(4003, 'You aren\'t on this team.');
        role(ws, user, team, m);
        for (const r of early) ws.emit('message', r);
      } catch (e) {
        console.error(`A connection failed: ${e.message}`);
        ws.close(1011, 'The hub hit an error.');
      }
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_HOOK_BODY });
  server.on('upgrade', (req, sock, head) => {
    sock.on('error', () => {}); // a connection reset mid-upgrade is the client's problem, not the hub's
    let route = null;
    try { route = new URL(req.url, 'http://x').pathname; } catch {} // a malformed address ("//") is just not found
    const role = { '/lane': onLane, '/watch': onWatcher }[route];
    if (!role) return sock.end('HTTP/1.1 404 Not Found\r\n\r\n');
    wss.handleUpgrade(req, sock, head, ws => {
      ws.on('error', () => {}); // an oversized or malformed frame closes that socket (ws does), and only that socket
      ws.alive = true;
      ws.on('pong', () => { ws.alive = true; });
      authenticate(ws, role);
    });
  });

  // Terminate connections that stopped answering pings (sleeping laptop, dropped Wi-Fi).
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else { ws.alive = false; ws.ping(); }
    }
    for (const [key, id] of identities) if (id.expires < Date.now()) identities.delete(key);
    for (const [key, until] of known) if (until < Date.now()) known.delete(key);
  }, HEARTBEAT_MS).unref();

  const close = () => new Promise(resolve => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    server.close(() => resolve());
  });

  // Moves the listening socket to `host` on the same port. Open WebSockets stay; idle HTTP connections are closed, and
  // clients reconnect. A hub on a Mac starts on 127.0.0.1 and moves to the network once its team is shared.
  const listenOn = h => new Promise((resolve, reject) => {
    const at = server.address().port;
    server.close();
    server.once('error', reject).listen(at, h, () => { server.off('error', reject); resolve(); });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject).listen(port, host, () => {
      server.off('error', reject).on('error', e => console.error(`Hub server error: ${e.message}`));
      resolve({ port: server.address().port, close, listenOn, fingerprint: ownPrint || undefined });
    });
  });
}

module.exports = { startHub, githubUser, signPass, readPass };

// Standalone: PORT, DATA_DIR, PROTO_OWNERS (comma-separated GitHub logins allowed to create teams).
if (require.main === module) {
  const owners = process.env.PROTO_OWNERS?.split(',').map(s => s.trim()).filter(Boolean);
  startHub({ port: +process.env.PORT || 7681, host: process.env.HOST, dataDir: process.env.DATA_DIR, owners: owners?.length ? owners : undefined })
    .then(({ port }) => {
      console.log(`Protoplasma hub on port ${port}${owners?.length ? `, teams created by ${owners.join(', ')}` : ''}`);
      if (!process.env.DATA_DIR) console.log('No DATA_DIR set: teams are kept in memory only and are lost when the hub restarts.');
    });
}

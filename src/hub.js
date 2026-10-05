// Coordination server. Hosts teams (an owner plus invited GitHub users), relays agent terminals to teammates,
// and answers Claude Code hooks with team context. It never runs agents or sees code.
// Protocol: see the README.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { SCROLLBACK, EDIT_TOOLS, appendScrollback, slug } = require('./shared');

const HEARTBEAT_MS = 15_000;
const IDENTITY_TTL_MS = 2 * 60_000; // how long a verified GitHub token is trusted before GitHub is asked again
const MAX_CHANGED = 200; // uncommitted files a lane reports
const MAX_API_BODY = 64 * 1024;
const MAX_HOOK_BODY = 5 * 1024 * 1024;
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const MAX_MEMORIES = 200;
const MAX_MEMORY = 500;
const MAX_SESSIONS = 200; // per team; the oldest finished ones are dropped first
const MAX_COMMENTS = 100; // per session; the oldest go first
const MAX_STOPPED = 20; // stopped agents whose last screen is kept, per team (in memory only)
const MAX_COMMENT = 500;
const PROTECTED_BRANCHES = ['main', 'master'];
const STATE_REFRESH_MS = 30_000; // rebroadcast at least this often so "last active" times stay fresh

/** This machine's LAN IPv4 addresses. */
const lanAddresses = () => Object.values(os.networkInterfaces()).flat()
  .filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address);

/** Resolves a GitHub token to its user. Only reads the public profile, so a token with no scopes works. */
async function githubUser(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'protoplasma' },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return { login: u.login, name: u.name || u.login, avatar: u.avatar_url };
}

/**
 * Starts a hub.
 * @param {object} [o]
 * @param {number} [o.port] 0 picks a free port
 * @param {string} [o.dataDir] where teams are saved; omit to keep them in memory
 * @param {string[]} [o.owners] GitHub logins allowed to create teams; omit to let anyone signed in
 * @param {(token: string) => Promise<{login: string, name: string, avatar: string} | null>} [o.verifyUser]
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startHub({ port = 7681, host = '0.0.0.0', dataDir, owners, verifyUser = githubUser } = {}) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const parse = raw => { try { return JSON.parse(raw); } catch { return null; } };
  const str = (v, max) => String(v ?? '').slice(0, max);

  // ---- Teams (persisted) ----
  const teamsFile = dataDir && path.join(dataDir, 'teams.json');
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const teams = new Map((teamsFile && fs.existsSync(teamsFile) ? JSON.parse(fs.readFileSync(teamsFile, 'utf8')) : [])
    .map(t => [t.id, { memories: [], sessions: [], ...t }]));
  // Written to a temporary file first, so a crash mid-write can't leave a half-written teams.json behind.
  const saveTeams = () => {
    if (!teamsFile) return;
    fs.writeFileSync(`${teamsFile}.tmp`, JSON.stringify([...teams.values()], null, 2));
    fs.renameSync(`${teamsFile}.tmp`, teamsFile);
  };
  const onTeam = (team, login) => same(team.owner, login) || team.members.some(m => same(m, login));
  // "Fix Login" and "fix-login" would get the same branch and folder, so they're the same session.
  // A renamed session keeps its original key, which names its branch and folders; that key still finds it.
  const keyOf = x => x.key || slug(x.name);
  const findSession = (team, name) => team.sessions.find(x => x.name === name) || team.sessions.find(x => slug(x.name) === slug(name) || keyOf(x) === slug(name));
  function ensureSession(team, name, login, task = '') {
    let session = findSession(team, name);
    if (!session) {
      session = { name, task, createdBy: login, createdAt: new Date().toISOString(), done: false };
      team.sessions.push(session);
      while (team.sessions.length > MAX_SESSIONS) {
        const oldestDone = team.sessions.findIndex(x => x.done);
        team.sessions.splice(oldestDone === -1 ? 0 : oldestDone, 1);
      }
    }
    return session;
  }

  // ---- Identity (GitHub tokens, cached by hash) ----
  const identities = new Map(); // sha256(token) -> { user, expires }
  async function identify(token) {
    if (typeof token !== 'string' || !token || token.length > 500) return null;
    const key = crypto.createHash('sha256').update(token).digest('hex');
    const hit = identities.get(key);
    if (hit?.expires > Date.now()) return hit.user;
    const user = await verifyUser(token).catch(() => null);
    if (user) identities.set(key, { user, expires: Date.now() + IDENTITY_TTL_MS });
    return user;
  }

  // ---- Live state ----
  const stopped = new Map();  // team id -> recently stopped agents, newest first, with the last of their output
  const stoppedViews = teamId => (stopped.get(teamId) || []).map(({ history, ...rest }) => rest);
  const lanes = new Map();    // id -> { id, team, login, name, avatar, session, cmd, root, repo, branch, cols, rows, open, status, lastActive, files: Set, history, hookSecret, ws }
  const watchers = new Set(); // app windows: ws.team, ws.login, ws.user, ws.session
  const teamLanes = teamId => [...lanes.values()].filter(l => l.team === teamId);
  // Which codebase a lane works in: its GitHub repo, or its own checkout when the folder has no GitHub remote.
  const repoKey = l => l.repo || l.tree;
  const inSameRepo = lane => teamLanes(lane.team).filter(o => o !== lane && repoKey(o) === repoKey(lane));
  // Files a lane has touched: edits Claude reported through its hooks, plus whatever its checkout has that main doesn't
  // (which also covers shell commands, Codex, OpenCode and people).
  const filesOf = l => new Set([...l.files, ...l.changed]);
  // What another lane has touched, as `lane` should see it. A lane in the same folder only counts for the edits it made
  // itself, since that folder's changes could just as well be `lane`'s own. Checkouts of the same branch share its
  // pushed commits, so between them only what isn't pushed yet counts.
  const touchedBy = (o, lane) => (o.tree === lane.tree ? o.files
    : o.branch && o.branch === lane.branch ? new Set([...o.local, ...[...o.files].filter(f => !o.changed.has(f))]) : filesOf(o));
  const othersOn = (lane, file) => inSameRepo(lane).filter(o => touchedBy(o, lane).has(file));
  const notesFor = (lane, file = '') => teams.get(lane.team).memories.filter(m => m.file === file && (!m.repo || m.repo === lane.repo));
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
    for (const w of watchers) if (w.team === teamId && w.readyState === w.OPEN) w.send(data);
  };
  // One entry per person and session they're viewing.
  const presence = teamId => [...new Map([...watchers].filter(w => w.team === teamId)
    .map(w => [`${w.login}|${w.session}`, { ...w.user, session: w.session }])).values()];
  const lastBroadcast = new Map(); // team id -> time of the last state broadcast
  const broadcastState = teamId => {
    lastBroadcast.set(teamId, Date.now());
    const team = teams.get(teamId);
    toTeam(teamId, { t: 'state', lanes: views(teamId), watchers: presence(teamId), memories: team?.memories || [], sessions: team?.sessions || [], stopped: stoppedViews(teamId) });
  };
  const teamView = t => ({ id: t.id, name: t.name, owner: t.owner, members: t.members, agents: teamLanes(t.id).length });

  // ---- Claude Code hooks ----
  const notes = list => list.map(m => `- ${m.text} (${m.author})`).join('\n');
  function teamContext(lane) {
    const others = inSameRepo(lane);
    const general = notesFor(lane);
    const goal = findSession(teams.get(lane.team), lane.session)?.task;
    const parts = goal ? [`You're working in the Protoplasma session "${lane.session}". Its goal: ${goal}`] : [];
    if (others.length) {
      parts.push(['Teammates working in this repo right now (from Protoplasma):',
        ...others.map(o => `- ${o.name}'s ${o.cmd} agent, session "${o.session}", ${o.status}` + (touchedBy(o, lane).size ? `, has changed: ${[...touchedBy(o, lane)].join(', ')}` : '')),
        'Check with the user before editing files a teammate has edited.'].join('\n'));
    }
    if (general.length) parts.push(`Team notes for this repo (from Protoplasma):\n${notes(general)}`);
    if (lane.git?.behind) {
      parts.push(`Your branch "${lane.branch}" is ${lane.git.behind} commit${lane.git.behind === 1 ? '' : 's'} behind: main or its pushed copy has ` +
        'commits it doesn\'t (from Protoplasma). Pull or rebase before making more changes, and before pushing.');
    }
    return parts.join('\n\n') || null;
  }

  // Why a `git push` needs a person's confirmation, or null if it's fine. Only applies when the team has other people.
  function pushRisk(lane, command) {
    const team = teams.get(lane.team);
    const push = /\bgit\b[^|;&]*?\bpush\b([^|;&]*)/.exec(command);
    if (!team.members.length || !push) return null;
    const words = push[1].trim().split(/\s+/).filter(Boolean).map(w => w.replace(/^(['"])(.*)\1$/, '$2'));
    const flags = words.filter(w => w.startsWith('-'));
    const refspecs = words.filter(w => !w.startsWith('-')).slice(1); // after the remote
    // --force-with-lease too: lanes fetch in the background, so the lease rarely protects a teammate's commits.
    if (flags.some(f => /^--force(-with-lease)?(=|$)/.test(f) || /^-[a-zA-Z]*f/.test(f)) || refspecs.some(r => r.startsWith('+'))) {
      return 'this force-push can overwrite commits your teammates pushed. Confirm it\'s intended.';
    }
    if (flags.some(f => f === '--all' || f === '--mirror')) {
      return `this pushes every branch, ${PROTECTED_BRANCHES.join(' and ')} included, which your team shares. Push just your branch, or confirm.`;
    }
    // No refspec pushes the current branch; otherwise the part after ":" (or the name itself) is the destination.
    const deleting = flags.some(f => f === '--delete' || f === '-d');
    const targets = (refspecs.length ? refspecs : ['HEAD']).map(r => r.split(':').pop().replace(/^refs\/heads\//, '')).map(t => (t === 'HEAD' ? lane.branch : t));
    const target = targets.find(t => PROTECTED_BRANCHES.includes(t));
    if (target && (deleting || refspecs.some(r => r.startsWith(':')))) return `this deletes ${target} on the remote, which your team shares. Confirm it's intended.`;
    const theirs = (deleting || refspecs.some(r => r.startsWith(':'))) && inSameRepo(lane).filter(o => targets.includes(o.branch));
    const names = theirs && [...new Set(theirs.map(o => o.name))];
    if (names?.length) return `this deletes ${theirs[0].branch} on the remote, which ${names.join(' and ')} also ${names.length === 1 ? 'works' : 'work'} on. Confirm it's intended.`;
    return target ? `this pushes straight to ${target}, which your team shares. Push a branch and open a pull request instead, or confirm.` : null;
  }

  const whoOn = others => others.map(o => `${o.name} (session "${o.session}")`).join(', ');
  // A shell command that writes a file a teammate has changed: sed -i, a redirect, tee, mv, rm and the like.
  // ponytail: a heuristic over the words of the command; a script that writes files it doesn't name isn't caught.
  function shellWriteRisk(lane, command, cwd) {
    if (!/\bsed\b[^|;&]*\s-[a-zA-Z]*i|\bperl\b[^|;&]*\s-[a-zA-Z]*i|>|\b(tee|mv|rm|cp|truncate)\b/.test(command)) return null;
    for (const word of command.split(/[\s;|&<>()'"=]+/)) {
      if (!/\/|\.\w+$/.test(word)) continue; // only words that look like paths
      const full = path.resolve(cwd || lane.root, word);
      const root = lane.roots.find(r => full.startsWith(r + path.sep)) || lane.root;
      const rel = path.relative(root, full);
      const others = rel && !rel.startsWith('..') ? othersOn(lane, rel) : [];
      if (others.length) return `${whoOn(others)} already edited ${rel}, and this command changes it. Coordinate before running it.`;
    }
    return null;
  }

  // A JSON reply steers the agent; an empty one lets it continue.
  function onHook(lane, ev) {
    const file = ev.tool_input?.file_path || ev.tool_input?.notebook_path;
    const full = file && path.resolve(ev.cwd || lane.root, file);
    const root = full && (lane.roots.find(r => full === r || full.startsWith(r + path.sep)) || lane.root);
    const rel = full && path.relative(root, full);
    lane.lastActive = new Date().toISOString();
    switch (ev.hook_event_name) {
      case 'UserPromptSubmit': {
        lane.status = 'working';
        lane.prompt = str(ev.prompt, 300).replace(/\s+/g, ' ').trim(); // shown to the team beside the agent
        const ctx = teamContext(lane);
        return ctx && { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } };
      }
      case 'PreToolUse': {
        if (ev.tool_name === 'Bash') {
          const command = String(ev.tool_input?.command || '');
          const reason = pushRisk(lane, command) || shellWriteRisk(lane, command, ev.cwd);
          return reason && { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Protoplasma: ${reason}` } };
        }
        // Attach the file's team notes, and require confirmation if a teammate's agent already edited it.
        if (!rel) return null;
        const pinned = notesFor(lane, rel);
        const others = EDIT_TOOLS.includes(ev.tool_name) ? othersOn(lane, rel) : [];
        if (!pinned.length && !others.length) return null;
        const out = { hookEventName: 'PreToolUse' };
        if (pinned.length) out.additionalContext = `Team notes about ${rel} (from Protoplasma):\n${notes(pinned)}`;
        if (others.length) {
          Object.assign(out, { permissionDecision: 'ask', permissionDecisionReason: `Protoplasma: ${whoOn(others)} already edited ${rel}. Coordinate before changing it.` });
        }
        return { hookSpecificOutput: out };
      }
      case 'PostToolUse':
        lane.status = 'working';
        if (rel && EDIT_TOOLS.includes(ev.tool_name)) lane.files.add(rel);
        return null;
      case 'PermissionRequest': lane.status = 'needs you'; return null;
      case 'Stop': lane.status = 'idle'; return null;
      default: return null;
    }
  }

  // ---- HTTP: team API and hooks ----
  const readBody = (req, max) => new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; if (body.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
  });
  const bearer = req => str(req.headers.authorization, 600).replace(/^Bearer /, '');
  const secretMatches = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

  async function handle(req, res) {
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(body === undefined ? '' : JSON.stringify(body));
    const [resource, id, sub, subId, leaf, leafId, ...rest] = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (rest.length || (leaf && !(sub === 'sessions' && leaf === 'comments'))) return json(404, { error: 'Not found.' });
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

    if (resource !== 'teams') return json(404, { error: 'Not found.' });
    const user = await identify(bearer(req));
    if (!user) return json(401, { error: 'Sign in with GitHub first.' });
    const body = req.method === 'POST' ? parse(await readBody(req, MAX_API_BODY)) || {} : {};

    if (!id && req.method === 'GET') return json(200, [...teams.values()].filter(t => onTeam(t, user.login)).map(teamView));
    if (!id && req.method === 'POST') {
      if (owners && !owners.some(o => same(o, user.login))) return json(403, { error: 'This hub only lets its owners create teams.' });
      const name = str(body.name, 60).trim();
      if (!name) return json(400, { error: 'Give the team a name.' });
      const team = { id: crypto.randomBytes(6).toString('base64url'), name, owner: user.login, members: [], memories: [], sessions: [] };
      teams.set(team.id, team);
      saveTeams();
      return json(201, teamView(team));
    }

    const team = teams.get(id);
    if (!team || !onTeam(team, user.login)) return json(404, { error: 'No such team.' });

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
          session.comments.push({ id: crypto.randomBytes(6).toString('base64url'), author: user.login, text, at: new Date().toISOString() });
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
      if (!subId && req.method === 'POST') {
        const name = str(body.name, 60).trim();
        if (!name) return json(400, { error: 'Name the session.' });
        const session = ensureSession(team, name, user.login);
        if (typeof body.task === 'string') session.task = str(body.task, 300).trim();
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
          // Only while nothing runs in it: running agents know their session by name.
          const name = str(body.rename, 60).trim();
          if (!name) return json(400, { error: 'Give the session a name.' });
          if (running(session.name)) return json(409, { error: 'Stop its agents first.' });
          const clash = team.sessions.find(x => x !== session && (x.name === name || slug(x.name) === slug(name) || keyOf(x) === slug(name)));
          if (clash) return json(409, { error: `There's already a session called ${clash.name}.` });
          for (const s of stopped.get(team.id) || []) if (s.session === session.name) s.session = name;
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
      if (onTeam(team, login)) return json(409, { error: `${login} is already on the team.` });
      team.members.push(login);
      saveTeams();
      return json(200, teamView(team));
    }
    if (subId && req.method === 'DELETE') {
      if (same(subId, team.owner)) return json(400, { error: 'The owner can\'t leave. Delete the team instead.' });
      team.members = team.members.filter(m => !same(m, subId));
      saveTeams();
      // Disconnect them now rather than on their next reconnect.
      for (const w of watchers) if (w.team === team.id && same(w.login, subId)) w.close(4003, 'Removed from the team.');
      for (const l of teamLanes(team.id)) if (same(l.login, subId)) l.ws.close(4003, 'Removed from the team.');
      return json(200, teamView(team));
    }
    return json(404, { error: 'Not found.' });
  }

  const server = http.createServer((req, res) => handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The hub hit an error.' }));
  }));

  // ---- WebSockets: agents (/lane) and app windows (/watch) ----
  const gitStats = g => g && typeof g === 'object'
    ? { added: g.added | 0, removed: g.removed | 0, files: g.files | 0, behind: g.behind | 0, ahead: g.ahead | 0, unpushed: g.unpushed | 0 } : null;
  const changedFiles = g => new Set(Array.isArray(g?.changed) ? g.changed.slice(0, MAX_CHANGED).map(f => str(f, 300)).filter(Boolean) : []);
  function onLane(ws, user, team, hello) {
    const existing = lanes.get(hello.id);
    if (!/^[\w-]{1,64}$/.test(hello.id) || typeof hello.hookSecret !== 'string' || (existing && !same(existing.login, user.login))) {
      return ws.close(4000, 'Bad hello.');
    }
    const lane = { id: hello.id, team: team.id, login: user.login, name: user.name, avatar: user.avatar,
      session: str(hello.session, 60), cmd: str(hello.cmd, 40), root: str(hello.root, 1000), repo: str(hello.repo, 200), branch: str(hello.branch, 100),
      roots: (Array.isArray(hello.roots) ? hello.roots.slice(0, 4) : []).map(r => str(r, 1000)).filter(Boolean),
      cols: hello.cols | 0 || 120, rows: hello.rows | 0 || 36, open: !!hello.open, status: str(hello.cmd, 40) === 'claude' ? 'idle' : 'running', lastActive: new Date().toISOString(), startedAt: existing?.startedAt || new Date().toISOString(), files: new Set(), changed: changedFiles(hello.git), local: changedFiles(hello.git?.local ? { changed: hello.git.local } : hello.git),
      git: gitStats(hello.git), history: typeof hello.history === 'string' ? hello.history.slice(-SCROLLBACK) : '', hookSecret: hello.hookSecret, ws };
    lane.tree = crypto.createHash('sha256').update(`${lane.login}\n${lane.root}`).digest('hex').slice(0, 12); // one per checkout
    lanes.set(lane.id, lane);
    stopped.set(team.id, (stopped.get(team.id) || []).filter(s => s.id !== lane.id)); // it reconnected
    const session = ensureSession(team, lane.session, user.login);
    lane.session = session.name; // a differently written name joins the existing session
    if (session.done) { session.done = false; session.doneAt = undefined; }
    if (lane.repo) session.repo = lane.repo; // so its pull requests and issues stay reachable after the agents stop
    saveTeams();
    broadcastState(team.id);
    toTeam(team.id, { t: 'out', lane: lane.id, d: lane.history });

    ws.on('message', raw => {
      const m = parse(raw);
      if (m?.t === 'out' && typeof m.d === 'string') {
        lane.history = appendScrollback(lane.history, m.d);
        toTeam(team.id, { t: 'out', lane: lane.id, d: m.d });
      } else if (m?.t === 'size') {
        lane.cols = m.cols | 0 || lane.cols;
        lane.rows = m.rows | 0 || lane.rows;
        broadcastState(team.id);
      } else if (m?.t === 'git') {
        lane.git = gitStats(m);
        lane.changed = changedFiles(m);
        lane.local = Array.isArray(m.local) ? changedFiles({ changed: m.local }) : lane.changed;
        lane.files = new Set([...lane.files].filter(f => lane.changed.has(f))); // edits since committed to main, or undone, no longer count
        lane.branch = str(m.branch, 100) || lane.branch;
        broadcastState(team.id);
      } else if (m?.t === 'status' && ['needs you', 'idle', 'working'].includes(m.status)) { // trust prompts, and agents without hooks
        lane.status = m.status;
        broadcastState(team.id);
      }
    });
    // A stopped agent's last screen stays viewable for a while, so teammates can see what it did.
    ws.on('close', () => {
      if (lanes.get(lane.id) !== lane) return;
      lanes.delete(lane.id);
      const { id, session, login, name, avatar, cmd, cols, rows, history } = lane;
      const list = [{ id, session, login, name, avatar, cmd, cols, rows, history, endedAt: new Date().toISOString() }, ...(stopped.get(team.id) || []).filter(s => s.id !== id)];
      stopped.set(team.id, list.slice(0, MAX_STOPPED));
      broadcastState(team.id);
    });
  }

  function onWatcher(ws, user, team) {
    Object.assign(ws, { team: team.id, login: user.login, user, session: null });
    watchers.add(ws);
    broadcastState(team.id); // doubles as the newcomer's first message
    for (const l of teamLanes(team.id)) send(ws, { t: 'out', lane: l.id, d: l.history });
    ws.on('message', raw => {
      const m = parse(raw);
      if (m?.t === 'look') { ws.session = m.session == null ? null : str(m.session, 60); return broadcastState(team.id); }
      if (m?.t === 'replay') { // the last screen of a stopped agent
        const agent = (stopped.get(team.id) || []).find(s => s.id === m.id);
        return agent && send(ws, { t: 'replay', id: agent.id, d: agent.history });
      }
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
  function authenticate(ws, role) {
    const early = [];
    let first = true;
    const timer = setTimeout(() => ws.close(4001, 'Sign-in timed out.'), 10_000);
    ws.on('message', async function gate(raw) {
      if (!first) return early.push(raw);
      first = false;
      const m = parse(raw);
      const user = await identify(m?.token);
      const team = teams.get(m?.team);
      clearTimeout(timer);
      ws.off('message', gate);
      if (ws.readyState !== ws.OPEN) return; // closed during verification
      if (!user) return ws.close(4001, 'Sign in with GitHub first.');
      if (!team || !onTeam(team, user.login)) return ws.close(4003, 'You aren\'t on this team.');
      role(ws, user, team, m);
      for (const r of early) ws.emit('message', r);
    });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_HOOK_BODY });
  server.on('upgrade', (req, sock, head) => {
    const role = { '/lane': onLane, '/watch': onWatcher }[new URL(req.url, 'http://x').pathname];
    if (!role) return sock.end('HTTP/1.1 404 Not Found\r\n\r\n');
    wss.handleUpgrade(req, sock, head, ws => {
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
  }, HEARTBEAT_MS).unref();

  const close = () => new Promise(resolve => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    server.close(() => resolve());
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject).listen(port, host, () => resolve({ port: server.address().port, close }));
  });
}

module.exports = { startHub, githubUser, lanAddresses };

// Standalone: PORT, DATA_DIR, PROTO_OWNERS (comma-separated GitHub logins allowed to create teams).
if (require.main === module) {
  const owners = process.env.PROTO_OWNERS?.split(',').map(s => s.trim()).filter(Boolean);
  startHub({ port: +process.env.PORT || 7681, host: process.env.HOST, dataDir: process.env.DATA_DIR, owners })
    .then(({ port }) => console.log(`Protoplasma hub on port ${port}${owners ? `, teams created by ${owners.join(', ')}` : ''}`));
}

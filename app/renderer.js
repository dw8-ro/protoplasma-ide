// Renderer: sign-in, team picker, the Sessions and People pages, and the session view.
// Talks to the machine through window.proto (preload.js) and to the hub over a WebSocket.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const errorText = e => String(e.message || e).replace(/^Error invoking remote method '[\w:]+': (Error: )?/, '');
const store = {
  get: k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const setHTML = (el, html) => { if (el._html !== html) { el._html = html; el.innerHTML = html; } };
const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const REPO = /^[\w.-]+\/[\w.-]+$/;

// ---- Preferences (Settings) ----

const DEFAULT_PREFS = { theme: 'dark', fontSize: 12.5, fontFamily: 'SF Mono', lineHeight: 1.2, notifyNeeds: true, notifyDone: true, badge: true, agent: 'claude', open: false, sessionBranches: true };
const prefs = { ...DEFAULT_PREFS, ...(() => { try { return JSON.parse(store.get('prefs') || '{}'); } catch { return {}; } })() };
const effectiveTheme = () => (prefs.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : prefs.theme);

// ---- Presentation helpers ----

// Each teammate gets a distinct colour. Logins hash to a slot and move to the next free one on collision;
// iterating in sorted order keeps the assignment identical in every teammate's app.
const PEOPLE_COLORS = ['#7aa2ff', '#f07a8b', '#6fd6a8', '#f2b35b', '#c49bff', '#5cc8e0', '#ff9a6b', '#d9e46a'];
const hash = s => { let h = 0; for (const ch of String(s).toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h; };
let teamColors = new Map();
function assignColors(logins) {
  const taken = new Set();
  teamColors = new Map();
  for (const login of [...new Set(logins)].sort()) {
    let i = hash(login) % PEOPLE_COLORS.length;
    for (let tries = 0; taken.has(i) && tries < PEOPLE_COLORS.length; tries++) i = (i + 1) % PEOPLE_COLORS.length;
    taken.add(i);
    teamColors.set(login, PEOPLE_COLORS[i]);
  }
}
const colorFor = login => teamColors.get(login) || PEOPLE_COLORS[hash(login) % PEOPLE_COLORS.length];

// A profile picture, or the person's initial when there isn't one or it can't be loaded (offline, or GitHub blocked).
// People known only by login (team members) use GitHub's avatar redirect; lanes carry the URL the hub got from GitHub.
const failedAvatars = new Set();
const avatarUrl = p => ('avatar' in p ? p.avatar : GITHUB_LOGIN.test(p.login || '') ? `https://github.com/${p.login}.png?size=64` : '');
const avatar = p => {
  const url = avatarUrl(p), initial = (p.name || p.login || '?')[0].toUpperCase();
  return `<span class="avatar" style="--c:${colorFor(p.login)}" title="${esc(p.name || p.login)}" data-initial="${esc(initial)}">${
    url && !failedAvatars.has(url) ? `<img src="${esc(url)}" alt="">` : esc(initial)}</span>`;
};
document.addEventListener('error', e => {
  if (!e.target.matches?.('.avatar img')) return;
  failedAvatars.add(e.target.getAttribute('src'));
  e.target.replaceWith(e.target.parentElement.dataset.initial);
}, true);
const agentName = cmd => ({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' })[cmd] || cmd;
const STATUS = { working: ['working', 'Working'], 'needs you': ['needs', 'Needs you'], idle: ['idle', 'Idle'], 'not synced': ['idle', 'Not synced'],
  overlap: ['overlap', 'Overlap'], done: ['done', 'Done'], running: ['idle', 'Running'], stopping: ['idle', 'Stopping'] };
const pill = status => {
  const [cls, label] = STATUS[status] || ['idle', status];
  return `<span class="pill ${cls}"><span class="dot"></span>${esc(label)}</span>`;
};
const people = lanes => {
  const byLogin = new Map(lanes.map(l => [l.login, l]));
  return `<span class="stack">${[...byLogin.values()].map(avatar).join('')}</span><span>${esc([...byLogin.values()].map(l => l.name).join(', '))}</span>`;
};
// "David & Max", or "2 of David's agents" when one person runs several.
const whoEdited = names => {
  const people = [...new Set(names)];
  return people.length > 1 ? people.join(' & ') : `${names.length} of ${people[0]}'s agents`;
};
const ago = iso => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  for (const [n, unit] of [[604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']]) if (s >= n) return `${Math.floor(s / n)}${unit} ago`;
  return 'just now';
};

// Most urgent status among a session's agents.
function sessionStatus(lanes) {
  if (lanes.some(l => l.status === 'needs you')) return 'needs you';
  if (lanes.some(l => l.overlaps.length)) return 'overlap';
  if (lanes.some(l => l.status === 'working')) return 'working';
  return lanes.some(l => l.status === 'running') ? 'running' : 'idle';
}

// ---- State ----

let me = null;             // your GitHub profile
let currentTeam = null;    // the open team
let ws, watchGeneration = 0;
let hubLanes = [];         // every agent on the team, as the hub reports them
let current = null;        // session shown in the room
let tab = 'agents';        // agents | memory | pulls | issues
let roomRepo = '';         // GitHub repo of the open session
let repos = null;          // your GitHub repos, loaded once
let reposError = '';       // why they couldn't be loaded
let teamWatchers = [];     // who is looking at which session
let memories = [];         // the team's shared notes
let sessionRecords = [];   // saved sessions: { name, task, createdBy, createdAt, done, doneAt }
let view = 'sessions';     // sessions | people | session
let focus = null;          // agent shown in the session view
let split = null;          // a second agent shown beside it ("New pane")
let panelTab = 'session';  // session | environment
let panelHidden = false;
let filterRepo = null;     // workspace the Sessions page is narrowed to ('' means folders with no GitHub repo)
let board = [];            // every agent on screen: the hub's, plus local ones it hasn't reported yet
let agents = [];           // agent CLIs and whether this Mac has them: { cmd, installed }
let stoppedAgents = [];    // recently stopped agents; the hub keeps their last screen
let replaying = null;      // the stopped agent whose last screen is on the stage
let lookedAt;              // last session reported to the hub via `look`
const lastStatus = new Map(); // lane id -> previous status, for notifications
const local = new Map();   // agents running in this app: id -> { teamKey, session, cmd, open, repo, login, name, avatar, refused? }
const terms = new Map();   // id -> { term, el, bar }
const pending = new Map(); // output that arrived before its terminal existed
const stopping = new Set(); // your agents that were told to stop and are still shutting down

const LIGHT_TERMINAL_THEME = {
  background: '#ffffff', foreground: '#1f1f24', cursor: '#17171a', cursorAccent: '#ffffff', selectionBackground: '#b9c8f388',
  black: '#1f1f24', red: '#c7374f', green: '#17875b', yellow: '#96650d', blue: '#2f5fd0', magenta: '#7b46c9', cyan: '#147f96', white: '#6b6b74',
  brightBlack: '#8a8a93', brightRed: '#d9506a', brightGreen: '#1f9d6b', brightYellow: '#a8770f', brightBlue: '#4a78e0', brightMagenta: '#9160dd', brightCyan: '#1c93ad', brightWhite: '#17171a',
};
const terminalTheme = () => (effectiveTheme() === 'light' ? LIGHT_TERMINAL_THEME : TERMINAL_THEME);
const terminalFont = () => `"${prefs.fontFamily}", ui-monospace, "SF Mono", Menlo, monospace`;
// CLIs pick their colours for dark terminals, so on white some greys are too faint. xterm darkens text below this ratio.
const contrastFloor = () => (effectiveTheme() === 'light' ? 3 : 1);
const TERMINAL_THEME = {
  background: '#141416', foreground: '#e4e4e7', cursor: '#f4f4f5', cursorAccent: '#141416', selectionBackground: '#3a3a4288',
  black: '#1c1c1f', red: '#f07a8b', green: '#6fd6a8', yellow: '#f2c46b', blue: '#7aa2ff', magenta: '#c49bff', cyan: '#5cc8e0', white: '#d4d4d8',
  brightBlack: '#5d5d65', brightRed: '#ff9aa8', brightGreen: '#8ee6bf', brightYellow: '#ffd88a', brightBlue: '#9dbbff', brightMagenta: '#d8b9ff', brightCyan: '#86dcee', brightWhite: '#fafafa',
};

// ---- Sign-in and teams ----

const VIEWS = ['signinView', 'codeView', 'teamsView'];
const showView = id => {
  for (const v of VIEWS) $(`#${v}`).hidden = v !== id;
  $('#err').textContent = '';
  if (id === 'signinView') startCellArt(); else stopCellArt();
};

// Welcome screen art: a halftone cell with a breathing membrane, in ink only to match the black-and-white logo.
// Drawn once and left static when the user prefers reduced motion.
let cellFrame;
function startCellArt() {
  const canvas = $('#cellArt');
  const ctx = canvas.getContext('2d');
  const { width: W, height: H } = canvas;
  const step = 15, still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--text').trim(), grid = css.getPropertyValue('--line-strong').trim();
  const draw = t => {
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.52, R = H * 0.38;
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) {
      const dx = (x - cx) / 1.25, dy = y - cy, angle = Math.atan2(dy, dx), r = Math.hypot(dx, dy);
      const edge = R * (1 + 0.09 * Math.sin(3 * angle + t / 1500) + 0.05 * Math.sin(5 * angle - t / 1100));
      const membrane = Math.exp(-((r - edge) ** 2) / 70);
      const nucleus = Math.hypot(x - cx - R * 0.42, y - cy + R * 0.22) < R * 0.3 ? 0.9 : 0;
      const inside = r < edge ? 0.14 + 0.1 * Math.sin(x * 0.07 + y * 0.05 + t / 900) : 0;
      const v = Math.min(1, membrane + nucleus + inside);
      if (v < 0.04) { ctx.fillStyle = grid; ctx.globalAlpha = 0.5; ctx.fillRect(x - 0.5, y - 0.5, 1, 1); ctx.globalAlpha = 1; continue; }
      ctx.globalAlpha = 0.25 + 0.75 * v;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.arc(x, y, 0.8 + v * step * 0.34, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (!still) cellFrame = requestAnimationFrame(draw);
  };
  stopCellArt();
  draw(0);
}
const stopCellArt = () => cancelAnimationFrame(cellFrame);
let signInUrl;

$('#start').oncancel = e => { if (!currentTeam) e.preventDefault(); };
// Chromium lets Escape close a dialog anyway when there's been no click or key since it opened; without a team the
// window has nothing to show, so it comes straight back.
$('#start').addEventListener('close', () => requestAnimationFrame(() => { if (!currentTeam && !$('#start').open) $('#start').showModal(); }));
$('#closeStart').onclick = () => $('#start').close();
$('#signin').onclick = async () => {
  try {
    const { code, url } = await proto.signIn();
    signInUrl = url;
    $('#userCode').textContent = code;
    showView('codeView');
  } catch (e) { $('#err').textContent = errorText(e); }
};
$('#reopen').onclick = () => proto.openExternal(signInUrl);
$('#cancelSignin').onclick = () => { proto.cancelSignIn(); showView('signinView'); };
proto.onSignedIn(({ user, error }) => {
  if (!user) { showView('signinView'); $('#err').textContent = error; return; }
  showTeams(user);
});
// Forget everything that belonged to the team that was open.
function clearTeamView() {
  hubLanes = [];
  teamWatchers = [];
  memories = [];
  sessionRecords = [];
  current = focus = split = filterRepo = replaying = null;
  stoppedAgents = [];
  view = 'sessions';
  tab = 'agents';
  for (const id of [...terms.keys()]) if (!local.has(id)) dropTerminal(id);
}

// Disconnects from the open team and empties the board.
// Removed from the team (or it was deleted) while it was open: back to your teams, saying what happened.
function removedFromTeam(reason) {
  const team = currentTeam, running = [...local.values()].filter(l => l.teamKey === team?.key).length;
  closeTeam();
  showTeams(me);
  $('#removedNote').hidden = false;
  $('#removedNote').textContent = `${team ? `${team.name}: ` : ''}${reason}`
    + (running ? ` Your agents there keep running on this Mac without being shared, and rejoin if you're invited back.` : '');
}
function closeTeam() {
  watchGeneration++;
  ws?.close();
  clearTeamView();
  render(); // while the team is still set, so the board is redrawn empty
  currentTeam = null;
  $('#teamSwitch').hidden = true;
  setConnection('', 'Not connected');
}

$('#signout').onclick = async () => {
  if (local.size && !confirm(`Sign out and stop your ${local.size === 1 ? 'agent' : `${local.size} agents`}?`)) return;
  $('#settings').close();
  for (const id of local.keys()) proto.kill(id); // they run under this sign-in
  await proto.signOut();
  closeTeam();
  me = null;
  store.set('team', '');
  $('.side-foot').hidden = true;
  showView('signinView');
  if (!$('#start').open) $('#start').showModal();
};

// The owner deletes a team; anyone else leaves it. Cancelling changes nothing.
const ownsTeam = team => team.owner.toLowerCase() === me.login.toLowerCase();
async function leaveOrDeleteTeam(team) {
  const deleting = ownsTeam(team);
  const unpushed = hubLanes.filter(l => local.get(l.id)?.teamKey === team.key && (l.git?.unpushed || l.local?.length)).length;
  const work = unpushed ? ` Some of your agents' folders have work that isn't pushed; it stays on this Mac.` : '';
  if (!confirm(deleting ? `Delete the team "${team.name}"? Its sessions and notes go with it, for everyone on it.${work}`
    : `Leave "${team.name}"? Your agents in it stop, and you'd need a new invite to come back.${work}`)) return;
  try { await (deleting ? proto.deleteTeam(team.key) : proto.leaveTeam(team.key)); }
  catch (e) { return alert(errorText(e)); }
  for (const [id, o] of local) if (o.teamKey === team.key) proto.kill(id);
  $('#settings').close();
  if (team.key === currentTeam?.key) closeTeam();
  showTeams(me);
}

function showTeams(user) {
  me = user;
  $('#meAvatar').innerHTML = avatar(user);
  $('#meLogin').textContent = user.login;
  $('.side-foot').hidden = false;
  $('#me').innerHTML = `${avatar(user)}${esc(user.login)}`;
  $('#closeStart').hidden = !currentTeam;
  $('#createErr').textContent = '';
  showView('teamsView');
  if (!$('#start').open) $('#start').showModal();
  refreshTeams();
}

// Polls while open, since teammates' hubs appear as Bonjour discovers them.
let teamsTimer, onlineReady = false, reopenLast = false;
async function refreshTeams() {
  clearTimeout(teamsTimer);
  if (!$('#start').open || $('#teamsView').hidden) return;
  try {
    const { teams, unreachable, online } = await proto.teams();
    onlineReady = online;
    renderTeamList(teams);
    const last = reopenLast && listedTeams.get(store.get('team')); // on launch, go straight back to the last team
    reopenLast = false;
    if (last) return openTeam(last);
    syncWhere();
    $('#teamsNote').textContent = unreachable.length ? `Couldn't reach ${unreachable.join(', ')} right now.` : '';
  } catch (e) { $('#err').textContent = errorText(e); }
  teamsTimer = setTimeout(refreshTeams, 4000);
}

let listedTeams = new Map();
function renderTeamList(teams) {
  listedTeams = new Map(teams.map(t => [t.key, t]));
  $('#teamList').innerHTML = teams.map(t => {
    const open = t.key === currentTeam?.key, size = t.members.length + 1;
    return `
    <button class="team ${open ? 'on' : ''}" data-key="${esc(t.key)}">
      <span class="stack">${[t.owner, ...t.members].slice(0, 5).map(login => avatar({ login })).join('')}</span>
      <span class="name">${esc(t.name)}<span class="where">${esc(t.where)}, ${size === 1 ? 'just you' : `${size} people`}</span></span>
      <span class="agents">${[open && 'Open', t.agents && `${t.agents} running`].filter(Boolean).join(', ')}</span>
    </button>`;
  }).join('') || `<p class="hint">No teams yet. Create one below, or ask a teammate to invite ${esc(me.login)}.</p>`;
}
$('#teamList').onclick = e => { const b = e.target.closest('[data-key]'); if (b) openTeam(listedTeams.get(b.dataset.key)); };

const whereValue = () => $('input[name=where]:checked').value;
function syncWhere() {
  const online = $('input[name=where][value=online]');
  online.disabled = !onlineReady;
  if (!onlineReady && online.checked) $('input[name=where][value=mac]').checked = true;
  $('#whereHint').textContent = whereValue() === 'online'
    ? 'Works from anywhere. Lives on your team\'s online hub.'
    : `For teammates on the same Wi-Fi. Available while Protoplasma is open.${onlineReady ? '' : ' The online hub isn\'t set up yet.'}`;
}
for (const r of document.querySelectorAll('input[name=where]')) r.onchange = syncWhere;

$('#createTeam').onsubmit = async e => {
  e.preventDefault();
  const button = e.submitter || e.target.querySelector('button');
  try {
    const name = $('#teamName').value.trim();
    if (!name) throw new Error('Give the team a name.');
    button.disabled = true;
    const team = await proto.createTeam({ name, online: whereValue() === 'online' });
    $('#teamName').value = '';
    $('#createErr').textContent = '';
    openTeam(team);
  } catch (err) { $('#createErr').textContent = errorText(err); }
  finally { button.disabled = false; }
};

async function openTeam(team) {
  try {
    const conn = await proto.openTeam(team.key);
    $('#removedNote').hidden = true;
    currentTeam = team;
    store.set('team', team.key);
    clearTeamView();
    $('#settings').close();
    $('#teamSwitch').hidden = false;
    $('#teamLabel').textContent = team.name;
    $('#teamWhere').textContent = team.where;
    $('#start').close();
    watch(conn);
    render();
    checkSetup();
  } catch (e) { $('#err').textContent = errorText(e); }
}
$('#teamSwitch').onclick = () => showTeams(me);

// ---- People ----

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function renderPeople() {
  const { owner, members } = currentTeam, mine = ownsTeam(currentTeam);
  $('#peopleTeam').textContent = `${currentTeam.name}, ${currentTeam.where}`;
  $('#inviteBtn').hidden = !mine;
  setHTML($('#memberList'), [owner, ...members].map(login => `
    <li>${avatar({ login })}<span class="who"><b>${esc(login)}${same(login, me.login) ? ' <span class="where">(you)</span>' : ''}</b></span>
      <span class="role">${login === owner ? 'Owner' : 'Member'}</span>
      ${mine && login !== owner ? `<button class="btn small" data-remove="${esc(login)}">Remove</button>` : ''}</li>`).join(''));
}
$('#memberList').onclick = async e => {
  const login = e.target.dataset.remove;
  if (!login || !confirm(`Remove ${login} from ${currentTeam.name}? Their agents here are disconnected.`)) return;
  try { currentTeam = await proto.removeMember(currentTeam.key, login); $('#peopleErr').textContent = ''; render(); }
  catch (err) { $('#peopleErr').textContent = errorText(err); }
};

$('#inviteBtn').onclick = () => {
  $('#inviteTeam').textContent = currentTeam.name;
  $('#inviteErr').textContent = '';
  $('#inviteLogin').value = '';
  $('#inviteDlg').showModal();
};
$('#shareBtn').onclick = () => $('#inviteBtn').click();
$('#inviteDone').onclick = () => $('#inviteDlg').close();
$('#inviteForm').onsubmit = async e => {
  e.preventDefault();
  const login = $('#inviteLogin').value.trim().replace(/^@/, '');
  if (!GITHUB_LOGIN.test(login)) { $('#inviteErr').textContent = 'Enter a GitHub username.'; return; }
  try { currentTeam = await proto.invite(currentTeam.key, login); $('#inviteDlg').close(); render(); }
  catch (err) { $('#inviteErr').textContent = errorText(err); }
};

// ---- Hub connection ----

function setConnection(state, text) {
  $('#conn').className = `conn ${state}`;
  $('#connText').textContent = text;
}

// Teammates' output arrives via the hub; our own lanes stream over IPC, so they keep working when the hub is down.
function watch(conn) {
  const generation = ++watchGeneration;
  ws?.close();
  (function connect() {
    if (generation !== watchGeneration) return;
    const socket = ws = new WebSocket(`${conn.hub.replace(/^http/, 'ws')}/watch`);
    let first = true;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'watch', token: conn.token, team: conn.id }));
    socket.onmessage = e => {
      const m = JSON.parse(e.data);
      if (first) { // the hub replays scrollback on every (re)connect
        first = false;
        lookedAt = undefined;
        setConnection('live', 'Connected');
        for (const [id, t] of terms) if (!local.has(id)) t.term.reset();
        if ([...local.values()].some(l => l.refused)) proto.rejoin(); // invited back: agents that were turned away try now
      }
      if (m.t === 'state') {
        hubLanes = m.lanes;
        for (const l of hubLanes) if (local.get(l.id)?.refused) delete local.get(l.id).refused;
        teamWatchers = m.watchers || [];
        memories = m.memories || [];
        sessionRecords = m.sessions || [];
        stoppedAgents = m.stopped || [];
        render();
      }
      if (m.t === 'out' && !local.has(m.lane)) write(m.lane, m.d);
      if (m.t === 'replay') showReplay(m);
    };
    socket.onclose = e => {
      if (generation !== watchGeneration) return;
      if (e.code === 4003) return removedFromTeam(e.reason);
      if (e.code >= 4000) return setConnection('retrying', e.reason);
      setConnection('retrying', 'Hub unreachable, retrying');
      setTimeout(connect, 3000);
    };
  })();
}

// Claude Code draws parts of its mascot on a pure black background (even in its light theme), which only blends in on
// a dark page. In light mode those cells get the page colour instead, so they read as gaps the way they do in dark.
// Pure black is true-colour 0,0,0 or colour 16 of the 256-colour palette; the theme's own "black" is left alone.
// ponytail: an escape sequence split across two chunks is left as it is; buffer partial sequences if that shows up.
function whiteForBlack(params) {
  const p = params.split(';'), out = [];
  for (let i = 0; i < p.length; i++) {
    const bg = p[i] === '48', colour = bg || p[i] === '38';
    if (colour && p[i + 1] === '2') {
      const rgb = p.slice(i + 2, i + 5);
      out.push(p[i], '2', ...(bg && rgb.join() === '0,0,0' ? ['255', '255', '255'] : rgb));
      i += 4;
    } else if (colour && p[i + 1] === '5') {
      out.push(p[i], '5', bg && p[i + 2] === '16' ? '231' : p[i + 2]); // 231 is white
      i += 2;
    } else out.push(p[i]);
  }
  return out.join(';');
}
const forPage = data => (effectiveTheme() !== 'light' ? data : data.replace(/\x1b\[([\d;]*)m/g, (_, params) => `\x1b[${whiteForBlack(params)}m`));
function write(id, data) {
  data = forPage(data);
  const t = terms.get(id);
  if (t) t.term.write(data);
  else pending.set(id, (pending.get(id) || '') + data);
}
proto.onData(write);
proto.onExit(id => {
  local.delete(id);
  stopping.delete(id);
  if (terms.has(id)) dropTerminal(id); // even when no team is open (signed out), so nothing lingers
  pending.delete(id);
  hubLanes = hubLanes.filter(l => l.id !== id);
  render();
});
proto.onRefused((id, reason) => {
  const lane = local.get(id);
  if (lane) { lane.refused = reason; render(); }
});

// ---- New session, and adding agents to one ----

// Where this Mac works on a session: what it was started with here, else the session's GitHub repo.
const sourceKey = session => `source:${currentTeam.key}:${session}`;
function sourceFor(session) {
  try { const saved = JSON.parse(store.get(sourceKey(session)) || 'null'); if (saved) return saved; } catch {}
  const repo = hubLanes.find(l => l.session === session && l.repo)?.repo || recordFor(session)?.repo;
  return repo ? { repo, worktree: prefs.sessionBranches } : null;
}

// Starts an agent and shows it. `source` is { repo, worktree } or { cwd }; `resume` picks up the agent's last
// conversation in that folder. A renamed session's folder and branch keep its original key.
const lastAgentKey = session => `lastAgent:${currentTeam.key}:${session}`;
async function startAgent({ session, cmd, open, source, task, resume = false }) {
  if (task && recordFor(session)?.task !== task) sessionRecords = await proto.saveSession(currentTeam.key, { name: session, task });
  const opts = { session, cmd, open, resume, folderKey: recordFor(session)?.key, ...source };
  const { id, repo } = await proto.startLane(opts);
  local.set(id, { teamKey: currentTeam.key, session, cmd, open, ...source, repo, login: me.login, name: me.name, avatar: me.avatar });
  store.set(sourceKey(session), JSON.stringify(source));
  store.set(lastAgentKey(session), cmd);
  openSession(session, id);
}
// The agent this Mac last ran in a session, if it can pick that conversation back up.
// Your agent that stopped most recently in this session, or else the last kind you started here.
const resumable = session => (sourceFor(session) && (stoppedAgents.find(s => s.session === session && same(s.login, me.login))?.cmd
  || store.get(lastAgentKey(session)))) || '';
async function resumeAgent() {
  const cmd = resumable(current);
  if (!cmd) return openNewAgent(current);
  try { await startAgent({ session: current, cmd, open: prefs.open, source: sourceFor(current), resume: true }); }
  catch (err) { alert(errorText(err)); }
}

// Only agents this Mac can run are offered; the rest are shown as not installed.
const refreshAgents = () => proto.agents().then(list => { agents = list; syncAgents(); });
const isInstalled = cmd => agents.find(a => a.cmd === cmd)?.installed !== false;
function syncAgents() {
  for (const input of document.querySelectorAll('input[name=cmd]')) {
    input.disabled = !isInstalled(input.value);
    input.nextElementSibling.title = input.disabled ? 'Not installed on this Mac' : '';
  }
  if ($('input[name=cmd]:checked')?.disabled) (document.querySelector('input[name=cmd]:not(:disabled)') || {}).checked = true;
  const missing = [...document.querySelectorAll('input[name=cmd]:disabled')].map(i => agentName(i.value));
  $('#agentHint').hidden = !missing.length;
  $('#agentHint').textContent = missing.length ? `${missing.join(' and ')} ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} installed on this Mac.` : '';
}

// With `session`, the form adds an agent to that session; without, it starts a new one.
async function openNewAgent(session) {
  const adding = !!session && (!!recordFor(session) || hubLanes.some(l => l.session === session));
  $('#agentTitle').textContent = adding ? 'Add an agent' : 'New session';
  $('#agentLede').textContent = `Signed in with GitHub as @${me.login}. Agents run on this Mac, under your own account.`;
  $('#startAgent').textContent = adding ? 'Start agent' : 'Start the session';
  $('#sessionList').innerHTML = [...new Set([...hubLanes.map(l => l.session), ...sessionRecords.filter(x => !x.done).map(x => x.name)])]
    .map(s => `<option value="${esc(s)}">`).join('');
  $('#session').value = session ?? '';
  $('#task').value = recordFor($('#session').value.trim())?.task || '';
  $('#task').dataset.from = recordFor($('#session').value.trim())?.name || '';
  $('#repo').value = (session && sourceFor(session)?.repo) || $('#repo').value || store.get('repo');
  if (!$('#cwd').value) showFolder(store.get('cwd'));
  const known = session && sourceFor(session); // an existing session keeps the kind of source it already uses
  $(`input[name=source][value=${(known ? known.cwd : store.get('sourceKind') === 'folder') ? 'folder' : 'repo'}]`).checked = true;
  $('#agentErr').textContent = '';
  $(`input[name=cmd][value=${prefs.agent}]`).checked = true;
  $('#open').checked = prefs.open;
  $('#repoHint').textContent = prefs.sessionBranches
    ? 'The session gets its own branch (session/…) and folder under ~/Protoplasma, so main only changes through a push or pull request.'
    : 'Cloned into ~/Protoplasma. The agent works on the repo\'s current branch (change this in Settings).';
  syncAgents();
  refreshAgents();
  $('#agent').showModal();
  syncSource();
  renderRepoPicker();
  if (repos) return;
  try {
    reposError = '';
    repos = await proto.repos();
  } catch (e) {
    reposError = errorText(e);
    if (!known?.repo) { $('input[name=source][value=folder]').checked = true; syncSource(); } // a repo session keeps its repo
  }
  renderRepoPicker();
}

// Your repos and the ones shared with you, filtered by what's typed. A full owner/name that isn't listed still works.
function renderRepoPicker() {
  const picker = $('#repoPicker');
  if (reposError) return setHTML(picker, `<p class="repo-note">${esc(reposError)}</p>`);
  if (!repos) return setHTML(picker, '<p class="repo-note">Loading your repos…</p>');
  const typed = $('#repo').value.trim().toLowerCase();
  const selected = repos.some(r => r.name.toLowerCase() === typed);
  const shown = selected || !typed ? repos : repos.filter(r => `${r.name} ${r.description}`.toLowerCase().includes(typed));
  const row = r => `
    <button type="button" class="repo-row ${r.name.toLowerCase() === typed ? 'on' : ''}" data-repo="${esc(r.name)}" role="option" aria-selected="${r.name.toLowerCase() === typed}">
      <span class="repo-name">${esc(r.name)}</span><span class="repo-tag">${r.private ? 'Private' : 'Public'}</span>
      ${r.description ? `<span class="repo-desc">${esc(r.description)}</span>` : ''}
    </button>`;
  const group = (label, list) => (list.length ? `<div class="repo-group">${label}</div>${list.map(row).join('')}` : '');
  setHTML(picker, group('Yours', shown.filter(r => r.mine)) + group('Shared with you', shown.filter(r => !r.mine))
    || `<p class="repo-note">${REPO.test($('#repo').value.trim()) ? 'Not in your list. Start the agent to use it anyway.' : 'No repos match.'}</p>`);
  picker.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
$('#repo').oninput = renderRepoPicker;
$('#repoPicker').onclick = e => {
  const row = e.target.closest('[data-repo]');
  if (row) { $('#repo').value = row.dataset.repo; renderRepoPicker(); }
};
// A long path is shown from its end, which is the part that tells folders apart.
const showFolder = dir => { const el = $('#cwd'); el.value = el.title = dir; el.scrollLeft = el.scrollWidth; };
const syncSource = () => {
  const fromRepo = $('input[name=source]:checked').value === 'repo';
  $('#repoField').hidden = !fromRepo;
  $('#folderField').hidden = fromRepo;
  showFolder($('#cwd').value);
};
for (const r of document.querySelectorAll('input[name=source]')) r.onchange = syncSource;
// The dialog follows the name typed: an existing session gets an agent added (with its goal), a new name starts one.
function syncSessionName() {
  const name = existingSession($('#session').value.trim()), rec = recordFor(name);
  const adding = !!rec || hubLanes.some(l => l.session === name);
  if (rec) $('#task').value = rec.task || '';
  else if ($('#task').dataset.from) $('#task').value = ''; // a goal filled in from another session doesn't carry over
  $('#task').dataset.from = rec ? rec.name : '';
  $('#agentTitle').textContent = adding ? 'Add an agent' : 'New session';
  $('#startAgent').textContent = adding ? 'Start agent' : 'Start the session';
}
$('#session').oninput = syncSessionName;
$('#task').oninput = () => { $('#task').dataset.from = ''; };
$('#new').onclick = () => openNewAgent();
$('#cancel').onclick = () => $('#agent').close();
$('#pick').onclick = async () => {
  const dir = await proto.pickFolder($('#cwd').value);
  if (dir) { showFolder(dir); store.set('cwd', dir); }
};
// A name that matches an existing session apart from case and punctuation joins it, since both would get the same
// branch and folder. Same rule as slug() in src/shared.js.
const slug = name => String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'session';
const existingSession = name => sessionList(board).find(s => slug(s.name) === slug(name))?.name;
$('#agentForm').onsubmit = async e => {
  e.preventDefault();
  const fromRepo = $('input[name=source]:checked').value === 'repo';
  const typed = $('#session').value.trim();
  const session = typed && (existingSession(typed) ?? typed);
  const source = fromRepo ? { repo: $('#repo').value.trim(), worktree: prefs.sessionBranches } : { cwd: $('#cwd').value };
  const button = $('#startAgent'), label = button.textContent;
  $('#agentErr').textContent = '';
  try {
    if (!session) throw new Error('Name the session.');
    if (fromRepo && !REPO.test(source.repo)) throw new Error('Pick a repo, like owner/name.');
    if (!fromRepo && !source.cwd) throw new Error('Choose a folder.');
    button.disabled = true;
    button.textContent = fromRepo ? 'Getting the repo…' : 'Starting…';
    await startAgent({ session, cmd: $('input[name=cmd]:checked').value, open: $('#open').checked, source, task: $('#task').value.trim() });
    if (fromRepo) store.set('repo', source.repo);
    store.set('sourceKind', fromRepo ? 'repo' : 'folder');
    $('#agent').close();
  } catch (err) {
    $('#agentErr').textContent = errorText(err);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
};

// The "+" in the session panel: another agent where this session already works, without the form.
async function addAgent(cmd) {
  const source = sourceFor(current);
  if (!source) return openNewAgent(current); // no repo, and this Mac hasn't worked on it yet: ask for a folder
  try { await startAgent({ session: current, cmd, open: prefs.open, source }); }
  catch (err) { alert(errorText(err)); }
}
function agentMenu(anchor) {
  refreshAgents();
  const last = resumable(current);
  showMenu(anchor, [...(last ? [{ text: `Resume ${agentName(last)}`, hint: 'last conversation', run: resumeAgent }] : []),
    { label: 'Add an agent' }, ...['claude', 'codex', 'opencode'].map(cmd =>
    ({ text: agentName(cmd), disabled: !isInstalled(cmd), hint: isInstalled(cmd) ? '' : 'Not installed', run: () => addAgent(cmd) }))]);
}

// A small pop-up menu under a button. Items are { text, hint, disabled, run }, or { label } for a heading.
const closeMenu = () => document.querySelector('.menu')?.remove();
function showMenu(anchor, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = items.map((it, i) => (it.label ? `<div class="menu-label">${esc(it.label)}</div>`
    : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''}>${esc(it.text)}${it.hint ? `<span>${esc(it.hint)}</span>` : ''}</button>`)).join('');
  menu.onclick = e => { const it = items[e.target.closest('button')?.dataset.i]; if (it) { closeMenu(); it.run(); } };
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
}
addEventListener('pointerdown', e => { if (!e.target.closest('.menu')) closeMenu(); }, true);

// ---- Navigation ----

// The sidebar can be tucked away (⌘B), as in Amoeba; the choice is remembered on this Mac.
function toggleSidebar(hide = !document.body.classList.contains('sidebar-hidden')) {
  document.body.classList.toggle('sidebar-hidden', hide);
  store.set('sidebarHidden', hide ? '1' : '');
  fitTeammates();
}
$('#sidebarToggle').onclick = () => toggleSidebar();
toggleSidebar(store.get('sidebarHidden') === '1');
$('#allWorkspaces').onclick = () => go('sessions');

function go(next, repo = null) {
  closeMenu();
  view = next;
  filterRepo = repo;
  current = null;
  $('#settings').close();
  render();
}
function openSession(name, laneId = null) {
  closeMenu();
  if (name !== current) code.on = false; // a session opens on its agents; the code comes up when you open a file
  if (laneId) Object.assign(code, { dock: 'agent', dockHidden: false }); // and an agent asked for by name is brought forward
  view = 'session';
  current = name;
  tab = 'agents';
  focus = laneId;
  split = null;
  $('#settings').close();
  render();
  terms.get(focus)?.term.focus();
}
$('#navSessions').onclick = () => go('sessions');
$('#navPeople').onclick = () => go('people');
$('#workspaces').onclick = e => {
  const menu = e.target.closest('[data-ws-menu]');
  if (menu) return workspaceMenu(menu, menu.dataset.wsMenu);
  if ('unhide' in e.target.dataset) return setHidden([]);
  const session = e.target.closest('[data-session]'), workspace = e.target.closest('[data-repo]');
  if (session) openSession(session.dataset.session);
  else if (workspace) go('sessions', workspace.dataset.repo);
};

const sessionAction = async action => {
  try { sessionRecords = await action(); render(); return true; }
  catch (err) { alert(errorText(err)); return false; }
};
async function deleteSession(name) {
  if (!confirm(`Delete the session "${name}"? Its agents have already stopped; this removes it from the board.`)) return;
  const source = sourceFor(name), key = recordFor(name)?.key || name;
  if (current === name) go('sessions');
  if (!await sessionAction(() => proto.deleteSession(currentTeam.key, name))) return;
  store.set(sourceKey(name), '');
  store.set(lastAgentKey(name), '');
  // Its own folder (and only that: never a folder you picked yourself) can go too, if you say so.
  const folder = source?.repo && source.worktree !== false && await proto.sessionFolder(source.repo, key);
  if (folder && confirm(`Also remove its folder on this Mac?\n\n${folder}\n\nThe session's branch is kept, and a folder with uncommitted changes is never removed. Ignored files in it (like node_modules or .env) are removed.`)) {
    proto.removeSessionFolder(source.repo, key).catch(err => alert(errorText(err)));
  }
}
const toggleDone = name => sessionAction(() => proto.setSessionDone(currentTeam.key, name, !recordFor(name)?.done));

// Renaming only changes the name people see (the hub refuses while agents run); branch and folders keep the original.
let renaming = null;
function openRename(name) {
  renaming = name;
  $('#renameInput').value = name;
  $('#renameErr').textContent = '';
  $('#renameDlg').showModal();
  $('#renameInput').select();
}
$('#renameCancel').onclick = () => $('#renameDlg').close();
$('#renameForm').onsubmit = async e => {
  e.preventDefault();
  const next = $('#renameInput').value.trim();
  if (!next || next === renaming) return $('#renameDlg').close();
  try {
    sessionRecords = await proto.renameSession(currentTeam.key, renaming, next);
    for (const key of [sourceKey, lastAgentKey]) {
      const value = store.get(key(renaming));
      if (value) { store.set(key(next), value); store.set(key(renaming), ''); }
    }
    if (current === renaming) current = next;
    $('#renameDlg').close();
    render();
  } catch (err) { $('#renameErr').textContent = errorText(err); }
};
function stopAgent(id) {
  const busy = ['working', 'needs you'].includes(hubLanes.find(l => l.id === id)?.status);
  if (busy && !confirm('This agent is in the middle of something. Stop it anyway?')) return;
  proto.kill(id);
  stopping.add(id); // an agent can take a couple of seconds to shut down
  render();
}
const statusOf = l => (stopping.has(l.id) ? 'stopping' : l.status);
// "Claude Code", or "Claude Code 2" for a person's second agent of the same kind in a session.
const agentLabel = (l, inRoom) => {
  const nth = inRoom.filter(o => o.login === l.login && o.cmd === l.cmd).sort((a, b) => (a.startedAt || '~').localeCompare(b.startedAt || '~')).indexOf(l);
  return agentName(l.cmd) + (nth > 0 ? ` ${nth + 1}` : '');
};

// ---- Rendering ----

function render() {
  if (!currentTeam) return;
  // Hub state plus any local lanes it hasn't reported yet (just started, hub down, or refused).
  const mine = [...local].filter(([id, o]) => o.teamKey === currentTeam.key && !hubLanes.some(l => l.id === id));
  const lanes = board = [...hubLanes, ...mine.map(([id, o]) => ({ id, ...o, status: o.refused ? `Not shared: ${o.refused}` : 'not synced', files: [], overlaps: [] }))];
  assignColors(lanes.map(l => l.login));
  const looking = view === 'session' ? current : null;
  if (lookedAt !== looking && ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ t: 'look', session: looking })); lookedAt = looking; }
  const inSettings = $('#settings').open;
  $('#navSessions').classList.toggle('on', !inSettings && view === 'sessions' && filterRepo === null);
  $('#navPeople').classList.toggle('on', !inSettings && view === 'people');
  $('#sessionsPage').hidden = view !== 'sessions';
  $('#peoplePage').hidden = view !== 'people';
  $('#room').hidden = view !== 'session';
  renderAlerts(lanes);
  renderWorkspaces(lanes);
  if (view === 'sessions') renderSessions(lanes);
  if (view === 'people') renderPeople();
  renderRoom(lanes); // always: it also decides which terminals exist and which are on screen
  notifyChanges(lanes);
}

// Actionable items only: agents waiting on a person, and files edited by more than one agent.
const canAnswer = l => local.has(l.id) || l.open;
function renderAlerts(lanes) {
  const waiting = lanes.filter(l => l.status === 'needs you' && canAnswer(l)).map(l => `
    <button class="alert" data-session="${esc(l.session)}" data-lane="${esc(l.id)}"><b>${local.has(l.id) ? 'Your agent needs you' : `${esc(l.name)}'s agent is waiting for an answer`}</b><span>${esc(l.session)}</span></button>`);
  const clashes = [...new Set(lanes.flatMap(l => l.overlaps))].map(file => {
    const who = lanes.filter(l => l.overlaps.includes(file));
    return `<button class="alert overlap" data-session="${esc(who[0].session)}" data-file="${esc(file)}"><b>${esc(whoEdited(who.map(l => l.name)))} edited</b><span>${esc(file)}</span></button>`;
  });
  setHTML($('#alerts'), [...waiting, ...clashes].slice(0, 4).join(''));
}
$('#alerts').onclick = e => {
  const a = e.target.closest('[data-session]');
  if (!a) return;
  openSession(a.dataset.session, a.dataset.lane || null);
  if (a.dataset.file) openFile(a.dataset.file);
};

// Notify when an agent we can answer needs input, or one of ours finishes, unless that session is already in view.
// The Dock badge counts agents waiting on input.
function notifyChanges(lanes) {
  for (const l of lanes) {
    const before = lastStatus.get(l.id);
    lastStatus.set(l.id, l.status);
    if (before === undefined || before === l.status) continue;
    if (document.hasFocus() && view === 'session' && current === l.session && tab === 'agents') continue;
    const mine = local.has(l.id);
    let title;
    if (l.status === 'needs you' && canAnswer(l) && prefs.notifyNeeds) title = mine ? 'Your agent needs you' : `${l.name}'s agent needs you`;
    else if (mine && before === 'working' && l.status === 'idle' && prefs.notifyDone) title = 'Your agent finished';
    if (!title) continue;
    const note = new Notification(title, { body: l.session });
    note.onclick = () => { proto.focus(); openSession(l.session, l.id); };
  }
  for (const id of lastStatus.keys()) if (!lanes.some(l => l.id === id)) lastStatus.delete(id);
  proto.setBadge(prefs.badge ? lanes.filter(l => l.status === 'needs you' && canAnswer(l)).length : 0);
}

const recordFor = name => sessionRecords.find(x => x.name === name);
const canManage = rec => !!rec && [rec.createdBy, currentTeam.owner].some(l => same(l, me.login));

// Every session on the board: the saved ones, plus any that only exist as running agents.
function sessionList(lanes) {
  const byName = Map.groupBy(lanes, l => l.session);
  return [...new Set([...sessionRecords.map(x => x.name), ...byName.keys()])].map(name => {
    const ls = byName.get(name) || [], rec = recordFor(name);
    return { name, rec, lanes: ls, repo: ls.find(l => l.repo)?.repo || rec?.repo || '',
      status: ls.length ? sessionStatus(ls) : rec?.done ? 'done' : 'idle',
      at: ls.map(l => l.lastActive).concat(rec?.doneAt || rec?.createdAt || '').filter(Boolean).sort().pop() || '' };
  });
}

// The sidebar's workspaces: each repo the team has open sessions in, with those sessions under it. Like Amoeba's,
// a workspace can be hidden from this Mac's sidebar (its sessions stay on the Sessions page).
const hiddenKey = () => `hiddenWorkspaces:${currentTeam.key}`;
const hiddenWorkspaces = () => { try { return JSON.parse(store.get(hiddenKey()) || '[]'); } catch { return []; } };
const setHidden = list => { store.set(hiddenKey(), JSON.stringify(list)); render(); };
function renderWorkspaces(lanes) {
  const open = sessionList(lanes).filter(s => s.status !== 'done');
  const hidden = hiddenWorkspaces();
  const all = [...new Set(open.map(s => s.repo))].sort((a, b) => !a - !b || a.localeCompare(b)); // folders with no GitHub repo go last
  const workspaces = all.filter(repo => !hidden.includes(repo));
  const tucked = all.length - workspaces.length;
  setHTML($('#workspaces'), workspaces.map(repo => `
    <div class="ws-row">
      <button class="ws ${view === 'sessions' && filterRepo === repo ? 'on' : ''}" data-repo="${esc(repo)}" title="${esc(repo || 'Sessions in folders with no GitHub repo')}"><svg><use href="#folder"/></svg><span>${esc(repo || 'Local folders')}</span></button>
      <button class="icon-btn small ws-menu" data-ws-menu="${esc(repo)}" aria-label="Workspace actions">⋯</button>
    </div>
    ${open.filter(s => s.repo === repo).map(s => `<button class="ws-session ${view === 'session' && current === s.name ? 'on' : ''}" data-session="${esc(s.name)}"><span>${esc(s.name)}</span><span class="dot ${STATUS[s.status]?.[0] || ''}"></span></button>`).join('')}`).join('')
    + (tucked ? `<button class="ws-more" data-unhide>Show ${tucked} hidden workspace${tucked === 1 ? '' : 's'}</button>` : '')
    || '<p class="hint">A repo shows up here once a session uses it.</p>');
}
function workspaceMenu(anchor, repo) {
  showMenu(anchor, [{ label: repo || 'Local folders' },
    ...(repo ? [{ text: 'Open on GitHub', run: () => proto.openExternal(`https://github.com/${repo}`) },
      { text: 'Show in Finder', run: () => proto.revealRepo(repo).catch(err => alert(errorText(err))) }] : []),
    { text: 'Hide from sidebar', run: () => { setHidden([...hiddenWorkspaces(), repo]); if (filterRepo === repo) go('sessions'); } }]);
}

function renderSessions(lanes) {
  const query = $('#search').value.trim().toLowerCase();
  const rank = s => (s.lanes.length ? 0 : s.status === 'done' ? 2 : 1);
  const list = sessionList(lanes)
    .filter(s => filterRepo === null || s.repo === filterRepo)
    .filter(s => !query || `${s.name} ${s.rec?.task || ''} ${s.repo}`.toLowerCase().includes(query))
    .sort($('#sortBy').value === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));
  setHTML($('#filterChip'), filterRepo === null ? '' : `<span class="chip">${esc(filterRepo || 'Local folders')}<button data-clear aria-label="Show sessions from all workspaces">×</button></span>`);
  setHTML($('#sessions'), list.map(s => {
    const n = s.lanes.length;
    return `
    <div class="card" data-session="${esc(s.name)}" role="button" tabindex="0">
      <div class="card-top"><span class="card-title">${esc(s.name)}</span>${canManage(s.rec) ? `<button class="icon-btn" data-menu="${esc(s.name)}" aria-label="Session menu">⋯</button>` : ''}</div>
      ${s.rec?.task ? `<div class="card-task">${esc(s.rec.task)}</div>` : ''}
      <div class="card-status">${pill(s.status)}<span>${n ? `${n} agent${n === 1 ? '' : 's'} running` : 'No agents running'}</span></div>
      ${n ? `<div class="card-agents">${esc([...new Set(s.lanes.map(l => agentName(l.cmd)))].join(', '))}</div>` : ''}
      ${branchLine(s.lanes)}
      ${fileList(s.lanes)}
      <div class="card-people">${n ? people(s.lanes) : `<span>${esc(s.repo)}</span>`}${s.at ? `<span class="ago">${ago(s.at)}</span>` : ''}</div>
    </div>`;
  }).join('') || `<p class="hint">${query || filterRepo !== null ? 'No sessions match.' : 'No sessions yet. Start one with New, or wait for a teammate to start theirs.'}</p>`);
}
$('#sessions').onclick = e => {
  const menu = e.target.closest('[data-menu]');
  if (menu) return sessionMenu(menu, menu.dataset.menu);
  const card = e.target.closest('[data-session]');
  if (card) openSession(card.dataset.session);
};
$('#sessions').onkeydown = e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-session]')) { e.preventDefault(); openSession(e.target.dataset.session); }
};
$('#filterChip').onclick = e => { if ('clear' in e.target.dataset) go('sessions'); };
$('#search').oninput = $('#sortBy').onchange = () => render();
function sessionMenu(anchor, name) {
  const done = recordFor(name)?.done, running = hubLanes.some(l => l.session === name);
  showMenu(anchor, [{ label: name },
    ...(ownsTeam(currentTeam) ? [{ text: 'Share…', run: () => $('#inviteBtn').click() }] : []),
    { text: 'Rename…', disabled: running, hint: running ? 'Agents running' : '', run: () => openRename(name) },
    { text: done ? 'Reopen' : 'Mark done', disabled: running, hint: running ? 'Agents running' : '', run: () => toggleDone(name) },
    { text: 'Delete session', disabled: running, hint: running ? 'Stop its agents first' : '', run: () => deleteSession(name) }]);
}

// Uncommitted changes, as the agents' git status reports them. Agents sharing a checkout are counted once.
const diffStat = lanes => {
  const g = [...new Map(lanes.filter(l => l.git).map(l => [l.tree || l.id, l.git])).values()];
  if (!g.some(x => x.added || x.removed || x.files)) return '';
  const files = g.reduce((n, x) => n + x.files, 0);
  return `<span class="diff" title="${files} file${files === 1 ? '' : 's'} changed"><span class="add">+${g.reduce((n, x) => n + x.added, 0)}</span><span class="del">−${g.reduce((n, x) => n + x.removed, 0)}</span></span>`;
};
// Commits a lane's branch is missing from its upstream.
const behindChip = l => (l.git?.behind ? `<span class="behind" title="${l.git.behind} commit${l.git.behind === 1 ? '' : 's'} behind. Pull before pushing.">↓${l.git.behind}</span>` : '');
const branchLine = lanes => {
  const names = [...new Set(lanes.map(l => l.branch).filter(Boolean))];
  const diff = diffStat(lanes);
  const behind = behindChip({ git: { behind: Math.max(0, ...lanes.map(l => l.git?.behind || 0)) } });
  return names.length || diff ? `<div class="card-branch"><svg><use href="#branch"/></svg>${esc(names.join(', '))}${behind}${diff}</div>` : '';
};
const lastActive = lanes => {
  const at = lanes.map(l => l.lastActive).filter(Boolean).sort().pop();
  return at ? `<span class="ago">${ago(at)}</span>` : '';
};

// Edited files, with overlaps (edited by more than one agent) first.
function fileList(lanes, max = 4) {
  const editors = new Map();
  for (const l of lanes) for (const f of l.files) editors.set(f, [...(editors.get(f) || []), l.name]);
  const clash = f => lanes.some(l => l.overlaps.includes(f));
  const files = [...editors.keys()].sort((a, b) => clash(b) - clash(a));
  if (!files.length) return '';
  return `<ul class="files">${files.slice(0, max).map(f => `
    <li class="${clash(f) ? 'overlap' : ''}" data-open-file="${esc(f)}" title="Open ${esc(f)}"><span class="path" title="${esc(f)}">${esc(f)}</span>${clash(f) ? `<span class="who">${esc(whoEdited(lanes.filter(l => l.overlaps.includes(f)).map(l => l.name)))}</span>` : ''}</li>`).join('')}
    ${files.length > max ? `<li class="more">${files.length - max} more</li>` : ''}</ul>`;
}

// The session view. One agent fills the stage (yours unless you pick another), with an optional second pane.
function renderRoom(lanes) {
  const showing = view === 'session';
  const inRoom = showing ? lanes.filter(l => l.session === current) : [];
  const rec = recordFor(current);
  if (showing && !inRoom.length && !rec) return go('sessions'); // it was deleted
  roomRepo = inRoom.find(l => l.repo)?.repo || (showing && rec?.repo) || '';
  if (!roomRepo && (tab === 'pulls' || tab === 'issues')) tab = 'agents';
  const here = id => inRoom.some(l => l.id === id);
  if (!here(focus)) focus = (inRoom.find(l => local.has(l.id)) || inRoom[0])?.id ?? null;
  if (!here(split) || split === focus) split = null;
  const onStage = tab === 'agents' ? [focus, split] : [];

  for (const id of terms.keys()) if (!lanes.some(l => l.id === id) && !local.has(id)) dropTerminal(id);
  for (const t of terms.values()) t.el.hidden = true; // local lanes on other teams stay alive, just hidden
  for (const l of lanes) {
    const t = terms.get(l.id) || createTerminal(l);
    const mine = local.has(l.id);
    t.el.hidden = !onStage.includes(l.id);
    gpu(t, !t.el.hidden);
    if (!t.el.hidden && !t.shown) requestAnimationFrame(() => t.term.scrollToBottom()); // output while hidden can leave it scrolled up
    t.shown = !t.el.hidden;
    t.el.style.setProperty('--c', colorFor(l.login));
    if (!mine && (t.term.cols !== l.cols || t.term.rows !== l.rows)) t.term.resize(l.cols, l.rows);
    const access = mine ? (l.open ? 'Teammates can type' : 'Only you can type') : (l.open ? 'You can type' : 'View only');
    const agent = agentLabel(l, lanes.filter(o => o.session === l.session));
    const [cls, label] = STATUS[statusOf(l)] || ['idle', l.status];
    setHTML(t.label, mine ? 'Me' : esc(l.name));
    setHTML(t.bar, `<span class="tag" title="${esc(agent)}">${esc(agent)}</span><span class="state ${cls}"><span class="dot"></span>${esc(label)}</span>` +
      `${diffStat([l])}${behindChip(l)}${l.branch ? `<span class="branch" title="${esc(l.branch)}">${esc(l.branch)}</span>` : ''}` +
      (mine && l.typedBy && Date.now() - Date.parse(l.typedAt) < 10 * 60_000 ? `<span class="typed" title="${esc(l.typedBy)} typed into this agent">${esc(l.typedBy)} typed, ${ago(l.typedAt)}</span>` : '') +
      `<span class="access" title="${access}">${access}</span>${mine && !stopping.has(l.id) ? `<button class="btn ghost small" data-stop="${esc(l.id)}">Stop</button>` : ''}`);
  }
  if (!showing) return renderCode();

  const shown = inRoom.find(l => l.id === focus);
  $('#roomTitle').textContent = current;
  $('#roomTask').hidden = !rec?.task;
  $('#roomTask').textContent = $('#roomTask').title = rec?.task || '';
  const ended = tab === 'replay' && stoppedAgents.find(s => s.id === replaying);
  $('#roomWho').hidden = !shown && !ended;
  const several = shown && inRoom.filter(l => l.login === shown.login).length > 1;
  $('#roomWho').textContent = ended ? `${whose(ended)} ${agentName(ended.cmd)}, stopped`
    : !shown ? '' : (local.has(shown.id) ? 'Your agent' : `${shown.name}'s agent`) + (several ? `, ${agentLabel(shown, inRoom)}` : '');
  $('#myAgent').hidden = !shown || local.has(shown.id) || !inRoom.some(l => local.has(l.id));
  $('#newPane').hidden = tab !== 'agents' || inRoom.length < 2;
  $('#newPane').textContent = split ? 'Close pane' : 'New pane';
  $('#shareBtn').hidden = !ownsTeam(currentTeam);
  $('#panel').hidden = panelHidden;
  $('#backBar').hidden = tab === 'agents';
  $('#stageTitle').textContent = { memory: 'Memory', pulls: 'Pull requests', issues: 'Issues' }[tab]
    || (ended ? `${whose(ended)} ${agentName(ended.cmd)}, stopped ${ago(ended.endedAt)}` : tab === 'replay' ? 'Stopped agent' : '');
  $('#replayPanel').hidden = tab !== 'replay';
  $('#replayScreen').hidden = !ended;
  $('#replayGone').hidden = tab !== 'replay' || !!ended;
  $('#lanes').hidden = tab !== 'agents';
  $('#memoryPanel').hidden = tab !== 'memory';
  $('#ghPanel').hidden = tab !== 'pulls' && tab !== 'issues';
  if (tab === 'memory') renderMemory(lanes);
  $('#empty').hidden = inRoom.length > 0;
  const last = resumable(current);
  $('#resumeBtn').hidden = !last;
  $('#resumeBtn').textContent = last ? `Resume ${agentName(last)}` : '';
  $('#emptyNew').classList.toggle('primary', !last);
  $('#emptyText').textContent = rec?.done ? 'This session is done. Add an agent to pick it back up.' : 'No agents are running in this session.';
  renderPanel(inRoom, rec);
  const watching = teamWatchers.filter(w => w.session === current && w.login !== me?.login);
  setHTML($('#roomWatching'), watching.length ? `<span class="stack">${watching.map(avatar).join('')}</span>watching` : '');
  fitTeammates();
  renderCode();
}

// The panel beside the stage. Session: everyone here and their agents. Environment: the code they're working in.
function renderPanel(inRoom, rec) {
  for (const b of $('.panel-tabs').children) b.classList.toggle('on', b.dataset.panel === panelTab);
  $('#commentForm').hidden = panelTab !== 'session';
  if (panelTab === 'environment') return setHTML($('#panelBody'), environment(inRoom, rec));
  const notes = roomNotes().length;
  // You come first, so there's always somewhere to add an agent.
  setHTML($('#panelBody'), [...new Set([me.login, ...inRoom.map(l => l.login)])].map(login => {
    const theirs = inRoom.filter(l => l.login === login), mine = login === me.login, who = theirs[0] || me;
    const at = theirs.map(l => l.lastActive).filter(Boolean).sort().pop();
    return `
    <div class="person">
      <div class="person-head">${avatar(who)}<b>${esc(who.name || who.login)}${mine ? ' <span>(you)</span>' : ''}</b>${mine ? '<button class="add-agent" data-add aria-label="Add an agent" title="Add an agent">+</button>' : ''}</div>
      <div class="person-meta"><span>${same(login, currentTeam.owner) ? 'Owner' : 'Member'}</span><span>${theirs.length ? `${(STATUS[sessionStatus(theirs)] || [])[1]?.toLowerCase() || ''}${at ? `, ${ago(at)}` : ''}` : 'no agents here'}</span></div>
      ${theirs.map(l => agentCard(l, agentLabel(l, inRoom))).join('')}
    </div>`;
  }).join('') + stoppedRows() + `<button class="panel-row" data-tab="memory"><b>Memory</b><span>${notes ? `${notes} note${notes === 1 ? '' : 's'}` : 'No notes yet'}</span></button>`
    + '<div class="panel-label">Comments</div>' + comments(rec));
}
// Agents that stopped in this session. The hub keeps the last of their output for a while.
const whose = agent => (same(agent.login, me.login) ? 'Your' : `${agent.name || agent.login}'s`);
function stoppedRows() {
  const ended = stoppedAgents.filter(s => s.session === current).slice(0, 5);
  return ended.length ? '<div class="panel-label">Stopped agents</div>' + ended.map(s => `
    <button class="panel-row" data-replay="${esc(s.id)}"><b>${esc(whose(s))} ${esc(agentName(s.cmd))}</b><span>${ago(s.endedAt)}</span></button>`).join('') : '';
}
let replayTerm;
function openReplay(id) {
  replaying = id;
  tab = 'replay';
  render();
  if (!replayTerm) {
    replayTerm = new Terminal({ fontSize: prefs.fontSize, lineHeight: prefs.lineHeight, fontFamily: terminalFont(), theme: terminalTheme(),
      minimumContrastRatio: contrastFloor(), disableStdin: true, scrollback: 5000 });
    replayTerm.open($('#replayScreen'));
    gpu({ term: replayTerm }, true);
  }
  replayTerm.reset();
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'replay', id }));
}
function showReplay(m) {
  if (m.id !== replaying || !replayTerm) return;
  const agent = stoppedAgents.find(s => s.id === m.id);
  replayTerm.reset();
  if (agent) replayTerm.resize(agent.cols, agent.rows);
  replayTerm.write(forPage(m.d));
  fitReplay();
}
// Like a teammate's pane: the owner's dimensions, with the font scaled to fit the stage.
function fitReplay() {
  if (!replayTerm || $('#replayPanel').hidden) return;
  const room = $('#replayPanel').clientWidth - 64;
  replayTerm.options.fontSize = Math.max(8, Math.min(prefs.fontSize, Math.floor(room / (replayTerm.cols * CHAR_WIDTH) * 2) / 2));
}

// Someone's profile as this app knows it (picture included), falling back to just their login.
const person = login => (same(login, me.login) ? me : board.find(l => same(l.login, login)) || { login });
// Comments are for the people in a session (Memory is for the agents).
function comments(rec) {
  const list = rec?.comments || [];
  const removable = c => same(c.author, me.login) || ownsTeam(currentTeam);
  return list.map(c => `
    <div class="comment">${avatar(person(c.author))}<div class="comment-body"><div><b>${esc(c.author)}</b><span class="ago">${ago(c.at)}</span></div><p>${esc(c.text)}</p></div>
      ${removable(c) ? `<button class="stop" data-uncomment="${esc(c.id)}" aria-label="Remove comment" title="Remove comment">×</button>` : ''}</div>`).join('')
    || '<p class="panel-empty">Nothing yet. Leave a note for the people in this session.</p>';
}
$('#commentForm').onsubmit = async e => {
  e.preventDefault();
  const text = $('#commentText').value.trim();
  if (!text) return;
  if (await sessionAction(() => proto.addComment(currentTeam.key, current, text))) {
    $('#commentText').value = '';
    $('#panelBody').scrollTop = $('#panelBody').scrollHeight;
  }
};
function agentCard(l, name) {
  const mine = local.has(l.id), [cls, label] = STATUS[statusOf(l)] || ['idle', l.status];
  // Like Amoeba's agent cards: the latest prompt, with an overlap flagged above it.
  const overlap = l.overlaps.length ? `Overlap in ${l.overlaps[0]}` : '';
  const own = l.local || l.files; // not what it shares with a teammate's pushed branch
  const detail = l.prompt ? `“${l.prompt}”` : own.length ? `Edited ${own.slice(-2).join(', ')}`
    : mine ? (l.open ? 'Teammates can type' : 'Only you can type') : (l.open ? 'You can type' : 'View only');
  return `
  <div class="agent-card ${[focus, split].includes(l.id) ? 'on' : ''}" data-focus="${esc(l.id)}" style="--c:${colorFor(l.login)}" role="button" tabindex="0">
    <b>${esc(name)}</b>
    <span class="sub ${cls}">${esc(label)}</span>
    ${overlap ? `<span class="sub overlap" title="${esc(overlap)}">${esc(overlap)}</span>` : ''}
    <span class="sub ${l.prompt ? 'prompt' : ''}" title="${esc(detail)}">${esc(detail)}</span>
    ${mine && !stopping.has(l.id) ? `<button class="stop" data-stop="${esc(l.id)}" aria-label="Stop this agent" title="Stop this agent">×</button>` : ''}
  </div>`;
}
function environment(inRoom, rec) {
  const branches = [...new Set(inRoom.map(l => l.branch).filter(Boolean))];
  const behind = Math.max(0, ...inRoom.map(l => l.git?.behind || 0));
  const mine = inRoom.filter(l => local.has(l.id)); // your checkout's commits; teammates' are on their own Macs
  const ahead = Math.max(0, ...mine.map(l => l.git?.ahead || 0)), unpushed = Math.max(0, ...mine.map(l => l.git?.unpushed || 0));
  const github = roomRepo && `https://github.com/${roomRepo}`;
  const row = (label, value, action = '') => `<${action ? 'button' : 'div'} class="panel-row" ${action}><b>${label}</b><span class="mono">${value}</span></${action ? 'button' : 'div'}>`;
  return [
    row('Changes', diffStat(mine.length ? mine : inRoom) || 'None'),
    branches.length ? row('Branch', esc(branches.join(', '))) : '',
    behind ? row('Behind', `${behind} commit${behind === 1 ? '' : 's'}`) : '',
    ahead ? row('Ahead of main', `${ahead} commit${ahead === 1 ? '' : 's'}`) : '',
    unpushed ? row('Not pushed', `${unpushed} commit${unpushed === 1 ? '' : 's'}`) : '',
    fileList(inRoom, 8),
    github ? '<div class="panel-label">GitHub</div>' + row('Repository', esc(roomRepo), `data-url="${esc(github)}"`)
      + row('Pull requests', '', 'data-tab="pulls"') + row('Issues', '', 'data-tab="issues"')
      + (branches.length === 1 ? row('Compare branch', '', `data-url="${esc(`${github}/compare/${branches[0].split('/').map(encodeURIComponent).join('/')}`)}"`) : '') : '',
    canManage(rec) && !inRoom.length ? '<div class="panel-label">Session</div>' + row('Rename session', '', 'data-act="rename"')
      + row(rec.done ? 'Reopen' : 'Mark done', '', 'data-act="done"') + row('Delete session', '', 'data-act="delete"') : '',
  ].join('');
}

$('.panel-tabs').onclick = e => { if (e.target.dataset.panel) { panelTab = e.target.dataset.panel; render(); } };
$('#panelBody').onclick = e => {
  const file = e.target.closest('[data-open-file]');
  if (file) return openFile(file.dataset.openFile);
  if (e.target.dataset.stop) return stopAgent(e.target.dataset.stop);
  if (e.target.dataset.uncomment) return sessionAction(() => proto.removeComment(currentTeam.key, current, e.target.dataset.uncomment));
  const replay = e.target.closest('[data-replay]');
  if (replay) return openReplay(replay.dataset.replay);
  if ('add' in e.target.dataset) return agentMenu(e.target);
  const { focus: lane, tab: next, url, act } = e.target.closest('[data-focus], [data-tab], [data-url], [data-act]')?.dataset || {};
  if (lane) { focus = lane; tab = 'agents'; render(); terms.get(lane)?.term.focus(); }
  if (next) { tab = next; render(); loadPanel(); }
  if (url) proto.openExternal(url);
  if (act === 'done') toggleDone(current);
  if (act === 'rename') openRename(current);
  if (act === 'delete') deleteSession(current);
};
$('#lanes').onclick = e => { if (e.target.dataset.stop) stopAgent(e.target.dataset.stop); };
$('#emptyNew').onclick = () => agentMenu($('#emptyNew'));
$('#resumeBtn').onclick = resumeAgent;
$('#myAgent').onclick = () => { focus = split = null; tab = 'agents'; render(); terms.get(focus)?.term.focus(); };
$('#newPane').onclick = () => {
  const others = board.filter(l => l.session === current && l.id !== focus);
  split = split ? null : (others.find(l => !local.has(l.id)) || others[0])?.id ?? null;
  panelHidden = !!split; // two terminals need the room
  render();
};
$('#panelToggle').onclick = () => { panelHidden = !panelHidden; render(); };
$('#backToAgents').onclick = () => { tab = 'agents'; render(); };
$('#ghPanel').onclick = e => { const item = e.target.closest('[data-url]'); if (item) proto.openExternal(item.dataset.url); };

// Remote terminals keep their owner's dimensions, so scale their font to fit their pane.
const CHAR_WIDTH = 0.61, LINE_HEIGHT = 1.2; // monospace advance width, and line height at 1.0 spacing, relative to font size
const fitFont = (term, box) => Math.max(8, Math.min(prefs.fontSize, Math.floor(Math.min(box.clientWidth / (term.cols * CHAR_WIDTH),
  box.clientHeight / (term.rows * prefs.lineHeight * LINE_HEIGHT)) * 2) / 2));
function fitTeammates() {
  for (const [id, t] of terms) {
    if (t.el.hidden || local.has(id)) continue;
    const size = fitFont(t.term, t.el.querySelector('.screen'));
    if (t.term.options.fontSize !== size) t.term.options.fontSize = size;
  }
}
// Window resizes, ⌘B, ⌘J and opening a second pane all change the room for terminals.
const refit = new ResizeObserver(() => { fitTeammates(); fitReplay(); });
refit.observe($('#lanes'));
refit.observe($('#replayPanel'));
setInterval(() => render(), 30_000); // keeps "2m ago" labels current between updates

// ---- Shared memory ----

// Notes that apply to the open session: its repo's, plus the ones written for every repo.
const roomNotes = () => memories.filter(m => !m.repo || (roomRepo && m.repo === roomRepo));
function renderMemory(lanes) {
  setHTML($('#fileList'), [...new Set(lanes.flatMap(l => l.files))].map(f => `<option value="${esc(f)}">`).join(''));
  const canRemove = m => [m.author, currentTeam.owner].some(l => l.toLowerCase() === me.login.toLowerCase());
  const notes = roomNotes();
  setHTML($('#memoryList'), notes.length ? `<div class="gh-list">${notes.reverse().map(m => `
    <div class="memory">
      <div class="memory-text">${esc(m.text)}</div>
      <div class="memory-meta">${m.file ? `<span class="file">${esc(m.file)}</span>` : `<span>${m.repo ? 'Whole repo' : 'Every repo'}</span>`}${avatar({ login: m.author })}<span>${esc(m.author)}</span><span>${ago(m.at)}</span></div>
      ${canRemove(m) ? `<button class="btn ghost small" data-forget="${esc(m.id)}">Remove</button>` : ''}
    </div>`).join('')}</div>` : '<p class="gh-empty">No notes yet. Add what you\'d tell a new teammate: conventions, gotchas, decisions.</p>');
}
$('#memoryForm').onsubmit = async e => {
  e.preventDefault();
  const note = { text: $('#memoryText').value.trim(), file: $('#memoryFile').value.trim().replace(/^\.?\//, ''), repo: roomRepo };
  if (!note.text) return $('#memoryText').focus();
  const button = e.submitter || $('#memoryForm button');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const known = note.file && await sessionFiles();
    if (known && !known.includes(note.file)) {
      const like = known.filter(f => f.endsWith(`/${note.file}`));
      if (like.length !== 1) {
        $('#memoryErr').textContent = like.length ? `More than one file is called ${note.file}. Use its path from the repo root, like ${like[0]}.`
          : `There's no ${note.file} in this repo. Use the file's path from the repo root, like src/app.ts.`;
        return;
      }
      note.file = like[0];
    }
    memories = await proto.addMemory(currentTeam.key, note);
    $('#memoryText').value = $('#memoryFile').value = '';
    $('#memoryErr').textContent = '';
    $('#memoryText').focus();
    render();
  } catch (err) { $('#memoryErr').textContent = errorText(err); } finally { button.disabled = false; }
};
$('#memoryList').onclick = async e => {
  const id = e.target.dataset.forget;
  if (!id) return;
  try { memories = await proto.removeMemory(currentTeam.key, id); render(); }
  catch (err) { $('#memoryErr').textContent = errorText(err); }
};

async function loadPanel() {
  const want = { tab, repo: roomRepo };
  if ((tab !== 'pulls' && tab !== 'issues') || !roomRepo) return;
  const noun = tab === 'pulls' ? 'pull requests' : 'issues';
  $('#ghPanel').innerHTML = `<p class="gh-empty">Loading ${noun}…</p>`;
  let html;
  try {
    const items = await (tab === 'pulls' ? proto.pulls(roomRepo) : proto.issues(roomRepo));
    html = items.length ? `<div class="gh-list">${items.map(it => `
      <button class="gh-item" data-url="${esc(it.url)}">
        <span class="num">#${it.number}</span><span class="title">${esc(it.title)}</span>
        <span class="by">${it.isDraft ? '<span class="pill">Draft</span>' : ''}${avatar({ login: it.author?.login })}${esc(it.author?.login)}</span>
        <span class="when">${ago(it.updatedAt)}</span>
      </button>`).join('')}</div>` : `<p class="gh-empty">No open ${noun} in ${esc(roomRepo)}.</p>`;
  } catch (e) { html = `<p class="gh-empty">${esc(errorText(e))}</p>`; }
  if (tab === want.tab && roomRepo === want.repo) $('#ghPanel').innerHTML = html;
}

// Block characters (Claude's mascot, box drawing) only join up across line spacing with the WebGL renderer. A page
// gets about 16 WebGL contexts, so only the terminals on screen have one; a lost context falls back to the DOM renderer.
function gpu(t, on) {
  if (on === !!t.webgl) return;
  if (!on) { t.webgl.dispose(); t.webgl = null; return; }
  try {
    t.webgl = new WebglAddon.WebglAddon();
    t.webgl.onContextLoss(() => gpu(t, false));
    t.term.loadAddon(t.webgl);
  } catch { t.webgl = null; }
}

function dropTerminal(id) {
  const t = terms.get(id);
  t.resizer?.disconnect();
  t.term.dispose();
  t.el.remove();
  terms.delete(id);
  pending.delete(id);
}

function createTerminal(l) {
  const mine = local.has(l.id);
  const el = document.createElement('section');
  el.className = mine ? 'lane mine' : 'lane';
  el.innerHTML = '<span class="lane-label"></span><div class="screen"></div><div class="lane-bar"></div>';
  $('#lanes').append(el);
  const term = new Terminal({ cols: l.cols || 120, rows: l.rows || 36, fontSize: prefs.fontSize, lineHeight: prefs.lineHeight, fontFamily: terminalFont(),
    theme: terminalTheme(), minimumContrastRatio: contrastFloor(), cursorBlink: mine, disableStdin: !mine && !l.open, scrollback: 5000 });
  term.open(el.querySelector('.screen'));
  let resizer, refit;

  if (mine) {
    // Local lanes fill their column and resize the pty to match.
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.onData(d => proto.write(l.id, d));
    refit = () => {
      if (el.hidden) return;
      const { cols, rows } = term;
      fit.fit();
      if (term.cols !== cols || term.rows !== rows) proto.resize(l.id, term.cols, term.rows);
    };
    resizer = new ResizeObserver(refit);
    resizer.observe(el);
    term.focus();
  } else {
    term.onData(d => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: 'in', lane: l.id, d })));
  }

  // A click anywhere in the pane, not just on the text, is a click in the terminal.
  el.addEventListener('mousedown', e => { if (!e.target.closest('.xterm, .lane-bar')) setTimeout(() => term.focus()); });
  const t = { term, el, label: el.querySelector('.lane-label'), bar: el.querySelector('.lane-bar'), resizer, refit };
  terms.set(l.id, t);
  if (pending.has(l.id)) { term.write(pending.get(l.id)); pending.delete(l.id); }
  return t;
}

// ---- Settings ----

function applyPrefs() {
  document.documentElement.dataset.theme = effectiveTheme();
  proto.setTheme(prefs.theme);
  for (const [id, t] of terms) {
    t.term.options.theme = terminalTheme();
    t.term.options.minimumContrastRatio = contrastFloor();
    t.term.options.fontFamily = terminalFont();
    t.term.options.lineHeight = prefs.lineHeight;
    if (local.has(id)) { t.term.options.fontSize = prefs.fontSize; t.refit(); }
  }
  fitTeammates();
  if (replayTerm) Object.assign(replayTerm.options, { theme: terminalTheme(), minimumContrastRatio: contrastFloor(), fontFamily: terminalFont(), lineHeight: prefs.lineHeight });
  for (const input of document.querySelectorAll('[data-pref]')) {
    if (input.tagName === 'SELECT') input.value = prefs[input.dataset.pref];
    else if (input.type === 'checkbox') input.checked = !!prefs[input.dataset.pref];
    else input.checked = input.value === String(prefs[input.dataset.pref]);
  }
  $('#fontSize').textContent = `${prefs.fontSize}px`;
  $('#lineHeight').textContent = prefs.lineHeight.toFixed(1);
  if ($('#start').open && !$('#signinView').hidden) startCellArt();
}
const savePrefs = () => { store.set('prefs', JSON.stringify(prefs)); applyPrefs(); };
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyPrefs);

function showPane(name) {
  for (const b of $('.settings-nav').querySelectorAll('[data-pane]')) b.classList.toggle('on', b.dataset.pane === name);
  for (const pane of $('.settings-body').querySelectorAll('section')) pane.hidden = pane.dataset.pane !== name;
}
async function openSettings(pane = 'general') {
  const team = currentTeam;
  $('#teamPane').innerHTML = team ? `
    <div class="group"><div class="setting"><div><b>${esc(team.name)}</b><p>${esc(team.where)}, owned by ${esc(team.owner)}</p></div>
      <button class="btn" data-open="people">${ownsTeam(team) ? 'Invite or remove people' : 'See everyone'}</button></div></div>
    <h4>People</h4>
    <div class="group"><ul class="members">${[team.owner, ...team.members].map(login => `<li>${avatar({ login })}<span class="login">${esc(login)}</span>${login === team.owner ? '<span class="where">Owner</span>' : ''}</li>`).join('')}</ul></div>
    <div class="actions" style="justify-content: flex-start; margin-top: 14px"><button class="btn" data-open="teams">Switch team</button>
      <button class="btn ghost" data-drop-team>${ownsTeam(team) ? 'Delete team' : 'Leave team'}</button></div>`
    : '<p class="hint">Open a team to see it here.</p>';
  $('#accountPane').innerHTML = me ? `
    <div class="group">
      <div class="setting"><div class="profile">${avatar(me)}<div><b>${esc(me.name)}</b><p>${me.name === me.login ? 'Signed in with GitHub' : `${esc(me.login)} on GitHub`}. Protoplasma only reads your public profile.</p></div></div>
        <button class="btn" data-open="signout">Sign out</button></div>
      <div class="setting"><div><b>GitHub CLI</b><p id="ghStatus">Checking…</p></div></div>
    </div>
    <p class="fine" style="margin-top: 12px">The GitHub CLI powers the repo list, pull requests and issues, using its own login on this Mac.</p>`
    : '<p class="hint">Sign in to see your account.</p>';
  $('#aboutPane').innerHTML = '<p class="hint">Loading…</p>';
  showPane(pane);
  applyPrefs();
  if (!$('#settings').open) { $('#settings').show(); $('#settings').focus(); render(); } // a page over the main area, not a modal
  proto.agents().then(list => {
    agents = list;
    $('#providers').innerHTML = list.map(a => `<div class="setting"><div><b>${esc(agentName(a.cmd))}</b><p>The <kbd>${esc(a.cmd)}</kbd> command on this Mac.</p></div>
      <span class="where">${a.installed ? 'Installed' : 'Not installed'}</span></div>`).join('');
  });
  proto.ghStatus().then(s => { if ($('#ghStatus')) $('#ghStatus').textContent = s.detail; });
  const info = await proto.appInfo();
  $('#aboutPane').innerHTML = `
    <div class="about"><svg class="mark"><use href="#cell"/></svg><b>Protoplasma ${esc(info.version)}</b>
      <p class="fine">A multiplayer workspace for AI coding agents.</p>
      <button class="linkish" data-url="https://github.com/dw8-ro/protoplasma-ide">github.com/dw8-ro/protoplasma-ide</button></div>
    <h4>Updates</h4>
    <div class="group"><div class="setting"><div><b id="updateStatus">Checking…</b><p>New versions come from GitHub releases and install themselves, so there's nothing to download again.</p></div>
      <button class="btn" data-check-updates>Check now</button></div></div>
    <h4>Online hub</h4>
    <div class="group"><div class="setting"><div><b>${esc(info.onlineHub ? new URL(info.onlineHub).host : 'Not set up')}</b>
      <p>Relays terminals and coordination between teammates. It never sees your repos, and keeps only team names, members, notes, and sessions with their goals and comments.</p></div></div></div>`;
  checkUpdates().then(showUpdateStatus);
}
$('#settingsBtn').onclick = () => openSettings();
const showUpdateStatus = u => {
  if ($('#updateStatus')) $('#updateStatus').textContent = !u ? 'Couldn\'t reach GitHub' : u.available ? `${u.latest} is available` : u.latest ? 'Up to date' : 'No releases yet';
};
$('#settingsDone').onclick = () => $('#settings').close();
$('#settings').addEventListener('close', () => render());
$('#settings').onchange = e => {
  const key = e.target.dataset.pref;
  if (!key) return;
  prefs[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  savePrefs();
};
$('#settings').onclick = e => {
  const { pane, step, line, open, url } = e.target.dataset;
  if (pane && e.target.closest('.settings-nav')) showPane(pane);
  if (step) { prefs.fontSize = Math.max(10, Math.min(18, prefs.fontSize + Number(step))); savePrefs(); }
  if (line) { prefs.lineHeight = Math.round(Math.max(1, Math.min(1.6, prefs.lineHeight + Number(line))) * 10) / 10; savePrefs(); }
  if (url) proto.openExternal(url);
  if ('checkUpdates' in e.target.dataset) { $('#updateStatus').textContent = 'Checking…'; checkUpdates().then(showUpdateStatus); }
  // These two ask first and close Settings themselves, so cancelling leaves you where you were.
  if ('dropTeam' in e.target.dataset) return leaveOrDeleteTeam(currentTeam);
  if (open === 'signout') return $('#signout').click();
  if (open === 'people') go('people');
  if (open === 'teams') { $('#settings').close(); showTeams(me); }
};

// ---- Updates: a newer release on GitHub replaces the app in place (see app/updates.js) ----

let update = null; // the last check's answer: { current, latest, available, canInstall, url }
async function checkUpdates() {
  try { update = await proto.checkUpdates(); } catch { return null; }
  $('#updateBar').hidden = !update.available;
  if (update.available) {
    $('#updateText').textContent = `A Protoplasma update is available (${update.latest}).`;
    $('#updateNow').textContent = update.canInstall ? 'Update now' : 'Download';
    $('#updateNow').disabled = false;
  }
  return update;
}
$('#updateLater').onclick = () => { $('#updateBar').hidden = true; };
$('#updateNow').onclick = async () => {
  if (!update.canInstall) return proto.openExternal(update.url);
  $('#updateNow').disabled = true;
  $('#updateText').textContent = `Downloading ${update.latest}…`;
  try {
    await proto.installUpdate();
    $('#updateText').textContent = `${update.latest} is ready. It goes in as soon as Protoplasma quits.`;
  } catch (err) {
    $('#updateText').textContent = errorText(err);
    $('#updateNow').disabled = false;
  }
};
setInterval(checkUpdates, 6 * 60 * 60_000);

// ---- Quick switcher (⌘K): sessions, workspaces, pages and actions by name ----

let switcherItems = [], switcherIndex = 0, switcherSource;
function switcherCandidates() {
  const list = sessionList(board);
  return [
    ...list.map(s => ({ text: s.name, kind: s.status === 'done' ? 'Session, done' : 'Session', run: () => openSession(s.name) })),
    ...[...new Set(list.map(s => s.repo).filter(Boolean))].map(repo => ({ text: repo, kind: 'Workspace', run: () => go('sessions', repo) })),
    { text: 'Sessions', kind: 'Page', run: () => go('sessions') },
    { text: 'People', kind: 'Page', run: () => go('people') },
    { text: 'Settings', kind: 'Page', run: () => openSettings() },
    { text: 'New session', kind: 'Action', run: () => openNewAgent() },
    ...(ownsTeam(currentTeam) ? [{ text: 'Invite someone', kind: 'Action', run: () => $('#inviteBtn').click() }] : []),
    { text: 'Switch team', kind: 'Action', run: () => showTeams(me) },
    { text: 'Toggle the sidebar', kind: 'Action', run: () => toggleSidebar() },
  ];
}
function renderSwitcher() {
  const query = $('#switcherInput').value.trim().toLowerCase();
  switcherItems = switcherSource().filter(it => !query || it.text.toLowerCase().includes(query)).slice(0, 30);
  switcherIndex = Math.min(switcherIndex, Math.max(0, switcherItems.length - 1));
  $('#switcherList').innerHTML = switcherItems.map((it, i) => `
    <button class="switch-row ${i === switcherIndex ? 'on' : ''}" data-i="${i}" role="option" aria-selected="${i === switcherIndex}"><span>${esc(it.text)}</span><small>${esc(it.kind)}</small></button>`).join('')
    || '<p class="panel-empty">Nothing matches.</p>';
  $('#switcherList .on')?.scrollIntoView({ block: 'nearest' });
}
function openSwitcher(source = switcherCandidates, placeholder = 'Go to a session, page or action') {
  switcherSource = source;
  $('#switcherInput').placeholder = placeholder;
  $('#switcherInput').value = '';
  switcherIndex = 0;
  renderSwitcher();
  $('#switcher').showModal();
  $('#switcherInput').focus();
}
const runSwitcher = i => { const it = switcherItems[i]; if (it) { $('#switcher').close(); it.run(); } };
$('#switcherInput').oninput = () => { switcherIndex = 0; renderSwitcher(); };
$('#switcherInput').onkeydown = e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    switcherIndex = (switcherIndex + (e.key === 'ArrowDown' ? 1 : -1) + switcherItems.length) % Math.max(1, switcherItems.length);
    renderSwitcher();
  }
  if (e.key === 'Enter') { e.preventDefault(); runSwitcher(switcherIndex); }
};
$('#switcherList').onclick = e => { const row = e.target.closest('[data-i]'); if (row) runSwitcher(+row.dataset.i); };
$('#switcher').onclick = e => { if (e.target === $('#switcher')) $('#switcher').close(); }; // a click outside the list

// ---- First-run checklist: what this Mac still needs before agents can run ----

const INSTALL_CLAUDE = 'npm install -g @anthropic-ai/claude-code';
function renderSetup(agentList, gh) {
  const items = [];
  if (!agentList.some(a => a.installed)) {
    items.push(`<div class="setup-item"><div><b>Install an agent</b><p>Claude Code is the one Protoplasma knows best: <code>${INSTALL_CLAUDE}</code>. Codex and OpenCode work too.</p></div><button class="btn small" data-copy="${esc(INSTALL_CLAUDE)}">Copy</button></div>`);
  }
  if (!gh.ok) {
    const cmd = /Not installed/.test(gh.detail) ? 'brew install gh && gh auth login' : 'gh auth login';
    items.push(`<div class="setup-item"><div><b>GitHub CLI</b><p>${esc(gh.detail)} It's what lists your repos, pull requests and issues; folders work without it.</p></div><button class="btn small" data-copy="${esc(cmd)}">Copy</button></div>`);
  }
  $('#setup').hidden = !items.length;
  setHTML($('#setup'), items.length ? `<h2>Finish setting up this Mac</h2><p>Run these in Terminal, then check again.</p>${items.join('')}
    <div class="actions"><button class="btn small" data-recheck>Check again</button></div>` : '');
}
const checkSetup = () => Promise.all([proto.agents(), proto.ghStatus()]).then(([list, gh]) => { agents = list; renderSetup(list, gh); });
$('#setup').onclick = e => {
  if (e.target.dataset.copy) { proto.copy(e.target.dataset.copy); e.target.textContent = 'Copied'; }
  if ('recheck' in e.target.dataset) checkSetup();
};

// ---- Menu shortcuts ----

proto.onMenu(action => {
  if (action === 'settings') return openSettings();
  if (action === 'updates') return openSettings('about');
  if (action === 'sidebar') return toggleSidebar();
  if (!me || document.querySelector('dialog[open]:not(#start, #settings)')) return;
  if (action === 'teams') return showTeams(me);
  if (!currentTeam) return;
  if (action === 'switcher') return openSwitcher();
  if (action === 'new-agent') openNewAgent(view === 'session' ? current : undefined);
  if (action === 'add-agent') view === 'session' ? addAgent(prefs.agent) : openNewAgent();
  if (action === 'panel' && view === 'session') code.on ? toggleDock() : $('#panelToggle').click();
  if (action === 'code' && view === 'session') showCode(!code.on);
  if (action === 'go-to-file') goToFile();
  if (action === 'save') saveActive();
  if (action === 'invite') ownsTeam(currentTeam) ? $('#inviteBtn').click() : alert(`Only the team's owner, ${currentTeam.owner}, can invite people.`);
});
// Settings is a page, so Esc closes it the way it closes a dialog.
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.menu')) return closeMenu();
  if ($('#settings').open && !document.querySelector('dialog:modal')) $('#settings').close();
});

// ---- Start ----

applyPrefs();
showView('signinView');
$('#start').showModal();
refreshAgents();
setTimeout(checkUpdates, 5000); // after startup, then every few hours
proto.savedUser().then(user => { if (user) { reopenLast = true; showTeams(user); } });

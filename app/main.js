// Electron main process: GitHub sign-in, team management and the agents running on this machine.
const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { startLane, installed } = require('../src/lane');
const github = require('./github');
const teams = require('./teams');
const config = require('./config.json');
const updates = require('./updates');
const files = require('./files');
const pty = require('node-pty');

const AGENTS = ['claude', 'codex', 'opencode'];
// How each agent CLI picks up its most recent conversation in the folder it starts in.
const RESUME = { claude: ['--continue'], codex: ['resume', '--last'], opencode: ['--continue'] };
const REPO_URL = 'https://github.com/dw8-ro/protoplasma-ide';
const onlineHub = process.env.PROTO_ONLINE_HUB ?? config.onlineHub;

// Agents and gh run with the user's login-shell environment. Apps launched from Finder get a minimal PATH, and a launch
// from inside Claude Code would leak that session's CLAUDE_* variables. Loaded async so startup isn't blocked.
const agentEnv = new Promise(resolve => {
  const { HOME, USER, LOGNAME, SHELL = '/bin/zsh' } = process.env;
  const child = execFile(SHELL, ['-ilc', 'printf __ENV__; env -0'], { encoding: 'utf8', timeout: 5000,
    env: { HOME, USER, LOGNAME, SHELL, TERM: 'xterm-256color' } }, (err, out) => {
    if (err) return resolve(process.env);
    const env = Object.fromEntries(out.split('__ENV__').pop().split('\0').filter(kv => kv.includes('='))
      .map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
    process.env.PATH = env.PATH || process.env.PATH; // node-pty resolves commands against our PATH
    resolve(env);
  });
  child.stdin.end();
});

const lanes = new Map(); // id -> lane running on this machine
const known = new Map(); // "hub|id" -> team from the last listing; the renderer can only open these
let win, session, team, signInAbort; // session: { token, user }; team: the open team

// Lanes can outlive the window during quit, and sending to a destroyed window throws.
const toWindow = (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };
const remember = t => { const key = `${t.hub}|${t.id}`; known.set(key, t); return { ...t, key }; };
const teamFor = key => { const t = known.get(key); if (!t) throw new Error('That team isn\'t available any more.'); return t; };
const signedIn = fn => async (_, ...args) => {
  if (!session) throw new Error('Sign in with GitHub first.');
  return fn(...args);
};

// ---- Sign-in ----
ipcMain.handle('auth:saved', async () => (session = await github.savedSignIn())?.user ?? null);
ipcMain.handle('auth:start', async () => {
  signInAbort?.abort(); // only one sign-in at a time
  const abort = signInAbort = new AbortController();
  const flow = await github.startSignIn(config.githubClientId);
  clipboard.writeText(flow.user_code);
  shell.openExternal(flow.verification_uri);
  // A cancelled or superseded attempt reports nothing, so it can't reset the screen for the current one.
  github.finishSignIn(config.githubClientId, flow, abort.signal)
    .then(s => { if (!abort.signal.aborted) { session = s; toWindow('auth:done', { user: s.user }); } })
    .catch(e => { if (!abort.signal.aborted) toWindow('auth:done', { error: e.message }); });
  return { code: flow.user_code, url: flow.verification_uri };
});
ipcMain.handle('auth:cancel', () => signInAbort?.abort());
ipcMain.handle('auth:signOut', () => { github.signOut(); session = null; });

// ---- Teams ----
ipcMain.handle('teams:list', signedIn(async () => {
  const { teams: list, unreachable } = await teams.listTeams(session, onlineHub);
  return { teams: list.map(remember), unreachable, online: !!onlineHub };
}));
ipcMain.handle('teams:create', signedIn(async o => remember(await teams.createTeam(session, onlineHub, { name: String(o.name), online: !!o.online }))));
ipcMain.handle('teams:open', signedIn(key => { team = teamFor(key); return { hub: team.hub, id: team.id, token: session.token }; }));
ipcMain.handle('teams:invite', signedIn(async (key, login) => {
  const found = await github.findUser(String(login), session.token); // catches typos before they become a member nobody is
  if (!found) throw new Error(`There's no GitHub user called ${login}.`);
  return remember({ ...teamFor(key), ...await teams.invite(session, teamFor(key), found) });
}));
ipcMain.handle('memories:add', signedIn((key, note) => teams.addMemory(session, teamFor(key), { text: String(note.text), file: String(note.file || ''), repo: String(note.repo || '') })));
ipcMain.handle('memories:remove', signedIn((key, id) => teams.removeMemory(session, teamFor(key), String(id))));
ipcMain.handle('sessions:save', signedIn((key, o) => teams.saveSession(session, teamFor(key), { name: String(o.name), task: String(o.task || '') })));
ipcMain.handle('sessions:done', signedIn((key, name, done) => teams.setSessionDone(session, teamFor(key), String(name), !!done)));
ipcMain.handle('sessions:rename', signedIn((key, name, rename) => teams.renameSession(session, teamFor(key), String(name), String(rename))));
ipcMain.handle('sessions:delete', signedIn((key, name) => teams.deleteSession(session, teamFor(key), String(name))));
ipcMain.handle('comments:add', signedIn((key, name, text) => teams.addComment(session, teamFor(key), String(name), String(text))));
ipcMain.handle('comments:remove', signedIn((key, name, id) => teams.removeComment(session, teamFor(key), String(name), String(id))));
ipcMain.handle('teams:remove', signedIn(async (key, login) => remember({ ...teamFor(key), ...await teams.removeMember(session, teamFor(key), String(login)) })));
// Leaving or deleting closes the team here too.
const forget = key => { known.delete(key); if (team && `${team.hub}|${team.id}` === key) team = null; };
ipcMain.handle('teams:leave', signedIn(async key => { await teams.removeMember(session, teamFor(key), session.user.login); forget(key); }));
ipcMain.handle('teams:delete', signedIn(async key => { await teams.deleteTeam(session, teamFor(key)); forget(key); }));

// ---- Repos ----
ipcMain.handle('repos:list', signedIn(async () => github.listRepos(await agentEnv, session.user.login)));
ipcMain.handle('repos:pulls', signedIn(async repo => github.pullRequests(String(repo), await agentEnv)));
ipcMain.handle('repos:issues', signedIn(async repo => github.issues(String(repo), await agentEnv)));
ipcMain.handle('openExternal', (_, url) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); });
ipcMain.handle('repo:reveal', async (_, repo) => {
  const dir = github.clonePath(String(repo));
  if (!fs.existsSync(dir)) throw new Error('That repo isn\'t cloned on this Mac yet. It will be once you start a session in it.');
  await shell.openPath(dir);
});
ipcMain.on('theme', (_, theme) => { if (['dark', 'light', 'system'].includes(theme)) nativeTheme.themeSource = theme; });
ipcMain.handle('app:info', () => ({ version: require('../package.json').version, onlineHub })); // app.getVersion() is Electron's when run from source
ipcMain.handle('gh:status', async () => github.ghStatus(await agentEnv));
ipcMain.on('focus', () => { win?.show(); app.focus({ steal: true }); });
ipcMain.on('badge', (_, count) => app.dock?.setBadge(count > 0 ? String(count) : ''));
ipcMain.on('clipboard', (_, text) => clipboard.writeText(String(text)));

// ---- Updates (see updates.js) ----
let release = null; // a newer release found by the last check
ipcMain.handle('updates:check', async () => {
  const current = require('../package.json').version;
  if (!app.isPackaged) return { current, available: false }; // running from source: git pull instead
  const latest = await updates.latestRelease(await agentEnv);
  release = latest && updates.isNewer(latest.version, current) ? latest : null;
  return { current, latest: latest?.version ?? null, available: !!release, canInstall: !!updates.ownBundle(app.getPath('exe')),
    url: latest?.url || `https://github.com/${updates.REPO}/releases` };
});
ipcMain.handle('updates:install', async () => {
  const bundle = updates.ownBundle(app.getPath('exe'));
  if (!release || !bundle) throw new Error('There\'s no update this copy of Protoplasma can install itself. Download it from GitHub instead.');
  await updates.stage(release, bundle, process.pid, await agentEnv);
  app.quit(); // asks first if agents are running; if that's cancelled, the update goes in at the next quit
});
ipcMain.handle('pickFolder', async (_, from) => (await dialog.showOpenDialog(win,
  { defaultPath: String(from || '') || undefined, properties: ['openDirectory', 'createDirectory'] })).filePaths[0]);

// ---- Agents ----
// Which agent CLIs this Mac can run, so the app only offers the ones that will start.
ipcMain.handle('agents:status', async () => { const env = await agentEnv; return AGENTS.map(cmd => ({ cmd, installed: installed(cmd, env) })); });
ipcMain.handle('startLane', signedIn(async o => {
  if (!team) throw new Error('Open a team first.');
  if (!AGENTS.includes(o.cmd)) throw new Error(`Unknown agent: ${o.cmd}`);
  const env = await agentEnv;
  // A renamed session keeps its original folder and branch, which `folderKey` names.
  const cwd = o.repo ? await github.sessionFolder(String(o.repo), String(o.folderKey || o.session), env, { worktree: o.worktree !== false }) : String(o.cwd);
  // Codex and OpenCode have no hooks to ask with, so on a shared team the push guard in app-made clones stops them instead.
  const shared = o.cmd !== 'claude' && team.members?.length > 0;
  const lane = startLane({ hub: team.hub, team: team.id, token: session.token, session: String(o.session), cmd: o.cmd, cwd, args: o.resume ? RESUME[o.cmd] : [],
    open: !!o.open, env: shared ? { ...env, PROTO_SHARED_TEAM: '1' } : env, onRefused: reason => toWindow('lane:refused', lane.id, reason) });
  lanes.set(lane.id, lane);
  folders.add(cwd);
  lane.cwd = cwd;
  lane.term.onData(d => toWindow('lane:data', lane.id, d));
  lane.term.onExit(() => { lanes.delete(lane.id); toWindow('lane:exit', lane.id); });
  return { id: lane.id, repo: lane.repo };
}));
ipcMain.on('lane:write', (_, id, d) => lanes.get(id)?.write(d));
ipcMain.handle('sessions:folder', (_, repo, name) => github.sessionFolderPath(String(repo), String(name)));
ipcMain.handle('sessions:removeFolder', signedIn(async (repo, name) => github.removeSessionFolder(String(repo), String(name), await agentEnv)));
ipcMain.on('lane:resize', (_, id, cols, rows) => lanes.get(id)?.resize(cols, rows));
ipcMain.on('lane:kill', (_, id) => lanes.get(id)?.term.kill());

// ---- Code (see files.js) ----
// The code view opens a session's folder on this Mac: where your agent runs, or the checkout the app made for it.
// Nothing else can be read or written through it.
const folders = new Set();
let stopWatching = () => {};
ipcMain.handle('code:root', (_, o) => {
  const root = o.lane ? lanes.get(o.lane)?.cwd : o.repo ? github.sessionFolderPath(String(o.repo), String(o.name)) : null;
  if (root) folders.add(root);
  return root || null;
});
const inFolder = fn => async (_, root, ...args) => {
  if (!folders.has(root)) throw new Error('That folder isn\'t open here.');
  return fn(root, await agentEnv, ...args);
};
ipcMain.handle('code:list', inFolder((root, env) => files.list(root, env)));
ipcMain.handle('code:status', inFolder((root, env) => files.status(root, env)));
ipcMain.handle('code:read', inFolder((root, env, rel) => files.read(root, rel)));
ipcMain.handle('code:committed', inFolder((root, env, rel) => files.committed(root, rel, env)));
ipcMain.handle('code:write', inFolder((root, env, rel, text) => files.write(root, rel, text)));
ipcMain.handle('code:search', inFolder((root, env, query) => files.search(root, query, env)));
ipcMain.handle('code:commit', inFolder((root, env, message) => files.commitAndPush(root, message, env)));
ipcMain.handle('code:watch', inFolder(root => {
  stopWatching();
  stopWatching = files.watch(root, paths => toWindow('code:changed', root, paths));
}));

// The Terminal tab: a plain shell in the session's folder, only on this Mac (never shared with the team).
const shells = new Map();
ipcMain.handle('shell:start', inFolder((root, env, cols, rows) => {
  const term = pty.spawn(env.SHELL || '/bin/zsh', ['-l'], { name: 'xterm-256color', cwd: root, cols, rows, env: { ...env, COLORTERM: 'truecolor' } });
  const id = String(term.pid);
  shells.set(id, term);
  term.onData(d => toWindow('shell:data', id, d));
  term.onExit(() => { shells.delete(id); toWindow('shell:exit', id); });
  return id;
}));
ipcMain.on('shell:write', (_, id, d) => shells.get(id)?.write(d));
ipcMain.on('shell:resize', (_, id, cols, rows) => shells.get(id)?.resize(cols, rows));

// Shortcuts live in the native menu so they work while a terminal has focus.
const menuAction = action => () => toWindow('menu', action);
Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: app.name, submenu: [
    { role: 'about' },
    { label: 'Check for Updates…', click: menuAction('updates') }, { type: 'separator' },
    { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: menuAction('settings') }, { type: 'separator' },
    { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
  ] },
  { label: 'File', submenu: [
    { label: 'New Session…', accelerator: 'CmdOrCtrl+N', click: menuAction('new-agent') },
    { label: 'Add an Agent', accelerator: 'CmdOrCtrl+Shift+L', click: menuAction('add-agent') },
    { label: 'Go to…', accelerator: 'CmdOrCtrl+K', click: menuAction('switcher') },
    { label: 'Go to File…', accelerator: 'CmdOrCtrl+P', click: menuAction('go-to-file') },
    { label: 'Save', accelerator: 'CmdOrCtrl+S', click: menuAction('save') },
    { label: 'Invite to Team…', accelerator: 'CmdOrCtrl+I', click: menuAction('invite') },
    { label: 'Switch Team…', accelerator: 'CmdOrCtrl+Shift+T', click: menuAction('teams') },
    { type: 'separator' },
    { role: 'close' },
  ] },
  { role: 'editMenu' },
  // Reloading would cut the window off from its running agents, so it's only offered when developing. macOS adds
  // its own full-screen item to a View menu.
  { label: 'View', submenu: [
    ...(app.isPackaged ? [] : [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }]),
    { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: menuAction('sidebar') },
    { label: 'Show Code', accelerator: 'CmdOrCtrl+Shift+E', click: menuAction('code') },
    { label: 'Toggle Panel', accelerator: 'CmdOrCtrl+J', click: menuAction('panel') },
    { type: 'separator' },
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
  ] },
  { role: 'windowMenu' },
  { role: 'help', submenu: [
    { label: 'Protoplasma on GitHub', click: () => shell.openExternal(REPO_URL) },
    { label: 'Report an Issue…', click: () => shell.openExternal(`${REPO_URL}/issues/new`) },
  ] },
]));

// The window's size and position, kept between launches.
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
const savedBounds = () => { try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch { return {}; } };

app.whenReady().then(() => {
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../build/icon.png'));
  win = new BrowserWindow({ width: 1440, height: 900, ...savedBounds(), minWidth: 900, minHeight: 560, backgroundColor: '#0b0b0c',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  // Never navigate away from the app page or open new windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
  // Closing the window quits the app, and with it every agent running here, so ask first.
  win.on('close', e => {
    const running = lanes.size;
    if (running && dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Quit', 'Cancel'], defaultId: 1, cancelId: 1,
      message: running === 1 ? 'An agent is still running' : `${running} agents are still running`,
      detail: `Quitting Protoplasma stops ${running === 1 ? 'it' : 'them'}. A Claude Code conversation can be picked up again later with /resume.` }) === 1) return e.preventDefault();
    try { fs.writeFileSync(boundsFile(), JSON.stringify(win.getNormalBounds())); } catch {}
  });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  for (const lane of lanes.values()) lane.term.kill();
  for (const term of shells.values()) term.kill();
  teams.stopAnnouncing();
});

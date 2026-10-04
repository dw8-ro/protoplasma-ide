// Drives the app to produce the README screenshots in docs/. It needs no network or GitHub account: a local hub stands
// in for the online one, with two made-up teammates. David runs a real Claude Code lane; Max is scripted.
// Usage: npm run screenshot
const { app, safeStorage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hubModule = require('../src/hub');
const laneModule = require('../src/lane');

const root = path.join(__dirname, '..');
const docs = path.join(root, 'docs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const people = {
  'tok-david': { login: 'david', name: 'David', avatar: '' },
  'tok-max': { login: 'max', name: 'Max', avatar: '' },
};
const verifyUser = async token => people[token] || null;
const demoRepos = [
  { name: 'david/lobby-server', description: 'Matchmaking and lobby service', private: true, mine: true },
  { name: 'david/protoplasma-ide', description: 'Multiplayer workspace for AI coding agents', private: false, mine: true },
  { name: 'david/dotfiles', description: '', private: false, mine: true },
  { name: 'max/game-client', description: 'Client for the lobby server', private: true, mine: false },
  { name: 'studio/design-system', description: 'Shared components', private: true, mine: false },
];

// A hook event as Claude Code would send it, signed with that lane's secret.
const edit = (hub, lane, secret, file) => fetch(`${hub}/hooks/${lane}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` },
  body: JSON.stringify({ hook_event_name: 'PostToolUse', cwd: root, tool_name: 'Edit', tool_input: { file_path: path.join(root, file) } }) });

// The scripted teammate. It's named `claude` so it shows as Claude Code, and prints a plausible transcript.
function fakeTeammate(secretFile) {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-teammate-')), 'claude');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$PROTO_HOOK_SECRET" > ${secretFile}
printf '\\033[1m✻ Claude Code\\033[0m\\r\\n\\r\\n\\033[2m>\\033[0m the lobby double-books seats under load, fix reserveSlot\\r\\n\\r\\n'
printf '\\033[32m●\\033[0m Read(src/lobby/join.ts)\\r\\n\\033[32m●\\033[0m Update(src/net/session_store.ts)\\r\\n'
printf '  \\033[2m⎿\\033[0m  reserveSlot now does a compare-and-swap on the seat version\\r\\n\\r\\n'
printf 'Seats are claimed atomically now. Two joins racing for the last slot get one success and one lobby_full.\\r\\n'
exec cat
`, { mode: 0o755 });
  return bin;
}

(async () => {
  // Stand in for GitHub and the online hub before the app loads, then sign David in from a saved profile.
  hubModule.githubUser = verifyUser;
  // Leave out the user's own Claude settings and plugins, so their startup output stays out of the pictures.
  const { startLane } = laneModule;
  laneModule.startLane = o => startLane({ ...o, args: ['--setting-sources', 'project,local'] });
  const hub = `http://127.0.0.1:${(await hubModule.startHub({ port: 0, host: '127.0.0.1', verifyUser })).port}`;
  process.env.PROTO_ONLINE_HUB = hub;
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-shot-')));
  await app.whenReady();
  fs.writeFileSync(path.join(app.getPath('userData'), 'github-token'),
    safeStorage.encryptString(JSON.stringify({ token: 'tok-david', user: people['tok-david'] })));
  app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', () => run(win, hub)));
  require('../app/main');
})();

async function run(win, hub) {
  const js = s => win.webContents.executeJavaScript(s);
  // Keep painting while the window is in the background, and wait for a fresh frame before each capture.
  win.webContents.setBackgroundThrottling(false);
  const shot = async name => {
    await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
    fs.writeFileSync(path.join(docs, name), (await win.webContents.capturePage()).toPNG());
  };
  const secretFile = path.join(os.tmpdir(), `protoplasma-shot-${process.pid}`);
  let teammate;
  try {
    fs.mkdirSync(docs, { recursive: true });
    while (!await js('!!me')) await sleep(100);
    await js(`showTeams(me); $('#teamName').value = 'Lobby'; $('#createTeam').requestSubmit()`);
    while (!await js('!!currentTeam')) await sleep(100);
    const team = await js('currentTeam.id');
    await js(`proto.invite(currentTeam.key, 'max').then(t => { currentTeam = t; }); 0`);
    await sleep(300);
    teammate = spawn('node', [path.join(root, 'src/lane.js'), hub, team, 'lobby-fix', fakeTeammate(secretFile)],
      { cwd: root, env: { ...process.env, PROTO_TOKEN: 'tok-max' }, stdio: 'ignore' });

    await js(`openNewAgent('lobby-fix')`);
    await sleep(1500);
    await js(`$('input[name=source][value=folder]').checked = true; syncSource(); $('#cwd').value = ${JSON.stringify(root)}; $('#task').value = 'Stop the lobby double-booking seats under load'; $('#agentForm').requestSubmit()`);
    while (!await js('local.size')) await sleep(100);
    const mine = await js('[...local.keys()][0]');
    await sleep(5000);
    await js(`proto.write(${JSON.stringify(mine)}, 'add a retry with backoff to retryJoin, and a test for the race'); 0`);
    await sleep(800);

    // Both agents edit the same file, so the board shows an overlap.
    const theirs = (await js('hubLanes.map(l => l.id)')).find(id => id !== mine);
    const claudePid = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .filter(line => line.includes('claude --settings') && !line.includes('protoplasma-teammate')).pop().trim().split(' ')[0];
    const mySecret = /PROTO_HOOK_SECRET=(\w+)/.exec(execFileSync('ps', ['eww', '-o', 'command=', '-p', claudePid], { encoding: 'utf8' }))[1];
    await edit(hub, theirs, fs.readFileSync(secretFile, 'utf8').trim(), 'src/net/session_store.ts');
    await edit(hub, mine, mySecret, 'src/lobby/join.ts');
    await edit(hub, mine, mySecret, 'src/net/session_store.ts');
    const prompt = (lane, secret, text) => fetch(`${hub}/hooks/${lane}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: root, prompt: text }) });
    await prompt(theirs, fs.readFileSync(secretFile, 'utf8').trim(), 'the lobby double-books seats under load, fix reserveSlot');
    await prompt(mine, mySecret, 'add a retry with backoff to retryJoin, and a test for the race');
    await js(`proto.addComment(currentTeam.key, 'lobby-fix', "I'll take reserveSlot, can you do the retry and the test?"); 0`);
    await js(`proto.addMemory(currentTeam.key, { text: 'Use pnpm, not npm. The lockfile is pnpm-lock.yaml.' }); 0`);
    await js(`proto.addMemory(currentTeam.key, { text: 'The seating path is pickOpenSlot, then reserveSlot, then retryJoin.', file: 'src/lobby/join.ts' }); 0`);
    // A second, finished session and made-up repo names, so the Sessions page has something to show
    // without publishing anyone's real (or private) repos.
    await js(`proto.saveSession(currentTeam.key, { name: 'promo-totals', task: 'Recompute cart totals when a promo changes' }).then(() => proto.setSessionDone(currentTeam.key, 'promo-totals', true)); 0`);
    await sleep(800);

    // The session view: your agent beside a teammate's, with the session panel on the right.
    await sleep(600);
    await shot('session.png');

    await js(`go('sessions')`);
    await sleep(600);
    await shot('sessions.png');

    await js(`reposError = ''; repos = ${JSON.stringify(demoRepos)}; openNewAgent();
      $('#session').value = 'matchmaking-queue'; $('input[name=source][value=repo]').checked = true; syncSource(); $('#repo').value = 'david/lobby-server'; renderRepoPicker()`);
    await sleep(600);
    await shot('new-session.png');

    await js(`$('#agent').close(); openSettings('agents')`);
    await sleep(800);
    await shot('settings.png');
    await js(`$('input[data-pref=theme][value=light]').click(); openSession('lobby-fix'); panelTab = 'environment'; render()`);
    await sleep(1000);
    await shot('light.png');
    console.log('saved docs/{session,sessions,new-session,settings,light}.png');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    teammate?.kill();
    fs.rmSync(secretFile, { force: true });
    win.destroy(); // skips the "agents are still running" prompt; the app quits once its window is gone
  }
}

// Drives the app to produce the README screenshots in docs/, with the made-up team from stage.js.
// Usage: npm run screenshot
const fs = require('fs');
const path = require('path');
const { boot, stageRepo, ownAgent, teammate, hook, sleep, c, light, claudeBanner, accepting } = require('./stage');

const docs = path.join(__dirname, '..', 'docs');
const demoRepos = [
  { name: 'david/lobby-server', description: 'Matchmaking and lobbies for the game', private: true, mine: true },
  { name: 'david/game-client', description: 'The game itself', private: true, mine: true },
  { name: 'david/website', description: 'Landing page and docs', private: false, mine: true },
  { name: 'max/anticheat', description: 'Server-side cheat detection', private: true, mine: false },
  { name: 'studio/design-system', description: 'Shared UI components', private: true, mine: false },
];
const sessions = [
  ['lobby-fix', 'Stop the lobby double-booking seats under load'],
  ['matchmaking-queue', 'Keep a player\'s place in the queue when they reconnect'],
  ['ws-reconnect', 'Reconnect the lobby socket after a server restart'],
  ['leaderboard-cache', 'Stop sorting the whole leaderboard on every request'],
  ['season-rollover', 'Archive last season\'s ranks when a new one starts'],
];

// David's Claude Code: a fix done, and its own / menu open. Lines fit the ~55 columns of a pane beside another.
const fit = (text, width) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);
const slashMenu = [
  ['/add-dir', 'Add a new working directory'], ['/agents', 'Manage agent configurations'],
  ['/clear', 'Clear conversation history and free up context'], ['/compact', 'Clear conversation history but keep a summary'],
  ['/config', 'Open config panel'], ['/context', 'Visualize current context usage as a colored grid'],
  ['/cost', 'Show the total cost and duration of the current session'], ['/doctor', 'Diagnose and verify your Claude Code installation'],
].map(([cmd, about], i) => (i ? `  ${cmd.padEnd(11)}${c.dim(fit(about, 40))}` : c.pick(`  ${cmd.padEnd(11)}${fit(about, 40)}`)));
const davidSaid = t => [...claudeBanner('~/Protoplasma/lobby-server@lobby-fix'), '',
  t.dim('> retryJoin gives up after one try, retry with backoff'), '',
  t.tool('Read', 'src/lobby/join.ts'), '  ⎿  Read 10 lines', '',
  t.tool('Update', 'src/lobby/join.ts'), '  ⎿  Updated src/lobby/join.ts with 5 additions',
  t.dim('     8   export async function retryJoin(id, player) {'),
  t.added('     9 +   for (let n = 0; n < 4; n++) {'),
  t.added('    10 +     try { return await joinLobby(id, player); }'),
  t.added('    11 +     catch (e) { if (!isSeatTaken(e)) throw e; }'),
  t.added('    12 +     await sleep(50 * 2 ** n);'),
  t.added('    13 +   }'),
  t.dim('    14     return joinLobby(id, player);'), '',
  `${t.said} retryJoin tries again when someone takes the seat`,
  '  first, waiting 50, 100, 200 and 400 ms. Any other', '  error still fails straight away.'];
const david = [
  ['say', ...davidSaid(c)],
  ['box', '/', ...slashMenu],
  ['wait', 'light'], // the light-theme shot: Claude Code in its light theme, with a prompt half written
  ['clear'],
  ['say', ...davidSaid(light)],
  ['box', 'add a test where two joins race for the last seat', accepting],
];

// Max's Claude Code, part way through the same session.
const maxClaude = [
  ['say', c.dim('> the lobby double-books seats under load, fix reserveSlot'), '',
    `${c.said} I'll start with how a seat gets claimed.`, '',
    c.tool('Read', 'src/net/session_store.ts'), '  ⎿  Read 10 lines', '',
    `${c.said} Two joins can read the lobby at once, both see the same free`,
    '  seat and both take it. I\'ll make the write depend on the lobby\'s',
    '  revision, so the second one fails instead.', '',
    c.tool('Update', 'src/net/session_store.ts'), '  ⎿  Updated src/net/session_store.ts with 2 additions and 1 removal',
    c.dim("     7     if (seat === null) throw new Error('lobby_full');"),
    c.removed('     8 -   await db.put(id, seated(lobby, seat, player));'),
    c.added('     8 +   const ok = await db.putIf(id, lobby.rev, seated(lobby, seat, player));'),
    c.added("     9 +   if (!ok) throw new Error('seat_taken');"),
    c.dim('    10     return seat;'), '',
    c.tool('Bash', 'pnpm vitest run test/lobby'), '  ⎿  Running…'],
  ['box', '', accepting],
  ['spin', c.orange('%s Running the lobby tests…') + c.dim(' (%ds · esc to interrupt)'), 0, 31],
];

const maxCodex = [
  ['say', '› players who drop mid-search lose their place in the queue', '',
    '• I\'ll hold a disconnected player\'s place for 30 seconds instead of', '  dropping them straight away.', '',
    '• Explored', c.dim('  └ Read queue.ts, matchmaker.ts'), '',
    `• Edited src/match/queue.ts (${c.green('+5')} -0)`],
  ['spin', '%s Working' + c.dim(' (%ds • esc to interrupt)'), 0, 48],
];

const saraClaude = [
  ['say', c.dim('> the lobby socket never comes back after a server restart'), '',
    c.tool('Read', 'src/net/socket.ts'), '  ⎿  Read 5 lines', '',
    `${c.said} It only logs when the socket closes. I'll reconnect with backoff.`, '',
    c.dim('─'.repeat(78)), ` ${c.bold('Edit file')}`, '  src/net/socket.ts',
    c.removed("    3 -   ws.onclose = () => console.warn('lobby socket closed');"),
    c.added('    3 +   ws.onclose = () => setTimeout(() => connect(url), backoff.next());'), '',
    ' Do you want to make this edit to socket.ts?', c.pick(' ❯ 1. Yes'), '   2. Yes, allow all edits during this session (shift+tab)',
    '   3. No, and tell Claude what to do differently (esc)'],
];

const saraOpenCode = [
  ['say', '┃ the leaderboard sorts every score on every request', '',
    `  ${c.dim('Read')}  src/leaderboard/cache.ts`, `  ${c.dim('Edit')}  src/leaderboard/cache.ts`, '',
    '  top() now keeps a sorted copy and record() throws it away, so scores', '  are only sorted again after one changes.'],
];

boot(async (win, hub) => {
  const js = s => win.webContents.executeJavaScript(s);
  const shot = async (name, { light = false } = {}) => {
    await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
    const png = (await win.webContents.capturePage()).toPNG();
    fs.writeFileSync(path.join(docs, name), Buffer.from(await js(frame(png, light)), 'base64'));
  };
  const folders = stageRepo();

  while (!await js('!!me')) await sleep(100);
  await js(`showTeams(me); $('#teamName').value = 'Lobby'; $('#createTeam').requestSubmit()`);
  while (!await js('!!currentTeam')) await sleep(100);
  const team = await js('currentTeam.id');
  await js(`proto.invite(currentTeam.key, 'max').then(() => proto.invite(currentTeam.key, 'sara')).then(t => { currentTeam = t; return 0; })`);
  for (const [name, task] of sessions) await js(`proto.saveSession(currentTeam.key, ${JSON.stringify({ name, task })}).then(() => 0)`);
  await js(`proto.setSessionDone(currentTeam.key, 'season-rollover', true).then(() => 0)`);

  const lane = (token, key, cmd, steps, size) => teammate({ hub, team, token, session: key.split('/')[1], cwd: folders[key], cmd, steps, ...size });
  const max = await lane('tok-max', 'max/lobby-fix', 'claude', maxClaude, { cols: 82, rows: 40 });
  await lane('tok-max', 'max/matchmaking-queue', 'codex', maxCodex);
  const sara = await lane('tok-sara', 'sara/ws-reconnect', 'claude', saraClaude);
  await lane('tok-sara', 'sara/leaderboard-cache', 'opencode', saraOpenCode);
  await hook(hub, max, { hook_event_name: 'UserPromptSubmit', prompt: 'the lobby double-books seats under load, fix reserveSlot' });
  await hook(hub, sara, { hook_event_name: 'UserPromptSubmit', prompt: 'the lobby socket never comes back after a server restart' });
  await hook(hub, sara, { hook_event_name: 'PermissionRequest', tool_name: 'Edit' });

  // David's agent, started the way anyone starts one: from the New agent form, in the session's checkout.
  const secret = ownAgent('claude', david);
  await js(`openNewAgent('lobby-fix')`);
  await sleep(1200);
  await js(`$('input[name=source][value=folder]').checked = true; syncSource(); $('#cwd').value = ${JSON.stringify(folders['david/lobby-fix'])}; $('#agentForm').requestSubmit()`);
  while (!await js('local.size')) await sleep(100);
  const mine = { id: await js('[...local.keys()][0]'), secret: await secret };
  await hook(hub, mine, { hook_event_name: 'UserPromptSubmit', prompt: 'retryJoin gives up after one try, retry with backoff' });
  await hook(hub, mine, { hook_event_name: 'Stop' });

  const say = (token, text) => fetch(`${hub}/teams/${team}/sessions/lobby-fix/comments`, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
  await say('tok-max', 'I\'ve got reserveSlot, it\'s a compare-and-swap now.');
  await sleep(50);
  await say('tok-david', 'Great, I\'ll put the retry on top of yours and add the race test.');
  await js(`proto.addMemory(currentTeam.key, { text: 'Use pnpm, not npm. The lockfile is pnpm-lock.yaml.' }).then(() => 0)`);
  await js(`proto.addMemory(currentTeam.key, { text: 'Seats go pickOpenSlot, then reserveSlot, then retryJoin.', file: 'src/lobby/join.ts' }).then(() => 0)`);
  await sleep(3000); // every checkout reports its changes

  // Your agent beside Max's, with the session panel. The sidebar folds away (⌘B) to give them room.
  await js(`toggleSidebar(true); openSession('lobby-fix'); focus = ${JSON.stringify(mine.id)}; split = ${JSON.stringify(max.id)}; render()`);
  await sleep(2000);
  await shot('session.png');

  // The code, the way Amoeba shows it: open a file, and the agents move to a panel underneath.
  await js(`toggleSidebar(false); split = null; render(); openFile('src/lobby/join.ts', { line: 9 }); 0`);
  await sleep(3000);
  await shot('code.png');
  await js(`toggleSidebar(false); go('sessions')`);
  await sleep(800);
  await shot('sessions.png');

  await js(`reposError = ''; repos = ${JSON.stringify(demoRepos)}; openNewAgent();
    $('#session').value = 'anticheat-alerts'; $('#task').value = 'Page the on-call when a ban wave starts';
    $('input[name=source][value=repo]').checked = true; syncSource(); $('#repo').value = 'david/lobby-server'; renderRepoPicker()`);
  await sleep(600);
  await shot('new-session.png');

  await js(`$('#agent').close(); openSettings('agents')`);
  await sleep(800);
  await shot('settings.png');

  await js(`proto.write(${JSON.stringify(mine.id)}, 'light\\r'); 0`);
  await js(`$('input[data-pref=theme][value=light]').click(); openSession('lobby-fix'); focus = ${JSON.stringify(mine.id)}; split = null; panelTab = 'environment'; render()`);
  await sleep(1500);
  await shot('light.png', { light: true });
  console.log('saved docs/{session,code,sessions,new-session,settings,light}.png');
});

// Runs in the page: puts the capture in a macOS window (rounded corners, traffic lights, a hairline edge and a soft
// shadow) on a transparent background, so it sits well on GitHub's light and dark pages. Returns base64 PNG.
const frame = (png, light) => `(async () => {
  const bytes = Uint8Array.from(atob('${png.toString('base64')}'), ch => ch.charCodeAt(0));
  const shot = await createImageBitmap(new Blob([bytes]));
  const k = shot.width / innerWidth, pad = 64 * k, r = 12 * k, w = shot.width, h = shot.height;
  const canvas = new OffscreenCanvas(w + pad * 2, h + pad * 2), g = canvas.getContext('2d');
  const outline = () => { g.beginPath(); g.roundRect(pad, pad, w, h, r); };
  g.save(); g.shadowColor = 'rgba(0, 0, 0, ${light ? 0.18 : 0.45})'; g.shadowBlur = 48 * k; g.shadowOffsetY = 16 * k;
  outline(); g.fill(); g.restore();
  g.save(); outline(); g.clip(); g.drawImage(shot, pad, pad); g.restore();
  ['#ff5f57', '#febc2e', '#28c840'].forEach((color, i) => {
    g.beginPath(); g.arc(pad + (24 + 20 * i) * k, pad + 24 * k, 6 * k, 0, 2 * Math.PI); g.fillStyle = color; g.fill();
  });
  outline(); g.lineWidth = k; g.strokeStyle = '${light ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.14)'}'; g.stroke();
  const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(s);
})()`;

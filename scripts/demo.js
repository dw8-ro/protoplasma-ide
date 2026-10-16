// Records docs/demo.gif, and its framed copies for the README in docs/readme/, with the made-up team from stage.js: David
// asks his agent for a test, opens the code and watches it being written, Max's change to the same file is flagged, and
// Max leaves a comment.
// Usage: npm run demo
const fs = require('fs');
const path = require('path');
const { framed, writeGif } = require('./gif');
const { boot, stageRepo, applyEdits, ownAgent, teammate, hook, sleep, c, claudeBanner, accepting } = require('./stage');

const WIDTH = 1120, HEIGHT = 700, FRAME_MS = 200;
const PROMPT = 'add a test where two joins race for the last seat';
const TEST = `import { test, expect } from 'vitest';
import { retryJoin } from '../src/lobby/join';
import { lobbyWithOneSeat } from './fixtures';

test('two joins racing for the last seat get one seat each way', async () => {
  const lobby = await lobbyWithOneSeat();
  const [first, second] = await Promise.allSettled([
    retryJoin(lobby.id, 'ana'),
    retryJoin(lobby.id, 'ben'),
  ]);
  const seated = [first, second].filter(r => r.status === 'fulfilled');
  expect(seated).toHaveLength(1);
  expect([first, second].find(r => r.status === 'rejected').reason.message).toBe('lobby_full');
});
`;

const david = [
  ['say', ...claudeBanner('~/Protoplasma/lobby-server@lobby-fix')],
  ['box', '', accepting],
  ['wait', PROMPT],
  ['say', '', c.dim(`> ${PROMPT}`), ''],
  ['sleep', 0.8],
  ['say', c.tool('Read', 'src/lobby/join.ts'), '  ⎿  Read 15 lines', ''],
  ['sleep', 0.6],
  ['say', c.tool('Write', 'test/lobby.test.ts'), '  ⎿  Wrote 15 lines to test/lobby.test.ts', ''],
  ['spin', c.orange('%s Writing the race test…') + c.dim(' (%ds · esc to interrupt)'), 5, 3],
  ['say', c.tool('Bash', 'pnpm vitest run test/lobby'), '  ⎿  1 passed', ''],
  ['say', `${c.said} Two joins racing for the last seat now get one seat and one`, '  lobby_full, and the test covers it.'],
];
const max = [
  ['say', c.dim('> the lobby double-books seats under load, fix reserveSlot'), '',
    `${c.said} I'll start with how a seat gets claimed.`, '', c.tool('Read', 'src/net/session_store.ts'), '  ⎿  Read 10 lines', ''],
  ['wait', 'go'],
  ['say', c.tool('Update', 'src/net/session_store.ts'), '  ⎿  Updated src/net/session_store.ts with 2 additions and 1 removal'],
  ['box', '', accepting],
  ['spin', c.orange('%s Running the lobby tests…') + c.dim(' (%ds · esc to interrupt)'), 0, 12],
];

boot(async (win, hub) => {
  const js = s => win.webContents.executeJavaScript(s);
  const folders = stageRepo({ later: ['max/lobby-fix'] });
  while (!await js('!!me')) await sleep(100);
  await js(`showTeams(me); $('#teamName').value = 'Lobby'; $('#createTeam').requestSubmit()`);
  while (!await js('!!currentTeam')) await sleep(100);
  const team = await js('currentTeam.id');
  await js(`proto.invite(currentTeam.key, 'max').then(t => { currentTeam = t; return 0; })`);
  await js(`proto.saveSession(currentTeam.key, { name: 'lobby-fix', task: 'Stop the lobby double-booking seats under load' }).then(() => 0)`);

  const theirs = await teammate({ hub, team, token: 'tok-max', session: 'lobby-fix', cwd: folders['max/lobby-fix'], cmd: 'claude', steps: max, cols: 80, rows: 30 });
  await hook(hub, theirs, { hook_event_name: 'UserPromptSubmit', prompt: 'the lobby double-books seats under load, fix reserveSlot' });
  const secret = ownAgent('claude', david);
  await js(`openNewAgent('lobby-fix')`);
  await sleep(1000);
  await js(`$('input[name=source][value=folder]').checked = true; syncSource(); $('#cwd').value = ${JSON.stringify(folders['david/lobby-fix'])}; $('#agentForm').requestSubmit()`);
  while (!await js('local.size')) await sleep(100);
  const mine = { id: await js('[...local.keys()][0]'), secret: await secret };
  await js(`go('sessions')`);
  await sleep(2500);

  // Record frames in the background while the scene plays out.
  const frames = [];
  let capturing = true;
  (async () => {
    while (capturing) {
      const started = Date.now();
      frames.push((await win.webContents.capturePage()).resize({ width: WIDTH, height: HEIGHT, quality: 'best' }).toBitmap());
      await sleep(Math.max(0, FRAME_MS - (Date.now() - started)));
    }
  })();
  const type = async text => { for (const ch of text) { await js(`proto.write(${JSON.stringify(mine.id)}, ${JSON.stringify(ch)}); 0`); await sleep(55); } };

  await sleep(1600);                                       // the board
  await js(`openSession('lobby-fix', ${JSON.stringify(mine.id)})`);
  await sleep(1400);
  await type(PROMPT);                                      // David asks his agent
  await js(`proto.write(${JSON.stringify(mine.id)}, '\\r'); 0`);
  await hook(hub, mine, { hook_event_name: 'UserPromptSubmit', prompt: PROMPT });
  await sleep(1600);
  // The agent writes the test; David opens it and watches it arrive.
  const test = path.join(folders['david/lobby-fix'], 'test/lobby.test.ts');
  fs.mkdirSync(path.dirname(test), { recursive: true });
  const lines = TEST.split('\n');
  fs.writeFileSync(test, lines.slice(0, 3).join('\n') + '\n');
  await sleep(500);
  await js(`openFile('test/lobby.test.ts'); 0`);
  for (let n = 6; n <= lines.length; n += 3) { await sleep(450); fs.writeFileSync(test, lines.slice(0, n).join('\n') + '\n'); }
  await sleep(1200);
  theirs.write('go\r');                                    // Max's agent changes the same file as David's
  applyEdits(folders, 'max/lobby-fix');
  await sleep(2600);
  await js(`proto.addComment(currentTeam.key, 'lobby-fix', 'Nice. I\\'ll rebase reserveSlot on your test.'); 0`);
  await hook(hub, mine, { hook_event_name: 'Stop' });
  await sleep(2000);
  await js(`$('#codeTree [data-dir="src"]')?.click(); 0`);
  await sleep(500);
  await js(`$('#codeTree [data-dir="src/net"]')?.click(); 0`);
  await sleep(1800);
  await js(`go('sessions')`);
  await sleep(2200);
  capturing = false;
  await sleep(FRAME_MS * 2);

  const out = path.join(__dirname, '..', 'docs', 'demo.gif');
  const rgba = frames.map(bgra => {
    const px = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) { px[i] = bgra[i + 2]; px[i + 1] = bgra[i + 1]; px[i + 2] = bgra[i]; px[i + 3] = 255; }
    return px;
  });
  writeGif(out, rgba, WIDTH, HEIGHT, FRAME_MS);
  // The README's copies, framed for GitHub's dark and light pages.
  fs.mkdirSync(path.join(__dirname, '..', 'docs', 'readme'), { recursive: true });
  for (const theme of ['dark', 'light']) {
    const f = rgba.map(frame => framed(frame, WIDTH, HEIGHT, theme));
    writeGif(path.join(__dirname, '..', 'docs', 'readme', `demo-${theme}.gif`), f.map(x => x.rgba), f[0].width, f[0].height, FRAME_MS);
  }
  if (process.env.DEMO_FRAMES) { // stills of every 12th frame, for checking the recording
    const { nativeImage } = require('electron');
    frames.forEach((bitmap, i) => i % 12 || fs.writeFileSync(path.join(process.env.DEMO_FRAMES, `frame-${String(i).padStart(3, '0')}.png`),
      nativeImage.createFromBitmap(bitmap, { width: WIDTH, height: HEIGHT }).toPNG()));
  }
  console.log(`saved docs/demo.gif and docs/readme/demo-{dark,light}.gif (${frames.length} frames, ${Math.round(fs.statSync(out).size / 1024)} KB)`);
});

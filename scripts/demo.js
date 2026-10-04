// Records docs/demo.gif: a short walk through a session. David's agent is a real Claude Code (its / menu and /help
// are real); Max is a scripted teammate. Like the screenshots, it needs no network or GitHub account.
// Usage: npm run demo
const { app, safeStorage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const hubModule = require('../src/hub');
const laneModule = require('../src/lane');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const people = { 'tok-david': { login: 'david', name: 'David', avatar: '' }, 'tok-max': { login: 'max', name: 'Max', avatar: '' } };
const verifyUser = async token => people[token] || null;
const WIDTH = 960, HEIGHT = 600, FRAME_MS = 200;

// Max's agent waits for "go", then works through a fix. It's named `claude` so it shows as Claude Code.
function fakeTeammate(secretFile) {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-teammate-')), 'claude');
  fs.writeFileSync(bin, `#!/bin/sh
echo "$PROTO_HOOK_SECRET" > ${secretFile}
printf '\\033[1m✻ Claude Code\\033[0m\\r\\n\\r\\n'
stty -echo; read go; stty echo
printf '\\033[2m>\\033[0m the lobby double-books seats under load, fix reserveSlot\\r\\n\\r\\n'; sleep 0.8
printf '\\033[32m●\\033[0m Read(src/lobby/join.ts)\\r\\n'; sleep 0.7
printf '\\033[32m●\\033[0m Read(src/net/session_store.ts)\\r\\n'; sleep 0.7
printf '\\033[32m●\\033[0m Update(src/net/session_store.ts)\\r\\n'; sleep 0.5
printf '  \\033[2m⎿\\033[0m  reserveSlot now does a compare-and-swap on the seat version\\r\\n\\r\\n'; sleep 0.9
printf 'Seats are claimed atomically now. Two joins racing for the last slot get one success and one lobby_full.\\r\\n'
exec cat
`, { mode: 0o755 });
  return bin;
}

(async () => {
  hubModule.githubUser = verifyUser;
  // Leave out the user's own Claude settings and plugins, so their startup output stays out of the recording.
  const { startLane } = laneModule;
  laneModule.startLane = o => startLane({ ...o, args: ['--setting-sources', 'project,local'] });
  const hub = `http://127.0.0.1:${(await hubModule.startHub({ port: 0, host: '127.0.0.1', verifyUser })).port}`;
  process.env.PROTO_ONLINE_HUB = hub;
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-demo-')));
  await app.whenReady();
  fs.writeFileSync(path.join(app.getPath('userData'), 'github-token'),
    safeStorage.encryptString(JSON.stringify({ token: 'tok-david', user: people['tok-david'] })));
  app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', () => run(win, hub)));
  require('../app/main');
})();

async function run(win, hub) {
  const js = s => win.webContents.executeJavaScript(s).catch(e => { throw new Error(`${e.message}\n  in: ${s.slice(0, 160)}`); });
  win.webContents.setBackgroundThrottling(false);
  const secretFile = path.join(os.tmpdir(), `protoplasma-demo-${process.pid}`);
  const hook = (lane, secret, body) => fetch(`${hub}/hooks/${lane}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` },
    body: JSON.stringify({ cwd: root, ...body }) });
  const frames = [];
  let teammate, capturing = false;
  try {
    while (!await js('!!me')) await sleep(100);
    await js(`showTeams(me); $('#teamName').value = 'Lobby'; $('#createTeam').requestSubmit()`);
    while (!await js('!!currentTeam')) await sleep(100);
    const team = await js('currentTeam.id');
    await js(`proto.invite(currentTeam.key, 'max').then(t => { currentTeam = t; return true; })`); // before Max's agent connects
    teammate = spawn('node', [path.join(root, 'src/lane.js'), hub, team, 'lobby-fix', fakeTeammate(secretFile)],
      { cwd: root, env: { ...process.env, PROTO_TOKEN: 'tok-max' }, stdio: ['pipe', 'ignore', 'ignore'] });
    await sleep(500);
    await js(`openNewAgent('lobby-fix')`);
    await sleep(1200);
    await js(`$('input[name=source][value=folder]').checked = true; syncSource(); $('#cwd').value = ${JSON.stringify(root)}; $('#task').value = 'Stop the lobby double-booking seats under load'; $('#agentForm').requestSubmit()`);
    while (!await js('local.size')) await sleep(100);
    const mine = await js('[...local.keys()][0]');
    await js(`proto.addMemory(currentTeam.key, { text: 'Use pnpm, not npm. The lockfile is pnpm-lock.yaml.' }); 0`);
    await sleep(6000); // Claude Code starting up

    const theirs = (await js('hubLanes.map(l => l.id)')).find(id => id !== mine);
    const claudePid = execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).split('\n')
      .filter(line => line.includes('claude --settings') && !line.includes('protoplasma-teammate')).pop().trim().split(' ')[0];
    const mySecret = /PROTO_HOOK_SECRET=(\w+)/.exec(execFileSync('ps', ['eww', '-o', 'command=', '-p', claudePid], { encoding: 'utf8' }))[1];
    const theirSecret = fs.readFileSync(secretFile, 'utf8').trim();

    // Record frames in the background while the scene plays out.
    capturing = true;
    (async () => {
      while (capturing) {
        const started = Date.now();
        frames.push((await win.webContents.capturePage()).resize({ width: WIDTH, height: HEIGHT, quality: 'best' }).toBitmap());
        await sleep(Math.max(0, FRAME_MS - (Date.now() - started)));
      }
    })();
    const type = async text => { for (const ch of text) { await js(`proto.write(${JSON.stringify(mine)}, ${JSON.stringify(ch)}); 0`); await sleep(140); } };

    await sleep(1400);
    await type('/');                                  // the real slash-command menu
    await sleep(1400);
    await type('help');
    await js(`proto.write(${JSON.stringify(mine)}, '\\r'); 0`);
    await sleep(2000);
    await js(`proto.write(${JSON.stringify(mine)}, '\\x1b'); 0`);
    await sleep(700);

    teammate.stdin.write('go\r');                    // Max's agent gets to work
    await hook(theirs, theirSecret, { hook_event_name: 'UserPromptSubmit', prompt: 'the lobby double-books seats under load, fix reserveSlot' });
    await sleep(900);
    await js(`$('#panelBody [data-focus="${theirs}"]').click()`);
    await sleep(1600);
    await hook(theirs, theirSecret, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/net/session_store.ts') } });
    await hook(mine, mySecret, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/net/session_store.ts') } });
    await sleep(2200);
    await js(`proto.addComment(currentTeam.key, 'lobby-fix', "I'll take reserveSlot, can you do the retry and the test?"); 0`);
    await sleep(1600);
    await js(`$('#myAgent').click()`);
    await sleep(900);
    await js(`go('sessions')`);
    await sleep(2200);
    capturing = false;
    await sleep(FRAME_MS * 2);

    writeGif(path.join(root, 'docs/demo.gif'), frames);
    if (process.env.DEMO_FRAMES) { // stills of every 12th frame, for checking the recording
      const { nativeImage } = require('electron');
      frames.forEach((bitmap, i) => i % 12 || fs.writeFileSync(path.join(process.env.DEMO_FRAMES, `frame-${String(i).padStart(3, '0')}.png`),
        nativeImage.createFromBitmap(bitmap, { width: WIDTH, height: HEIGHT }).toPNG()));
    }
    console.log(`saved docs/demo.gif (${frames.length} frames, ${Math.round(fs.statSync(path.join(root, 'docs/demo.gif')).size / 1024)} KB)`);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    capturing = false;
    teammate?.kill();
    fs.rmSync(secretFile, { force: true });
    win.destroy();
  }
}

// One shared palette, and pixels that didn't change since the previous frame left transparent, so the GIF stays small.
function writeGif(file, bitmaps) {
  const rgba = bitmaps.map(bgra => {
    const out = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4) { out[i] = bgra[i + 2]; out[i + 1] = bgra[i + 1]; out[i + 2] = bgra[i]; out[i + 3] = 255; }
    return out;
  });
  const pick = [0, rgba.length >> 1, rgba.length - 1].map(i => rgba[i]);
  const sample = new Uint8Array(pick.reduce((n, f) => n + f.length, 0));
  pick.reduce((offset, f) => { sample.set(f, offset); return offset + f.length; }, 0);
  const colours = quantize(sample, 255);
  const palette = [...colours, [0, 0, 0]]; // index 255: transparent
  const gif = GIFEncoder();
  let previous = null;
  for (const frame of rgba) {
    const index = applyPalette(frame, colours);
    const drawn = index.slice();
    if (previous) for (let i = 0; i < index.length; i++) if (index[i] === previous[i]) index[i] = 255;
    gif.writeFrame(index, WIDTH, HEIGHT, { palette: previous ? undefined : palette, delay: FRAME_MS, transparent: !!previous, transparentIndex: 255, dispose: 1 });
    previous = drawn;
  }
  gif.finish();
  fs.writeFileSync(file, gif.bytes());
}

// The made-up team the README pictures are taken with: David, Max and Sara working on david/lobby-server. Each session
// has its own checkout, and the "GitHub repo" never touches the network (fetches fail at once). Every agent is a
// script playing its CLI, so the pictures don't depend on whose Mac takes them, and Claude Code never has to be asked
// to trust a folder. Used by screenshot.js and demo.js. Needs no GitHub account.
const { app, safeStorage, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hubModule = require('../src/hub');
const laneModule = require('../src/lane');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const people = {
  'tok-david': { login: 'david', name: 'David', avatar: '' },
  'tok-max': { login: 'max', name: 'Max', avatar: '' },
  'tok-sara': { login: 'sara', name: 'Sara', avatar: '' },
};
const verifyUser = async token => people[token] || null;
const { startLane } = laneModule;
const temp = [];
const running = [];
let own = null; // the script the next agent started from the app runs, in place of the real CLI

/** Starts a local hub standing in for the online one, signs David in, and calls run(win, hub) once the window loads. */
async function boot(run) {
  hubModule.githubUser = verifyUser;
  laneModule.startLane = o => startLane({ ...o, cmd: own ? path.join(own, o.cmd) : o.cmd });
  const hub = `http://127.0.0.1:${(await hubModule.startHub({ port: 0, host: '127.0.0.1', verifyUser })).port}`;
  process.env.PROTO_ONLINE_HUB = hub;
  app.setPath('userData', tempDir('protoplasma-stage-'));
  await app.whenReady();
  fs.writeFileSync(path.join(app.getPath('userData'), 'github-token'),
    safeStorage.encryptString(JSON.stringify({ token: 'tok-david', user: people['tok-david'] })));
  app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', async () => {
    win.webContents.setBackgroundThrottling(false); // keep painting while the window is behind others
    win.webContents.on('console-message', e => { if (['warning', 'error'].includes(e.level)) console.log(`[page] ${e.message} (${String(e.sourceId).split("/").pop()}:${e.lineNumber})`); });
    try { await run(win, hub); } catch (e) { console.error(e); process.exitCode = 1; } finally { cleanUp(); win.destroy(); }
  }));
  require('../app/main');
  // This Mac has all three agents, as far as the pictures go.
  ipcMain.removeHandler('agents:status');
  ipcMain.handle('agents:status', () => ['claude', 'codex', 'opencode'].map(cmd => ({ cmd, installed: true })));
}

const tempDir = prefix => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temp.push(dir); return dir; };

function cleanUp() {
  for (const lane of running) try { lane.term.kill(); } catch {}
  for (const dir of temp) fs.rmSync(dir, { recursive: true, force: true });
}

// ---- The repo ----

const files = {
  'package.json': JSON.stringify({ name: 'lobby-server', private: true, scripts: { dev: 'tsx watch src/main.ts', test: 'vitest' } }, null, 2) + '\n',
  'README.md': '# lobby-server\n\nMatchmaking and lobbies for the game. `pnpm dev` runs it locally.\n',
  'src/lobby/join.ts': `import { reserveSlot } from '../net/session_store';

export async function joinLobby(id: string, player: string) {
  const seat = await reserveSlot(id, player);
  return { id, seat };
}

export async function retryJoin(id: string, player: string) {
  return joinLobby(id, player);
}
`,
  'src/net/session_store.ts': `import { pickOpenSlot, seated } from '../lobby/seats';
import { db } from './db';

export async function reserveSlot(id: string, player: string) {
  const lobby = await db.get(id);
  const seat = pickOpenSlot(lobby);
  if (seat === null) throw new Error('lobby_full');
  await db.put(id, seated(lobby, seat, player));
  return seat;
}
`,
  'src/net/socket.ts': `export function connect(url: string) {
  const ws = new WebSocket(url);
  ws.onclose = () => console.warn('lobby socket closed');
  return ws;
}
`,
  'src/match/queue.ts': `export class Queue {
  private waiting: string[] = [];

  add(playerId: string) {
    this.waiting.push(playerId);
  }

  drop(playerId: string) {
    this.waiting = this.waiting.filter(p => p !== playerId);
  }
}
`,
  'src/leaderboard/cache.ts': `const scores = new Map<string, number>();

export const top = (n: number) => [...scores].sort((a, b) => b[1] - a[1]).slice(0, n);
`,
};

// Uncommitted work in each session's checkout: [file, line index, new lines, how many old lines they replace].
const edits = {
  'david/lobby-fix': [
    ['src/lobby/join.ts', 8, `  for (let n = 0; n < 4; n++) {
    try { return await joinLobby(id, player); }
    catch (e) { if (!isSeatTaken(e)) throw e; }
    await sleep(50 * 2 ** n);
  }`],
    ['src/net/session_store.ts', 7, '  if (!(await db.claim(id, seat, player))) throw new Error(\'seat_taken\');', 1],
  ],
  'max/lobby-fix': [['src/net/session_store.ts', 7, '  const ok = await db.putIf(id, lobby.rev, seated(lobby, seat, player));\n  if (!ok) throw new Error(\'seat_taken\');', 1]],
  'max/matchmaking-queue': [['src/match/queue.ts', 10, `
  // Keep a player's place for 30 seconds after they disconnect.
  park(playerId: string) {
    setTimeout(() => this.drop(playerId), 30_000);
  }`]],
  'sara/ws-reconnect': [['src/net/socket.ts', 2, '  ws.onclose = () => setTimeout(() => connect(url), backoff.next());', 1]],
  'sara/leaderboard-cache': [['src/leaderboard/cache.ts', 2, 'let sorted: [string, number][] | null = null;\nexport const record = (id: string, score: number) => { scores.set(id, score); sorted = null; };']],
};

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Writes the repo and a checkout for each session, with its work so far (leaving out `later`'s). Returns their folders. */
function stageRepo({ later = [] } = {}) {
  const stage = tempDir('protoplasma-repo-');
  const origin = path.join(stage, 'origin');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(origin, file)), { recursive: true });
    fs.writeFileSync(path.join(origin, file), text);
  }
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '.');
  git(origin, '-c', 'user.name=David', '-c', 'user.email=david@example.com', 'commit', '-q', '-m', 'Lobby server');
  const folders = {};
  for (const key of Object.keys(edits)) {
    const [who, session] = key.split('/');
    const dir = folders[key] = path.join(stage, who, `lobby-server@${session}`);
    git(stage, 'clone', '-q', origin, dir);
    git(dir, 'checkout', '-q', '-b', `session/${session}`);
    git(dir, 'remote', 'set-url', 'origin', 'git@github.com:david/lobby-server.git');
    git(dir, 'config', 'core.sshCommand', 'false'); // a made-up repo: fetches fail at once, without going online
    if (!later.includes(key)) applyEdits(folders, key);
  }
  return folders;
}

/** Makes one session's changes in its checkout. */
function applyEdits(folders, key) {
  for (const [file, at, text, replace = 0] of edits[key]) {
    const lines = fs.readFileSync(path.join(folders[key], file), 'utf8').split('\n');
    lines.splice(at, replace, text);
    fs.writeFileSync(path.join(folders[key], file), lines.join('\n'));
  }
}

// ---- Agents ----

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * Writes a scripted agent named after the CLI it plays (so the app labels it) and returns its folder. It lays itself out
 * like the real one at whatever size its terminal is, following `steps`:
 *   ['say', ...lines]           prints lines under the ones before
 *   ['box', typed, ...below]    draws Claude Code's prompt box at the bottom, with `typed` in it and lines under it
 *   ['spin', format, s, from]   animates a status line just above the box for `s` seconds (0: for good); the format gets
 *                               the spinner glyph (%s) and the seconds so far, counting from `from` (%d)
 *   ['wait', text]              waits until that line is typed in, then empties the box
 *   ['clear']                   starts again from an empty screen
 *   ['sleep', s]
 */
function agent(cmd, steps) {
  const dir = tempDir('protoplasma-agent-');
  const body = steps.map(([op, ...a]) => ({
    say: () => a.map(line => `say ${q(line)}`).join('\n'),
    box: () => `box ${q(a[0])} ${a.length - 1} ${q(a.slice(1).join('\r\n'))}`,
    spin: () => `spin ${q(a[0])} ${a[1] || 0} ${a[2] || 0}`,
    wait: () => `wait_for ${q(a[0])}`,
    clear: () => 'SAID=; N=0; Y=1; BOXED=0; printf \'\\033[2J\'',
    sleep: () => `sleep ${a[0]}`,
  })[op]()).join('\n');
  fs.writeFileSync(path.join(dir, cmd), `#!/bin/sh
echo "$PROTO_HOOK_SECRET" > ${q(path.join(dir, 'secret'))}
set -f; NL='
'; SAID=''; N=0; Y=1; NB=0; BL=''; TYPED=''; BOXED=0
size() { set -- $(stty size); R=$1; C=$2; TOP=$(( BOXED ? R - 2 - NB : R + 1 )); }
room() { echo $(( BOXED ? TOP - 3 : R )); } # above the spinner line and the box
rule() { printf '\\033[2m─\\033[%sb\\033[22m' $((C - 1)); }
say() {
  [ -z "$1" ] && set -- ' '
  SAID="$SAID$1$NL"; N=$((N + 1))
  if [ $Y -gt $(room) ]; then redraw; else printf '\\033[%s;1H\\033[2K%s' $Y "$1"; Y=$((Y + 1)); fi
}
# Like the real CLIs, lay everything out again when the terminal changes size, keeping the latest lines in view.
redraw() {
  size; r=$(room); [ $r -lt 1 ] && r=1
  printf '\\033[2J'
  printf '%s' "$SAID" | tail -n $r | { y=1; while IFS= read -r line; do printf '\\033[%s;1H%s' $y "$line"; y=$((y + 1)); done; }
  Y=$(( N < r ? N + 1 : r + 1 ))
  [ $BOXED = 1 ] && box "$TYPED" $NB "$BL"
}
trap redraw WINCH
box() {
  BOXED=1; TYPED=$1; NB=$2; BL=$3; TOP=$((R - 2 - NB))
  printf '\\033[%s;1H\\033[J' $TOP; rule; printf '\\r\\n\\033[2m>\\033[22m %s\\r\\n' "$1"; rule
  [ $NB -gt 0 ] && printf '\\r\\n%s' "$BL"
  printf '\\033[%s;%sH' $((TOP + 1)) $((3 + \${#1}))
}
spin() {
  i=0
  while [ $2 = 0 ] || [ $i -lt $(($2 * 4)) ]; do for s in '·' '✢' '✳' '✶' '✻' '✽'; do
    i=$((i + 1)); printf '\\0337\\033[%s;1H\\033[2K' $((TOP - 2)); printf "$1" "$s" $(($3 + i / 4)); printf '\\0338'; sleep 0.25
  done; done
  printf '\\0337\\033[%s;1H\\033[2K\\0338' $((TOP - 2))
}
wait_for() { while :; do read -r line || continue; [ "$line" = "$1" ] && break; done; box '' $NB "$BL"; }
sleep 1; size; printf '\\033[2J'
${body}
while :; do read -r line; done
`, { mode: 0o755 });
  return dir;
}

const secretOf = async dir => {
  while (!fs.existsSync(path.join(dir, 'secret'))) await sleep(50);
  return fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim();
};

/** Makes the next agent started from the app run these steps. Resolves to its hook secret once it's running. */
const ownAgent = (cmd, steps) => secretOf(own = agent(cmd, steps));

/** Runs a scripted agent as a teammate's, in `cwd`, at a fixed size. Resolves to { id, secret, write }. */
async function teammate({ hub, team, token, session, cwd, cmd, steps, cols = 80, rows = 40 }) {
  const dir = agent(cmd, steps);
  const lane = startLane({ hub, team, token, session, cmd: path.join(dir, cmd), cwd, cols, rows, env: process.env });
  running.push(lane);
  return { id: lane.id, secret: await secretOf(dir), write: d => lane.write(d) };
}

/** Sends a Claude Code hook event for a lane, as Claude would. */
const hook = (hub, lane, body) => fetch(`${hub}/hooks/${lane.id}`, { method: 'POST', headers: { authorization: `Bearer ${lane.secret}` },
  body: JSON.stringify({ cwd: '/', ...body }) });

// ---- Claude Code's look ----

const c = {
  dim: s => `\x1b[2m${s}\x1b[22m`, bold: s => `\x1b[1m${s}\x1b[22m`, orange: s => `\x1b[38;2;215;119;87m${s}\x1b[39m`,
  pick: s => `\x1b[38;2;177;185;249m${s}\x1b[39m`, green: s => `\x1b[38;2;78;186;101m${s}\x1b[39m`,
  added: s => `\x1b[48;2;19;53;29m${s}\x1b[K\x1b[49m`, removed: s => `\x1b[48;2;76;27;31m${s}\x1b[K\x1b[49m`,
};
c.tool = (name, arg) => `${c.green('⏺')} ${c.bold(name)}(${arg})`;
c.said = '⏺';
// Claude Code's light theme, for agents shown on the light page.
const light = { ...c, added: s => `\x1b[48;2;214;245;222m${s}\x1b[K\x1b[49m`, removed: s => `\x1b[48;2;253;224;224m${s}\x1b[K\x1b[49m` };
const claudeBanner = where => [
  `${c.orange(' ▐▛███▜▌')}   ${c.bold('Claude Code')} ${c.dim('v2.1.289')}`,
  `${c.orange('▝▜█████▛▘')}  ${c.dim('Opus 5.5 · Claude Pro')}`,
  `${c.orange('  ▘▘ ▝▝')}    ${c.dim(where)}`,
];
const accepting = c.dim('  ⏵⏵ accept edits on (shift+tab to cycle)');

module.exports = { boot, stageRepo, applyEdits, ownAgent, teammate, hook, sleep, c, light, claudeBanner, accepting };

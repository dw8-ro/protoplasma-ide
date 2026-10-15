// Runs an agent CLI (claude, codex, opencode) in a local pseudo-terminal and streams it to the team hub.
// Because it's the real interactive CLI, every slash command works. Used by the app, or standalone (see bottom).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const pty = require('node-pty');
const WebSocket = require('ws');
const { EDIT_TOOLS, appendScrollback } = require('./shared');

const RECONNECT_MS = 3000;
const REJOIN_MS = 30_000; // after being removed from a team: an invite back lets the agent rejoin
const PING_MS = 20_000; // a connection that misses a ping's answer for this long is dead (sleep, a network change)
const FLUSH_MS = 16; // TUIs redraw in many tiny writes; batch them into one message per frame
const GIT_POLL_MS = 5000;
const FETCH_EVERY = 12; // polls, so about once a minute
const MAX_CHANGED = 200; // uncommitted paths reported to the hub
// Codex and OpenCode have no hooks the hub can use, so their status comes from activity: output streaming means
// working, and this long without output means idle. Output just after a keystroke is the echo, not work.
const NO_HOOKS = ['codex', 'opencode'];
const QUIET_MS = 3000;
const ECHO_MS = 400;
// A CLI asking whether to trust its folder (Claude Code does in every new session folder). No hook fires for it.
// The question and both answers (Yes and No) on screen together, so output that only mentions the phrase doesn't count.
const TRUST_PROMPT = /trust\s*(?:this\s*folder|the\s*files\s*in\s*this\s*folder|the\s*contents\s*of\s*this\s*directory)/i;
const ANSWERS = /\bYes\b[\s\S]*\bNo\b|\bNo\b[\s\S]*\bYes\b/;
const stripAnsi = s => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');

// Per-run HTTP hooks for Claude Code. --settings merges with the user's own settings rather than replacing them.
// Hooks authenticate with a per-lane secret, so no GitHub or team credential enters Claude's environment.
// If the hub is down the hooks fail open and the agent keeps working.
function claudeHookSettings(url) {
  const hook = { type: 'http', url, timeout: 3, headers: { Authorization: 'Bearer $PROTO_HOOK_SECRET' }, allowedEnvVars: ['PROTO_HOOK_SECRET'] };
  return JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [hook] }],
    // Read: deliver a file's notes before any edit. Bash: confirm risky pushes.
    PreToolUse: [{ matcher: ['Read', 'Bash', ...EDIT_TOOLS].join('|'), hooks: [hook] }],
    PostToolUse: [{ hooks: [hook] }],
    PermissionRequest: [{ hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
  } });
}

const git = (cwd, ...args) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};
// The repo root as git reports it (symlinks resolved, e.g. /private/var/...) and as the agent sees it (/var/...), so
// the hub recognises a file whichever way an agent writes its path.
function rootsOf(cwd, root) {
  try { return [...new Set([root, path.join(cwd, path.relative(fs.realpathSync(cwd), root))])]; } catch { return [root]; }
}
/** "owner/name" from a GitHub remote URL (https or ssh), or '' for anything else. */
const repoFromRemote = url => /(?:^|[/@])github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] || '';
const githubRepo = cwd => repoFromRemote(git(cwd, 'remote', 'get-url', 'origin'));

/**
 * Branch, and what this checkout has that the repo's main branch doesn't: changed files (committed on the branch or
 * not, plus new files) with their paths from the repo root, and lines added/removed. Also how far behind it is (commits
 * on main, or on its own pushed branch, that it doesn't have), how far ahead of main, and how many commits aren't pushed.
 * `local` is the part of `changed` that is only here: not pushed (or not committed). Checkouts sharing a pushed branch
 * share its commits, so only this part can collide between them.
 * Never blocks; `fetch` updates the remote refs first, failing quietly when offline or unauthenticated.
 */
async function gitStatus(cwd, { env = process.env, fetch = false } = {}) {
  // null when git failed (a timeout, too much output): then there's nothing to report, not "no changes".
  const run = (...args) => new Promise(resolve => execFile('git', ['-c', 'core.quotePath=false', ...args],
    { cwd, encoding: 'utf8', maxBuffer: 10e6, timeout: 20_000, env: gitEnv(env) }, (err, out) => resolve(err ? null : out)));
  const line = async (...args) => (await run(...args) || '').trim();
  if (fetch) await fetchGit(cwd, env);
  let [branch, upstream, main] = await Promise.all([line('branch', '--show-current'), line('rev-parse', '--abbrev-ref', '@{upstream}'),
    line('rev-parse', '--abbrev-ref', 'origin/HEAD')]);
  branch ||= await line('rev-parse', '--short', 'HEAD'); // detached, e.g. mid-rebase: the commit stands in for the branch
  const exists = async ref => !!await line('rev-parse', '--verify', '--quiet', ref);
  // No origin/HEAD (a clone of an empty repo, a remote added by hand): main or master stands in.
  for (const ref of ['origin/main', 'origin/master']) if (!main && await exists(`refs/remotes/${ref}`)) main = ref;
  // A branch with a pushed copy but no upstream (pushed without -u, or a session branch made before a teammate pushed
  // it) is counted against that copy. A session branch also gets it as its upstream, so a plain `git pull` works there.
  // (Same name, so a bare `git push` still goes nowhere else.)
  if (!upstream && branch && await exists(`refs/remotes/origin/${branch}`)) {
    if (branch.startsWith('session/')) await run('branch', `--set-upstream-to=origin/${branch}`);
    upstream = `origin/${branch}`;
  }
  const base = main && await line('merge-base', 'HEAD', main); // where this checkout left main
  const count = async (...args) => Number(await line('rev-list', '--count', ...args)) || 0;
  const [numstat, untracked, behind, ahead, unpushed, sinceUpstream] = await Promise.all([
    run('diff', '--numstat', '-z', base || 'HEAD'), run('ls-files', '-z', '--others', '--exclude-standard', '--full-name'),
    count('^HEAD', ...[main, upstream].filter(Boolean)), main ? count(`${main}..HEAD`) : 0, count(`${upstream || main || 'HEAD'}..HEAD`),
    upstream ? line('merge-base', 'HEAD', upstream).then(at => run('diff', '--name-only', '-z', at || upstream)) : null]);
  if (numstat === null || untracked === null) return null;
  const added = untracked.split('\0').filter(Boolean), changed = [];
  // mainBranch: the branch origin/HEAD names (develop, trunk…), which the push guard protects like main.
  const stats = { branch, mainBranch: main.replace(/^origin\//, ''), added: 0, removed: 0, files: added.length, behind: main || upstream ? behind : 0, ahead, unpushed };
  // With -z each entry is "added\tremoved\tpath"; a rename has an empty path followed by its old and new paths.
  const fields = numstat.split('\0');
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const [plus, minus, file] = fields[i].split('\t');
    const name = file ? file : fields[i += 2]; // a rename counts as its new path
    stats.added += +plus || 0; // binary files report "-"
    stats.removed += +minus || 0;
    stats.files++;
    if (name) changed.push(name);
  }
  for (const file of added.slice(0, MAX_CHANGED)) changed.push(file); // (a spread of a huge list would overflow the stack)
  const local = sinceUpstream === null ? changed : [...new Set([...(sinceUpstream || '').split('\0').filter(Boolean), ...added])];
  return { ...stats, changed: changed.slice(0, MAX_CHANGED), local: local.slice(0, MAX_CHANGED) };
}
// Git run in the background never asks for anything: no password prompt nobody sees, no ssh passphrase on a terminal.
const gitEnv = env => ({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' });
/** Updates the remote refs, failing quietly when offline or unauthenticated. */
const fetchGit = (cwd, env = process.env) => new Promise(resolve => execFile('git', ['fetch', '--quiet'], { cwd, timeout: 20_000, env: gitEnv(env) }, () => resolve()));

// node-pty doesn't report a missing command (the lane would start and exit at once), so look for it first.
const runnable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
const installed = (cmd, env) => (cmd.includes('/') ? [cmd] : (env.PATH || '').split(path.delimiter).map(dir => path.join(dir, cmd))).some(runnable);
// Which Mac an agent runs on, without saying its name: the same folder path on two Macs is two checkouts.
const MACHINE = crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 16);

/**
 * Starts an agent CLI in a pseudo-terminal and streams it to the hub, reconnecting whenever the hub comes back.
 * @param {object} o
 * @param {string} o.hub hub URL
 * @param {string} o.team team id
 * @param {string} [o.token] GitHub token proving who you are (read:user is enough)
 * @param {() => Promise<{token: string, ca?: string}>} [o.credentials] instead of `token`: asked before each connection,
 *   for a hub on someone's Mac (a current pass, and `ca`, the certificate the connection must present)
 * @param {string} o.session session name shown on the Sessions page
 * @param {string} [o.cmd] CLI to run; `claude` also gets coordination hooks
 * @param {string[]} [o.args] its arguments
 * @param {string} [o.cwd] the folder it works in
 * @param {boolean} [o.open] let teammates type into this agent
 * @param {number} [o.cols] @param {number} [o.rows] the terminal's size
 * @param {object} [o.env] its environment
 * @param {(reason: string) => void} [o.onRefused] called when the hub turns it away (a 4xxx close)
 * @returns {{ id: string, term: import('node-pty').IPty, repo: string, write: (data: string) => void, rejoin: () => void,
 *   resize: (cols: number, rows: number) => void }}
 */
function startLane({ hub, team, token, credentials = () => ({ token }), session, cmd = 'claude', args = [], cwd = process.cwd(), open = false, cols = 120, rows = 36, env = process.env, onRefused }) {
  hub = new URL(hub).origin;
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Folder not found: ${cwd}`);
  if (!installed(cmd, env)) throw new Error(`The "${cmd}" command isn't installed on this Mac. Install it, then start the agent again.`);
  const id = crypto.randomUUID();
  const hookSecret = crypto.randomBytes(24).toString('hex');
  if (path.basename(cmd) === 'claude') args = ['--settings', claudeHookSettings(`${hub}/hooks/${id}`), ...args];
  // TODO: hooks for Codex and OpenCode. Their lanes get terminal sharing but no overlap warnings yet.

  let term;
  try {
    // The app's terminal (xterm.js) does 24-bit colour; saying so lets CLIs use their real colours.
    // Codex and OpenCode have no hooks, so they (and whatever they run) don't get the hook secret.
    const secret = NO_HOOKS.includes(path.basename(cmd)) ? {} : { PROTO_HOOK_SECRET: hookSecret };
    term = pty.spawn(cmd, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...env, COLORTERM: 'truecolor', ...secret } });
  } catch {
    throw new Error(`Couldn't start "${cmd}". Is it installed and on your PATH?`);
  }

  // Local scrollback, sent with every hello so a (re)started hub still gets the current screen.
  let ws, history = '', unsent = '', flushTimer = null, exited = false;
  let asking = false, recent = ''; // waiting on the trust prompt, and the latest output (plain text) to spot it in
  const byActivity = NO_HOOKS.includes(path.basename(cmd));
  let activity = null, quiet = null, lastInput = 0;
  const report = status => { if (activity !== status) { activity = status; send({ t: 'status', status }); } };
  const root = git(cwd, 'rev-parse', '--show-toplevel') || cwd;
  const hello = { t: 'hello', team, id, hookSecret, session, cmd: path.basename(cmd),
    root, roots: rootsOf(cwd, root), repo: githubRepo(cwd), branch: git(cwd, 'branch', '--show-current'), open, machine: MACHINE };
  const send = msg => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  let lastGit = null; // last reported git stats
  let retry = null, signingIn = false, creds = null; // creds: the sign-in last used, { token, ca? }
  // A hub on someone's Mac must present the certificate its pass names; `ca` pins the connection to exactly that one.
  const socketTo = c => new WebSocket(`${hub.replace(/^http/, 'ws')}/lane`, c.ca ? { ca: c.ca, checkServerIdentity: () => undefined } : undefined);
  function connect() {
    clearTimeout(retry);
    if (exited || signingIn || (ws && ws.readyState !== WebSocket.CLOSED)) return;
    signingIn = true;
    Promise.resolve().then(credentials).then(c => {
      signingIn = false;
      if (!exited) openSocket(creds = c);
    }, e => { // no pass to be had (the online hub is down): try again now and then, not on every reconnect
      signingIn = false;
      onRefused?.(String(e?.message || e));
      if (!exited) retry = setTimeout(connect, REJOIN_MS);
    });
  }
  function openSocket(c) {
    ws = socketTo(c);
    ws.alive = true;
    ws.on('pong', function () { this.alive = true; });
    ws.on('open', () => {
      unsent = ''; // history covers anything unsent
      send({ ...hello, token: c.token, cols: term.cols, rows: term.rows, history, git: lastGit });
      if (activity && (byActivity || asking)) send({ t: 'status', status: activity }); // a hooked agent's status is the hub's, from its hooks
    });
    ws.on('message', raw => {
      // Typing from teammates only reaches an agent started open, whatever the hub (or something posing as it) sends.
      try { const m = JSON.parse(raw); if (m.t === 'in' && open && typeof m.d === 'string') write(m.d); } catch {}
    });
    ws.on('close', (code, reason) => {
      if (code >= 4000) onRefused?.(String(reason));
      // Keep working offline and rejoin when the hub is back. Being removed from a team (4003) can be undone by an invite,
      // so that's retried now and then; a failed sign-in (4000, 4001) won't fix itself.
      if (code < 4000 || code === 4003) retry = setTimeout(connect, code === 4003 ? REJOIN_MS : RECONNECT_MS);
    });
    ws.on('error', () => {});
  }
  connect();
  // After sleep or a network change the socket can look open while nothing gets through; a missed ping answer ends it,
  // and the close reconnects.
  const beat = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    ws.ping();
  }, PING_MS);
  beat.unref();

  const flush = () => {
    flushTimer = null;
    if (unsent) send({ t: 'out', d: unsent });
    unsent = '';
  };
  term.onData(d => {
    history = appendScrollback(history, d);
    unsent += d;
    flushTimer ??= setTimeout(flush, FLUSH_MS);
    recent = (recent + stripAnsi(d)).slice(-400);
    if (!asking && TRUST_PROMPT.test(recent) && ANSWERS.test(recent)) { asking = true; recent = ''; clearTimeout(quiet); report('needs you'); }
    if (byActivity && !asking && Date.now() - lastInput > ECHO_MS) {
      report('working');
      clearTimeout(quiet);
      quiet = setTimeout(() => report('idle'), QUIET_MS);
    }
  });
  // Enter, Esc or typed text answers the trust prompt, so the agent goes back to idle until its hooks say otherwise.
  // The terminal's own automatic replies (escape sequences answering the CLI's queries) don't count.
  function write(d) {
    lastInput = Date.now();
    if (asking && (d === '\r' || d === '\x1b' || !d.includes('\x1b'))) { asking = false; recent = ''; report('idle'); }
    term.write(d);
  }
  // Report git progress (and branch switches) as the agent works, only when something changed.
  let polls = 0, polling = false, fetching = false;
  const pollGit = setInterval(async () => {
    if (polls++ % FETCH_EVERY === 0 && !fetching) { fetching = true; fetchGit(cwd, env).finally(() => { fetching = false; }); } // beside the poll, not in it
    if (polling) return;
    polling = true;
    const next = await gitStatus(cwd, { env }).finally(() => { polling = false; });
    if (exited || !next?.branch || JSON.stringify(next) === JSON.stringify(lastGit)) return;
    lastGit = next;
    send({ t: 'git', ...lastGit });
  }, GIT_POLL_MS);
  pollGit.unref();

  term.onExit(() => {
    exited = true;
    clearInterval(pollGit);
    clearInterval(beat);
    clearTimeout(quiet);
    clearTimeout(retry);
    flush();
    if (ws?.readyState === WebSocket.OPEN) return ws.close();
    // Offline when it ended: one last try, so teammates see how it finished rather than an older screen.
    ws?.terminate();
    if (!creds) return; // it never signed in
    const last = socketTo(creds);
    last.on('open', () => { last.send(JSON.stringify({ ...hello, token: creds.token, cols: term.cols, rows: term.rows, history, git: lastGit })); setTimeout(() => last.close(), 1000); });
    last.on('error', () => {});
    setTimeout(() => last.terminate(), 10_000).unref();
  });

  return { id, term, repo: hello.repo, write, rejoin: connect, resize(c, r) {
    if (exited || !(c > 0 && r > 0)) return; // a hidden terminal measures 0
    lastInput = Date.now(); // the redraw that follows isn't work
    try { term.resize(c, r); } catch { return; } // the agent exited a moment ago
    send({ t: 'size', cols: c, rows: r });
  } };
}

module.exports = { startLane, repoFromRemote, gitStatus, fetchGit, installed };

// Standalone: PROTO_TOKEN=<github token> node src/lane.js <hub-url> <team-id> <session> [--open] [cmd...]
// A classic token with no scopes is enough; it's only used for identity.
if (require.main === module) {
  const argv = process.argv.slice(2);
  const open = argv.includes('--open');
  const [hub, team, session, cmd = 'claude', ...args] = argv.filter(a => a !== '--open');
  if (!hub || !team || !session || !process.env.PROTO_TOKEN) {
    console.error('usage: PROTO_TOKEN=<github token> node src/lane.js <hub-url> <team-id> <session-name> [--open] [claude|codex|opencode|any cli...]');
    process.exit(1);
  }
  let lane, said = '';
  try {
    lane = startLane({ hub, team, token: process.env.PROTO_TOKEN, session, cmd, args, open, cols: process.stdout.columns, rows: process.stdout.rows,
      // Said once per reason: a removal is retried every 30 s, and the agent's screen shouldn't fill with it.
      onRefused: reason => { if (reason !== said) { said = reason; process.stderr.write(`\r\n[protoplasma] hub refused: ${reason}\r\n`); } } });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  lane.term.onData(d => process.stdout.write(d));
  lane.term.onExit(({ exitCode }) => process.exit(exitCode));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8'); // text, so Esc alone answers a trust prompt
  process.stdin.on('data', d => lane.write(d));
  process.stdout.on('resize', () => lane.resize(process.stdout.columns, process.stdout.rows));
}

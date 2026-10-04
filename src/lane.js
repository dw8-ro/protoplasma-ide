// Runs an agent CLI (claude, codex, opencode) in a local pseudo-terminal and streams it to the team hub.
// Because it's the real interactive CLI, every slash command works. Used by the app, or standalone (see bottom).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const pty = require('node-pty');
const WebSocket = require('ws');
const { EDIT_TOOLS, appendScrollback } = require('./shared');

const RECONNECT_MS = 3000;
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
const TRUST_PROMPT = /trust\s*(?:this\s*folder|the\s*files\s*in\s*this\s*folder)/i;
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
/** "owner/name" from a GitHub remote URL (https or ssh), or '' for anything else. */
const repoFromRemote = url => /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1] || '';
const githubRepo = cwd => repoFromRemote(git(cwd, 'remote', 'get-url', 'origin'));

/**
 * Branch, uncommitted changes (lines added/removed in tracked files, plus untracked files, and their paths from the repo
 * root) and how far the branch is behind/ahead of its upstream (or of the remote's default branch if it has none yet).
 * Never blocks; `fetch` updates the remote refs first, failing quietly when offline or unauthenticated.
 */
async function gitStatus(cwd, { env = process.env, fetch = false } = {}) {
  const run = (...args) => new Promise(resolve => execFile('git', args,
    { cwd, encoding: 'utf8', maxBuffer: 10e6, timeout: 20_000, env: { ...env, GIT_TERMINAL_PROMPT: '0' } }, (err, out) => resolve(err ? '' : out.trim())));
  if (fetch) await run('fetch', '--quiet');
  const [branch, numstat, untracked, upstream] = await Promise.all([
    run('branch', '--show-current'), run('diff', '--numstat', 'HEAD'), run('ls-files', '--others', '--exclude-standard', '--full-name'),
    run('rev-parse', '--abbrev-ref', '@{upstream}')]);
  const [behind, ahead] = (await run('rev-list', '--left-right', '--count', `${upstream || 'origin/HEAD'}...HEAD`)).split(/\s+/).map(Number);
  const changed = untracked ? untracked.split('\n') : [];
  const stats = { branch, added: 0, removed: 0, files: changed.length, behind: behind || 0, ahead: ahead || 0 };
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [added, removed, file] = line.split('\t');
    stats.added += +added || 0; // binary files report "-"
    stats.removed += +removed || 0;
    stats.files++;
    changed.push(file.replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '')); // a rename counts as its new path
  }
  return { ...stats, changed: changed.slice(0, MAX_CHANGED) };
}

/**
 * Starts an agent CLI in a pseudo-terminal and streams it to the hub, reconnecting whenever the hub comes back.
 * @param {object} o
 * @param {string} o.hub hub URL
 * @param {string} o.team team id
 * @param {string} o.token GitHub token proving who you are (read:user is enough)
 * @param {string} o.session session name shown on the Sessions page
 * @param {string} [o.cmd] CLI to run; `claude` also gets coordination hooks
 * @param {boolean} [o.open] let teammates type into this agent
 * @returns {{ id: string, term: import('node-pty').IPty, write: (data: string) => void, resize: (cols: number, rows: number) => void }}
 */
// node-pty doesn't report a missing command (the lane would start and exit at once), so look for it first.
const runnable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
const installed = (cmd, env) => (cmd.includes('/') ? [cmd] : (env.PATH || '').split(path.delimiter).map(dir => path.join(dir, cmd))).some(runnable);

function startLane({ hub, team, token, session, cmd = 'claude', args = [], cwd = process.cwd(), open = false, cols = 120, rows = 36, env = process.env, onRefused }) {
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
    term = pty.spawn(cmd, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...env, COLORTERM: 'truecolor', PROTO_HOOK_SECRET: hookSecret } });
  } catch {
    throw new Error(`Couldn't start "${cmd}". Is it installed and on your PATH?`);
  }

  // Local scrollback, sent with every hello so a (re)started hub still gets the current screen.
  let ws, history = '', unsent = '', flushTimer = null, exited = false;
  let asking = false, recent = ''; // waiting on the trust prompt, and the latest output (plain text) to spot it in
  const byActivity = NO_HOOKS.includes(path.basename(cmd));
  let activity = null, quiet = null, lastInput = 0;
  const report = status => { if (activity !== status) { activity = status; send({ t: 'status', status }); } };
  const hello = { t: 'hello', token, team, id, hookSecret, session, cmd: path.basename(cmd),
    root: git(cwd, 'rev-parse', '--show-toplevel') || cwd, repo: githubRepo(cwd), branch: git(cwd, 'branch', '--show-current'), open };
  const send = msg => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  let lastGit = null; // last reported git stats
  (function connect() {
    if (exited) return;
    ws = new WebSocket(`${hub.replace(/^http/, 'ws')}/lane`);
    ws.on('open', () => {
      unsent = ''; // history covers anything unsent
      send({ ...hello, cols: term.cols, rows: term.rows, history, git: lastGit });
      if (asking) send({ t: 'status', status: 'needs you' });
      else if (activity) send({ t: 'status', status: activity });
    });
    ws.on('message', raw => {
      try { const m = JSON.parse(raw); if (m.t === 'in' && typeof m.d === 'string') write(m.d); } catch {}
    });
    ws.on('close', (code, reason) => {
      if (code >= 4000) return onRefused?.(String(reason)); // auth failures: retrying won't help
      setTimeout(connect, RECONNECT_MS); // keep working offline and rejoin when the hub is back
    });
    ws.on('error', () => {});
  })();

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
    if (!asking && TRUST_PROMPT.test(recent)) { asking = true; recent = ''; send({ t: 'status', status: 'needs you' }); }
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
    if (asking && (d === '\r' || d === '\x1b' || !d.includes('\x1b'))) { asking = false; send({ t: 'status', status: 'idle' }); }
    term.write(d);
  }
  // Report git progress (and branch switches) as the agent works, only when something changed.
  let polls = 0;
  const pollGit = setInterval(async () => {
    const next = await gitStatus(cwd, { env, fetch: polls++ % FETCH_EVERY === 0 });
    if (exited || !next.branch || JSON.stringify(next) === JSON.stringify(lastGit)) return;
    lastGit = next;
    send({ t: 'git', ...lastGit });
  }, GIT_POLL_MS);
  pollGit.unref();

  term.onExit(() => { exited = true; clearInterval(pollGit); clearTimeout(quiet); flush(); ws.close(); });

  return { id, term, repo: hello.repo, write, resize(c, r) { term.resize(c, r); send({ t: 'size', cols: c, rows: r }); } };
}

module.exports = { startLane, repoFromRemote, gitStatus, installed };

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
  const lane = startLane({ hub, team, token: process.env.PROTO_TOKEN, session, cmd, args, open,
    cols: process.stdout.columns, rows: process.stdout.rows, onRefused: reason => console.error(`\r\n[protoplasma] hub refused: ${reason}\r\n`) });
  lane.term.onData(d => process.stdout.write(d));
  lane.term.onExit(({ exitCode }) => process.exit(exitCode));
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', d => lane.write(d));
  process.stdout.on('resize', () => lane.resize(process.stdout.columns, process.stdout.rows));
}

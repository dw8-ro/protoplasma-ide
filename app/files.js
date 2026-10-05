// The code view's access to a session's folder on this Mac: its files, their last committed versions, search, commits,
// and a watch for changes (so an agent's edits show up as it makes them). main.js decides which folders it may open.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MAX_BYTES = 2_000_000; // bigger files aren't opened in the editor
const MAX_FILES = 20_000;

// Git's own words for a failure: its error line, not the hints after it.
const gitError = (errOut, fallback) => {
  const lines = errOut.trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('hint:'));
  return (lines.find(l => /^(error|fatal):/.test(l)) || lines.find(l => l.startsWith('!')) || lines.pop() || fallback).replace(/^(error|fatal): /, '');
};
const git = (root, args, env) => new Promise((resolve, reject) => execFile('git', args, { cwd: root, env, maxBuffer: 64e6 },
  (err, out, errOut) => (err ? reject(Object.assign(new Error(gitError(errOut, err.message)), { code: err.code, stderr: errOut })) : resolve(out))));

/** The real path of `rel` inside `root`, refusing anything (symlinks included) that leads outside it. */
function inside(root, rel, { exists = true } = {}) {
  const base = fs.realpathSync(root);
  let full = path.resolve(base, String(rel));
  if (exists) full = fs.realpathSync(full);
  else full = path.join(fs.realpathSync(path.dirname(full)), path.basename(full));
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('That file is outside the session folder.');
  return full;
}

/** Every file in the folder, as paths from its root: what git tracks plus new files it doesn't ignore. */
async function list(root, env) {
  try {
    return (await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'], env))
      .split('\0').filter(Boolean).slice(0, MAX_FILES);
  } catch {
    return walk(root); // not a git repo
  }
}
function walk(root, dir = '', out = []) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (out.length >= MAX_FILES) break;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
  return out;
}

/**
 * The branch, how many commits aren't pushed yet, and each changed file with its state: M(odified), A(dded),
 * D(eleted), R(enamed) or U(ntracked).
 */
async function status(root, env) {
  try {
    const [branch, out, unpushed] = await Promise.all([git(root, ['branch', '--show-current'], env),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env),
      git(root, ['rev-list', '--count', '@{upstream}..HEAD'], env).catch(() => git(root, ['rev-list', '--count', 'origin/HEAD..HEAD'], env)).catch(() => '0')]);
    const entries = out.split('\0'), changes = [];
    for (let i = 0; i < entries.length; i++) {
      const [xy, file] = [entries[i].slice(0, 2), entries[i].slice(3)];
      if (!file) continue;
      if (/[RC]/.test(xy)) i++; // a rename is followed by the old path
      const state = xy === '??' ? 'U' : /D/.test(xy) ? 'D' : /R/.test(xy) ? 'R' : /A/.test(xy) ? 'A' : 'M';
      changes.push({ path: file, state });
    }
    return { branch: branch.trim(), unpushed: Number(unpushed) || 0, changes };
  } catch {
    return { branch: '', unpushed: 0, changes: [] };
  }
}

/** A file's text, or why it can't be shown. */
function read(root, rel) {
  let file;
  try { file = inside(root, rel); } catch (e) { if (e.code === 'ENOENT') return { gone: true }; throw e; }
  if (fs.statSync(file).size > MAX_BYTES) return { tooBig: true };
  const bytes = fs.readFileSync(file);
  return bytes.subarray(0, 8000).includes(0) ? { binary: true } : { text: bytes.toString('utf8') };
}

/** The file as of the last commit ('' for a file that's new since). */
const committed = (root, rel, env) => git(root, ['show', `HEAD:./${rel}`], env).catch(() => '');

function write(root, rel, text) {
  fs.writeFileSync(inside(root, rel, { exists: fs.existsSync(path.resolve(root, String(rel))) }), String(text));
}

/** Lines containing `query` (any case), at most 20 per file: [{ path, line, text }]. */
async function search(root, query, env) {
  if (!String(query).trim()) return [];
  try {
    const out = await git(root, ['grep', '-n', '-I', '-i', '-F', '--max-count=20', '--untracked', '-e', String(query)], env);
    return out.split('\n').filter(Boolean).slice(0, 500).map(line => {
      const [, file, at, text] = /^(.*?):(\d+):(.*)$/.exec(line) || [];
      return { path: file, line: Number(at), text: (text || '').trim().slice(0, 200) };
    }).filter(hit => hit.path);
  } catch (e) {
    if (e.code === 1) return []; // no matches
    throw e;
  }
}

/**
 * Commits everything with `message` (if there's one) and pushes the branch. When a teammate pushed to the same branch
 * first, this work goes on top of theirs and is pushed again. Resolves to what happened, in words.
 */
async function commitAndPush(root, message, env) {
  const done = message ? 'Committed and pushed.' : 'Pushed.';
  if (message) {
    await git(root, ['add', '-A'], env);
    await git(root, ['commit', '-m', String(message)], env);
  }
  const was = message ? 'Committed, but' : 'It';
  const push = () => git(root, ['push', '-u', 'origin', 'HEAD'], env);
  try {
    await push();
    return done;
  } catch (e) {
    if (!/rejected|non-fast-forward|fetch first/.test(e.stderr || e.message)) return `${was} couldn't be pushed: ${e.message}`;
  }
  const branch = (await git(root, ['branch', '--show-current'], env)).trim();
  try {
    await git(root, ['pull', '--rebase', '--autostash', 'origin', branch], env);
  } catch {
    await git(root, ['rebase', '--abort'], env).catch(() => {});
    return `${was} couldn't be pushed: a teammate changed the same lines on ${branch}. Pull in the Terminal tab and sort out the conflict, or ask your agent to.`;
  }
  try {
    await push();
    return `${message ? 'Committed, put' : 'Put'} on top of your teammate's work on ${branch}, and pushed.`;
  } catch (e) {
    return `${was} couldn't be pushed: ${e.message}`;
  }
}

/** Calls onChange(paths) shortly after files in the folder change. Returns a function that stops watching. */
function watch(root, onChange) {
  let changed = new Set(), timer = null;
  const watcher = fs.watch(root, { recursive: true }, (_, file) => {
    if (!file) return;
    const rel = file.split(path.sep).join('/');
    // Inside .git, only a new commit or index matters (it changes what counts as changed).
    if (rel.startsWith('.git/') && !/^\.git\/(index|HEAD)$/.test(rel)) return;
    changed.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => { const paths = [...changed]; changed = new Set(); onChange(paths); }, 150);
  });
  watcher.on('error', () => {});
  return () => { clearTimeout(timer); watcher.close(); };
}

module.exports = { list, status, read, committed, write, search, commitAndPush, watch, inside };

// The code view's access to a session's folder on this Mac: its files, their last committed versions, search, commits,
// and a watch for changes (so an agent's edits show up as it makes them). main.js decides which folders it may open.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const MAX_BYTES = 2_000_000; // bigger files aren't opened in the editor
const MAX_FILES = 20_000;

// Git's own words for a failure: its error, including the lines it wraps onto, not the hints after it.
const gitError = (errOut, fallback) => {
  const lines = errOut.trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('hint:'));
  const at = lines.findIndex(l => /^(error|fatal):/.test(l));
  if (at < 0) return lines.find(l => l.startsWith('!')) || lines.pop() || fallback;
  const rest = lines.slice(at + 1).findIndex(l => /^(error|fatal|!|To |\w+:)/.test(l));
  return lines.slice(at, rest < 0 ? at + 4 : at + 1 + rest).join(' ').replace(/^(error|fatal): /, '');
};
// Paths as they are (not C-quoted), never a password prompt nobody can see, and a limit for a network that hangs.
const git = (root, args, env) => new Promise((resolve, reject) => execFile('git', ['-c', 'core.quotePath=false', ...args],
  // Commits and pushes run the repo's own hooks (tests, linters), which get much longer.
  { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64e6, timeout: { commit: 0, push: 900_000 }[args[0]] ?? 120_000 },
  (err, out, errOut) => (err ? reject(Object.assign(new Error(gitError(errOut || out, err.message)), { code: err.code, stderr: errOut })) : resolve(out))));

/** The real path of `rel` inside `root`, refusing anything (symlinks included) that leads outside it. */
function inside(root, rel, { exists = true } = {}) {
  const base = fs.realpathSync(root);
  let full = path.resolve(base, String(rel));
  if (exists) full = fs.realpathSync(full);
  else {
    full = path.join(fs.realpathSync(path.dirname(full)), path.basename(full));
    if (fs.lstatSync(full, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('That file is outside the session folder.'); // a link to nowhere
  }
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

/** A rebase, merge, cherry-pick or revert that was started and not finished, or null. */
function underWay(root) {
  try {
    const dir = path.resolve(root, execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim());
    return [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]
      .find(([file]) => fs.existsSync(path.join(dir, file)))?.[1] || null;
  } catch { return null; }
}

/**
 * The branch, how many commits aren't pushed yet, any rebase or merge under way, and each changed file with its
 * state: M(odified), A(dded), D(eleted), R(enamed), U(ntracked) or C(onflicted).
 */
async function status(root, env) {
  try {
    // Status paths are from the repo's root; a session folder can be a part of the repo, and its paths start there.
    const [branch, out, unpushed, prefix] = await Promise.all([git(root, ['branch', '--show-current'], env),
      git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env),
      git(root, ['rev-list', '--count', '@{upstream}..HEAD'], env).catch(() => git(root, ['rev-list', '--count', 'origin/HEAD..HEAD'], env)).catch(() => '0'),
      git(root, ['rev-parse', '--show-prefix'], env).then(p => p.trim(), () => '')]);
    const entries = out.split('\0'), changes = [];
    for (let i = 0; i < entries.length; i++) {
      const [xy, file] = [entries[i].slice(0, 2), entries[i].slice(3)];
      if (/[RC]/.test(xy)) i++; // a rename is followed by the old path
      if (!file || !file.startsWith(prefix)) continue;
      const state = xy === '??' ? 'U' : /U|AA|DD/.test(xy) ? 'C' : /D/.test(xy) ? 'D' : /R/.test(xy) ? 'R' : /A/.test(xy) ? 'A' : 'M';
      changes.push({ path: file.slice(prefix.length), state });
    }
    return { branch: branch.trim(), unpushed: Number(unpushed) || 0, underWay: underWay(root), changes };
  } catch {
    return { branch: '', unpushed: 0, underWay: null, changes: [] };
  }
}

/** A file's text, or why it can't be shown. */
function read(root, rel) {
  let file;
  try { file = inside(root, rel); } catch (e) { if (e.code === 'ENOENT') return { gone: true }; throw e; }
  const stat = fs.statSync(file);
  if (stat.isDirectory()) return { binary: true }; // a submodule
  if (stat.size > MAX_BYTES) return { tooBig: true };
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8000).includes(0)) return { binary: true };
  // Text in another encoding would come back changed after a save, so it isn't opened.
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; } catch { return { notUtf8: true }; } // a BOM stays
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
  // Committing in the middle of a rebase or merge would commit its conflict markers.
  const busy = underWay(root);
  if (busy) throw new Error(`A ${busy} is under way. Finish it (or abort it) in the Terminal tab, then commit.`);
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
    // Only a teammate's newer commits are worked around; the server refusing it (a protected branch) is reported as is.
    if (!/non-fast-forward|fetch first/.test(e.stderr || e.message)) return `${was} couldn't be pushed: ${e.message}`;
  }
  const branch = (await git(root, ['branch', '--show-current'], env)).trim();
  try {
    await git(root, ['pull', '--rebase', '--autostash', 'origin', branch], env);
  } catch (e) {
    const conflict = underWay(root);
    await git(root, ['rebase', '--abort'], env).catch(() => {});
    if (!conflict) return `${was} couldn't be pushed: ${e.message}`;
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
    if (/(^|\/)node_modules\//.test(rel)) return; // installs and builds churn there
    changed.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => { const paths = [...changed]; changed = new Set(); onChange(paths); }, 150);
  });
  watcher.on('error', () => {});
  return () => { clearTimeout(timer); watcher.close(); };
}

module.exports = { list, status, read, committed, write, search, commitAndPush, watch, inside };

// The code view's access to a session's folder on this Mac: its files, their last committed versions, search, commits,
// and a watch for changes (so an agent's edits show up as it makes them). main.js decides which folders it may open.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const MAX_BYTES = 2_000_000; // bigger files aren't opened in the editor
const MAX_FILES = 20_000;

// Git's own words for a failure: its error, including the lines it wraps onto, not the hints after it. A refused push
// says why above "failed to push some refs": the server's remote: lines, a hook's output, or the reason on its ! line.
const gitError = (errOut, fallback) => {
  const lines = errOut.trim().split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('hint:'));
  const at = lines.findIndex(l => /^(error|fatal):/.test(l));
  if (at < 0) return lines.find(l => l.startsWith('!')) || lines.pop() || fallback;
  const rest = lines.slice(at + 1).findIndex(l => /^(error|fatal|!|To |\w+:)/.test(l));
  const message = lines.slice(at, rest < 0 ? at + 4 : at + 1 + rest).join(' ').replace(/^(error|fatal): /, '');
  if (!/failed to push some refs/.test(message)) return message;
  const said = lines.slice(0, at).filter(l => !/^(To |!|Enumerating|Counting|Compressing|Writing|Total|Delta)/.test(l))
    .map(l => l.replace(/^remote:\s*/, '')).filter(l => l && !/^-+$/.test(l));
  const refused = lines.find(l => l.startsWith('!'))?.match(/\(([^)]*)\)\s*$/)?.[1];
  return [...said.slice(-6), refused && `(${refused})`].filter(Boolean).join(' ') || message;
};
// Paths as they are (not C-quoted), never a password prompt nobody can see, and a limit for a network that hangs.
const git = (root, args, env) => new Promise((resolve, reject) => execFile('git', ['-c', 'core.quotePath=false', ...args],
  // Commits and pushes run the repo's own hooks (tests, linters), which get much longer.
  { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 64e6, timeout: { commit: 0, push: 900_000 }[args[0]] ?? 120_000 },
  (err, out, errOut) => (err ? reject(Object.assign(new Error(err.killed ? 'Git took too long, so it was stopped.' : gitError(errOut || out, err.message)),
    { code: err.code, stderr: errOut, killed: err.killed })) : resolve(out))));

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

/**
 * Every file in the folder, as paths from its root: what git tracks plus new files it doesn't ignore. Past the limit,
 * new files (often an agent's) are kept and tracked ones cut.
 */
async function list(root, env) {
  const files = args => git(root, ['ls-files', '-z', ...args], env).then(out => out.split('\0').filter(Boolean).map(p => p.replace(/\/$/, ''))); // a nested repo ends in /
  try {
    const [added, tracked] = await Promise.all([files(['--others', '--exclude-standard']), files(['--cached', '--deduplicate'])]);
    return [...added.slice(0, MAX_FILES), ...tracked.slice(0, Math.max(0, MAX_FILES - added.length))];
  } catch {
    return walk(root); // not a git repo
  }
}
function walk(root, dir = '', out = []) {
  let entries;
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return out; } // a folder it can't read
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, rel, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(rel); // not pipes or sockets: reading one would wait forever
  }
  return out;
}

/** A rebase, merge, cherry-pick or revert that was started and not finished, or null. */
function underWay(root, env = process.env) {
  try {
    const dir = path.resolve(root, execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return [['rebase-merge', 'rebase'], ['rebase-apply', 'rebase'], ['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]
      .find(([file]) => fs.existsSync(path.join(dir, file)))?.[1] || null;
  } catch { return null; }
}

/**
 * The branch, how many commits aren't pushed yet, any rebase or merge under way, and each changed file with its
 * state: M(odified), A(dded), D(eleted), R(enamed), U(ntracked) or C(onflicted). `prefix` is where the folder sits in
 * its repo ('' at the top): teammates' paths are from the repo's top. `notGit` for a folder that isn't a repository.
 */
async function status(root, env) {
  if (!await git(root, ['rev-parse', '--is-inside-work-tree'], env).then(() => true, () => false)) {
    return { branch: '', unpushed: 0, underWay: null, changes: [], prefix: '', notGit: true };
  }
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
    return { branch: branch.trim(), unpushed: Number(unpushed) || 0, underWay: underWay(root, env), changes, prefix };
  } catch (e) {
    return { branch: '', unpushed: 0, underWay: null, changes: [], prefix: '', error: e.message };
  }
}

/** A file's text, or why it can't be shown. */
function read(root, rel) {
  let file;
  try { file = inside(root, rel); } catch (e) { return e.code === 'ENOENT' ? { gone: true } : { outside: true }; } // a link out of the folder
  const stat = fs.statSync(file);
  if (!stat.isFile()) return { binary: true }; // a submodule, a pipe
  if (stat.size > MAX_BYTES) return { tooBig: true };
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8000).includes(0)) return { binary: true };
  // Text in another encoding would come back changed after a save, so it isn't opened.
  try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; } catch { return { notUtf8: true }; } // a BOM stays
}

// Whether `rel` stays inside `root` by its name alone (for paths that may not exist yet, or only in git).
const within = (root, rel) => { const full = path.resolve(root, String(rel)); return full.startsWith(path.resolve(root) + path.sep); };
/** The file as of the last commit ('' for a file that's new since). */
const committed = (root, rel, env) => (within(root, rel) ? git(root, ['show', `HEAD:./${rel}`], env).catch(() => '') : Promise.resolve(''));

function write(root, rel, text) {
  if (!within(root, rel)) throw new Error('That file is outside the session folder.');
  const target = path.resolve(root, String(rel));
  let existing = path.dirname(target);
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  inside(root, path.relative(root, existing)); // no folders made through a link that leads out
  fs.mkdirSync(path.dirname(target), { recursive: true }); // a file whose folder was deleted goes back with its folder
  if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() && !fs.existsSync(target)) throw new Error('That file is a link to something that doesn\'t exist.');
  fs.writeFileSync(inside(root, rel, { exists: fs.existsSync(target) }), String(text));
}

/** Lines containing `query` (any case), at most 20 per file: [{ path, line, text }]. */
async function search(root, query, env) {
  if (!String(query).trim()) return [];
  // -z puts a NUL after the path and the line number, so neither needs guessing; a folder outside git is searched too.
  const grep = scope => git(root, ['grep', '-z', '-n', '-I', '-i', '-F', '--max-count=20', ...scope, '-e', String(query)], env);
  let out;
  try { out = await grep(['--untracked']); } catch (e) {
    if (e.code === 1) return []; // no matches
    if (!/not a git repository/i.test(e.message)) throw e;
    try { out = await grep(['--no-index', '--exclude-standard']); } catch (e2) { if (e2.code === 1) return []; throw e2; }
  }
  return out.split('\n').filter(Boolean).slice(0, 500).map(record => {
    const [file, at, ...text] = record.split('\0');
    return { path: file, line: Number(at), text: text.join(' ').replace(/\r$/, '').trim().slice(0, 200) };
  }).filter(hit => hit.path && hit.line);
}

const CONFLICT_LINES = /^(<{7}|>{7})( |$)/m; // what git writes around both sides of a conflict

/**
 * Brings a teammate's newer work on this branch into this checkout, after Commit & Push found you both changed the same
 * lines. A merge, not a rebase: lines changed on both sides get git's conflict lines and are marked C, to fix in the
 * editor; Commit & Push then finishes the merge. Resolves to what happened, in words.
 */
async function pull(root, env) {
  const busy = underWay(root, env);
  if (busy) throw new Error(`A ${busy} is already under way. Finish it (or abort it) first.`);
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'], env)).trim()) throw new Error('Commit or undo your changes first, so they aren\'t mixed into the pull.');
  const branch = (await git(root, ['branch', '--show-current'], env)).trim();
  if (!branch) throw new Error('This checkout isn\'t on a branch (a detached HEAD). Switch to one in the Terminal tab first.');
  try {
    // --ff and --no-rebase override a pull.ff or pull.rebase setting that would refuse or rebase instead.
    await git(root, ['pull', '--no-rebase', '--ff', '--no-edit', 'origin', branch], env);
    return `Pulled your teammate's work on ${branch}. Commit & Push to send yours.`;
  } catch (e) {
    if (underWay(root, env) !== 'merge') throw e;
    return `Pulled your teammate's work on ${branch}. The files marked C changed on both sides: in each, keep what should stay and delete git's <<<<<<<, ======= and >>>>>>> lines, save, then Commit & Push.`;
  }
}

/**
 * Commits everything with `message` (if there's one) and pushes the branch. When a teammate pushed to the same branch
 * first, this work goes on top of theirs and is pushed again. During a merge (from Pull), finishes it instead, once no
 * file has conflict lines left. Resolves to what happened, in words.
 */
async function commitAndPush(root, message, env) {
  // Committing in the middle of a rebase, or with files still conflicted, would commit conflict markers.
  const busy = underWay(root, env);
  if (busy && busy !== 'merge') throw new Error(`A ${busy} is under way. Finish it (or abort it) in the Terminal tab, then commit.`);
  const conflicted = async () => (await git(root, ['diff', '--name-only', '--diff-filter=U'], env).catch(() => '')).trim();
  if (busy === 'merge') return finishMerge(root, message, env, (await conflicted()).split('\n').filter(Boolean));
  if (await conflicted()) throw new Error('Some files still have conflicts (marked C). Sort them out first.');
  if (!(await git(root, ['branch', '--show-current'], env)).trim()) throw new Error('This checkout isn\'t on a branch (a detached HEAD). Switch to one in the Terminal tab first.');
  const done = message ? 'Committed and pushed.' : 'Pushed.';
  if (message) {
    // Only this folder: in a session that is part of a bigger repo, the rest isn't what the person looked at.
    await git(root, ['add', '-A', '--', '.'], env);
    await git(root, ['commit', '-m', String(message), '--', '.'], env);
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
    return `${was} couldn't be pushed: a teammate changed the same lines on ${branch}. Pull their work, fix the files marked C, then Commit & Push. Or ask your agent to.`;
  }
  // Uncommitted edits put back after the rebase can clash with the teammate's change: then they're marked C.
  const clashed = await conflicted() ? ' Your uncommitted changes clashed with theirs when put back: sort out the files marked C (git keeps your version in its stash too).' : '';
  try {
    await push();
    return `${message ? 'Committed, put' : 'Put'} on top of your teammate's work on ${branch}, and pushed.${clashed}`;
  } catch (e) {
    return `${was} couldn't be pushed: ${e.message}${clashed}`;
  }
}

// Fixed files still count as conflicted to git until they're added, so a file is taken as fixed once its conflict lines
// are gone. `unmerged` paths are from the repo's top.
async function finishMerge(root, message, env, unmerged) {
  const top = (await git(root, ['rev-parse', '--show-toplevel'], env)).trim();
  const left = unmerged.filter(f => { try { return CONFLICT_LINES.test(fs.readFileSync(path.join(top, f), 'utf8')); } catch { return false; } }); // a deleted file has none
  if (left.length) throw new Error(`Some files still have git's conflict lines (<<<<<<<): ${left.slice(0, 3).join(', ')}. Fix them and save, then Commit & Push.`);
  await git(root, ['add', '-A', '--', '.'], env);
  if (unmerged.length) await git(top, ['add', '-A', '--', ...unmerged], env);
  await git(root, ['commit', ...(message ? ['-m', String(message)] : ['--no-edit'])], env); // the whole merge: it can't be split by folder
  try {
    await git(root, ['push', '-u', 'origin', 'HEAD'], env);
    return 'Merged and pushed.';
  } catch (e) {
    return /non-fast-forward|fetch first/.test(e.stderr || e.message)
      ? 'Merged, but couldn\'t be pushed: a teammate pushed again since. Pull again, then Commit & Push.'
      : `Merged, but couldn't be pushed: ${e.message}`;
  }
}

/**
 * Calls onChange(paths) shortly after files in the folder change (at least once a second while something keeps
 * writing). Returns a function that stops watching. In a session worktree git's own files live elsewhere, so a commit
 * there isn't seen; the code view also checks git's status every few seconds.
 */
function watch(root, onChange) {
  let changed = new Set(), timer = null, since = 0;
  const flush = () => { clearTimeout(timer); timer = null; const paths = [...changed]; changed = new Set(); onChange(paths); };
  const watcher = fs.watch(root, { recursive: true }, (_, file) => {
    if (!file) return;
    const rel = file.split(path.sep).join('/');
    // Inside .git, only a new commit or index matters (it changes what counts as changed).
    if (rel.startsWith('.git/') && !/^\.git\/(index|HEAD)$/.test(rel)) return;
    if (/(^|\/)node_modules\//.test(rel)) return; // installs and builds churn there
    changed.add(rel);
    if (!timer) since = Date.now();
    clearTimeout(timer);
    timer = Date.now() - since > 1000 ? (flush(), null) : setTimeout(flush, 150);
  });
  watcher.on('error', () => {});
  return () => { clearTimeout(timer); watcher.close(); };
}

/** Where `root` sits in its repo ('' at the top, or outside git): agents report paths from the repo's top. */
const prefixOf = (root, env) => git(root, ['rev-parse', '--show-prefix'], env).then(p => p.trim(), () => '');

module.exports = { list, status, read, committed, write, search, pull, commitAndPush, watch, inside, prefixOf };

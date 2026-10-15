// Per-session git worktrees. Each session gets its own folder and its own branch, so sessions never share a checkout
// and nothing reaches the default branch without a push (ideally a pull request).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { slug } = require('./shared');

// Git's own reason for a failure: its last "fatal:" or "error:" line, not a hint after it.
const reasonOf = (errOut, fallback) => {
  const lines = errOut.trim().split('\n');
  return (lines.filter(l => /^(fatal|error):/.test(l)).pop() || lines.pop() || fallback).replace(/^(fatal|error):\s*/, '');
};
// A stalled network (a captive portal, a dead VPN) gives up after a while instead of holding up a new session.
const git = (cwd, args, env) => new Promise((resolve, reject) => execFile('git', args,
  { cwd, encoding: 'utf8', env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: args[0] === 'fetch' ? 30_000 : 300_000 },
  (err, out, errOut) => (err ? reject(new Error(reasonOf(errOut, err.message))) : resolve(out.trim()))));
const tryGit = (cwd, args, env) => git(cwd, args, env).catch(() => '');

// The branch new sessions start from: the remote's default branch. If origin/HEAD is stale (the default branch was
// renamed on GitHub) it's looked up again; offline with nothing known, the local main or master; HEAD as a last resort.
async function baseOf(clone, env) {
  const exists = ref => tryGit(clone, ['rev-parse', '--verify', '--quiet', ref], env);
  const head = async () => { const ref = await tryGit(clone, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env); return ref && await exists(ref) && ref; };
  let base = await head();
  if (!base) { await tryGit(clone, ['remote', 'set-head', 'origin', '--auto'], env); base = await head(); }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) if (!base && await exists(ref)) base = ref;
  return base || 'HEAD';
}

const making = new Map(); // folder -> its creation under way, so two agents starting at once share one
/**
 * The session's worktree of `clone`, created on first use at `<clone>@<session>` on the branch `session/<session>`.
 * If a teammate already pushed that branch it continues from theirs; otherwise it starts from the remote's default
 * branch. The new branch has no upstream, so a bare `git push` can't land on the default branch by accident.
 * @returns {Promise<{ dir: string, branch: string }>}
 */
function sessionWorktree(clone, session, env = process.env) {
  const dir = `${clone}@${slug(session)}`;
  if (!making.has(dir)) making.set(dir, makeWorktree(clone, session, dir, env).finally(() => making.delete(dir)));
  return making.get(dir);
}
async function makeWorktree(clone, session, dir, env) {
  const branch = `session/${slug(session)}`;
  if (fs.existsSync(path.join(dir, '.git'))) {
    // A leftover from an older clone points at a worktree git no longer knows: every git command there would fail.
    if (!await tryGit(dir, ['rev-parse', '--git-dir'], env)) throw new Error(`The folder ${dir} is left over from an earlier copy of the repo. Move it away, then start again.`);
    return { dir, branch };
  }
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`There's already a folder at ${dir} that isn't this session's. Move it away, then start again.`);

  await tryGit(clone, ['fetch', 'origin', '--prune'], env); // fine to be offline
  await tryGit(clone, ['worktree', 'prune'], env);          // forget worktrees whose folders were deleted
  const exists = ref => tryGit(clone, ['rev-parse', '--verify', '--quiet', ref], env);
  const base = await baseOf(clone, env);
  // An old session's branch of the same name that is already in main (merged, its remote branch gone) starts over,
  // rather than bringing its old commits back. Nothing is lost: main has them.
  if (await exists(`refs/heads/${branch}`) && !await exists(`refs/remotes/origin/${branch}`)
    && await git(clone, ['merge-base', '--is-ancestor', branch, base], env).then(() => true, () => false)) {
    await tryGit(clone, ['branch', '-D', branch], env);
  }
  const existed = fs.existsSync(dir);
  try {
    if (await exists(`refs/heads/${branch}`)) await git(clone, ['worktree', 'add', dir, branch], env);
    else if (await exists(`refs/remotes/origin/${branch}`)) await git(clone, ['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`], env);
    else await git(clone, ['worktree', 'add', '--no-track', '-b', branch, dir, base], env);
  } catch (e) {
    // A half-made folder (git stopped part way) would look ready next time.
    await tryGit(clone, ['worktree', 'remove', '--force', dir], env);
    if (!existed) fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { dir, branch };
}

// Ignored files that a build or install makes again; anything else ignored (.env, a local database) is someone's work.
const REMAKEABLE = /^(node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|\.venv|venv|__pycache__|\.pytest_cache|\.gradle|\.DS_Store)(\/|$)/;
/**
 * Removes a session's worktree folder. Git refuses if it has uncommitted changes; this also refuses if it holds ignored
 * files that aren't build output (git would delete them). The session branch is kept either way.
 */
async function removeSessionWorktree(clone, session, env = process.env) {
  const dir = `${clone}@${slug(session)}`;
  if (!fs.existsSync(dir)) { await tryGit(clone, ['worktree', 'prune'], env); return false; } // deleted by hand: forget it
  const ignored = (await tryGit(dir, ['status', '--porcelain', '--ignored'], env)).split('\n')
    .filter(l => l.startsWith('!! ')).map(l => l.slice(3)).filter(p => !p.split('/').some((_, i, parts) => REMAKEABLE.test(parts.slice(i).join('/'))));
  if (ignored.length) {
    throw Object.assign(new Error(`It has files git ignores that would be lost (${ignored.slice(0, 3).join(', ')}${ignored.length > 3 ? ', …' : ''}), so it was kept.`), { kept: true });
  }
  await git(clone, ['worktree', 'remove', dir], env);
  return true;
}

// A pre-push hook for the clones the app makes. It only acts for agents started with PROTO_SHARED_TEAM set: Codex and
// OpenCode on a team with other people. (Claude agents are asked through their hooks instead, and people pushing from
// their own terminal aren't affected.)
const PUSH_GUARD = `#!/bin/sh
# Added by Protoplasma. Stops agents on a shared team from pushing straight to main, master or the repo's default
# branch, deleting branches, or force-pushing. People pushing from their own terminal aren't affected.
[ -n "$PROTO_SHARED_TEAM" ] || exit 0
zero=0000000000000000000000000000000000000000
default=$(git symbolic-ref --quiet --short "refs/remotes/$1/HEAD" 2>/dev/null)
default=\${default#"$1"/}
while read -r local_ref local_sha remote_ref remote_sha; do
  branch=\${remote_ref#refs/heads/}
  if [ "$branch" = main ] || [ "$branch" = master ] || [ "$branch" = "$default" ]; then
    echo "Protoplasma: don't push straight to $branch, which your team shares. Push the session branch and open a pull request." >&2
    exit 1
  fi
  if [ "$local_sha" = "$zero" ] && [ "$branch" != "$remote_ref" ]; then
    echo "Protoplasma: this would delete $branch on the remote, and teammates may have pushed to it. If it's meant, a person can delete it from their own terminal." >&2
    exit 1
  fi
  if [ "$remote_sha" != "$zero" ] && [ "$local_sha" != "$zero" ] && ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    echo "Protoplasma: this push would replace commits on $branch that your branch doesn't have. Pull and merge them in; if you rebased your own branch, push it under a new name instead of forcing." >&2
    exit 1
  fi
done
`;
/** Installs the push guard in `clone`, unless the repo manages its own hooks or already has a pre-push hook. */
async function installPushGuard(clone, env = process.env) {
  if (await tryGit(clone, ['config', 'core.hooksPath'], env)) return false; // husky and the like
  const hooks = path.join(path.resolve(clone, await git(clone, ['rev-parse', '--git-common-dir'], env)), 'hooks');
  const file = path.join(hooks, 'pre-push');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current !== null && !current.includes('Added by Protoplasma')) return false;
  if (current === PUSH_GUARD) { fs.chmodSync(file, 0o755); return true; }
  // Written beside it and renamed into place, so a push running right now never sees a half-written hook.
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(`${file}.tmp`, PUSH_GUARD, { mode: 0o755 });
  fs.chmodSync(`${file}.tmp`, 0o755);
  fs.renameSync(`${file}.tmp`, file);
  return true;
}

module.exports = { sessionWorktree, removeSessionWorktree, installPushGuard, slug };

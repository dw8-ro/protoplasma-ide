// Per-session git worktrees. Each session gets its own folder and its own branch, so sessions never share a checkout
// and nothing reaches the default branch without a push (ideally a pull request).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { slug } = require('./shared');

// A stalled network (a captive portal, a dead VPN) gives up after a while instead of holding up a new session.
const git = (cwd, args, env) => new Promise((resolve, reject) => execFile('git', args,
  { cwd, encoding: 'utf8', env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: args[0] === 'fetch' ? 30_000 : 120_000 },
  (err, out, errOut) => (err ? reject(new Error(errOut.trim().split('\n').pop() || err.message)) : resolve(out.trim()))));
const tryGit = (cwd, args, env) => git(cwd, args, env).catch(() => '');

/**
 * The session's worktree of `clone`, created on first use at `<clone>@<session>` on the branch `session/<session>`.
 * If a teammate already pushed that branch it continues from theirs; otherwise it starts from the remote's default
 * branch. The new branch has no upstream, so a bare `git push` can't land on the default branch by accident.
 * @returns {Promise<{ dir: string, branch: string }>}
 */
async function sessionWorktree(clone, session, env = process.env) {
  const branch = `session/${slug(session)}`;
  const dir = `${clone}@${slug(session)}`;
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch };

  await tryGit(clone, ['fetch', 'origin', '--prune'], env); // fine to be offline
  await tryGit(clone, ['worktree', 'prune'], env);          // forget worktrees whose folders were deleted
  const exists = ref => tryGit(clone, ['rev-parse', '--verify', '--quiet', ref], env);
  if (await exists(`refs/heads/${branch}`)) {
    await git(clone, ['worktree', 'add', dir, branch], env);
  } else if (await exists(`refs/remotes/origin/${branch}`)) {
    await git(clone, ['worktree', 'add', '--track', '-b', branch, dir, `origin/${branch}`], env);
  } else {
    const base = await tryGit(clone, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], env) || 'HEAD';
    await git(clone, ['worktree', 'add', '--no-track', '-b', branch, dir, base], env);
  }
  return { dir, branch };
}

/** Removes a session's worktree folder. Git refuses if it has uncommitted changes; the session branch is kept either way. */
async function removeSessionWorktree(clone, session, env = process.env) {
  const dir = `${clone}@${slug(session)}`;
  if (!fs.existsSync(dir)) return false;
  await git(clone, ['worktree', 'remove', dir], env);
  return true;
}

// A pre-push hook for the clones the app makes. It only acts for agents started with PROTO_SHARED_TEAM set: Codex and
// OpenCode on a team with other people. (Claude agents are asked through their hooks instead, and people pushing from
// their own terminal aren't affected.)
const PUSH_GUARD = `#!/bin/sh
# Added by Protoplasma. Stops agents on a shared team from pushing straight to main or master, or force-pushing.
# People pushing from their own terminal aren't affected. To push anyway: git push --no-verify
[ -n "$PROTO_SHARED_TEAM" ] || exit 0
zero=0000000000000000000000000000000000000000
while read -r local_ref local_sha remote_ref remote_sha; do
  branch=\${remote_ref#refs/heads/}
  case "$branch" in main|master)
    echo "Protoplasma: don't push straight to $branch, which your team shares. Push the session branch and open a pull request." >&2
    exit 1;;
  esac
  if [ "$remote_sha" != "$zero" ] && [ "$local_sha" != "$zero" ] && ! git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null; then
    echo "Protoplasma: this push would overwrite commits on $branch. Pull them in first instead of force-pushing." >&2
    exit 1
  fi
done
`;
/** Installs the push guard in `clone`, unless the repo manages its own hooks or already has a pre-push hook. */
async function installPushGuard(clone, env = process.env) {
  if (await tryGit(clone, ['config', 'core.hooksPath'], env)) return false; // husky and the like
  const hooks = path.join(path.resolve(clone, await git(clone, ['rev-parse', '--git-common-dir'], env)), 'hooks');
  const file = path.join(hooks, 'pre-push');
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('Added by Protoplasma')) return false;
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(file, PUSH_GUARD);
  fs.chmodSync(file, 0o755); // writeFileSync's mode only applies to a new file, and git skips a hook it can't run
  return true;
}

module.exports = { sessionWorktree, removeSessionWorktree, installPushGuard, slug };

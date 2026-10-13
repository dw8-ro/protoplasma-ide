# Section 4: session worktrees and the push hook

## Covered
- src/workspace.js lines 1-79: `git`/`tryGit` helper (timeouts, env, error text), `sessionWorktree` (existing local branch, existing remote branch + tracking, new branch from origin/HEAD, HEAD fallback, offline/no origin/empty repo, 30s fetch timeout, folder without .git, concurrent calls, branch checked out elsewhere, worktree prune, stale `.git` pointer), `removeSessionWorktree` (clean, dirty, ignored files, unpushed commits, missing folder, plain folder, locked), `PUSH_GUARD` script (main/master, force, delete, new branch, ff, tags, --no-verify, mirror, env set/unset), `installPushGuard` (local+global core.hooksPath, foreign hook, own hook rewrite + chmod, worktree as argument, missing hooks dir, empty hooksPath, not-a-repo).
- slug() (src/shared.js, only as used here): Cyrillic, CJK, Devanagari, emoji, NFD, 60 and 61 CJK chars, `x.lock.lock`, `@{u}`, `HEAD`, `-rf`, `a/b`: all make valid branches and folders except `x.lock.lock`. Same-slug names are the same session in the hub too (hub.js uses slug for identity), so one folder for them is intended.
- test/workspace.test.js: ran it (8 pass), then again with push.autoSetupRemote=true and with PROTO_SHARED_TEAM=1 in the environment; compared each test name with what it asserts.
- Glanced at app/github.js sessionFolder/removeSessionFolder and app/main.js:146-149 (PROTO_SHARED_TEAM) only for how the results are used.
- Scripts and output: scratch/04/t1.js..t6.js (git 2.55.0, isolated global git config).

## [medium] A renamed default branch makes every new session for that repo fail ("invalid reference: origin/main")
- Where: src/workspace.js:33-34 (and :25 `fetch --prune`)
- What happens: base = `git symbolic-ref --short refs/remotes/origin/HEAD`. If the repo's default branch was renamed on GitHub after the clone was made (master -> main, main -> trunk), origin/HEAD still points at the old name. `fetch --prune` then deletes `origin/<old>`, the symbolic-ref still prints `origin/<old>`, and `worktree add --no-track -b ... origin/<old>` throws. Git's followRemoteHEAD=create (default, git 2.55) only creates a *missing* origin/HEAD, it does not repair a stale one. Result: no new session can start in that repo (sessionFolder surfaces "Couldn't make this session's own folder ... You can turn off 'A branch for every session'") until the user runs `git remote set-head origin -a` by hand.
- Evidence: CONFIRMED (scratch/04/t1.js, scenario "default renamed main->trunk": THROWS "fatal: invalid reference: origin/main").
- Suggested fix: only use the symbolic-ref result if `rev-parse --verify <it>` resolves; otherwise run `git remote set-head origin -a` (tryGit) and retry, else fall back to HEAD.

## [medium] Two agents starting at once in the same new session: the second fails with "cannot lock ref ... reference already exists"
- Where: src/workspace.js:23-35 (check-then-create, no per-folder lock)
- What happens: both calls see no `<clone>@<slug>/.git`, both fetch, both reach `worktree add -b session/<slug>`; the loser throws and startLane fails with the "Couldn't make this session's own folder" error even though the folder now exists and a retry would work. Happens when two lanes of the same, not yet created session are started together (double click on Start, or app restart resuming several lanes of a session whose folder was deleted). Different sessions at the same time are fine (5 in parallel all succeeded).
- Evidence: CONFIRMED (scratch/04/t1.js "concurrent same session x2": fulfilled + rejected "fatal: cannot lock ref 'refs/heads/session/dup': reference already exists").
- Suggested fix: keep a module-level Map of in-flight promises keyed by `dir` and return the same promise to concurrent callers.

## [low] A leftover `<clone>@<session>/.git` whose worktree record is gone is treated as a ready folder
- Where: src/workspace.js:23
- What happens: the only check is `fs.existsSync(dir/.git)`. If the clone was deleted and re-cloned (or `.git/worktrees/<name>` was removed), the old `repo@session` folder still has a `.git` pointer file, so sessionWorktree returns it and the agent starts in a directory where every git command fails ("fatal: not a git repository"). Git status/overlaps silently die for that lane, and removeSessionWorktree later fails with "not a working tree", which github.js reports as "uncommitted changes".
- Evidence: CONFIRMED (scratch/04/t1.js "worktree admin dir gone": returns the dir; `git status` there prints "fatal: not a git repository: (null)").
- Suggested fix: validate with `git -C dir rev-parse --git-dir` (or `--show-toplevel`) before the early return; if it fails, treat as broken and rebuild/err clearly.

## [low] A non-empty `<clone>@<session>` folder without .git blocks the session with a raw git error
- Where: src/workspace.js:23,29-34
- What happens: if the folder exists with files but no `.git` (leftover from a killed worktree add, a manual mkdir, or a partial delete), `worktree add` fails with "fatal: '<path>' already exists". An empty folder works. The user sees the git sentence wrapped in the "turn off A branch for every session" advice, with no hint to delete/move that folder.
- Evidence: CONFIRMED (scratch/04/t1.js "nonempty folder no .git" THROWS; "empty folder" ok).
- Suggested fix: catch this case and say which folder is in the way (or use it if empty), rather than the generic advice.

## [medium] Removing a session folder silently deletes git-ignored files (.env, local databases, node_modules)
- Where: src/workspace.js:39-45 (`git worktree remove` without --force); comment says "Git refuses if it has uncommitted changes"
- What happens: `git worktree remove` only refuses for modified/untracked (non-ignored) files. Ignored files do not count, so a folder holding a hand-made `.env`, `.env.local`, a local SQLite/dev DB, uploaded fixtures, build output, etc. is wiped with no warning, while github.js's wording ("Its folder has uncommitted changes, so it was kept") suggests anything unsaved blocks removal. Commits are safe (branch is kept); ignored files are gone for good.
- Evidence: CONFIRMED (scratch/04/t4.js: folder with `.env`, `local.db`, `node_modules/` and clean `git status` -> removeSessionWorktree returned true and the folder was deleted).
- Suggested fix: before removing, check `git status --porcelain --ignored` (ignoring node_modules/known build dirs if wanted) and refuse or ask when ignored files other than the usual dependency/build dirs exist; at least say so in the comment/UI.

## [low] The push guard only knows the names `main` and `master`
- Where: src/workspace.js:57
- What happens: a repo whose shared branch is `develop`, `trunk`, `production`, `release`... is not protected: a shared-team Codex/OpenCode agent can push straight to it (and to a `main`-less repo whose default differs). README line 107 and the hook text promise "main or master", so this is a documented limit, but the clone already knows the real default (`refs/remotes/origin/HEAD`).
- Evidence: CONFIRMED (scratch/04/t5.js: with PROTO_SHARED_TEAM=1, `git push origin HEAD:refs/heads/develop` ALLOWED while HEAD:main and HEAD:master are BLOCKED).
- Suggested fix: in the hook also block `$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')`.

## [low] The guard lets a shared-team agent delete any branch except main/master, including a teammate's session branch
- Where: src/workspace.js:61 (`[ "$local_sha" != "$zero" ]` skips deletions)
- What happens: `git push origin :session/theirs` / `--delete` passes, and that destroys a teammate's pushed work as thoroughly as a force push does (the stated aim is to stop force pushes). Deleting the agent's own session branch is harmless, so some rule is needed, not a blanket block.
- Evidence: CONFIRMED (scratch/04/t5.js: "delete teammate branch: ALLOWED" with PROTO_SHARED_TEAM=1; `:main` / `--delete master` BLOCKED).
- Suggested fix: block deletions of any `refs/heads/*` other than the agent's own `session/*` branch, or at least state in the README that deletions are not covered.

## [low] `git push --no-verify` (and any `-c core.hooksPath=...`) bypasses the guard for Codex/OpenCode
- Where: src/workspace.js:52 (comment) and 50-66
- What happens: for agents the hook is the only barrier and an agent can skip it with one flag; the block message does not mention the flag, but the hook's own header comment does ("To push anyway: git push --no-verify"), and any agent that reads `.git/hooks/pre-push` after a block will find it. Decided as "heuristic" for the Claude hook, but here it is a one-flag bypass of the only guard these agents have, so README ("stops them") overstates it.
- Evidence: CONFIRMED (scratch/04/t5.js: `--no-verify` to main with PROTO_SHARED_TEAM=1 ALLOWED and main moved).
- Suggested fix: reword README to "discourages"; drop the --no-verify hint from the file comment or keep it only in README; optionally also protect server-side with branch protection.

## [low] The guard is silently not installed when the repo has any pre-push hook or hooksPath, and the caller never learns
- Where: src/workspace.js:69,72 (returns false); app/github.js:118 (`await installPushGuard(clone, env).catch(() => {})` ignores the result)
- What happens: husky/lefthook (core.hooksPath), a global core.hooksPath, or any existing foreign pre-push (git-lfs writes one into clones of LFS repos on checkout when git-lfs is installed) means shared-team Codex/OpenCode agents get no protection at all, and nothing tells the user. Conversely, if our hook were written first, `git lfs install` refuses to overwrite it and LFS objects would stop being uploaded on push. Our hook never chains to an existing one.
- Evidence: CONFIRMED for the skip (scratch/04/t6.js: local hooksPath, global hooksPath, foreign hook all return false and leave things untouched); SUSPECTED for the git-lfs part (git-lfs is not installed here).
- Suggested fix: if installPushGuard returns false on a shared team, show a one-line notice; or install the guard through `core.hooksPath`-aware chaining (call the existing hook after ours).

## [low] Rewriting a rebased own session branch is blocked with advice that does not help ("Pull them in first")
- Where: src/workspace.js:61-63
- What happens: an agent that rebases its own `session/...` branch onto main and force-pushes gets "this push would overwrite commits on session/x. Pull them in first instead of force-pushing". When nobody else pushed there, pulling changes nothing; the agent loops or reaches for --no-verify. Also `--force-with-lease` is blocked the same way.
- Evidence: CONFIRMED (scratch/04/t5.js: "force own branch after amend" and "force-with-lease own branch" BLOCKED with that message).
- Suggested fix: say "rebuild the branch with a merge instead of rebasing, or push a new branch name"; or allow force when the remote tip is the agent's own last push.

## [low] Tests inherit the developer's environment: two of them fail in normal setups
- Where: test/workspace.test.js:11 (`env = { ...process.env, ... }`), :58-62 and :87-100
- What happens: (a) The push guard test's "a person isn't stopped" push (`push(aliceTree, {}, ...)`) uses the inherited env. Run `npm test` from inside a shared-team Codex/OpenCode lane (where PROTO_SHARED_TEAM=1 is set, exactly how an agent would work on this repo) and that push is blocked: the test fails with "don't push straight to main". (b) "a bare `git push` ... cannot land on main" asserts git's "no upstream" error. With the very common `push.autoSetupRemote=true` (or push.default=current) the bare push succeeds (to a new `session/...` branch, still not main) and the test fails although the protection holds.
- Evidence: CONFIRMED (`PROTO_SHARED_TEAM=1 node --test test/workspace.test.js` -> 1 fail; `HOME=<dir with [push] autoSetupRemote=true>` -> 1 fail; plain run 8 pass).
- Suggested fix: build `env` with `PROTO_SHARED_TEAM` deleted plus `GIT_CONFIG_GLOBAL=/dev/null`/`GIT_CONFIG_NOSYSTEM=1`; for (b) assert that origin/main did not move rather than the message.

## [low] Test names claim more than they check
- Where: test/workspace.test.js:48, :87, :102
- What happens: "off the default branch" passes if the worktree were cut from HEAD, since local main equals origin/main in the fixture (no test where they differ, or where origin/HEAD is stale/missing). "...and nobody else" checks one fast-forward push without the variable; nothing covers `master`, deletions, `--no-verify`, the core.hooksPath skip, rewriting/chmod of our own hook, or installing from a worktree argument. "removed only when it has nothing uncommitted" checks an untracked file only, so it misses that ignored files are deleted (see above). Not covered at all: offline fetch, a folder that exists without .git, the worktree prune, concurrent calls, stale `.git` pointer, renamed default branch (all of which have bugs above).
- Evidence: CONFIRMED by reading the tests against the runs in scratch/04.
- Suggested fix: add the missing cases (each is 5-10 lines with the existing bare-origin fixture).

## [low] git error text: only the last stderr line is kept, which is often a hint or the second half of a two-line message
- Where: src/workspace.js:11 (`errOut.trim().split('\n').pop()`)
- What happens: the text shown to the user (via github.js into "Couldn't make this session's own folder ... : <text>") can lose the actual problem. Seen: `x.lock.lock` -> "hint: Disable this message with "git config set advice.refSyntax false"" (the fatal line above it is dropped); removing a locked worktree -> "use 'remove -f -f' to override or unlock first" (without "cannot remove a locked working tree").
- Evidence: CONFIRMED (scratch/04/t3.js and t4.js output).
- Suggested fix: keep the last line starting with `fatal:` or `error:` (stripping the prefix), fall back to the last line.

## [low] removeSessionWorktree on a missing folder returns false and leaves the worktree registered
- Where: src/workspace.js:42
- What happens: if the user deleted the folder by hand, `git worktree remove` is never tried and no `worktree prune` runs, so `.git/worktrees/<name>` stays and `git branch -d session/<name>` in the clone fails with "used by worktree at ..." until the next sessionWorktree call for any session prunes it. The function reports false ("nothing to remove") as if all is clean.
- Evidence: CONFIRMED (scratch/04/t4.js "remove missing folder": false; afterwards `git worktree list` still shows it and `branch -d` errors).
- Suggested fix: on a missing folder run `git worktree prune` before returning false.

## [low] A new session reusing the name of an old one resumes the old local branch, even if its work was merged and the remote branch deleted
- Where: src/workspace.js:28-29 and 40-45 (branch is kept on removal)
- What happens: removing a session folder keeps `session/<slug>`; once the PR is squash-merged and GitHub deletes the remote branch, `fetch --prune` drops origin/session/<slug> but the local branch stays. Creating a session with the same name later checks out that stale local branch (not a fresh one from origin/HEAD): it is behind main and carries the already-merged commits, so gitStatus lists those files as "changed" (false overlap warnings) and a new PR re-includes the old commits. The doc comment only describes continuing a teammate's pushed branch.
- Evidence: SUSPECTED (by reading; the "local branch" path in scratch/04/t1.js confirms an existing local branch is reused as-is, no fetch/merge/reset).
- Suggested fix: when the local branch exists, has no upstream or its upstream is gone, and its tip is reachable from origin/HEAD (or fully merged), delete and recreate it from origin/HEAD.

## [low] If origin/HEAD is missing, a new session starts from whatever the shared clone has checked out
- Where: src/workspace.js:33 (`|| 'HEAD'`)
- What happens: with the remote unreachable (or no origin/HEAD yet) the base is the clone's HEAD, which can be a leftover feature branch or detached commit, not the default branch. The new session then silently contains that branch's commits (and shows them as its changes). Current git recreates a missing origin/HEAD on every successful fetch, so this mostly hits offline use.
- Evidence: CONFIRMED (scratch/04/t2.js: offline, origin/HEAD removed, clone on branch `wip` -> new session folder contains wip.txt).
- Suggested fix: fall back to the clone's local default branch (`main`/`master` if present) before HEAD, or refuse with "can't tell the default branch while offline".

## [low] The 120s limit on `git worktree add` can leave a half-checked-out folder that is then treated as ready
- Where: src/workspace.js:10 (timeout) and :23 (early return on `.git`)
- What happens: for a very large repo or a slow disk, execFile kills `worktree add` at 120s after the `.git` file and admin dir exist but before checkout finishes. The error is shown once, but on the next start `dir/.git` exists, so sessionWorktree returns the partial folder without error: files missing/"deleted" in git status.
- Evidence: SUSPECTED (by reading; not run - needs a >2 minute checkout).
- Suggested fix: on failure of `worktree add`, run `git worktree remove --force dir` (and remove the folder) before rethrowing; or raise the timeout for `worktree add`.

## [low] The pre-push hook is rewritten on every session start, non-atomically
- Where: src/workspace.js:73-75; called from app/github.js:118 on each sessionFolder
- What happens: `writeFileSync` truncates the live hook then writes it, and on a first install the file exists as 0644 until the chmod. A `git push` by an agent in another session during that moment can run an empty or partial script (passes silently, or fails with a sh syntax error), or skip the hook as non-executable. Windows are microseconds wide, so rarely hit, but it is also pointless work: the content is almost always identical.
- Evidence: SUSPECTED (by reading).
- Suggested fix: read the file first and only write (to a temp file, then rename) when the content differs; use `{ mode: 0o755 }` on the temp file.

## Outside my scope
- src/shared.js:21 `slug('x.lock.lock')` returns `x.lock`, which is not a valid branch name (`session/x.lock` -> "not a valid branch name"), so such a session can never start; the `.lock` strip needs to loop (`/(\.lock)+$/`). Only exotic names.
- app/github.js:131-134 `removeSessionFolder` turns every failure into "Its folder has uncommitted changes, so it was kept." Confirmed other causes reach it from removeSessionWorktree: a locked worktree, or a folder that is not a worktree (stale `.git` pointer, plain folder) - both throw and get the same misleading message.
- app/github.js:118 ignores installPushGuard's return value (see the "silently not installed" finding), so a skipped guard on a shared team is never surfaced in the UI.

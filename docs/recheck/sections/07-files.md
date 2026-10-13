# Section 7: app/files.js (code view file access)

Scripts and temp repos: `<recheck>/scratch/7/{a,b,c,d,e}.js` (real temp repos: bare origin + clones, linked worktrees, a
subfolder session, a plain folder). git 2.55.0, Node 26.

## Covered
- git helper (files.js:10-22): gitError extraction (error/fatal/hint/"remote:" lines, stdout-only failures, empty stderr),
  `core.quotePath=false`, GIT_TERMINAL_PROMPT=0 (verified against an http remote answering 401: fails at once, "terminal
  prompts disabled", no hang), GIT_OPTIONAL_LOCKS=0, timeout table (commit none / push 15 min / rest 2 min: read, not run to
  the limit).
- inside() (24-35): `..`, `sub/../..`, absolute path, '' and '.', symlink to outside, symlink to inside, dangling
  symlink (in and out), symlink dir, file-as-directory, sibling-prefix dir (by mutation), new file / new file in a missing folder.
- list() / walk() (37-55): spaces, unicode, ignored files, untracked, nested repo, symlinks, the 20,000 cap (git and walk),
  plain folder (.git / node_modules skipped), unreadable subfolder, FIFO.
- underWay() (57-64): merge, cherry-pick, revert, rebase, each in a linked worktree (git-dir under the main .git): all detected.
- status() (66-89): M / A / D / R (with spaces and unicode) / U / C, the subfolder prefix, unpushed with an upstream, without
  one (origin/HEAD fallback), with upstream = origin/main, detached HEAD, plain folder.
- read() (91-102): directory, binary, exactly 2,000,000 and 2,000,001 bytes, invalid UTF-8, BOM, UTF-16, empty file, missing,
  dangling link, FIFO.
- committed() (104-105): paths with spaces and unicode, a new file, a subfolder session, `..`.
- write() (107-109): new file, existing file via an in-folder symlink, dangling links, exec bit kept, new file mode, missing folder.
- search() (111-124): case-insensitive fixed string, untracked, non-ASCII path and text (with and without LANG), `:` in names,
  regex characters, leading dash, blank, no match, deleted tracked file, per-file cap, the 500 cap, CRLF, tab in a name,
  subfolder session, plain folder.
- commitAndPush() (126-163): clean tree (with and without message), first push setting upstream, a teammate pushing first,
  dirty tree + teammate first (autostash), autostash that conflicts, real same-line conflict with a dirty tree (abort keeps
  everything), remote pre-receive rejection, local pre-push rejection, pre-commit rejection, network failure during pull,
  password-needing remote, detached HEAD, subfolder session, refusal while a merge is under way.
- watch() (165-180): edits, node_modules, .git filtering, batching (50 writes -> 1 call), a continuous writer, commit / push /
  checkout / reset in a normal repo and in a linked worktree, missing root.
- Callers: main.js `code:*` handlers (folders allow-list, `code:readLane`), code.js `refreshFiles` (3 s poll), `commit()`,
  search/open paths, renderer.js `answerFile`.
- test/files.test.js: ran it; ran 8 deliberate breakages of files.js against it (see the last finding).

## Findings

## [medium] Search drops every hit on a line ending in CRLF
- Where: app/files.js:117 (`/^(.*?):(\d+):(.*)$/`)
- What happens: `git grep` prints the line with its `\r`; in JavaScript `.` does not match `\r`, so `(.*)$` fails, the line doesn't parse, and `.filter(hit => hit.path)` throws it away without a trace. Every match inside a Windows-line-ending file (.bat, .sln, .cs, files from a Windows teammate) is missing from the results; searching a repo with CRLF files shows only the LF files. Same for text containing U+2028/U+2029 or a lone `\r`.
- Evidence: CONFIRMED. `crlf.txt` ("crlf needle line\r\nsecond\r\n") and `lf.txt` both contain "needle"; `git grep` finds both (checked by hand), `files.search` returned only `lf.txt`, tracked or untracked.
- Suggested fix: use the `s` flag (`/^(.*?):(\d+):(.*)$/s`) or `[^]*`, or strip a trailing `\r` before matching; better, parse with `git grep -z` (next finding).

## [medium] Why a push was refused is thrown away: the remote's or hook's message never reaches the user
- Where: app/files.js:10-17 (gitError), 145 (comment "the server refusing it (a protected branch) is reported as is"), 146, 154, 161
- What happens: a rejected push prints `remote: <reason>` / hook output, then `! [remote rejected] ...`, then `error: failed to push some refs to '<url>'`. `gitError` starts at the first line that begins `error:` or `fatal:` (the last line here; `remote:` lines don't match) and returns only that. The person sees "Committed, but couldn't be pushed: failed to push some refs to '/path/o.git'" with no reason: no "Protected branch update failed" (GitHub GH006), no "Repository rule violations" (GH013, which includes secret-scanning push protection), no lint/test output from their own pre-push hook. The comment at 145 and the "message passed through" intent are not what happens.
- Evidence: CONFIRMED. Bare repo with a pre-receive hook printing "GH006: Protected branch update failed": raw stderr contained `remote: GH006: Protected branch update failed`, `files.commitAndPush` returned only "...failed to push some refs to '<path>'". Same with a local pre-push hook that prints "lint failed: 3 problems" (lost too). A pre-commit hook's output does survive (it is printed to stdout and the last line is used), so commit and push behave differently.
- Suggested fix: when the extracted line is "failed to push some refs", also keep the `remote:` lines (and hook output before `To `); e.g. collect `remote: ` lines first and prefer them.

## [medium] In a session folder that is a subfolder of a repo, Commit & Push commits (and pushes) the whole repo
- Where: app/files.js:136 (`git add -A`), with status() filtering to the prefix at 81
- What happens: `git add -A` stages the entire working tree from the repo root, not just the folder. The code view only lists changes under the session folder, so the person sees (and approves) a commit of, say, one file, while every other modified or new file elsewhere in the repo (other work in progress, local config, secrets that aren't ignored) is committed and pushed under their message too. Anything already staged outside is included as well.
- Evidence: CONFIRMED. Session at `repo/sub` with `sub/inside.txt` and `outside.txt` both new: `status` showed only `inside.txt`; after `commitAndPush(repo/sub, 'in')` the commit's stat listed `outside.txt` and `sub/inside.txt`.
- Suggested fix: `git add -A -- .` and `git commit -m msg -- .` (cwd is the folder), or refuse with a note when the repo has changes outside the folder.

## [low] Opening a named pipe in a non-git session folder freezes the whole app
- Where: app/files.js:46-55 (walk lists every non-directory entry), 92-102 (read never checks `stat.isFile()`)
- What happens: in a folder that isn't a git repo `walk()` lists FIFOs like any file (git's ls-files does not, so repos are safe). Clicking one calls `read()` -> `fs.readFileSync` on the FIFO, which blocks until a writer appears. It runs synchronously in Electron's main process, so every window hangs until the pipe is written to or the app is killed.
- Evidence: CONFIRMED. `mkfifo plain/pipe`; `list(plain)` returned `pipe`; `read(plain, 'pipe')` in a child process was still blocked after 4 s (killed by the timeout).
- Suggested fix: skip entries that aren't regular files or symlinks in `walk`, and in `read` return `{ binary: true }` unless `stat.isFile()`.

## [low] Search results are parsed from text: paths with `:<digits>:` or odd characters come out wrong
- Where: app/files.js:115-118
- What happens: `file:line:text` is split with a lazy regex, so a file named `colon:12:name.txt` is reported as path `colon`, line 12, text `name.txt:1:needle...`; clicking opens a file that doesn't exist. A path with a tab or double quote is C-quoted by git (`"tab\tname.txt"` with the quotes) because `core.quotePath=false` only covers non-ASCII, so that hit's path is also wrong.
- Evidence: CONFIRMED (both outputs seen in c.js: `colon|12|name.txt:1:needle in colon file`, `"tab\tname.txt"|1|...`).
- Suggested fix: `git grep -z -n ...` (NUL after the path and after the line number, no quoting) and split on `\0`.

## [low] A push-only Commit & Push can leave conflict markers in the tree and still say "pushed"
- Where: app/files.js:150 (`pull --rebase --autostash`), 157-159
- What happens: if the working tree has uncommitted edits (the agent writing while the pull runs, or the person's edits between the 3 s status refresh and the click) that touch the same lines a teammate changed, the rebase succeeds, pushes, and then the autostash re-apply conflicts. Git exits 0, so the result is "Put on top of your teammate's work on <branch>, and pushed." while the tree now has `<<<<<<<` markers in the file (state C) and the edits sit in a leftover `stash@{0}`. (A conflicting rebase is handled well: abort restores the edits, verified.)
- Evidence: CONFIRMED. Unpushed commit + dirty `g.txt` edit on the same line as a teammate's pushed change: result string above, `git status` = `UU g.txt`, stash list = `autostash`, file contains markers.
- Suggested fix: after the pull, check `underWay`/status for `C` entries (or `git stash list` growth) and say so; or skip `--autostash` and refuse when the tree is dirty.

## [low] Watcher never fires while anything keeps writing more often than every 150 ms
- Where: app/files.js:175-176
- What happens: each event clears and restarts the 150 ms timer (a trailing debounce with no maximum wait). While a dev server, test watcher or build writes steadily (outside node_modules, e.g. `.next/`, `dist/`, a log file), `onChange` never runs, so open files don't reload with the agent's edits and the tree isn't refreshed by events (only the 3 s status poll in code.js still runs; reload of open editors is event-only).
- Evidence: CONFIRMED. A file written every 100 ms for 3 s: 0 calls during the writes, 1 after they stopped.
- Suggested fix: also flush when the first pending event is older than ~1 s.

## [low] In a linked worktree (every session the app creates) the watcher sees no git changes; the `.git` filter is dead code
- Where: app/files.js:171-172
- What happens: in a worktree `.git` is a file, and the real git dir (index, HEAD) is under the main repo's `.git/worktrees/<name>/`, outside the watched folder. So commit, add, checkout and branch switches in the session folder fire nothing (the comment promises "a new commit or index matters"). In a normal clone `add+commit` and `checkout -b` do fire `.git/index` / `.git/HEAD`; `git commit --allow-empty`, `reset --soft` and `push` fire nothing in either. Effect is limited to a delay: code.js polls status every 3 s while the code view is visible.
- Evidence: CONFIRMED (d.js): worktree add+commit, checkout -b, empty commit -> `[]`; normal repo add+commit -> `[".git/index"]`.
- Suggested fix: watch the path from `git rev-parse --git-dir` (and `--git-common-dir` for refs) in addition, or say in the comment that the poll covers it.

## [low] Search is silently empty, and status/diff silently "clean", in a folder that isn't a git repo, though the file list works there
- Where: app/files.js:86-88, 105, 112-123; app/code.js:549 (`.catch(() => [])`)
- What happens: `list()` has an explicit non-git fallback, but `search()` runs `git grep`, which fails with "fatal: not a git repository" (128); it rethrows and the renderer shows "no results". `status` returns an empty, branch-less result, `committed` returns '' for every file (so a diff shows the whole file as added), and Commit & Push throws the git error. `status()` also turns any git failure into the same empty result (a 2-minute timeout, a broken repo), so the UI says "There's nothing to commit." instead of showing an error.
- Evidence: CONFIRMED for `search`/`status`/`committed`/`commitAndPush` on a plain temp folder; SUSPECTED for the timeout case (by reading the catch at 86).
- Suggested fix: `git grep --no-index` (or a scan over `walk`) when not a repo; hide Commit / search for plain folders; let status distinguish "not a repo" from other errors.

## [low] Files listed but unreadable: read() throws for a symlink that leaves the folder, and the file list fails outright on one unreadable subfolder
- Where: app/files.js:94 (read), 46-55 (walk)
- What happens: (a) a tracked or untracked symlink pointing outside the folder (`ln -s ../shared x`) is in the list; opening it makes `read` throw "That file is outside the session folder." instead of returning an object like every other can't-show case (`binary`, `tooBig`, `notUtf8`, `gone`). `openFile` in code.js has no catch around `modelFor`, so the tab is added and the error is unhandled (SUSPECTED for the UI part, by reading code.js:210-221). (b) in a non-git folder one subfolder the app can't read (permissions, macOS privacy-protected folders) makes `walk` throw EACCES, and `list` calls it from inside `catch`, so no files are shown at all.
- Evidence: CONFIRMED for the throws (a.js: `read out-link` via inside(), `list unreadable subdir (plain)` -> `EACCES ... scandir`).
- Suggested fix: return `{ outside: true }`/`{ binary: true }` for it, and wrap the `readdirSync` in a try/catch that skips the folder.

## [low] Past 20,000 files, the cut removes exactly the newest (untracked) files
- Where: app/files.js:40-41
- What happens: `ls-files --cached --others` prints tracked files first, so with more than 20,000 tracked files `slice(0, MAX_FILES)` drops all untracked ones, i.e. the new files an agent just made. They never show in the tree or in Go to (status still lists them as changes). Nothing tells the person the list is cut. For a non-git folder the cut keeps whatever readdir order gives.
- Evidence: CONFIRMED. 20,000 tracked files + one new `zzz-new.txt`: list returned 20,000 entries without it.
- Suggested fix: keep the paths from `status` in the list, or cap tracked and untracked separately; show a "list cut" note.

## [low] Detached HEAD: a commit is made and then orphaned, with a long confusing message; unpushed is counted against origin/HEAD
- Where: app/files.js:140 (`push -u origin HEAD`), 75 (unpushed fallback), 10-17
- What happens: on a detached HEAD, Commit & Push commits, then the push fails with git's four-line "The destination you provided is not a full refname ... We tried to guess what you meant by ... You must fully qualify the ref." (shown whole, joined into one line). The commit now exists only on the detached HEAD. `status` shows branch '' and `unpushed` = commits since origin/HEAD (2 in the test), which makes the button read as pushable. Also, a branch with no upstream in a clone that has no `origin/HEAD` (e.g. a repo `git init`-ed and given a remote) shows unpushed 0 even with unpushed commits (SUSPECTED, by reading 75).
- Evidence: CONFIRMED (detached message and the `u:2` status); SUSPECTED for the no-origin/HEAD case.
- Suggested fix: refuse with "Switch to a branch first" when `branch --show-current` is empty, before committing.

## [low] Smaller things in files.js
- `committed()` (105) does not go through `inside()`: from a subfolder session, `committed(root, '../top.txt')` returns that file's committed text from elsewhere in the repo (CONFIRMED). Only the renderer calls it, and it stays inside the repo, so it is a boundary slip rather than an escape.
- `list()` returns an untracked nested repo as `nested/` (with a trailing slash; CONFIRMED). `read` turns it into `{ binary: true }`, but the tree builder (code.js `treeOf`) will likely see an empty file name (SUSPECTED).
- `inside(root, 'dangle', { exists: false })`/`write` to a dangling symlink that points inside the folder says "That file is outside the session folder." (CONFIRMED), and a new file in a missing folder throws the raw `ENOENT ... lstat '/full/path'`. Nothing is written in either case.
- A timeout kills the child with SIGTERM and the message is git's `Command failed: git -c core.quotePath=false pull ...` (SUSPECTED, node's execFile message). `pull` and `add` share the 2-minute limit while `push` gets 15; a slow fetch killed mid-rebase would hit the "a teammate changed the same lines" branch (underWay is true) and be reported as a conflict.
- `underWay()` (60) uses `execFileSync` with `process.env`, not the `env` the other calls get (agentEnv, with the login-shell PATH); if git is only on the login-shell PATH, it returns null and the "rebase is under way" guard at 132 silently switches off. Not reproduced.

## [low] test/files.test.js: names match what they test, but most of files.js is untested and the boundary test is weaker than it reads
- Where: test/files.test.js
- What happens: the four test names do describe their bodies (teammate pushed first, real conflict kept and nothing half-done, mid-rebase refusal, nothing outside the folder). But only `commitAndPush`, `status().unpushed`/`underWay`/one `C`, `read`/`write` of three bad paths and `inside` through them are exercised. Not tested at all: `list`/`walk`, `search`, `committed`, `watch`, `gitError` wording, states A/D/R/M/U, the subfolder prefix, BOM / binary / size limits in `read`, `write` of new files, worktrees. The boundary test accepts `/outside the session folder|ENOENT/`, so a wrong ENOENT passes, and it has no sibling-prefix or dangling-symlink case. `ENOENT` can't even occur for the three paths used, so the alternative only loosens it. The test also leaves its temp repos behind (no cleanup; 40 `protoplasma-files-*` dirs had piled up in the temp dir) and runs with the developer's own global git config (a `commit.gpgsign` or `init.templateDir` there would change or hang it).
- Evidence: CONFIRMED by breaking a copy of files.js one line at a time and running this test file: the suite still passed (4/4) with (1) `startsWith(base + path.sep)` -> `startsWith(base)` (a sibling folder `/x/david-evil` becomes readable and writable), (2) the dangling-symlink guard in `inside` removed, (3) the rename `i++` skip removed (renames would show a bogus second entry), (4) `--autostash` removed, (5) the node_modules filter removed, (6) the ENOENT -> `gone` mapping removed, (7) the `.git` filter removed. Only forcing `unpushed` to 0 was caught.
- Suggested fix: add small cases for (1)-(3) first (they are security/correct-state), plus a CRLF/colon search case and a subfolder `add -A` case once fixed; `after(() => rmSync(tmp, {recursive:true}))`; set `GIT_CONFIG_GLOBAL=/dev/null` in `env`.

## Outside my scope
- renderer.js `answerFile` (about 1316) checks `lane.files.includes(m.path)`, where lane.js:77 builds those with `--full-name` (paths from the repo root), but `code:readLane` reads relative to the lane's cwd; for an agent running in a subfolder of a repo, a teammate's request for its changed file will not find the file (SUSPECTED, not run).
- main.js `folders` (the allow-list for `code:*`) only ever grows; a removed session's folder stays openable until the app restarts. Harmless (same user), but the comment says "nothing else" (by reading).

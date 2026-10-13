# Section 5: Electron main process (app/main.js, app/preload.js)

Scratch scripts: `scratch/5/env.js` (agentEnv cases), `scratch/5/hub-bonjour.js` (hub owners, Bonjour goodbye), `scratch/5/bounds.js` (window placement), `scratch/5/nested/` (lane paths).

## Covered
- main.js 1-50: requires, AGENTS/RESUME, `agentEnv` (timeout, `__ENV__` marker split, empty/odd output, LANG default, PATH copy, bad SHELL, what the login shell env drops vs process.env), `toWindow`, `remember`, `teamFor`, `signedIn`.
- Sign-in IPC (53-67): auth:saved, auth:start (abort of the previous flow, clipboard/openExternal, aborted-flow silence), auth:cancel, auth:signOut (what it clears and what it leaves: lanes, shells, folders allow-list, in-process hub, Bonjour ad, unsaved count).
- Teams IPC (70-97): list (nearby opt-in coercion), create, open (token handed to renderer), invite (findUser, remember merge), remove, leave, delete, `forget`, `remember` refreshing the open team and `known` never being pruned.
- Memories, sessions, comments, steps IPC (81-92): argument coercion for each (String()/!!/|0), raw `change` on steps:update.
- Repos and URLs (100-115): repos:list/pulls/issues (checkRepo regex), openExternal (github.com prefix), repo:reveal (cloneDir/REPO regex, openPath result), theme, app:info, gh:status, focus, badge, clipboard, unsaved, pickFolder.
- Updates IPC (118-132): check (not packaged, offline, release cache, canInstall), install (stage, swap.sh waits on pid, quit cancelled; UI has a `downloading` guard); renderer consumer `showUpdateStatus`.
- Agents (138-162): agents:status, startLane (team pinned, session read after awaits, o.repo / o.cwd / folderKey / worktree, resume args and what the renderer does when resume exits at once, PROTO_SHARED_TEAM, `members` semantics on hub, error paths, lane.cwd/folders), lane:write/resize/kill, lanes:rejoin (lane.js resize guards `c>0 && r>0`, try/catch).
- Code view IPC (167-194): `folders` allow-list, `code:root` (lane or repo+name via REPO regex and slug), `inFolder` guard, files.js `inside()` (realpath, symlinks, `..`, absolute rel, non-existing file), read/write/committed/search/commit, code:watch (single watcher, closer idempotent, `error` handler), code:readLane (renderer checks shareFiles and `lane.files.includes(path)`).
- Terminal tab shells (197-207): shell:start (cwd/env/cols/rows), id = pid, shell:write, shell:resize guard + try/catch, onExit; renderer lifecycle in code.js 605-635.
- Menu (210-245): every accelerator vs `runMenu` actions in renderer.js 1650-1666; Monaco bindings in code.js 86-92 (they already mirror the menu keys); roles; View menu in packaged builds.
- Window (248-284): single-instance lock and second-instance, window bounds save/restore (macOS pulls an off-screen window back: tested, x6000/y3000 became x72/y82), will-navigate / window.open denied, CSP in index.html, close/quit dialog text and conditions, `window-all-closed`, `will-quit` cleanup, `teams.stopAnnouncing`.
- preload.js 1-82: every exposed function checked against its handler (channel name, argument order, invoke vs send): all match, no handler is missing a preload entry, `listen` has no unsubscribe but every call site registers once at load (renderer.js 189/474/475/491/1666, code.js 169/631/632), nothing raw (no ipcRenderer, no event object) is exposed.

No high-severity problem found. The renderer cannot reach a file outside an allowed folder: the allow-list is exact-match, `inside()` resolves symlinks and `..`, and `repo`/`name` go through the REPO regex and `slug`.

## [medium] A slow or unusual .zshrc leaves the app with the wrong environment for its whole life
- Where: app/main.js:22-34 (callers: 100, 111, 138, 145)
- What happens: `agentEnv` is computed once. (a) If the login shell fails or times out, it resolves `process.env`, which for a Finder launch has the minimal PATH and no LANG (the `env.LANG ||=` line only runs on success). `agents:status` then reports every agent as not installed, `gh` can't be found, and non-ASCII output is mangled. Nothing retries; only a relaunch helps. A heavy rc (nvm, conda, brew shellenv plus network calls) hitting the 5 s timeout is common enough. (b) If the rc replaces the shell (`exec fish`, `[ -z "$TMUX" ] && exec tmux`-style lines) the `-c` command never runs, the output has no `__ENV__` marker and exit code 0, and the parse yields `{}`: the app resolves an empty env plus LANG, with no PATH and no HOME, so nothing starts.
- Evidence: CONFIRMED (b): with `.zshrc` = `echo hello banner; exec true`, the same execFile + parse gave `err null, out "hello banner\n", parsed keys 0, PATH undefined` (scratch/5/env.js). (a) SUSPECTED by reading lines 26 and 29-31.
- Suggested fix: Require the marker and a non-empty PATH in the parsed env, otherwise fall back to `{ ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' }`; apply the LANG default on every path; retry the login-shell read lazily (for example once more when `agents:status` finds nothing installed).

## [medium] The login-shell environment drops SSH_AUTH_SOCK and TMPDIR
- Where: app/main.js:23-25
- What happens: the shell is started with only HOME, USER, LOGNAME, SHELL and TERM. Everything launchd gives a GUI app and Terminal gives its shells is gone unless an rc file sets it again: SSH_AUTH_SOCK, TMPDIR, XPC_*, __CF_USER_TEXT_ENCODING. Agents, `gh`, and the code view's `git commit`/`git push` (files.js `commitAndPush`, which passes this env) then run without the ssh-agent that works in Terminal. For a user with an SSH remote and a passphrase key loaded with plain `ssh-add` (no UseKeychain), push and clone fail with "Permission denied (publickey)" in the app only. TMPDIR falling back to /tmp changes where tools put temp files.
- Evidence: CONFIRMED that the keys are missing: with the same execFile the result lacked SSH_AUTH_SOCK, TMPDIR, XPC_SERVICE_NAME, XPC_FLAGS and __CF_USER_TEXT_ENCODING, all present in process.env (scratch/5/env.js). The push failure itself is SUSPECTED (depends on the user's ssh setup).
- Suggested fix: after parsing, copy those variables from `process.env` when the login shell didn't set them: `for (const k of ['SSH_AUTH_SOCK','TMPDIR']) env[k] ||= process.env[k]`.

## [medium] Closing the window with only a Terminal-tab shell open quits without asking, and nothing can close a shell
- Where: app/main.js:267-276 (and 196-207, preload.js 75-81)
- What happens: the warning is shown only when `what.length` is non-zero, and `what` holds only agents and unsaved files. `shells.size` is used only to add a sentence to the detail text ("Terminals open in the code view close too."). So with no agent running and no unsaved file, Cmd+Q or Cmd+W kills a shell running a dev server, build, or a half-finished `git rebase` with no prompt. The text shows the intent was to warn about shells. Separately, there is no `shell:kill` IPC and no preload entry: a shell started once stays alive until it exits itself or the app quits, even after its session is deleted, its folder removed (renderer.js 773), or the user signs out (the renderer's `shells` map and the main process's `shells` both keep it).
- Evidence: SUSPECTED by reading (the dialog condition at line 272 does not include `shells.size`; no kill channel in main.js or preload.js).
- Suggested fix: add `shells.size && plural(shells.size, 'a terminal is open', 'terminals are open')` to `what`; add a `shell:kill` handler (and preload entry) and call it when a session's folder is removed or on sign-out.

## [medium] Sign-out leaves the in-process hub and its Bonjour ad running; the next account can't create a team on this Mac
- Where: app/main.js:67 with app/teams.js:35-42 (`hosting ??=`, `owners: [user.login]`, `bonjour.publish`)
- What happens: `auth:signOut` aborts sign-in, deletes the token, clears `session`, `team` and `known`, and stops the code watcher. It does not stop the hub that `hostHere` started, does not unpublish the Bonjour service (`"<login> on <host>"`, still answering teammates' lookups), does not clear the `folders` allow-list and does not close Terminal-tab shells. Because `hosting` is cached, signing in as a different GitHub user (personal vs work account on one Mac) and choosing "On this Mac" for a new team reuses the hub that was started with `owners: [first login]`, and the hub answers 403 "This hub only lets its owners create teams." That user can't host a team here until the app is restarted. (Agents are stopped by the renderer before sign-out, so those are fine.)
- Evidence: CONFIRMED the hub half: `startHub({ owners: ['alice'] })` returned 201 for alice and 403 `{"error":"This hub only lets its owners create teams."}` for bob (scratch/5/hub-bonjour.js). That the app reuses the first hub is SUSPECTED by reading `hosting ??=`.
- Suggested fix: on sign-out call a `teams.stopHosting()` that closes the hub, unpublishes, and clears `hosting`/`local` (or key `hosting` by login); also clear `folders` and kill `shells`.

## [low] The login-shell timeout is not enforced, and every code-view call waits for it
- Where: app/main.js:24 (`timeout: 5000`) and 174-177 (`inFolder` awaits `agentEnv`)
- What happens: `execFile`'s timeout kills only the shell. A child of the shell that holds the stdout pipe (sleep, a slow `nvm`/`brew` call in the rc) keeps the pipe open, so the callback runs only when that child ends. With a 1.5 s timeout and a 7 s rc the callback fired after 7016 ms. Meanwhile `agents:status`, `startLane`, `repos:list` and `gh:status` wait, and so does every `code:*` call, even `code:read` and `code:write`, which never use the env (`inFolder` always awaits it and hands it on). Opening the code view or saving a file right after launch can stall for the length of the rc.
- Evidence: CONFIRMED timing (scratch/5/env.js: `slow rc (timeout 1.5s): ms 7016, err killed`).
- Suggested fix: race the promise against its own `setTimeout` (resolve the fallback env after 5 s regardless), and have `inFolder` pass the env only to the handlers that use it (read/write don't).

## [low] Bonjour goodbye packets are never sent at quit
- Where: app/teams.js:93 (`stopAnnouncing`), called from app/main.js:283
- What happens: `bonjour.unpublishAll(); bonjour.destroy();` closes the mDNS socket before the goodbye (TTL 0) records go out, so other Macs keep listing "X on Y's Mac" until the records expire; with "Look for teams on this network" on, they show it under "unreachable" meanwhile.
- Evidence: CONFIRMED: a second Bonjour browser saw the service come up and never saw it go down after `unpublishAll(); destroy()`, but did see it go down when `destroy()` ran inside the `unpublishAll(cb)` callback (scratch/5/hub-bonjour.js).
- Suggested fix: `bonjour.unpublishAll(() => bonjour.destroy())`, and in `will-quit` call `e.preventDefault()` until it finishes (or wait briefly) before quitting.

## [low] A teammate's request for a changed file fails when the agent was opened in a subfolder of a repo
- Where: app/main.js:186-190 (`code:readLane`), with src/lane.js `gitStatus` (`changed` paths)
- What happens: the lane reports changed files with paths from the repo root (`sub/a.txt`), and the renderer checks the teammate's path against that list, but `readLane` resolves it against `lane.cwd`. For an agent started with "Open a folder" on a subfolder of a repo, `cwd/sub/a.txt` doesn't exist, so the teammate sees "That file can't be shown." for every file.
- Evidence: CONFIRMED: in a temp repo with the agent folder `sub/`, `gitStatus` gave `changed: ["sub/a.txt","sub/new.txt"]` and `files.read(<repo>/sub, 'sub/a.txt')` returned `{gone:true}` while `'a.txt'` returned the text (scratch/5/nested).
- Suggested fix: resolve against the repo root the lane reported (`lane`'s `root`/`git rev-parse --show-toplevel`) in `code:readLane`, still confined by `inside()`.

## [low] Cancelling sign-in while the code request is still in flight opens the browser anyway
- Where: app/main.js:54-65
- What happens: `auth:cancel` (or a second `auth:start`) aborts the controller, but `auth:start` doesn't check `abort.signal.aborted` after `await github.startSignIn(...)`. If the cancel lands during that request, the handler still overwrites the clipboard with the code, opens github.com/login/device, and returns `{ code, url }` to a renderer that has already left the sign-in screen. Two quick `auth:start` calls can also return in the wrong order, leaving the displayed and copied code that of the aborted flow.
- Evidence: SUSPECTED by reading (no check between the await and lines 58-59).
- Suggested fix: `if (abort.signal.aborted) return null;` right after the await (the renderer ignores a null result on cancel).

## [low] updates:check reports "No releases yet" when GitHub can't be reached
- Where: app/main.js:119-126 with app/updates.js `latestRelease`
- What happens: `latestRelease` swallows network errors and a missing `gh` and returns null, so the handler returns `{ latest: null, available: false }`, and `showUpdateStatus` (renderer.js 1521) prints "No releases yet". Offline, rate-limited (60 unauthenticated calls an hour per IP), or behind a captive portal, Settings → About claims there are no releases. The branch that prints "Couldn't reach GitHub" only runs if the IPC itself throws, which it never does for this case.
- Evidence: SUSPECTED by reading (`fetch(...).catch(() => null)` then `catch { return null }`).
- Suggested fix: have `latestRelease` throw (or return `{ error }`) on network failure and let `updates:check` reject, so the existing "Couldn't reach GitHub" text is used.

## [low] startLane reads the session after long awaits
- Where: app/main.js:140-148
- What happens: the team is pinned at the top, but `session.token` is read at line 148 after `await agentEnv` and `await github.sessionFolder(...)`, which can be a long `gh repo clone`. If the user signs out meanwhile, `session` is null and the user sees "Cannot read properties of null (reading 'token')" (after the clone has run); if a different account signs in meanwhile, the agent starts as the new account on the old account's team.
- Evidence: SUSPECTED by reading.
- Suggested fix: `const { token } = session;` next to `const team = openTeam();`.

## [low] An agent started on a solo team never gets the push guard after teammates are invited
- Where: app/main.js:147-149
- What happens: `PROTO_SHARED_TEAM` is put in the agent's environment at start, from `team.members.length > 0`. The pre-push hook reads it from that process's env. A Codex or OpenCode agent started while the owner is alone keeps running unguarded after the owner invites someone (only agents started later get the variable); `remember` refreshing the team (line 45) helps only new agents, as its comment says.
- Evidence: SUSPECTED by reading (env fixed at spawn; hub creates teams with `members: []`, so a solo owner is unguarded).
- Suggested fix: accept it and say so in the invite confirmation, or make the hook ask the hub (or a file in the clone) at push time rather than reading an env var.

## [low] repo:reveal ignores the error shell.openPath returns
- Where: app/main.js:104-108
- What happens: `shell.openPath` resolves to an error string instead of rejecting. The handler awaits it and discards it, so if Finder can't open the folder (permissions, odd path) the user clicks "Show in Finder" and nothing happens, with no message.
- Evidence: SUSPECTED by reading (Electron's documented return value).
- Suggested fix: `const err = await shell.openPath(dir); if (err) throw new Error(err);`

## [low] A second copy of the app runs the login shell and joins Bonjour before it quits
- Where: app/main.js:22-34, 252-253; app/teams.js:17-24 (module-level `new Bonjour()` and `find`)
- What happens: the single-instance check is near the end of main.js, after the top-level code has already started `zsh -ilc` (running the user's rc files a second time, with their side effects) and the Bonjour browser. The second copy then quits. Harmless in effect, but wasteful and it runs rc files for nothing.
- Evidence: SUSPECTED by reading.
- Suggested fix: do the `requestSingleInstanceLock()` / `app.quit()` first and skip the rest (for example `if (!firstCopy) return` before the `agentEnv` definition, or build `agentEnv` lazily).

## Outside my scope
- app/updates.js:70-76: `swap.sh` waits on the pid forever; if the user cancels the quit that `updates:install` asked for, the script keeps polling, and a second Install after a cancelled quit stages another 150 MB and a second script that races the first at quit (the renderer has a `downloading` flag against double clicks; main.js itself has no in-flight or already-staged guard).
- app/github.js:129-134: `removeSessionFolder` reports "Its folder has uncommitted changes, so it was kept." for any `git worktree remove` failure, including ones that have nothing to do with uncommitted changes.

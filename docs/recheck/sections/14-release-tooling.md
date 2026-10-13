# Section 14: release, tooling and docs

## Covered
- package.json: scripts (start, hub, test, e2e, demo, release with its main-branch check, screenshot, playground, dist with its --ignore regex and asar.unpackDir, postinstall, icon), dependencies and versions against the lockfile, engines, allowScripts, app id (default com.electron.protoplasma). Checked the packaged output of an existing dist/ build with @electron/asar: only app/, src/, node_modules (xterm, monaco `min` only, node-pty unpacked, ws, bonjour-service and deps), package.json, README, LICENSE, Dockerfile, .gitignore; no docs/scripts/test/build/.github/install.sh. Fine.
- .github/workflows/ci.yml and release.yml: triggers, permissions, secrets use (only the signing step), node version, caching, tag-vs-package.json check, zip name vs the updater's ASSET regex, what gets published.
- scripts/sign.sh: CI guard, ad hoc path, temporary keychain, search-list handling, partition list, fingerprint lookup, verify, traps. Also read ~/.config/protoplasma-signing/cert.pem metadata only (CN "Protoplasma Release Signing", valid to 2036).
- install.sh: sysctl arm64 check, gh vs curl paths, private-repo message, extract, replace-in-place, quarantine, open. `sh -n` passes (shellcheck is not installed).
- scripts/e2e.js (all 389 lines: what each check asserts, the alert/confirm stubs, the gh-dependent check, process lookups, cleanup), scripts/playground.js, scripts/playground-app.js (control API, cleanup, dialogs stubs, lane monkeypatch), scripts/stage.js, screenshot.js, demo.js, icon.js (identifiers used against app/renderer.js, app/code.js, app/preload.js; startLane patch order against app/main.js's destructured import; staged data and shots).
- Dockerfile (files copied vs hub.js/shared.js requires, env vars vs hub.js bottom). No Railway config file in the repo.
- README.md, every claim: install steps, shortcuts table vs app/main.js menu and app/code.js, features, how it works, working-on-same-code list, protocol table vs src/hub.js, hub config, security and privacy vs what the hub keeps and relays, updates and signing vs app/updates.js and scripts/sign.sh, roadmap, dev commands.
- Ran: `node --check` on every script and app/src file (all pass), `sh -n` on install.sh and sign.sh (pass), `npm test` (50/50 pass).
- Viewed docs/light.png and docs/code.png: no real paths, names or hostnames (made-up ~/Protoplasma/lobby-server@lobby-fix, persona "david"). Did not open the other four images or the gif.

## Findings

## [medium] Playground control API has no authentication, so any web page or local process can run JavaScript in the app
- Where: scripts/playground-app.js:60-103 (`/js` at 69, `/type` 88, `/menu` 89, `/hook` 90-98), listening on 127.0.0.1:7801 and :7802 (scripts/playground.js:15)
- What happens: the server only binds to loopback; it checks no token, Host or Origin. `POST /js` evaluates the body as page JavaScript in the app window, which has the `proto` preload bridge (`proto.shell.write`, `proto.kill`, `proto.write`, as e2e.js uses). A web page in the developer's browser can send `fetch('http://127.0.0.1:7801/js', {method: 'POST', mode: 'no-cors', body: '...'})`: a text/plain POST needs no preflight, so it is sent, and the response is only unreadable. DNS rebinding also works because Host is not checked. Result: code execution on the Mac as the user while a playground is running (the copies run with the developer's real account, only HOME is swapped). Chrome's local-network prompt may block this in Chrome; Safari and Firefox and other local processes are not covered.
- Evidence: SUSPECTED (by reading; did not start the playground).
- Suggested fix: generate a random token in playground.js, pass it as PLAY_TOKEN, and require it in an `x-play-token` header (a custom header forces a preflight that is never answered) or reject requests whose Host is not `127.0.0.1:<port>`.

## [medium] Ctrl+C in the playground leaves both app copies running when they have agents, and deletes their folders
- Where: scripts/playground.js:72-76 (`stop`), app/main.js:267-275 (close handler), header comment at playground.js:4 ("Ctrl+C stops everything and removes it")
- What happens: `stop()` does `a.kill()` (SIGTERM) on each Electron copy, then `fs.rmSync(root)` and `process.exit(0)` without waiting. Electron turns SIGTERM into `before-quit` and a window `close`; main.js then calls `dialog.showMessageBoxSync` ("An agent is still running ... Quit / Cancel", default Cancel) whenever `lanes.size > 0`, which is the normal state of the playground. The copy does not quit, its home, userData and hub are deleted underneath it, and the Node script has already exited, so the windows are orphaned, disconnected, and each has a blocking modal. With no agents running it works.
- Evidence: CONFIRMED in part: a stand-in Electron app that cancels `close` was still alive 4 s after SIGTERM and logged `before-quit` then `close` (scratch/14/t.js, m.js). The prompt condition is in main.js:267-275.
- Suggested fix: `a.kill('SIGKILL')` (the PTYs get SIGHUP when their master dies), or add a `/quit` route to playground-app.js that calls `app.exit(0)`; wait for the children's `exit` events before `rmSync`.

## [medium] e2e's "this run's agents" lookup also matches agents of any other Protoplasma app on the Mac
- Where: scripts/e2e.js:54-56 (`secretOf`, `claudePids`; comment says "only this run's agents"), 167, 224, 313
- What happens: `claudePids()` keeps every user-owned process whose command contains `claude --settings` and whose environment has PROTO_HOOK_SECRET. The installed Protoplasma, the playground and a second e2e all produce such processes. Line 224 takes `claudePids().find(pid => secretOf(pid) !== mySecret)`, which can be another app's agent (lowest pid first); the hook call to this run's hub then gets 401, `hook()` returns null and "its agent is told to pull first" fails for a reason unrelated to the code. Line 167 (`.pop()`, highest pid) can also pick a foreign agent if one starts meanwhile. Line 313 ("starts it with --continue") passes if any other `claude --continue` is running. Developers running e2e usually have the installed app open with agents.
- Evidence: SUSPECTED (by reading; e2e launches the app, so not run).
- Suggested fix: restrict to children of this process: parse `ps -Ao pid=,ppid=,command=` and keep `ppid === process.pid` (or walk up the parent chain), or have the app expose the lane's pid.

## [low] e2e's repo-list check fails on any Mac where the GitHub CLI is missing or not signed in
- Where: scripts/e2e.js:87-90; app/github.js:83-87
- What happens: the check passes if the repo list loads, or if the picker text matches `/reach GitHub/`. With no `gh`, the error is "Install the GitHub CLI to use repos here..."; signed out it is "Sign in to the GitHub CLI to see your repos here...". Neither matches, so the step FAILs, although the header says it "runs on any network". With `gh` signed in, it reads the developer's real repo list (private repo names) from GitHub.
- Evidence: CONFIRMED by reading both strings (github.js:83-87 against e2e.js:89); not run.
- Suggested fix: accept any of the three messages (`/reach GitHub|Install the GitHub CLI|Sign in to the GitHub CLI/`), or stub `gh` through PATH for the run.

## [low] e2e swallows every alert and never looks at them; it has no overall timeout and leaves temp folders
- Where: scripts/e2e.js:65 (stub; `window.__alerts` is never read), 44, 26, 80, 217, 361 (temp dirs), 40-49 and 51-66 (no timeout)
- What happens: the app reports real errors with `alert(errorText(e))` (renderer.js:253, 481, 533, 677, 689, 761; code.js:289, 624). The stub collects them in `__alerts`, but no check or the final summary prints or asserts them, so a flow that now alerts an error can still pass if its final DOM check is satisfied. Separately, if the page hangs or crashes before `run` finishes (or `run` throws before its try block, at line 65), the hub keeps the process alive and no summary or exit code is produced. Each run also leaves `protoplasma-e2e-*` (userData), `-remote-`, `-other-`, `-teammate-` and `-trust-` folders in the temp dir (only some are removed).
- Evidence: SUSPECTED (by reading).
- Suggested fix: print `__alerts` in the `finally` (and fail on any besides "stopped as soon as it started"), add a global timeout that sets the exit code and quits, and remove the temp dirs in `finally`.

## [low] sign.sh restores the keychain search list by word-splitting, which breaks for paths with spaces
- Where: scripts/sign.sh:25-27
- What happens: `SEARCH=$(security list-keychains -d user | tr -d '"')` keeps one path per line; `$SEARCH` is then expanded unquoted in both `-s "$KC" $SEARCH` and the EXIT trap. A home folder with a space ("/Users/John Smith/...") splits into several bogus entries, so a local run with MAC_CERT_P12 set first puts garbage in the search list and then the trap writes the same garbage back, dropping the user's login keychain from it. CI runner paths have no spaces, so releases are not affected.
- Evidence: CONFIRMED (scratch/14/split.sh: a two-line list with one spaced path yields 3 words).
- Suggested fix: read lines into positional parameters with `IFS` set to newline, or run the local path against a throwaway `HOME`; or document that sign.sh with a certificate is for CI only.

## [low] The release script and workflow check little: any pushed `v*` tag ships to every installed copy
- Where: package.json (`release`), .github/workflows/release.yml:5-7, 21-25
- What happens: (1) `npm version patch && git push --follow-tags` only checks the branch name. If local main is behind or diverged from origin/main, `npm version` has already made the commit and tag when the push is refused, so the next run skips a version and leaves a stale local tag. (2) release.yml runs on any `v*` tag from any commit; it checks the tag against package.json but not that the commit is on main or that CI passed for it, and a tag made by hand (not through `npm run release`) from a branch is published as the latest release and auto-installed by every copy within hours. (3) A re-run after a partial failure fails at `gh release create` because the release exists.
- Evidence: SUSPECTED (by reading; the release flow was not run).
- Suggested fix: in the script, `git fetch && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]` before `npm version`; in the workflow, `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` (with `fetch-depth: 0`) as the first step.

## [low] CI never builds or signs the app, so packaging mistakes surface only when a tag is pushed
- Where: .github/workflows/ci.yml:12-23, package.json `dist`
- What happens: CI runs `npm ci` with the Electron download skipped and `npm test` only. A change to the `--ignore` regex, a missing file in the asar, or a packager/electron version problem is first seen in release.yml, after the version commit and tag already exist on main.
- Evidence: SUSPECTED (by reading).
- Suggested fix: a second CI job (or a step on pull requests touching package.json) that runs `npm run dist` and checks the asar lists `src/hub.js`, `app/index.html` and `node_modules/monaco-editor/min`.

## [low] install.sh over a running copy leaves the old version running, and the message says it installed
- Where: install.sh:21-27
- What happens: the script replaces /Applications/Protoplasma.app while it may be open (macOS allows deleting a running bundle), then runs `open /Applications/Protoplasma.app`. Because the same bundle is already running, `open` only brings the old process to the front. The user sees "Installed Protoplasma" and keeps using the old version, with files under the old bundle gone, until they quit it. The header comment on lines 20-24 ("a failed move never leaves you with neither") also holds only until the `rm -rf` on line 23; if the last `mv` then fails, only `.app.new` remains.
- Evidence: SUSPECTED (by reading).
- Suggested fix: quit the app first (`osascript -e 'tell application "Protoplasma" to quit'`) or print "Quit and reopen Protoplasma to use the new version" when `pgrep -x Protoplasma` finds it; move the old copy aside instead of `rm -rf` and delete it after the final `mv`.

## [low] playground.js can print "ready" when nothing is ready, and setup failures leave processes and a temp folder
- Where: scripts/playground.js:19-64, 66-70; scripts/playground-app.js:103
- What happens: the readiness loop gives up silently after 100 tries (30 s) and the "Playground ready" banner prints anyway. The control ports 7801/7802 are fixed: a second playground (or a stale one) makes `listen` fail with an uncaught EADDRINUSE in the new copy, while the loop polls the other playground's API and reports ready. There is no try/catch around setup, so a failing `git` call in the loop (after the first copy was already spawned) rejects the async function, exits the script and leaves the Electron copies running and the temp folder behind. The SIGINT handler is only registered at the very end, so Ctrl+C during setup also leaves the temp folder.
- Evidence: SUSPECTED (by reading).
- Suggested fix: register `stop` first, wrap setup in try/catch calling it, pick free ports (listen on 0 and write the port to a file in PLAY_DIR), and exit with an error if a copy is not ready in time.

## [low] README: "on one shared team" is not what the playground sets up
- Where: README.md:169 (and scripts/playground.js:1-4)
- What happens: the playground starts a hub, a repo and two signed-in copies; it never creates a team or invites Max (no team calls anywhere in playground.js). Whoever uses it has to create the team in David's copy and invite `max` before the two see each other.
- Evidence: CONFIRMED by reading playground.js and playground-app.js (no createTeam/invite).
- Suggested fix: reword to "two copies of the app, David and Max, on one local hub and repo" and say to create a team and invite max first (or have playground.js do it through the hub API).

## [low] README wire-protocol table leaves out messages the hub sends and receives
- Where: README.md:152-159 against src/hub.js (onLane 521, relayFile 580, onWatcher 598, broadcastState)
- What happens: missing from the table: `/watch` app -> hub `file:get {lane, path, ask}` and `file:put {req, text, error}`, hub -> app `file:get {req, lane, path, from}` and `file:put {ask, text, error}` (the whole "Share the files your agents change" relay the Security section describes); `state` also carries `members`; the lane `git` message also carries `local` and `unpushed`; `/teams` also has plan steps (`/teams/:id/sessions/:s/steps`) and renaming, and the `hello` message's fields (id, hookSecret, session, cmd, root, roots, repo, git, cols, rows, open, history) are not listed. The sentence "nothing else is accepted until both are verified" is right (the hub queues up to 100 early messages and replays them after verification).
- Evidence: CONFIRMED by reading both.
- Suggested fix: add the four `file:*` rows, `members`, `local`/`unpushed`, steps, and a one-line `hello` field list.

## [low] README privacy section: "teammates see which files changed, not what's in them" is too strong, and the kept-data list is shorter than the app's
- Where: README.md:183-185; app/index.html:1013 (in-app "Kept on the hub")
- What happens: any teammate can open your agent full size and read its terminal, which shows diffs and file contents the agent prints; the hub also keeps each agent's scrollback and the last screen of up to 20 stopped agents in memory, and each prompt (first 300 characters) is shown beside the agent. Line 183 does mention terminal output passing through, but line 185 then says teammates see "not what's in them", which a reader takes as no code reaching teammates without the sharing switch. Also the README list of what the hub keeps ("team names, members, notes, sessions with goals, plans and comments") leaves out what the in-app text includes: each session's GitHub repo name (and who created it).
- Evidence: CONFIRMED by reading hub.js (lane.history relay, `prompt`, `session.repo`) and index.html:1013.
- Suggested fix: say "in the Explorer, teammates see which files changed; what your agent prints in its terminal is visible to the team", and add "repos" to the kept list.

## [low] README install: the documented command needs the GitHub CLI although it calls it optional
- Where: README.md:115-121; install.sh:11-17
- What happens: the one-line install is `gh api ... | sh`, so it needs `gh` installed and signed in, while line 115 says the CLI is optional. install.sh itself has a curl path that works without `gh` for a public repo, but nothing in the README shows it. A reader without `gh` has to find the zip on Releases and go through "Open Anyway".
- Evidence: CONFIRMED by reading.
- Suggested fix: say in the Install paragraph that the one-liner needs `gh auth login` (or, if the repo is public, give the `curl -fsSL https://raw.githubusercontent.com/dw8-ro/protoplasma-ide/main/install.sh | sh` form).

## [low] package.json allowScripts pins exact versions, so a routine bump silently skips Electron's and node-pty's install scripts
- Where: package.json (`allowScripts`: node-pty@1.1.0, electron@44.5.1)
- What happens: npm 11.19 honours `allowScripts` and rejects ranges (arborist script-allowed.js), so the entries must match the locked versions exactly. After `npm update` (the dependencies use ^ ranges), electron@44.5.2 is not covered: its postinstall (the binary download) is skipped or flagged, and `npm start` fails with "Electron failed to install correctly" until the entry is edited. CI/release use `npm ci` and the lockfile, so they only break when someone bumps without editing the policy.
- Evidence: SUSPECTED (read npm's script-allowed.js; did not bump a version).
- Suggested fix: note the pairing in a comment next to the dependencies (JSON has no comments, so in README "Development"), or run `npm install-scripts approve` as part of any bump.

## Checked and fine (no finding)
- sign.sh CI guard: with `CI` set and no MAC_CERT_P12 it exits 1 before any ad hoc signing; secrets are only in the signing step's env; keychain and cert.p12 are removed by the EXIT trap; an unmatched fingerprint lookup yields an empty `ID` and codesign fails, so it fails closed.
- release.yml: tag/package.json check, `npm test` before `dist`, zip name matches updater's ASSET regex, `permissions: contents: write` only.
- ci.yml: node 24, npm cache, read-only permissions.
- The `--ignore` regex works as intended (verified in the packaged asar); the lane monkeypatch in stage.js and playground-app.js happens before `require('../app/main')`, so main.js's destructured `startLane` gets the patched one; all `proto.*` and renderer functions used by screenshot.js, demo.js and e2e.js exist.
- Dockerfile copies everything hub.js and shared.js require; env names PORT, DATA_DIR, PROTO_OWNERS (and HOST) match hub.js. Shortcut table matches the menu and Monaco bindings (⇧⌘M is the `protoplasma.comment` keybinding).

## Outside my scope
- src/hub.js:2 says the hub "never ... sees code", but it relays terminals and, with sharing on, file text, and stores comment snippets (section 1/2).
- src/hub.js:55 defaults `host` to 0.0.0.0, so a local team hub (app/teams.js:31, `PROTO_BIND` unset) listens on every interface even when "Look for teams on this network" is off (section 6).
- app/main.js:267-275: the close prompt runs for any quit request, including SIGTERM and `app.quit()` from updates, so a signal-driven quit with agents running blocks (section 5).

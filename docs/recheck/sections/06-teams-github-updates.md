# Section 6: teams, GitHub and updates

## Findings

## [high] A session named ".." deletes the whole team when it is deleted (and "." can never be changed)
- Where: app/teams.js:80-84 (sessionRoute, used by setSessionDone, renameSession, deleteSession; commentRoute and stepRoute build on it)
- What happens: `encodeURIComponent('..')` is `'..'` (dots are never encoded), and `fetch` collapses `..` in a URL path before it sends. So deleting a session called `..` sends `DELETE /teams/<id>/` instead of `DELETE /teams/<id>/sessions/..`, which the hub answers as "delete the team". The hub accepts `..` as a session name (it only trims and cuts to 60 characters). The team owner who clicks Delete on that session loses the team with all its sessions, notes and plan (the hub only refuses while an agent is running in the team). A session called `.` is stuck for everyone: done and rename become `POST /teams/<id>/sessions/` and answer "Name the session.", delete answers "Not found.", comments and plan steps answer "No such session.". Names with `/`, `?` or `#` are fine (they become %2F, %3F, %23 and the hub decodes after splitting).
- Evidence: CONFIRMED. scratch/06/routes.js starts a real hub in-process and calls the real teams.js builders: for `..` saveSession was ok, setSessionDone/renameSession/addComment/addStep answered "Not found.", deleteSession answered ok and the team no longer existed afterwards; for `.` done/rename said "Name the session.", delete "Not found.", comment/step "No such session."; `a/b` and `a?b#c` worked for every action. `removeMember(team, '..')` also deleted the team in the same test, but the hub never accepts `..` as a member name, so that route is only reachable with a bad hub.
- Suggested fix: percent-encoding doesn't help (`%2E%2E` is collapsed too). Have the hub refuse session names made only of dots (and keep the client from sending them: throw in `sessionRoute` when `/^\.+$/.test(name)`), or send the name in the body/query string instead of the path.


## [medium] This Mac's own Bonjour entry is never recognised, so "Look for teams on this network" lists your own Mac as a second hub
- Where: app/teams.js:19-21 (`svc.name !== local?.name`) and :32 (`name: \`${user.login} on ${os.hostname()}\``)
- What happens: bonjour-service rewrites every dot in a service name to a dash (node_modules/bonjour-service/dist/lib/service.js:28). macOS hostnames normally end in `.local` (`os.hostname()` here is "Mac.Home"), so the advertised name is "alice on Mac-Home" while `local.name` is "alice on Mac.Home". The comparison never matches, so with nearby lookup on, the user's own hub is added to `nearby` and listed again as "<Name>'s Mac" at the LAN address. The same teams then show twice (different hub URL, so a different key) and each refresh asks the Mac's own hub twice.
- Evidence: CONFIRMED. scratch/06/bonjour.js runs the real teams.js (electron stubbed, hub bound to loopback): the watcher process saw `UP "alice on Mac-Home"`; `listTeams(..., {nearby:false})` gave ['This Mac'], with `{nearby:true}` the unreachable list contained "Alice's Mac" (it is only unreachable here because I bound the hub to 127.0.0.1; with the real 0.0.0.0 bind it would answer and duplicate the teams).
- Suggested fix: compare against the name bonjour will use (`local.name.split('.').join('-')`), or better skip any service whose port and address are this hub's (`svc.port === hub.port` and an address of this Mac) or put a random id in a txt field and ignore your own.

## [low] stopAnnouncing sends no goodbye, so a quit Mac stays in teammates' nearby list
- Where: app/teams.js:93 (`bonjour.unpublishAll(); bonjour.destroy();`)
- What happens: `unpublishAll` sends the goodbye packets asynchronously and takes a callback; `destroy()` closes the socket on the next line, before they go out. Teammates' Bonjour browsers never get the 'down' event and keep this Mac until the record expires (bonjour-service records live for minutes to hours). With "look for teams on this network" on, every team refresh then waits for the 5 s hub timeout on the dead entry and shows "<Name>'s Mac" as unreachable.
- Evidence: CONFIRMED. scratch/06/control.js: with the same two calls back to back, a watcher process saw UP and never saw DOWN in 12 s; with `unpublishAll(() => destroy())` it saw DOWN about 2 s later.
- Suggested fix: `bonjour.unpublishAll(() => bonjour.destroy())` and let `will-quit` wait for it (preventDefault, then quit again), with a short timeout.

## [low] A second person signing in on the same Mac can't create "This Mac" teams until the app restarts
- Where: app/teams.js:31 (`owners: [user.login]`, `hosting ??=`)
- What happens: the in-process hub is started once, for whoever called `hostHere` first, with only that login allowed to create teams. After sign-out and sign-in as another GitHub user the hub (and its advertisement, "alice on Mac") stays as it was, and the new user's "Create team on this Mac" is refused with "This hub only lets its owners create teams."
- Evidence: CONFIRMED. scratch/06/owners.js: alice created a team, then bob's createTeam failed with that message.
- Suggested fix: add the new user to the hub's owners (or run the hub with no owner list and let the team's owner be whoever creates it), or restart the hub when the signed-in user changes.

## [medium] Any failure sending a Bonjour reply throws in the main process (no error callback, no uncaughtException handler)
- Where: app/teams.js:14 (`new Bonjour()`), with node_modules/bonjour-service/dist/lib/mdns-server.js:16,86
- What happens: bonjour-service's default `errorCallback` is `err => { throw err }`, and it is called from the callback of every reply the Mac sends to a Bonjour query (`mdns.respond(..., err => this.errorCallback(err))`). `socket.send` reports errors such as ENETUNREACH, EHOSTUNREACH, EADDRNOTAVAIL there when the network changes (Wi-Fi switch, VPN on/off, wake from sleep). Once this Mac hosts a team and is advertising, such a failed reply throws inside a socket callback, which is an uncaught exception in Electron's main process (Electron's "A JavaScript error occurred in the main process" dialog, and the app can be left half-working). app/main.js has no `process.on('uncaughtException')`.
- Evidence: SUSPECTED (read the dist code; I could not make the OS fail a multicast send on demand). `grep uncaughtException app/main.js` finds nothing.
- Suggested fix: `new Bonjour({}, err => console.error('Bonjour:', err.message))`.


## [medium] An interrupted or timed-out clone leaves a `.git` that is later treated as a finished (or empty) clone
- Where: app/github.js:103-109 (cloneRepo: `existsSync(dir/.git)`), :116-126 (sessionFolder's "empty repo" fallback), :81 (gh timeout 120 s)
- What happens: `git clone` creates `.git` first. If the clone doesn't finish (the 120 s `gh` timeout on a big repo, the app quit mid-clone, a crash, a kill -9), `cloneRepo` on the next try sees `.git`, skips cloning and returns the folder. `sessionWorktree` then fails (no `HEAD`), `sessionFolder` finds `rev-parse --verify HEAD` failing, decides the repo "has no commits yet", and returns the clone itself. The agent starts in an empty, half-made folder on the default branch with no session branch and no error. (If the folder exists without a `.git`, `gh repo clone` refuses it with git's "already exists and is not an empty directory", which the user can't act on from the app.) The timeout only kills `gh`, not the `git` it started, so the first attempt reports "Command failed: gh repo clone ..." while git may still be running and finish later in the background.
- Evidence: CONFIRMED for the fallback (scratch/06/gh_cases.js: a repo with `.git`, a remote and nothing fetched made `sessionFolder` return the clone folder with 0 files and no error). The orphaned git after the timeout is SUSPECTED (execFile's timeout signals only its direct child).
- Suggested fix: clone into `dir + '.partial'` and rename when `gh` succeeds (and remove a stale `.partial` first); give clones a longer timeout than API calls; treat "no HEAD" as an empty repo only if the remote also has no refs (`git ls-remote --heads origin` is empty).

## [medium] "gh auth status" is read as "the first account is the signed-in one", and any broken saved account makes it say "not signed in"
- Where: app/github.js:136-141 (ghStatus)
- What happens: `gh` has supported several accounts since 2.40 and prints each one with `Active account: true/false`. The regex `/account (\S+)/` takes the first account listed, so with two accounts Settings says "Signed in as alice" while bob (the active one, whose token the repo calls use) is active; with an enterprise host listed first it names that host's account. `gh auth status` also exits non-zero when any saved account has a bad token, so someone whose active login works but who has one stale account is told "Installed, but not signed in. Run gh auth login." Repos load fine at the same time.
- Evidence: CONFIRMED against a fake `gh` that prints the 2.40+ format as I remember it (scratch/06/gh_cases.js): two accounts with bob active gave "Signed in as alice"; a stale account plus a good active one (exit 1) gave `ok:false`; an enterprise host first gave "Signed in as bob-corp". The real output format is from memory, not a live `gh`.
- Suggested fix: use `gh auth status --active` (or read the account that has `Active account: true`) and judge success by that account rather than the exit code; or ask `gh api user -q .login`.

## [low] gh error mapping blames the connection for permission, SAML, rate-limit and not-found errors; other failures show raw text
- Where: app/github.js:83-87
- What happens: the third branch tests `api\.github\.com` against the last stderr line. Errors from `gh pr list`, `gh issue list` and other GraphQL commands end with the request URL (`HTTP 403: ... (https://api.github.com/graphql)`), so SAML enforcement, rate limits, "Not Found" and permission errors all turn into "Couldn't reach GitHub. Check your connection, or choose a folder instead." Other failures surface raw: gh older than 2.48 (no `--slurp`) shows its usage line "Usage:  gh api <endpoint> [flags]"; a 120 s timeout shows "Command failed: gh api --paginate --slurp user/repos?per_page=100&sort=...".
- Evidence: CONFIRMED mapping with a fake `gh` printing those lines (scratch/06/gh_cases.js); that real gh prints the URL form for these errors is SUSPECTED (from gh's usual `HTTP <code>: <message> (<url>)` format).
- Suggested fix: test for network wording only (`dial tcp|no such host|i/o timeout|connection refused|EOF`), map `HTTP 403/404` and SAML to their own short messages, say "update the GitHub CLI" for an unknown flag, and say "took too long" when `err.killed`.

## [low] removeSessionFolder reports every failure as "uncommitted changes"
- Where: app/github.js:130-133
- What happens: the catch ignores the cause. A locked worktree, a worktree with submodules, a missing clone (git can't run in a folder that doesn't exist), a git timeout, and even an invalid repo name (`checkRepo` runs inside the try) all say "Its folder has uncommitted changes, so it was kept." The user then commits or discards changes that don't exist.
- Evidence: CONFIRMED (scratch/06/gh_cases.js): a `git worktree lock`ed session folder and the repo name "not a repo" both gave exactly that message.
- Suggested fix: keep git's message when it isn't about modified or untracked files (`/modified or untracked|contains modified/.test(e.message) ? 'Its folder has uncommitted changes, so it was kept.' : e.message`).


## [low] The swap script fails silently: if the first `mv` fails the old app is simply reopened
- Where: app/updates.js:71-75 (swap.sh)
- What happens: `if mv "$1" "$1.old" && mv "$2" "$1"; then ... elif [ -d "$1.old" ] && [ ! -d "$1" ]; then ... fi` has no branch for "the first mv failed" (no `.old` exists yet), so the script just runs `open "$1"` on the unchanged old app and deletes the download. The app had said "<version> is ready. It goes in as soon as Protoplasma quits."; after the restart it is still the old version, nothing says why, and the next check offers the same update again. Likely causes: an install folder that became read-only, a locked bundle, macOS App Management protection. stdio is ignored so the `mv` error is lost. (The "second mv failed, old copy restored" path works: see the run results below.)
- Evidence: CONFIRMED. scratch/06/swap.js runs the real script text from updates.js against fake bundles in paths with spaces, quotes, `'` and `$`: success swaps and opens the right path; missing new copy restores the old one; stale `.old` directory is cleaned up; the pid wait holds for 2.2 s; with a read-only parent folder the bundle stays at the old version, the old app is opened, exit status 0, error only on stderr that nobody sees.
- Suggested fix: write the script's output to a log file in the temp dir (or `~/Library/Logs`) and on failure open a small notice instead of silently reopening; at least keep the log.

## [low] swap.sh cleanup quotes the temp folder with JSON.stringify, which doesn't stop `$` or backticks expanding
- Where: app/updates.js:75 (`rm -rf ${JSON.stringify(dir)}`)
- What happens: JSON quoting gives a double-quoted shell string, inside which `$VAR` and `` `cmd` `` still expand. `dir` is `os.tmpdir()` plus a random suffix, so this only bites when TMPDIR contains such characters (the cleanup then misses the 150 MB download, or removes a different path). The bundle paths are passed as `$1`/`$2` and are quoted correctly.
- Evidence: CONFIRMED in the swap.js run: with `$HOME` in the folder name the script's `rm -rf` expanded it, so "tmpDir=left" in every scenario.
- Suggested fix: pass the folder as `$3` and write `rm -rf "$3"`.

## [low] Device-flow polling dies on any network blip or non-JSON answer, with raw error text; a null user gets saved
- Where: app/github.js:15-16 (postForm), :51-69 (finishSignIn), :27-40 and :20 (saveSignIn)
- What happens: `postForm` has no timeout, no retry, and calls `r.json()` unguarded. During the minutes a person takes to approve on GitHub, one dropped request ends the sign-in with "fetch failed", and a 502 HTML page from GitHub ends it with `Unexpected token '<', "<html>Bad "... is not valid JSON` (shown as the sign-in error). A stalled connection hangs the loop past the deadline. After the token is granted, a failing `/user` call ends the sign-in with "GitHub answered 500." and the approval is wasted. If `githubUser` returns null (a 401 right after issuing), `finishSignIn` saves `{token, user: null}` and returns a session with `user: null`, so `session.user.login` in main.js (repos:list, teams:leave) throws; only the next launch clears it. If `safeStorage.encryptString` throws, sign-in ends with Electron's raw "Error while encrypting the text provided to safeStorage.encryptString..." message. Saved sign-in itself behaves well: offline, GitHub 500 and a 403 rate limit keep the cached profile; only 401 deletes the file; an old bare-token file works online and gives null offline.
- Evidence: CONFIRMED with stubbed fetch/safeStorage (scratch/06/signin.js): "fetch failed" and the `<html>` JSON error from a blip/502, `{"user":null}` saved to disk after a 401, "GitHub answered 500." after the token; savedSignIn results as above. slow_down handling worked in the same run (pending, slow_down, approved). My expiry and cancel cases errored because my stub reused a Response body, so those two paths are verified by reading only.
- Suggested fix: in the loop wrap the request in try/catch (treat network errors and non-JSON as `authorization_pending` until the deadline), add `AbortSignal.timeout(15000)`, retry `githubUser` a few times, and throw "GitHub didn't recognise the new sign-in" when it returns null.

## [low] findUser has no timeout and lets organisation names through
- Where: app/github.js:72-76
- What happens: `fetch` has no signal, so with GitHub unresponsive the "invite" action hangs until undici's own 5 minute timeout (the `.catch` only handles rejections). `GET /users/{name}` also answers for organisations, so inviting "acme" (an org) is accepted as a teammate who can never sign in; the check is meant to catch typos.
- Evidence: hang CONFIRMED with a never-resolving fetch stub (still pending after 1.5 s); organisation behaviour is SUSPECTED from the GitHub API (stub returned `type: "Organization"` and the function returned the login).
- Suggested fix: `signal: AbortSignal.timeout(8000)` and reject when `type !== 'User'`.

## [low] isNewer ignores prerelease suffixes and a fourth number
- Where: app/updates.js:13-18
- What happens: `parseInt('0-beta')` is 0 and only three parts are compared, so "0.5.0-beta.1" counts as "0.5.0": a copy on 0.5.0-beta.1 is never offered 0.5.0, and 0.5.0-beta.2 is not newer than 0.5.0-beta.1. A tag with four numbers (0.4.1.1) is not newer than 0.4.1.
- Evidence: CONFIRMED (node -e): isNewer('0.5.0','0.5.0-beta.1') false, isNewer('0.5.0-beta.2','0.5.0-beta.1') false, isNewer('0.4.1.1','0.4.1') false. Releases so far are plain x.y.z and `releases/latest` skips GitHub prereleases, so this is latent.
- Suggested fix: split off the `-suffix` and treat "no suffix" as newer than any suffix, or state in the workflow that tags are always x.y.z.

## [low] The update check can hang for minutes on a stalled network
- Where: app/updates.js:33-35 (latestRelease), :20-21 (run)
- What happens: the public `fetch` has no timeout (undici gives up after about 5 minutes), and the `gh` fallback can take up to `run`'s 300 s. Settings shows "Checking…" for that long behind a captive portal or dead VPN. A 200 answer that isn't JSON makes `latestRelease` throw instead of returning null.
- Evidence: SUSPECTED (read; no timeout argument anywhere on that path). The asset pattern does match what the release workflow publishes (`Protoplasma-<version>-mac-arm64.zip`, .github/workflows/release.yml:32).
- Suggested fix: `signal: AbortSignal.timeout(10000)` on the fetch, a 20 s timeout for the `gh api` call, and a try/catch around `res.json()`.

## [low] teams.js: raw network errors, and one bad hub can sink or hide results
- Where: app/teams.js:39-45 (hubApi), :49 (listTeams), :59-61
- What happens: (1) For every action except listing, a dead or slow hub shows "fetch failed" or "The operation was aborted due to timeout" (the 5 s limit also covers a cold-starting online hub). (2) `data.error` is used as-is, so a non-string error from a hub becomes "[object Object]". (3) `await hostHere(user)` in listTeams isn't caught, so if the local hub can't start (data folder not writable, say) the whole list, online teams included, fails with the raw error. (4) A hub that answers 200 with something that isn't an array is neither listed nor reported unreachable; a hub that rejects the token (401) is reported as "Couldn't reach ...".
- Evidence: SUSPECTED (read; the validation and Promise.allSettled paths behave as written in my listTeams runs: This Mac listed, nearby off/on, unreachable names reported).
- Suggested fix: catch `TimeoutError`/`TypeError` in hubApi and throw "Couldn't reach that hub."; `String(data.error)` only when it's a string; wrap the hostHere resume in try/catch and add the Mac to `unreachable`.

## [low] test/updates.test.js: the "only an app bundle in a writable folder" test can't fail for the case it names
- Where: test/updates.test.js:15-18
- What happens: both assertions expect `null` (a non-.app path, and a read-only folder). The positive case, a bundle in a writable folder returning the bundle, is never checked, so `ownBundle` could always return null and nothing would notice. The first test does cover what its name says (isNewer with and without `v`, numbers not strings, missing parts); latestRelease, stage, sameSigner and swap.sh have no tests at all.
- Evidence: CONFIRMED. With `ownBundle` changed to `return null;` in a copy (scratch/06/mut), both tests still pass. The real function does return the bundle for `<tmp>/My.app/Contents/MacOS/My`.
- Suggested fix: add `ownBundle(tmp + '/My.app/Contents/MacOS/My') === tmp + '/My.app'` using a `mkdtemp` folder.

## [low] sameSigner: an ad hoc copy accepts any intact app, and a failed read of its own signature silently relaxes the check
- Where: app/updates.js:84-88
- What happens: with a certificate-signed copy the check is right (the matrix below). With an ad hoc signed copy `required` is undefined and `codesign --verify` only proves the update is intact, so even an app with a different bundle identifier signed by another certificate is accepted. If `codesign -d -r-` on the running bundle fails for any reason, `.catch(() => '')` has the same effect. This matches the comment ("takes any intact update"); the point is that the bundle identifier isn't compared even then.
- Evidence: CONFIRMED with real `codesign` and two self-signed certificates in a throw-away keychain (deleted afterwards; the login keychain list is unchanged): cert A copy accepts cert A, rejects ad hoc, cert B, a different bundle id and a file modified after signing; an ad hoc copy accepts ad hoc, cert A and a different bundle id, and rejects a modified ad hoc copy. `codesign -d -r-` prints the requirement on stdout, and the regex finds `designated => identifier "..." and certificate leaf = H"..."` (ad hoc prints `# designated => cdhash`, so no match).
- Suggested fix: when `required` is empty, also require the same `CFBundleIdentifier` (`codesign -dv` shows `Identifier=`), and refuse (instead of relaxing) when reading the current signature fails.

## [low] Two sessions starting at once on a not-yet-cloned repo or session can fail one of them
- Where: app/github.js:103-109 (cloneRepo), :116-126; src/workspace.js:20-37 (sessionWorktree)
- What happens: both callers see no `.git` / no worktree folder, then both run `gh repo clone` into the same folder, or both fetch (up to 30 s) and then `git worktree add -b session/x`. The second fails ("destination path ... already exists and is not an empty directory" / "a branch named ... already exists") and is shown as "Couldn't make this session's own folder and branch". Needs two starts for the same repo or session within the clone/fetch window.
- Evidence: SUSPECTED (read; no per-repo or per-session lock).
- Suggested fix: keep a `Map` of in-flight promises keyed by clone dir (and by worktree dir) so concurrent callers share one.

## [low] The push guard is skipped, without telling anyone, when git has a global `core.hooksPath`
- Where: src/workspace.js:68-70 (called from app/github.js:118)
- What happens: `git config core.hooksPath` reads the global config too, so anyone with a global hooks folder (git-secrets, a company template) gets no Protoplasma pre-push guard for Codex/OpenCode on shared teams, and `sessionFolder` swallows every installPushGuard error (`.catch(() => {})`). The comment promises the guard only for repos "that manage their own hooks".
- Evidence: SUSPECTED (read; `git config <key>` without `--local` merges all scopes).
- Suggested fix: use `git config --local core.hooksPath`, or tell the user in the session that the push guard isn't active.

## [low] listRepos reads every repo into one 20 MB buffer with a 120 s limit
- Where: app/github.js:81, :93-98
- What happens: `gh api --paginate --slurp` returns the full repo JSON (several KB each) for every repo the user can reach. Someone in a large organisation with a few thousand repos hits `maxBuffer` ("stdout maxBuffer length exceeded") or the 120 s timeout and sees that raw text instead of a list.
- Evidence: SUSPECTED (size estimate from the API's per-repo payload; not run against a big account).
- Suggested fix: pass `--jq` to `gh api` so only name, description, private, archived and owner.login come back.

## Covered
- app/teams.js, every line: Bonjour browse callback (IPv4 pick, own-ad filter, 'down'), `hostHere` (shared start across concurrent callers, failure reset, owners), `hubApi` (timeout, JSON errors), `listTeams` (nearby opt-in, validation, unreachable), `createTeam`, every route builder (`sessionRoute`, `commentRoute`, `stepRoute`, member, memory routes with `.`, `..`, `/`, `?`, `#`), `stopAnnouncing`; bonjour-service 1.4.4 and multicast-dns 7.2.5 internals read for name mangling, goodbye packets, error callback.
- app/github.js, every line: `savedSignIn` (new/old format, offline, 401, 500, 403, encrypt failure), `startSignIn`, `finishSignIn` (pending, slow_down, expiry, cancel, network errors, null user), `findUser`, `gh` error mapping, `listRepos`, `checkRepo`/`cloneDir`, `cloneRepo`, `sessionFolder` (worktree, empty repo fallback, error text, push guard install), `sessionFolderPath`, `removeSessionFolder`, `ghStatus`, `pullRequests`, `issues`.
- app/updates.js, every line: `isNewer`, `run`, `latestRelease`, `ownBundle`, `stage`/`prepare` (download, ditto, Info.plist check, xattr, signer check, cleanup on failure), swap.sh (success, missing new copy, read-only parent, stale `.old`, pid wait, quoting of bundle paths, two scripts at once), `sameSigner` (ad hoc and certificate-signed matrix).
- test/updates.test.js: both tests against their names (mutation run).
- Connections read: app/main.js handlers (auth, teams, repos, updates, sessions folders), app/renderer.js update flow (guards against a double install; `esc()` used for `where`), src/hub.js route parsing and team/session handlers, src/workspace.js.
- Checked, no problem found: concurrent `hostHere` callers share one start (code); a hub that fails to start resets `hosting` (code); long (300 char) and wide-character GitHub names publish without throwing; `encodeURIComponent` handles `/`, `?`, `#` in session names; swap.sh restores the old app when the second `mv` fails and keeps paths with spaces/quotes/`$` intact; the asset regex matches the release workflow's file name; the double-install is blocked by `staged`/`downloading` in the renderer (the double-script race I tried did not corrupt anything in a run).

## Outside my scope
- app/main.js: `known` keeps teams found on nearby hubs after "Look for teams on this network" is turned off (until sign-out), so the GitHub sign-in is still sent to those hubs for team actions.
- Packaging/Info.plist (not in my files): the Bonjour browser starts at launch regardless of the nearby setting (teams.js is required by main.js), so macOS 15's Local Network prompt may appear for everyone; worth checking NSLocalNetworkUsageDescription/NSBonjourServices in the packager settings.
- src/hub.js:350 and the in-process hub: `session` names made only of dots are accepted by the hub (the cause of the first finding); a hub-side check would fix it for every client.

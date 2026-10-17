# AGENTS.md: working on Protoplasma

Protoplasma is a macOS (Apple silicon) Electron app for multiplayer AI coding, laid out like
[Amoeba](https://useamoeba.com). A team works in **sessions**. Each person runs real agent CLIs (Claude Code, Codex,
OpenCode) in terminals on their own Mac. A **hub** relays those terminals to teammates, tracks which files each checkout
changed (overlaps), and answers Claude Code hooks: it adds team context to prompts, and asks before risky pushes or
before edits to a file a teammate changed. The app also has a Monaco code view, pane mode, plans (steps), team notes,
comments on code lines, opt-in sharing of changed files, and self-updates from GitHub Releases.

- **Current state and open work:** [HANDOFF.md](HANDOFF.md). Read it first in a new session.
- **The last full review:** [docs/recheck/](docs/recheck/). Its line numbers are from 0.4.1.
- **User-facing docs:** [README.md](README.md), including the wire-protocol table.

Function names below are stable. Line numbers drift, so search by name.

## Commands

| Command | What it does | Needs |
|---|---|---|
| `npm install` | Installs dependencies (postinstall makes node-pty's `spawn-helper` executable) | Node 24 |
| `npm start` | Runs the app from source. Updates are off in source runs. | |
| `npm test` | 80 integration tests in `test/*.test.js`: real hub, real lanes, real git. About a minute. | git ≥ 2.28, macOS. No network or Electron needed. |
| `npm run e2e` | Drives the real Electron app through every main flow and prints `PASS`/`FAIL` per step, ending with `N/M passed`. 15-minute cap. | The `claude` CLI on the login-shell PATH and a GUI session. One step needs `gh auth status` to succeed (online). |
| `npm run dist` | Packages `dist/Protoplasma-darwin-arm64/Protoplasma.app`, unsigned. | |
| `npm run playground` | Two app copies (David on port 7801, Max on 7802) on a local hub and repo, each with an HTTP control API | |
| `for s in 1 2 3 4 5 6 7 8; do node scripts/customer/s$s.js; done` | The customer simulation (docs/usage-test/REPORT.md): 91 checks driven with real clicks and typing against a running playground, start to finish on one fresh playground | `npm run playground` running |
| `npm run hub` | A standalone hub on `PORT` (default 7681). Memory only unless `DATA_DIR` is set. | |
| `npm run screenshot` / `npm run demo` | Regenerate `docs/*.png` and `docs/demo.gif` (plus its framed copies in `docs/readme/`) from a staged fake team (`scripts/stage.js`) | |
| `npm run readme-art` | Builds the README images in `docs/readme/` (dark and light) from `docs/*.png`: the pages in `scripts/readme-art/`, rendered offscreen, and the how-it-works SVG | Run after `npm run screenshot` |
| `npm run icon` | Renders `app/icon.svg` to `build/icon.png` and `build/icon.icns` | |
| `npm run release` | Bumps the patch version, tags `v<version>` and pushes. GitHub Actions builds, signs and publishes. | On `main`, with `main` equal to `origin/main` |

**Verifying a change:** run `npm test`, then `npm run e2e`. For packaging changes, also run `npm run dist`, then
`npx asar list dist/Protoplasma-darwin-arm64/Protoplasma.app/Contents/Resources/app.asar`. To try it as an installed
app:
1. Quit the running app first, after checking it has no agents running.
2. Copy the `.app` to `/Applications`.
3. Launch it with `open /Applications/Protoplasma.app`. Opening it by name can start the `dist/` copy instead.

Syntax checks: `node --check <file>` and `sh -n install.sh scripts/sign.sh`.

## Repo map

```
src/hub.js        the hub: REST, /lane and /watch WebSockets, Claude hook answers, push guard, overlaps (~800 lines)
src/lane.js       runs one agent CLI in a PTY and connects it to the hub; git status polling (~290)
src/workspace.js  per-session git worktrees and the pre-push guard hook (~130)
src/shared.js     slug(), scrollback limit, EDIT_TOOLS; shared by hub, lane, workspace (~30)
app/main.js       Electron main: single-instance lock, login-shell env, every IPC handler, menu, window, quit (~330)
app/preload.js    window.proto: the whole renderer API over IPC (~80)
app/teams.js      hub discovery (online / This Mac / nearby via Bonjour), hosting, hubApi REST client (~130)
app/github.js     device-flow sign-in, gh CLI wrapper, repo list, cloning, session folders (~190)
app/updates.js    update check, download, signature check, swap.sh (~110)
app/files.js      code-view file access: list, status, read/write boundary, search, Commit & Push, watch (~220)
app/renderer.js   every screen, the hub watch socket, terminals (~1800)
app/code.js       the Monaco code view (~770)
app/panes.js      pane mode (~90)
app/index.html    CSP, all CSS (tokens and themes), icon sprite, all markup and dialogs (~1040)
app/config.json   githubClientId (OAuth app, device flow), onlineHub (the Railway URL)
scripts/          e2e.js, playground.js + playground-app.js, stage.js, screenshot.js, demo.js + gif.js, readme-art.js +
                  readme-art/ (the README image pages and diagram), sign.sh, icon.js
test/             hub.test.js (40), hub-live.test.js (5), workspace.test.js (13), files.test.js (10), lan.test.js (7),
                  identity.test.js (2), updates.test.js (3)
.github/workflows ci.yml (npm test on every push to main and PR), package.yml (dist check), release.yml (tag → release)
Dockerfile        the hosted hub image (only src/hub.js + src/shared.js + ws)
install.sh        the one-line installer
build/            icon.icns, icon.png, extend-info.plist (Info.plist keys merged in by dist)
docs/             screenshots (sources), readme/ (the README's images, dark and light), recheck/ (review records)
```

## How it fits together

```
 ┌────────────── your Mac ──────────────┐                ┌──── hub (Railway, or inside someone's app) ────┐
 │ renderer (index.html + renderer.js,  │  /watch WS     │ src/hub.js                                    │
 │  code.js, panes.js) ──────────────────┼───────────────►│  teams.json (teams, members, notes, sessions)  │
 │      │ window.proto (preload.js)     │                │  live lanes, watchers, overlaps, stopped agents │
 │      ▼ IPC                           │  /lane WS      │                                               │
 │ main.js ── startLane ── src/lane.js ──┼───────────────►│  POST /hooks/:lane  ◄── Claude Code HTTP hooks │
 │   │          node-pty: claude/codex/opencode           │  REST /teams/...    ◄── app/teams.js hubApi     │
 │   ├ github.js → gh CLI, ~/Protoplasma/<owner>/<repo>    └───────────────────────────────────────────────┘
 │   ├ src/workspace.js → <clone>@<slug> on session/<slug>
 │   ├ files.js → code view (only folders in main's `folders` allow-list)
 │   └ updates.js → GitHub Releases, swap.sh
 └──────────────────────────────────────┘
```

- **Three kinds of hub** (`app/teams.js`):
  - **Online:** `config.json` `onlineHub`, overridden by `PROTO_ONLINE_HUB`.
  - **This Mac:** `startHub` running inside the main process, over https/wss with a self-signed certificate
    (`hubCert`: `<userData>/hub/tls-cert.pem` and `tls-key.pem`, made once with `/usr/bin/openssl`). Its data is in
    `<userData>/hub/teams.json`. It registers its certificate with the online hub (`POST /hubs`). It listens on `127.0.0.1` until
    one of its teams has someone besides the owner (`share`, at an invite or a listing). Then it moves to `0.0.0.0` on the
    same port (`listenOn`) and is advertised over Bonjour as `<login> on <hostname>`. `PROTO_BIND` overrides where it
    listens and turns `share` off.
  - **Nearby:** found over Bonjour type `protoplasma`, and only when the user turns on "Look for teams on this network".
- **Identity:** a GitHub token from the device flow with scope `read:user` only. The app sends it to the online hub and
  to this Mac's own hub, which check it against GitHub `/user`, and to no other hub. A hub on another Mac gets a
  **pass** instead (see "Passes" below). Repo access stays in the user's `gh` CLI and is never sent anywhere.
- **The team key** in the app is `${where}|${id}` (`keyOf` in main.js), so teams with the same id on different hubs don't
  clash.

### The hub (`src/hub.js`)
- **The server:** `startHub({port, host, dataDir, owners, verifyUser, tls, passIssuer})` → `{port, close, listenOn, fingerprint}`.
  The default host is `0.0.0.0`. With `tls` (`{key, cert}`) it serves https/wss; `fingerprint` is that certificate's.
  - `owners` lists the logins allowed to create teams. Leave it out to let anyone create them; an empty array lets
    nobody. The standalone entry point turns a blank `PROTO_OWNERS` into "left out".
  - The default `verifyUser` calls `module.exports.githubUser` late on purpose: scripts swap it for fake identities.
- **State:**
  - `teams` is persisted to `teams.json` synchronously via `.tmp` and a rename. A bad file is moved aside to
    `teams.json.bad-<ms>`.
  - `lanes` holds live agents, `watchers` holds app windows, and `stopped` holds the last 20 stopped agents per team.
    These three are in memory only.
  - The owner is never in `team.members`. `members.length > 0` means "has teammates", and turns on the push guard.
  - `team.ids` maps each login (lower case) to its GitHub numeric id. `onTeam(team, user)` matches by id. It records a
    missing id at that person's first sign-in (older teams, or an invite made while GitHub couldn't be asked), refuses
    a login now held by another id, and follows a rename (`renamePerson`). Every owner and author check runs after it,
    so they can keep comparing logins. Invites carry the id the app got from GitHub (`findUser`).
- **Sign-in:** `identify` caches a good token for 2 minutes and a rejected one for 10 s, keyed by its sha256.
  Concurrent lookups share one request. A GitHub outage is never cached: REST answers 503 and a WebSocket closes with
  1013. `githubUser` returns null without asking GitHub for anything not shaped like a GitHub token (`gh?_…`,
  `github_pat_…` or 40 hex characters).
- **WebSockets:** the first frame carries `{token, team}`, and `authenticate` checks it. Frames sent while it's checked
  wait in a queue (at most 1 MB). Close codes:

  | Code | Meaning | What the client does |
  |---|---|---|
  | 4000 | Bad hello | Lane doesn't retry |
  | 4001 | Sign-in failed | Lane doesn't retry |
  | 4003 | Not on the team, removed, or team deleted | Lane retries every 30 s; renderer shows "removed" |
  | 1013 | Try again (GitHub slow, or too much sent before sign-in) | Retries |
  | 1011 | Hub error | Retries |

- **`onLane`:**
  - Validates the hello: the id matches `[\w-]{1,64}`, `hookSecret` is at least 16 characters, the session name isn't
    made only of dots, and the id isn't held by another login.
  - Builds the lane record. `tree` is a hash of login, machine and root, and identifies one checkout.
  - On a reconnect, carries over status, prompt and files.
  - Relays `out` to every watcher on the team, and handles `size`, `git` and `status`.
- **`onWatcher`:** handles `look` (presence), `replay` (a stopped agent's last screen), `in` (typing, only into lanes
  started with `open`), and the `file:get`/`file:put` relay through `relayFile`. Only the lane owner's login may answer
  a file request.
- **`broadcastState`:** sends everything to every watcher of the team: lanes (via `views`, which never includes root,
  roots, hookSecret or history), watchers, members, memories, sessions and stopped agents.
- **Overlaps:**
  - `filesOf` is a lane's hook-reported edits plus its git changes against main.
  - `touchedBy(o, lane)` depends on how the two checkouts relate. Same tree: only o's hook edits. Same branch: o's edits
    not yet committed, plus what o hasn't pushed. Otherwise: everything o changed.
  - An overlap is a file each lane sees the other touching.
- **Hooks:** `POST /hooks/:laneId` with `Authorization: Bearer <hookSecret>`, compared timing-safe. `onHook` handles:
  - **UserPromptSubmit:** sets the lane to working and adds `teamContext`: the session goal, plan, other agents and their
    files, notes, and a behind warning.
  - **PreToolUse Bash:** `pushRisk` or `shellWriteRisk` → `ask`.
  - **PreToolUse on another tool:** adds the file's notes. For edit tools (`EDIT_TOOLS`), asks when `othersOn` the file.
  - **PostToolUse:** records the edit.
  - **PermissionRequest:** sets the lane to "needs you". **Stop:** sets it to idle.

  Claude Code's hook timeout is 3 s, so hook answers must stay fast. If the hook fails, Claude Code carries on.
- **Push guard** (`pushRisk` → `pushRiskOf`): a word heuristic, not a shell parser.
  - `partsOf` splits on `; | &` and line ends outside quotes, and drops `#` comments and heredoc bodies.
  - `commandsIn` also looks inside `-c`/`eval`/`ssh` quotes, `$(…)` and backticks, reading only the first 20,000
    characters.
  - `subcommandAt` skips git's own options.
  - It asks on: a force push, `--all`/`--mirror`, deleting any remote branch (naming main/master/the default branch,
    or a teammate on it, when that's what it is), and pushing to main/master or the lane's `mainBranch` (the branch
    `origin/HEAD` names, reported by lane.js `gitStatus`). It follows `git checkout`/`switch` within the same command.
- **Shell-write check** (`shellWriteRisk` via `writtenBy`): finds the paths a command writes, then asks if another
  agent in the same repo changed one. That can be a teammate's or one of your own in another checkout, which `whoOn`
  names as "your agent in session …". The edit ask (`othersOn`) and the "branch a teammate is on" push check work the
  same way.
  - Writes it recognises: redirect targets, `rm`/`mv`/`cp`/`tee`/`sed -i`, formatters with `--write`, `curl -o`, `dd of=`.
  - Git commands that discard changes (`checkout -- path`, `reset --hard`, `stash`, `clean`) only count for the same
    tree.
- **REST:** `handle()`. Session names travel in URL paths, so clients `encodeURIComponent` them. Routes:
  - `GET /` (health check).
  - `/teams`, `/teams/:id`, `/teams/:id/members[/:login]`, `/teams/:id/memories[/:id]`.
  - `/teams/:id/sessions[/:name]` (create, done, rename, delete).
  - `…/sessions/:name/comments[/:id]` and `…/sessions/:name/steps[/:id]`.

  Errors are `{error}` with status 400, 401, 403, 404, 409, 413, 503 or 500.
- **Sessions:** `findSession` matches the exact name, then `slug(name)`, the stored `key`, or an alias. A renamed session
  keeps `key` (the original slug), so its branch and folders don't move, and its old names go into `aliases` (at most
  50). Creating a session whose name matches an existing one joins it.
- **Standalone and Docker:** the env vars are `PORT`, `HOST`, `DATA_DIR` and `PROTO_OWNERS` (comma-separated; blank means
  anyone). The Dockerfile copies only `src/hub.js` and `src/shared.js` and installs only `ws`.

- **Passes:** how someone signs in to a hub on another Mac without handing it their GitHub token.
  - `signPass`/`readPass`: `p1.<payload>.<signature>`, Ed25519, payload `{login, id, name, avatar, aud, exp}`. `aud` is
    the hub certificate's `fingerprint` (shared.js: sha256 of the DER, base64url), and `exp` is 12 hours on
    (`PASS_TTL_MS`).
  - Issuing (the online hub, so only without `tls`): `POST /hubs {fp}` records a certificate under the caller's login
    (`hubs.json`, at most 5 per login). `POST /passes {aud}` signs a pass for the caller only if someone registered
    `aud`, and answers `{pass, owners, expires}`. `GET /passes/key` is the public key (SPKI DER, base64url). The private
    key is `pass-key.pem` in `dataDir`, made on first use.
  - Checking (a hub with `tls` and `passIssuer`): `identify` sends tokens starting `p1.` to `passUser`, which checks the
    signature with the issuer's key (fetched when first needed, and again at most once a minute when a pass fails), the
    `aud` against its own fingerprint, and expiry. A pass's identity is cached no longer than the pass lasts. A failure
    to reach the issuer is treated like a GitHub outage (503 / 1013).

### Agents (`src/lane.js`)
- **`startLane(opts)`:**
  - Throws straight away for a missing folder, a CLI that isn't installed, or a spawn failure. node-pty would hide a
    missing command, so `installed()` checks first.
  - Makes an id (a UUID) and a 48-hex `hookSecret`.
  - For `claude`, adds `--settings` with HTTP hooks (`claudeHookSettings`: UserPromptSubmit, PreToolUse
    `Read|Bash|EDIT_TOOLS`, PostToolUse, PermissionRequest and Stop, with a 3 s timeout). They go to `hookBase` when
    given, else to the hub.
  - A hub on a Mac has a self-signed certificate that Claude Code can't check, so its hooks would all fail (and fail
    open). main.js passes `hookBase` = teams.js `hookRelay`, a loopback http server that forwards `POST /hooks/:id` to
    the agent's hub pinned to its certificate. It adds no credentials. The online hub gets hooks directly.
  - Sets `PROTO_HOOK_SECRET` in the agent's env, except for `NO_HOOKS` CLIs (codex, opencode).
  - Signs in with `token`, or with `credentials()`, asked before each connection: `{token, ca}`, where `ca` pins a hub on a
    Mac to its certificate. The app passes `teams.access`, so a pass is renewed in time. If `credentials` fails, the
    lane reports it through `onRefused` and tries again every 30 s.
- **The hello:** `{t:'hello', token, team, id, hookSecret, session, cmd, root, roots, repo, branch, open, machine}`,
  plus `cols, rows, history, git` on each connect (`token` from that connection's credentials).
  - `machine` is a hash of the hostname.
  - `roots` lists the repo root both as git reports it (symlinks resolved) and as seen from the working folder.
- **Messages:** `out` is batched every 16 ms; `size`; `git` only when it changed; `status`.
- **Status:** "needs you" while the folder-trust prompt shows (`TRUST_PROMPT` plus its answers in `ANSWERS`, within the
  last 400 characters: Yes and No for Claude Code, "Trust and continue" for Codex). For codex and opencode, working or idle is guessed from output: output more than 400 ms after
  input means working, and 3 s of quiet means idle. Input clears "needs you", but the terminal's own escape-sequence
  replies don't count.
- **Connection:**
  - Pings every 20 s and terminates a socket that missed a pong.
  - Reconnects after 3 s for codes below 4000, or every 30 s after 4003. It doesn't retry after 4000 or 4001.
  - On exit while offline, sends one last hello with the final screen.
- **`gitStatus(cwd, {env})`:**
  - Polled every 5 s, with `fetchGit` beside every 12th poll. `fetchGit` leaves out `GIT_SSH_COMMAND` when the repo
    sets `core.sshCommand`, which would otherwise be overridden (a key per host, several accounts).
  - Main is `origin/HEAD`, else `origin/main` or `origin/master`; the diff is from the merge-base.
  - Uses `-z` output and caps file lists at 200 (`MAX_CHANGED`, which must equal the hub's).
  - Returns null when git fails.
  - **It writes one thing:** it sets the upstream of a `session/*` branch when the remote branch exists.
- **Standalone:** `PROTO_TOKEN=<token> node src/lane.js <hub> <team> <session> [--open] [cmd args…]`. The tests and e2e
  use it.

### Session folders and the pre-push guard (`src/workspace.js`)
- **`sessionWorktree(clone, session)`** → `{dir: '<clone>@<slug>', branch: 'session/<slug>'}`.
  - The `making` map makes two agents starting one session at once share one folder.
  - It continues a teammate's pushed branch if there is one; otherwise it starts from `baseOf`. That's origin/HEAD,
    re-detected if stale, then origin/main, origin/master, main, master.
  - A new branch has no upstream, so a bare `git push` can't reach main.
  - A merged, stale local branch of the same name is recreated.
  - A leftover or foreign folder is an error, never a silent fallback.
- **`removeSessionWorktree`:**
  - Refuses with `{kept: true}` when ignored files that aren't build output would be deleted, e.g. `.env`.
    `REMAKEABLE` lists the build output that is safe to delete.
  - Never passes `--force`, so git refuses uncommitted work.
  - Keeps the branch.
- **`PUSH_GUARD` / `installPushGuard`:**
  - A `pre-push` hook in the clone's common git dir, written atomically. It keeps the marker line `Added by Protoplasma`.
  - It only acts when `PROTO_SHARED_TEAM` is set, which main.js does for non-Claude agents on a team with members. It
    blocks pushes to main/master and the default branch (`refs/remotes/<remote>/HEAD`), branch deletions, and
    non-fast-forward pushes. `--no-verify` skips it; the README calls it a safeguard, not a lock (D5).
  - It skips repos with `core.hooksPath` or their own pre-push hook.
  - Claude agents are covered by the hub's hook answers instead. People pushing from their own terminal aren't affected.

### Electron main (`app/main.js`, `app/preload.js`)
- **Startup:**
  - The single-instance lock must stay the very first thing that runs
    (`if (!app.requestSingleInstanceLock()) { app.quit(); return; }`).
  - `agentEnv` loads the login-shell environment (`$SHELL -ilc`, 6 s hard limit) and falls back to the app's own env.
    It sets `process.env.PATH`, which node-pty needs, carries over `SSH_AUTH_SOCK` and `TMPDIR`, and sets `LANG` if
    missing.
- **State:**
  - `lanes`: id → lane, with `cwd`, `teamKey`, `unguarded` (a Codex/OpenCode agent started while its team was just
    you: `teams:invite` warns about these, D7) and a cached `prefix` added.
  - `known`: team key → team.
  - `folders`: the allow-list that every `inFolder(...)` handler checks (`code:list`, `status`, `read`, `committed`,
    `write`, `search`, `commit`, `pull`, `watch` and `shell:start`). Only lane folders and app-made session folders go in;
    `code:root` adds them. `code:readLane` is the exception: it reads from one of this Mac's live lanes by lane id,
    confined to that lane's folder by `inside()`.
  - `shells`: the Terminal tab's plain shells, never shared with the hub.
- **The `startLane` handler:**
  - Captures team and session before any `await`, and refuses on a `teamKey` mismatch or an unknown CLI. The lane
    signs in with `credentials: () => teams.access(…)`.
  - Gets the folder from `github.sessionFolder` (clone, push guard, worktree) or the user's own `cwd`.
  - Sets `PROTO_SHARED_TEAM=1` for codex/opencode on a team with members.
  - Returns a `notice` when a codex/opencode agent on a team with members has no pre-push guard: an app-made clone
    whose repo has its own hooks, or a folder the user picked (the app never installs the guard there).
  - Returns `{id, repo, notice}`.
- **The IPC rule:** every `proto.x` in preload.js has a matching main handler. `invoke` pairs with `ipcMain.handle` and
  `send` with `ipcMain.on`. Wrap a handler in `signedIn(…)` if it needs the session, and in `inFolder(…)` if it takes a
  folder. Coerce every argument (`String()`, `|0`, `!!`).
- **Security:** contextIsolation and the sandbox are on (Electron's defaults), the window never navigates, and
  `openExternal` only opens `https://github.com/` links.
- **Quitting:**
  - The close dialog counts agents, unsaved files and shells.
  - SIGTERM quits without the dialog; the playground relies on this.
  - `will-quit` kills lanes and shells, waits up to 1 s for `teams.stopAnnouncing`, then quits again on the next tick
    (`setImmediate`). A quit asked for while Electron is still handling one is ignored, which left the app running with
    no window after Quit, Update now or logging out (F1 in docs/usage-test). e2e ends with SIGTERM to cover this path;
    `win.destroy()` doesn't, because the whole chain then runs inside one JavaScript call.

### Services (`app/teams.js`, `app/github.js`, `app/updates.js`, `app/files.js`)
- **teams.js:**
  - Bonjour is created lazily, so macOS asks for local-network permission only when you host or browse.
  - `hostHere` starts the This Mac hub once (`hosting ??=`), and `stopHosting` runs at sign-out (it also forgets passes).
    `register` retries the certificate registration at each listing until it works.
  - `access(s, url)` decides what to sign in with. The online hub gets the GitHub token. This Mac's hub gets the token
    and `ca` (its own certificate). Any other hub must be https. It gets pinned to the certificate it presents (`certOf`,
    `pins`), then gets a pass for that fingerprint from the online hub (`passes`, renewed an hour before it expires),
    plus `owners`, who registered it.
  - `hubApi(s, url, …)` makes every hub request through `access`, with `ca` pinning the connection. It times out after
    15 s for the online hub (Railway cold start) and 5 s otherwise. A failed request forgets the pin, so a hub with a new
    certificate is read again.
  - `listTeams` asks every hub at once. A nearby hub goes through `teamsAt`, which keeps only teams owned by its
    `owners`, labelled `<owner>'s Mac`.
  - `hookRelay(hubFor)` starts (once) the loopback relay for Claude Code's hooks to hubs on a Mac. `hubFor(laneId)` is
    main.js `hookTarget`: the lane's hub and its pinned `ca`, only for this Mac's own lanes.
  - `isPinned(hostname, pem)` backs main.js's `setCertificateVerifyProc`: Chromium accepts a self-signed certificate
    only when it's the one pinned for that host.
  - Electron is required late (in `localDataDir`), so tests can load this file.
  - `sessionRoute` refuses names made only of dots.
- **github.js:**
  - **Sign-in:** the device flow saves `{token, user}` to `<userData>/github-token`, encrypted with `safeStorage`.
    `PROTO_GITHUB_TOKEN` overrides the saved token, and nothing is written then.
  - **`gh(args, env)`** maps gh's errors to plain messages.
  - **Clones:** `checkRepo` validates `owner/name` before anything builds a path or gh call from it. `cloneRepo` clones
    into `<dir>.partial` and then renames it, and shares one clone between concurrent callers.
  - **Session folders:** `sessionFolder` runs clone, then push guard, then worktree. A repo with no commits uses the
    clone itself. `sessionFolderPath` must build the same `<clone>@<slug>` as workspace.js.
- **updates.js:**
  - **Finding a release:** `latestRelease` asks the public API (no sign-in; GitHub allows 60 such requests an
    hour per IP). If that fails, it falls back to `gh api` when `gh` is signed in.
  - **Installing:** `stage` downloads, unzips with `ditto`, strips quarantine, then requires `sameSigner`: the same
    certificate requirement, or for ad hoc copies, the same bundle id. Then a detached `swap.sh` replaces the app after
    it quits. swap.sh takes args `$1`–`$5`, logs to `~/Library/Logs/Protoplasma-update.log`, and puts the old app back on
    failure.
- **files.js:**
  - **Reads and writes** are confined to the folder. `inside()` compares real paths against `base + path.sep`, so
    symlinks and sibling folders like `david-evil` are refused. `within()` is the name-only check for git paths.
  - **`read`** returns one of `{text}`, `{gone}`, `{outside}`, `{binary}`, `{tooBig}` (over 2 MB) or `{notUtf8}`.
  - **`status`** returns `prefix`, the folder's place in its repo. Teammates' paths are from the repo top, so code.js and
    `code:readLane` add or strip it.
  - **`commitAndPush`:**
    - Refuses during a rebase (or cherry-pick, revert), with conflicts, or on a detached HEAD.
    - Runs `add -A -- .` and `commit -- .`, which only touch this folder, then `push -u origin HEAD`.
    - If a teammate pushed first, runs `pull --rebase --autostash` and pushes again. If you both changed the same lines,
      it aborts the rebase and says "Pull their work…", which makes code.js show the **Pull** button (D8).
    - During a merge, `finishMerge` commits it (the whole merge, `--no-edit` without a message) once no conflicted file
      still has conflict lines (`CONFLICT_LINES`), adding the fixed files for you, then pushes.
    - Returns a sentence, and code.js decides success by matching words in it.
  - **`pull`:** `pull --no-rebase --ff --no-edit origin <branch>`, refused with uncommitted changes or anything under
    way. Lines changed on both sides are left marked C for the editor.

### The UI (`app/renderer.js`, `app/code.js`, `app/panes.js`, `app/index.html`)
- **One shared scope:** these are classic scripts that share one global lexical scope, with no modules.
  - A new top-level `const`/`let`/`class` whose name already exists in another of the files is a SyntaxError that
    stops that file loading. A new top-level `function` with another file's function name silently replaces it
    everywhere.
  - e2e, the playground and stage.js reach the globals by name.
  - The script order in index.html must stay: xterm, its addons, renderer.js, code.js, panes.js, then Monaco's
    `loader.js` last. Monaco's AMD `define` would otherwise capture xterm.
- **Drawing:**
  - `render()` is the single idempotent redraw. It runs on every hub `state`, on local events and every 30 s. Keep it
    cheap.
  - `setHTML(el, html)` writes only when the string changed, so focus and terminals survive redraws. Don't also set
    `innerHTML` directly on the same element, or its cache goes stale.
- **Escaping:** every string from the hub or a teammate goes through `esc()`. The renderer can start agents and write
  files, so XSS would be serious. The git numbers are interpolated raw only because the hub coerces them to integers.
- **The hub socket:** `watch(conn)` asks main for a token (`proto.hubToken`, which renews passes) before each
  connection, connects to `${hub}/watch`, and handles `state`, `out`, `replay`, `file:get` and `file:put`.
- **Terminals:** `createTerminal` makes one per lane, and the element is moved between `#lanes` and pane columns, never
  recreated.
  - Only on-screen terminals get WebGL; a page gets about 16 contexts.
  - Teammates' terminals keep the owner's columns and rows, and `fitFont` scales the font, down to 6 px.
  - A teammate terminal sends input only while focused, and never xterm's automatic replies.
- **Sharing files:** `answerFile` replies only for this Mac's own live lane, only with **Share the files your agents
  change** on, and only for files in `lane.files`. Only the renderer enforces the share setting and the `lane.files` check. The hub routes requests only to the
  agent owner's windows, accepts answers only from that login, and enforces the 1,000,000-character cap
  (`MAX_SHARED_FILE`).
- **Session names:** `slug` and `existingSession` in renderer.js copy `slug` in `src/shared.js` and `findSession` in the
  hub. Keep all of them identical.
- **The code view** (code.js): it uses the `code` state object and `models` (per path: `saved`, `stale`, `bom`,
  `theirs`).
  - Unsaved models are parked per folder when you switch session.
  - A git status poll runs every 3 s, because `fs.watch` misses commits in worktrees.
  - Monaco's Cmd-S, Cmd-K, Shift-Cmd-L and Cmd-I are re-routed to the app's menu actions, and Shift-Cmd-M comments on
    lines.
- **Settings** is a non-modal `<dialog>`, so the sidebar and main area are made `inert` while it's open.
- **Preferences** live in localStorage `prefs` (`DEFAULT_PREFS`). An input with `data-pref="key"` saves itself.
- **Pane mode** (panes.js): up to 3 sessions side by side, saved per team as `panes:<teamKey>`.

## Keep these in sync (they break silently)
- **Session naming:**
  - `slug()` in `src/shared.js` and its byte-for-byte copy in `app/renderer.js`.
  - Hub `findSession` and renderer `existingSession`.
  - Changing slug renames existing branches and folders.
- **Folder and branch names:** `<clone>@<slug>` and `session/<slug>` appear in `src/workspace.js` (three places) and
  `app/github.js` `sessionFolderPath`.
- **Limits:**
  - `MAX_CHANGED` (200) in hub.js and lane.js.
  - `EDIT_TOOLS` drives both the lane's hook matcher and the hub's edit tracking.
  - The hub's `MAX_SHARED_FILE` and 5 MB frame limit, and renderer `answerFile`'s limits.
- **Status strings** `'needs you' | 'idle' | 'working'`: the lane, the hub's allow-list, and the renderer's `STATUS`.
  The hub also gives agents without hooks the initial status `'running'` (`onLane`), which the renderer's `STATUS` and
  `sessionStatus` handle.
- **Push-guard rules:** `PROTECTED_BRANCHES`/`pushRiskOf` in the hub and `PUSH_GUARD` in workspace.js.
- **Privacy numbers:** the README "Security and privacy" section and the in-app Data & privacy text (index.html) quote
  the constants. Up to 512 KB of output (2 × `SCROLLBACK`), the last 20 stopped agents (`MAX_STOPPED`), and comment
  snippets of up to 300 characters.
- **Release artifact:** the zip name `Protoplasma-<ver>-mac-arm64.zip` (release.yml) must match `ASSET` in
  updates.js and the patterns in install.sh. The zip holds `Protoplasma.app` at the top level, and tags are
  `v<version>`.
- **Bundle id:** `com.electron.protoplasma` (packager's default). Never change it, because sameSigner and macOS identity
  rely on it.
- **Agent lists:** `AGENTS` and `RESUME` in main.js, `NO_HOOKS` in lane.js, and the renderer's agent pickers.
- **Dependencies:** `allowScripts` in package.json names the exact Electron and node-pty versions. Bump them with the
  dependencies, or their install scripts are skipped and `npm start` fails.
- **Hub deploy:** the Dockerfile copies only `src/hub.js` and `src/shared.js`. A new hub dependency or file needs the
  Dockerfile updated, or the hosted hub crashes on start.
- **Load order:** scripts that fake GitHub or agents (e2e.js, stage.js, playground-app.js) must replace
  `hubModule.githubUser` and `laneModule.startLane` before `require('../app/main')`. github.js and main.js destructure
  them at load.
- **Terminal colours:** the dark terminal background `#141416` equals `--main`/`--lane`; the light one `#ffffff` equals
  the light `--lane`.

## Security boundaries
- **Hooks:** a hook is authenticated only by the per-lane secret, never a GitHub token. `hookSecret`, `root`, `roots`
  and `history` must never appear in `state`. The hook relay (teams.js `hookRelay`) listens on 127.0.0.1 only and
  passes the hook's own Authorization header through; it must never add a token or pass.
- **Typing in:** remote input only goes to lanes started with `open`, on the watcher's own team. lane.js also drops
  `in` itself unless it was started open, whatever a hub sends.
- **Lane ids:** an id held by one login, live or stopped, can't be claimed by another.
- **Code view:** every `code:*` handler takes its root through `inFolder`, except `code:root` (which registers the
  folder) and `code:readLane` (keyed by one of this Mac's live lane ids and confined to that lane's folder). Every path from the renderer passes
  `inside()` (filesystem) or `within()` (git only).
- **Repo strings:** every repo string passes `checkRepo` before a path or gh call is built from it.
- **Token scope:** the token stays `read:user`. Looking for nearby teams stays opt-in.
- **Hubs on other Macs:** the GitHub token goes only to the online hub and this Mac's own hub (`access` in teams.js).
  Anything else is https only, pinned to the certificate it presented, and gets a pass bound to that certificate. Keep
  every hub connection going through `access` (REST), `credentials` (lanes) or `proto.hubToken` (the hub socket).
- **Git prompts:** `GIT_TERMINAL_PROMPT=0` is set by the git helpers in files.js, workspace.js and lane.js `gitEnv`,
  so nothing there hangs on an invisible prompt. The clone (`gh repo clone`) and a few local-only calls (lane.js's sync
  `git()`, github.js `rev-parse`, files.js `underWay`) don't set it. Route any new network git call through one of the
  prompt-free helpers.
- **Releases:** never publish an ad hoc release. `sign.sh` exits 1 in CI without the certificate.
- **Open security decisions** (D1 to D4) are in HANDOFF.md:
  - logins vs numeric ids;
  - the token in clear text to hubs on a Mac;
  - the hub listening on every interface;
  - which branches are protected.

## Gotchas
- **Hub tests:** `test/hub.test.js` tests share one hub, team and set of lanes, and run in file order. `nextState()` only
  sees *future* messages, so set it up before the action. Waiting for a state that already arrived hangs, which once
  broke a release build on the detached tag checkout. Raw lanes need a hook secret of 16+ characters (`SECRET`).
- **Test isolation:** workspace.test.js and files.test.js set `GIT_CONFIG_GLOBAL=/dev/null` and
  `GIT_CONFIG_NOSYSTEM=1`, and workspace.test.js also deletes `PROTO_SHARED_TEAM`. hub.test.js lanes run git in this repo
  with the developer's own environment. New git-running tests should do all three, or developer config
  (`push.autoSetupRemote`, signing) changes results. Tests
  must not require `electron` or modules that do, because CI skips the Electron download.
- **e2e touches the real home folder:** it recreates `~/Protoplasma/protoplasma-e2e`, and runs real Claude Code with the
  user's `~/.claude`. It reads hook secrets from `ps eww`.
- **e2e page code:** inside template literals, page code needs `\\n` to mean a newline in the page.
- **A real `claude` in a new folder stops at its folder-trust prompt.** Never answer it on David's behalf. e2e checks the
  "needs you" state and dismisses it with Esc, which declines.
- **Packaging:** `package.yml` only runs when packaging files change. A new runtime file excluded by `--ignore` (dist,
  docs, scripts, test, build, .github, install.sh, the root CLAUDE.md, AGENTS.md and HANDOFF.md, monaco esm/dev) only
  shows up as broken in a release. These are prefixes: anything at the root whose path merely starts with one of them
  (`testdata/`, `build-info.json`) is left out too. Run `npm run dist`, and add critical files to package.yml's asar list.
- **Releases:**
  - `npm run release` only bumps the patch version. For minor or major, run `npm version minor && git push
    --follow-tags` by hand, after checking you're on `main` and in sync yourself.
  - A failed release needs a new commit and a new version, because the tag must equal package.json and be on main.
- **Shortcuts:** Monaco grabs Cmd-K, Shift-Cmd-L, Cmd-I and Cmd-S. A new app shortcut that Monaco also binds needs an
  `ed.addCommand` in code.js `ensureEditor`.
- **Similar names:** `#codeView` is the sign-in device-code step, not the editor; the editor is `#code` / `.code-view`.
  `data-pane` is used both by Settings sections and by pane-mode columns.
- **Caches on functions:** `refreshFiles.last`, `renderTabs.unsaved` and `marks.last` hold
  state. Reset them with the state they belong to.
- **`main.js` uses some variables before their declarations,** inside callbacks (`folders`, `shells`, `stopWatching`, `terminated`).
  Don't move those calls to module top level.
- **Deliberate shortcuts:** comments marked `ponytail:` name a simplification with a known ceiling and the way up from
  it. Keep the marker when you touch them.

## How to…
- **Add a hub REST route:**
  1. Add it in `handle()` in hub.js, after the team lookup, so sign-in and membership are already checked. A route
     deeper than `/teams/:id/:sub/:subId` also needs the path guard at the top of `handle()` widened; it returns 404
     for anything else.
  2. Mutate the team, then call `saveTeams()` and `broadcastState(team.id)`.
  3. Add a helper in `app/teams.js` (`hubApi`, `encodeURIComponent` on every id), an `ipcMain.handle` in main.js
     wrapped in `signedIn` and `teamFor(key)`, and a method in preload.js.
  4. Add a test using `api()` in hub.test.js.
- **Add a WebSocket message:**
  - Lane → hub: add it to the message chain in `onLane`. Watcher → hub: add it to `onWatcher`. Hub → app: use
    `toTeam(...)` or `send(ws, ...)`.
  - Handle it in renderer `watch()` or lane.js.
  - Add it to the README protocol table.
- **Add a field teammates see on an agent:**
  1. Read it from the hello with `str()`/`size()` caps.
  2. Add it to `views()`, and to the reconnect carry-over if it should survive. For stopped agents, add it to the
     stopped record in `onLane`'s close handler and to `stoppedViews()`, which picks a fixed set of fields.
  3. Send it from lane.js.
- **Add an agent CLI:**
  - Add it to `AGENTS` and `RESUME` (main.js), to `NO_HOOKS` (lane.js), to renderer.js `agentName`, and to the Settings
    agent radios in index.html.
  - Hooks are wired only for the command named `claude`. A CLI left out of `NO_HOOKS` gets `PROTO_HOOK_SECRET` but no
    status at all, and stays "running". Keep it in `NO_HOOKS` unless you also add hook settings like
    `claudeHookSettings`.
  - Check the hard-coded `'claude'` tests in main.js `startLane` (shared-team push guard), lane.js `startLane` (hook
    settings) and hub.js `onLane` (initial status).
- **Add an IPC call:** add it to preload.js (`invoke` or `send`), add the matching main handler (`signedIn`, `inFolder`,
  coerced arguments), and call it as `proto.x(...)` with failures shown via `errorText(e)`.
- **Add a preference:** add a default to `DEFAULT_PREFS`, and an input with `data-pref="key"` in the Settings markup. It
  saves and syncs itself.
- **Add a page:** add a `<section class="page" hidden>` in index.html's `<main>` and a sidebar button. Wire `go('x')`,
  toggle it in `render()`, and add it to `switcherCandidates`.
- **Add a menu command or shortcut:** add a `menuAction('x')` item in main.js and handle `'x'` in `runMenu`. Check
  Monaco's bindings, and list it in Settings → Keyboard and the README table.
- **Change the push guard:** change `PROTECTED_BRANCHES`/`pushRiskOf` (hub.js) and `PUSH_GUARD` (workspace.js) together.
  Existing clones get the new hook the next time a session starts. Add cases to both test files.
- **Teach the shell-write check a command:** add it to `writtenBy` or `FORMATTERS`, with read-only and writing examples
  in hub.test.js.
- **Add a code-view file operation:** add a function in files.js (with `inside()` or `within()`, using the local
  `git()` helper). Register `code:<name>` in main.js wrapped in `inFolder`, add it to preload's `code` namespace, and
  call it from code.js.
- **Add a test:** add `test/<name>.test.js` using `node:test` and `node:assert/strict`, with an isolated git config and
  cleanup in `after()`.
- **Add an e2e step:** inside `run()` in scripts/e2e.js, use `await js(...)` to act and `check(name, await until(expr,
  ms))` to assert. Kill agents you start.

## Releases, signing and the hosted hub
- **Release:** check `npm test` and `npm run e2e` pass, then run `npm run release`. That refuses unless you're on `main`
  and `main` equals `origin/main`.
  - **CI on the push:** pushing `main` runs `ci.yml` (`npm test`). It also runs `package.yml` when packaging files
    changed.
  - **The tag:** the tag runs `release.yml`, which checks:
    - that the tag is on `origin/main`;
    - that the tag equals `v<package.json version>`.

    It then runs `npm ci`, `npm test` and `npm run dist`. `scripts/sign.sh` signs with the certificate, `ditto` makes
    the zip, and `gh release create` publishes it. Its notes are generated from the commits, with
    `docs/release-notes/<version>.md` above them when that file exists: write it before tagging.
  - **Without pushing a tag** (a cloud session can't): bump the version on `main` (`npm version patch`, push `main`),
    then run Release from the Actions page on `main` (`workflow_dispatch`). It releases package.json's version, refuses
    one that's already tagged, and `gh release create --target` makes the tag. A tag made that way doesn't start a
    second run (GitHub doesn't trigger workflows from `GITHUB_TOKEN` events).
  - **Installed copies** check 5 s after launch, every 6 hours, and from the menu's "Check for Updates…".
- **Signing:** releases are signed with a self-signed certificate, "Protoplasma Release Signing" (valid to 2036).
  - **The only copies:** `~/.config/protoplasma-signing/` on David's Mac (`release.p12`, the password, `cert.pem`), and
    the repo secrets `MAC_CERT_P12` (base64) and `MAC_CERT_PASSWORD`.
  - **Never regenerate or replace it.** A copy signed with it only accepts updates signed with the same certificate, so
    a new one strands every installed copy until it's reinstalled with install.sh.
  - **Signing a local build:** run `scripts/sign.sh <app>` for ad hoc. To use the certificate, first export
    `MAC_CERT_P12="$(base64 < ~/.config/protoplasma-signing/release.p12)"` and `MAC_CERT_PASSWORD`.
- **Hosted hub:** Railway project `protoplasma`, service `hub`, region sfo.
  - Built from `main` of `dw8-ro/protoplasma-ide`.
  - Watch patterns: `src/hub.js`, `src/shared.js` and `Dockerfile`. Only pushes touching those redeploy it.
  - A volume at `/data`, with variables `DATA_DIR` and `PROTO_OWNERS`. Don't change `PROTO_OWNERS` without asking
    David.
  - Health check: `/`. URL: `https://hub-production-fba9.up.railway.app`.
  - Hub changes reach installed apps only after this deploy, so push `main` when hub code changed.
- **Install:** the README one-liner (`curl -fsSL https://raw.githubusercontent.com/dw8-ro/protoplasma-ide/main/install.sh | sh`)
  works without signing in, because the repo is public (since 17 Oct 2026).
  install.sh quits a running copy, swaps it via `.old`, and rolls back on failure.

## Conventions
- **Code:** match the surrounding code. Small, direct functions; short comments that say *why*; `ponytail:` on deliberate
  shortcuts. No new dependencies for what a few lines can do.
- **Text people read** (UI, errors, docs): plain sentences in sentence case. Say what happened and what to do next.
  Follow Amoeba's placement and wording for anything that has an Amoeba equivalent.
- **Product decisions:**
  - Teams are permanent: deleting or leaving one happens only in Settings → Team.
  - Real terminals instead of a chat box, and named teams, are kept different from Amoeba on purpose.
- **Workflow:**
  - Keep anything worth rerunning in the repo (`scripts/`), not in a temporary folder.
  - Work in small sections and write findings to files as you go; the usage limit has been hit often.
- **Repo:** public since 17 Oct 2026, so teammates install and update without `gh`. Commits are
  authored as `dw8-ro <61916598+dw8-ro@users.noreply.github.com>`, with no Claude or AI attribution lines (no `Co-Authored-By`, no session links).

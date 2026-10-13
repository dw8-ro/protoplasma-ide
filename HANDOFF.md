# Handoff: Protoplasma IDE, 13 October 2026

Read this first in a new session, then [AGENTS.md](AGENTS.md) for how the code fits together. Everything below is
true as of release **v0.4.2** (commit `f6e19d7`).

## Where things stand

- **Released:** v0.4.2 is published on GitHub Releases (`Protoplasma-0.4.2-mac-arm64.zip`, signed with the project's
  own certificate). Installed copies (0.2.0 and later) pick it up by themselves within a few hours.
- **Hub:** the hosted hub on Railway (`https://hub-production-fba9.up.railway.app`) runs commit `9d8fd0f`, the last
  commit that changed hub code. Railway redeploys a push to `main` only when it touches `src/hub.js`,
  `src/shared.js` or `Dockerfile` (its watch patterns); other pushes show as SKIPPED.
- **Checks on v0.4.2:**
  - `npm test`: 58 of 58 pass.
  - `npm run e2e`: 118 of 118 checks pass.
  - The app builds with `npm run dist`, and the new Package workflow passed on GitHub.
- **Nothing is uncommitted or unpushed.** `main` on GitHub has everything, including this file.
- **Repo:** `dw8-ro/protoplasma-ide`, private. It must stay private until David says otherwise.

## What the last stretch of work did

### 1. A full recheck of 0.4.1
The whole app was rechecked in 16 sections, one at a time, without fixing anything yet.
- **Sections:** the hub (API, then live), agents, worktrees, the main process, teams/GitHub/updates, the code view
  (files, then editor), the screens in four parts, markup and CSS, release tooling, and two live runs in the playground
  (one person, then two).
- **Result:** 196 problems after merging duplicates (2 high, 32 medium, 162 low), plus 8 questions that need a decision.
- **Records:** everything is in [docs/recheck/](docs/recheck/).
  - `COMPILED.md`: the full ranked list, with item numbers C1 to C196 and decisions D1 to D8.
  - `FIXLOG.md`: what each fix batch did.
  - `sections/`: the raw findings and evidence from each section.
  - `INSTRUCTIONS.md`: the method, reusable for the next recheck.
  - Line numbers in those files are from 0.4.1 and have moved since; search by function name instead.

### 2. Fixes in seven batches
Tests ran after each batch, and each batch is one commit:

| Commit | Batch | Main changes |
|---|---|---|
| `f82a38b` | A: hub | Bad WebSocket frames and resets no longer crash the hub. Session/team names made only of dots are refused (a session named `..` used to turn "Delete session" into "delete the team"). Sockets can send at most 1 MB before sign-in. Malformed tokens are refused without asking GitHub. The push guard understands quoting, `bash -lc`, `eval` and `ssh`. The shell-write check only flags real writes. `teams.json` is validated. Members are included in `state`. |
| `80a396b` | B: agents and session folders | git status uses `-z`. Lanes ping every 20 s. Trust-prompt detection needs the question and both answers. A session folder holding ignored files that aren't build output (like `.env`) is kept, not deleted. Two agents starting one session share one folder. A renamed default branch is found again. The pre-push hook is written atomically. |
| `dd7d174` | C: main process, teams, GitHub, updates | The single-instance lock comes first. The agent login-shell environment has a hard time limit. Sign-out stops hosting, shells and folders. GitHub and hub calls time out. Clones go into `.partial` first. Team keys are `where\|id`. Updates check the signer and bundle id, and the swap logs to `~/Library/Logs/Protoplasma-update.log`. SIGTERM quits without the dialog. |
| `a132b61` | D: code view | Subfolder sessions work (`prefix`). Reads and writes are confined to the session folder, symlinks included. Find in files uses `grep -z`. Commit & Push commits only the folder (`add -A -- .`) and refuses during a conflict or on a detached HEAD. Unsaved edits are kept when you switch files. |
| `23a8af5` | E: screens and panes | Watching an agent no longer types your terminal's replies into it. Session aliases are followed after renames. Notifications skip agents already on screen. Keyboard access throughout. Deleted teams stop their agents. |
| `d13e370` | F: markup and styles | Contrast (`--faint`), focus outlines, ARIA tabs, `<bdi>` around paths. The in-app privacy text now says what the hub really relays. |
| `9d8fd0f` | G: tooling, tests, docs | The playground control API needs a token. e2e has a 15-minute limit and an unexpected-alert check, and cleans up. Releases only ship commits on `main`. A Package workflow builds the app. `install.sh` replaces a running copy. Tests use an isolated git config and clean up. The README matches the code. |

193 of the 196 items are fixed. The rest are listed below.

## Still open

### Needs David's decision
These are written up in full, with options, in `docs/recheck/COMPILED.md` under "Needs a decision". The recommendation
is the one proposed to David; he hasn't chosen yet.

| # | Question | Today | Recommended |
|---|---|---|---|
| D1 | Teams store members by GitHub login. If an account is renamed, someone else can claim the old login and be let in as that member, or as the owner. | Logins are stored, and the hub never checks an invite against GitHub. | Store GitHub's numeric user id next to the login and match on the id, migrating `teams.json` on first sign-in. |
| D2 | Teams hosted on a Mac (`http://<ip>:<port>`) receive the GitHub token in clear text, readable by anyone on the same Wi-Fi. | Clear text for "This Mac" and nearby teams. The hosted hub uses https. | After one verified sign-in, the hub issues its own short-lived token, and the app sends only that afterwards. |
| D3 | The hub inside the app listens on every network interface, even with "Look for teams on this network" off. | It binds to `0.0.0.0`. | Bind to `127.0.0.1` until the user shares the team. |
| D4 | The push guard protects only `main` and `master`, and doesn't stop branch deletions (`git push origin :their-branch`). | `main` and `master` only. | Also protect the branch `origin/HEAD` points at, and block deleting any branch except the agent's own `session/*`. |
| D5 | `git push --no-verify` skips the pre-push guard for Codex and OpenCode. | Allowed. The hint in the hook was removed, but the README still says the hook "stops" them. | Accept it, call it a safeguard in the README, and turn on GitHub branch protection for `main`. |
| D6 | When a system notification should fire. | Already done as option (a): no notification for an agent visible in a pane while the window is focused. | Keep, unless David wants it changed. |
| D7 (C129) | A Codex or OpenCode agent started while a team has no other members never gets the push guard, even after someone is invited (`PROTO_SHARED_TEAM` is fixed when it starts). | Not done. | Say so when inviting ("agents already running aren't guarded until restarted"). |
| D8 | Everyone in a session shares one `session/<slug>` branch, so two people's Commit & Push can collide. | Commit & Push refuses, and tells them to pull in the Terminal tab. | Keep the shared branch, and add a "Pull" button to that message. |

### Known and left alone on purpose
- **C44:** inviting a login with an underscore is refused. Only GitHub Enterprise Managed Users have such logins, and they
  can't use the public device-flow sign-in anyway.
- **C157:** after switching theme, terminal output already on screen keeps the old colours until it's redrawn.
- **Part of C151:** there's no automatic retry when Monaco fails to load, because its AMD loader caches the failure. The
  code view now explains the failure instead.
- **Test gaps** (C107, C109 to C111): the key cases were added, but much of the live hub isn't covered yet. Examples:
  hello validation, size clamps, the slow-viewer drop, the file-relay timeout, PermissionRequest/Stop hooks, and the
  15-file cap. So are `files.js` list/search/watch, and `updates.js` latestRelease/stage/sameSigner/swap.sh. The full
  lists are in those items.

### Found while writing this handoff (after the recheck)
Mapping the code for AGENTS.md turned up these. None are fixed yet.

| # | Where | Problem |
|---|---|---|
| N1 | app/files.js `write` | The parent folders are created (`mkdirSync`) before the folder-boundary check. So saving `link-to-outside/newdir/x.js` creates `newdir` outside the session folder, although the file write itself is refused. |
| N2 | app/updates.js swap.sh, app/main.js `updates:install` | swap.sh gives up if the app hasn't quit within about an hour, and leaves its ~150 MB download behind. `staging` stays resolved in main, so pressing Update again just quits without staging, and the update is lost until the next launch's check. |
| N3 | app/teams.js `stopHosting` | Signing out while the This Mac hub is still starting leaves that hub running for the signed-out user. A later `hostHere` then starts a second hub on the same data folder. |
| N4 | app/renderer.js `renderTeamList` | The team list is filled with `innerHTML` but cleared with `setHTML` at sign-out. From the second sign-out on, the clear is skipped, so the previous person's teams flash up at the next sign-in, and clicking one throws. |
| N5 | src/lane.js `connect` | On every reconnect the lane re-sends its own last status. After a folder-trust prompt has been answered, that's "idle", which overwrites the hook-driven "working" until the next hook. |
| N6 | app/main.js `startLane` | An agent in the user's own folder (`cwd`) counts as guarded, so no "not guarded" notice is shown, although no push guard is installed there. |
| N7 | src/hub.js `partsOf` | A here-string (`<<<word`) or arithmetic like `$((1<<2))` is taken for a heredoc. Every following line is then skipped, so a push or write later in the same command is missed. |
| N8 | src/hub.js session rename | Renaming a session doesn't update watchers' presence until each app sends a new `look`. |
| N9 | app/renderer.js `pending` | Output for a local agent that has no terminal yet is buffered without limit. This happens, for example, when you switch team while it starts. |
| N10 | src/hub.js `lanAddresses`, scripts/icon.js | Small leftovers: an unused export, and a temp iconset folder that is never removed. |
| N11 | docs/*.png, docs/demo.gif | The README images predate 0.4.0 (pane mode, plans, Conflicts). Regenerate them with `npm run screenshot` and `npm run demo`. |
| N12 | updates (behaviour) | While the repo is private, installed copies only update when the user's `gh` is signed in with access to it. The README now says so; making the repo public, or another download route, would remove the requirement. |

## Rules from David that still apply
- Keep the repo private.
- Never accept a Claude Code folder-trust prompt for him, and never enter passwords or handle credentials.
- Don't invite real people to teams. Max is a placeholder until David gives his GitHub username.
- Don't change the Railway `PROTO_OWNERS` variable without asking.
- Never regenerate or replace the release signing certificate. See "Releases" in AGENTS.md.
- The layout and wording follow Amoeba (useamoeba.com), so people coming from it understand Protoplasma at once. Teams
  are permanent: deleting or leaving one happens only in Settings → Team.
- The usage limit has been hit often. Work in small sections, write findings to files as you go, and use few subagents.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Suggested next steps
0. **Start here.** The last session ended before a final check could finish, to stay within the weekly usage limit.
   - N1 to N12 above were found by reading the code only. Confirm or refute each one before fixing it.
   - AGENTS.md was written from careful readings of every file, but its claims haven't been checked against the code
     by a second pass. Where it and the code disagree, the code wins: fix AGENTS.md.
1. Get David's choices on D1 to D8, then implement them. D2, D3 and D4 are the security-relevant ones.
2. Fill the test gaps above, starting with the hub's live side.
3. Release with `npm run release` (see AGENTS.md). Push `main` first if hub code changed, so the hosted hub matches.

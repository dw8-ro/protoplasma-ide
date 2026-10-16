# Handoff: Protoplasma IDE, 16 October 2026

Read this first in a new session, then [AGENTS.md](AGENTS.md) for how the code fits together.

## Where things stand

- **Released: v0.5.1** (16 Oct 2026, commit `7e96090`): signed, `Protoplasma-0.5.1-mac-arm64.zip`, notes from
  `docs/release-notes/0.5.1.md` (the F1 Force Quit advice first). Made with Actions → Release → Run workflow, because the
  cloud session can't push tags; the release created the tag. Installed copies see it within about 6 hours.
- **Before that: v0.5.0** (commit `2779b8b`), with N1–N10 and D1–D8. It's signed with the project's certificate, and its
  release notes say Mac-hosted teams need everyone on 0.5. Installed copies see it within about 6 hours, where the
  user's `gh` can see the private repo.
- **After 0.5.0 (on `main` locally, not pushed or released yet):** a customer simulation of 0.5.0
  ([docs/usage-test/REPORT.md](docs/usage-test/REPORT.md)), the fixes for its six findings, N11 and N12, and more
  tests (`3033f93` to `c72f427`).
  - **F1 matters most:** in 0.4.x and 0.5.0, Quit, Update now and logging out close the window but leave the app
    running, so it can't be reopened. Users on those versions finish an update by force-quitting it (then it
    installs). 0.5.1 fixes it and says so in its notes.
- **0.5.1 prepared (16 Oct 2026), for Max, who uses Codex:** checked against a real Codex CLI (0.163) in a cloud
  session. Three fixes: Codex's "Trust this folder?" ("Trust and continue" / "Back to Agent Command Center") now shows
  as needs you (`ANSWERS` in lane.js, test in hub.test.js); Add agent falls back to an installed agent when the
  preferred one (Claude Code by default) isn't installed (`defaultAgent` in renderer.js); and `hubApi` retries once on
  a reset kept-alive connection, which this Mac's hub closes when it moves to the network at an invite (lan.test.js
  caught it on Linux). The README installs with `curl` (the repo is going public), and release.yml puts
  `docs/release-notes/<version>.md` above the generated notes; 0.5.1's carries the F1 Force Quit advice.
  - CI on the 0.5.1 commit failed once: two hub tests leaned on when the agents' first git report (about 5 s in) landed.
    The setup now waits for it, and the typing test sends a presence change that always gets a state back.
  - Checked on Linux only: `npm test` 79 of 79. e2e and the customer simulation need a Mac and weren't rerun.
  - Codex passes `PROTO_SHARED_TEAM` through to its commands (it only filters names with KEY, SECRET or TOKEN), so the
    pre-push guard works for it. `codex resume --last` still exists.
- **README redesigned for going public (16 Oct 2026):** new images in `docs/readme/`, each in a dark and a light version
  that GitHub picks with `<picture>`. A hero and five feature shots (agents, overlap, code, sessions, start) are real
  crops of `docs/*.png` over a soft glow of the two people's colours (`npm run readme-art`, pages in
  `scripts/readme-art/`). There's a how-it-works SVG (`readme-art/diagram.js`), and the demo GIF is framed the same way
  (`scripts/gif.js`, used by `npm run demo`). The direction was picked by a small design panel; the README text was
  reviewed for accuracy, GitHub rendering and polish. Re-run `npm run screenshot`, `npm run readme-art` and
  `npm run demo` together when the UI changes.
- **0.5.2 (16 Oct 2026): Claude Code's hooks reach hubs on a Mac again.** Since 0.5.0 (D2) a hub on a Mac serves
  https with a self-signed certificate, which the app pins but Claude Code's HTTP hooks can't. On teams hosted on a Mac
  every Claude hook failed open: no team context, no ask before a conflicting edit or a risky push, and the status stuck
  at Idle. Found by the README review. Fixed with a loopback relay (teams.js `hookRelay`, main.js `hookTarget`, lane.js
  `hookBase`), tested in lan.test.js and with the real `claude` 2.1.301 against a TLS hub (status went working with the
  relay, stayed idle without). Teams on the online hub were never affected. e2e doesn't send a hook to a Mac hub yet.
- **Hub:** the hosted hub on Railway (`https://hub-production-fba9.up.railway.app`) runs `17f747e`: D1 ids, D2 passes
  (`/passes`, `/hubs`) and D4. Nothing since then touches `src/hub.js`, so pushing doesn't redeploy it.
- **Checks on `c72f427`:**
  - `npm test`: 78 of 78.
  - `npm run e2e`: 126 of 126. It now ends by quitting through the real quit path, and fails if the app doesn't exit.
  - The customer simulation (`scripts/customer`, against `npm run playground`): 91 of 91.
- **Repo:** `dw8-ro/protoplasma-ide`. On 16 Oct 2026 David decided to make it public so Max can install it; he flips
  the setting himself (no tool here can). Until it's public, people need `gh` signed in with access to install and
  update, and "Report a problem" opens a page they can't see. Commit metadata shows David's email once it's public.

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
| `f82a38b` | A: hub | Bad WebSocket frames and resets no longer crash the hub. Session names made only of dots are refused (a session named `..` used to turn "Delete session" into "delete the team"). Sockets can send at most 1 MB before sign-in. Malformed tokens are refused without asking GitHub. The push guard understands quoting, `bash -lc`, `eval` and `ssh`. The shell-write check only flags real writes. `teams.json` is validated. Members are included in `state`. |
| `80a396b` | B: agents and session folders | git status uses `-z`. Lanes ping every 20 s. Trust-prompt detection needs the question and both answers. A session folder holding ignored files that aren't build output (like `.env`) is kept, not deleted. Two agents starting one session share one folder. A renamed default branch is found again. The pre-push hook is written atomically. |
| `dd7d174` | C: main process, teams, GitHub, updates | The single-instance lock comes first. The agent login-shell environment has a hard time limit. Sign-out stops hosting, shells and folders. GitHub and hub calls time out. Clones go into `.partial` first. Team keys are `where\|id`. Updates check the signer and bundle id, and the swap logs to `~/Library/Logs/Protoplasma-update.log`. SIGTERM quits without the dialog. |
| `a132b61` | D: code view | Subfolder sessions work (`prefix`). Reads and writes are confined to the session folder, symlinks included. Find in files uses `grep -z`. Commit & Push commits only the folder (`add -A -- .`) and refuses during a conflict or on a detached HEAD. Unsaved edits parked for a deleted session folder are dropped, so they no longer block quitting, and saving a deleted file recreates its folder. Also a 3-line hub change. |
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
| D1 | Teams store members by GitHub login. If an account is renamed, someone else can claim the old login and be let in as that member, or as the owner. | Logins are stored, and the hub never checks an invite against GitHub. | **Done (15 Oct 2026, David's choice).** `team.ids` holds each person's GitHub id, recorded at invite (the app sends it) or at their first sign-in for older teams; `onTeam` matches on it and follows renames. Tests in test/identity.test.js. Hosted hub: the ids fill in as people sign in after the deploy. |
| D2 | Teams hosted on a Mac used to receive the GitHub token in clear text, readable by anyone on the same Wi-Fi, and the hosting Mac itself got everyone's token. | **Done (15 Oct 2026), David asked for a fix that keeps teams on local networks.** Mac hubs serve https/wss with a self-signed certificate. Other Macs pin the certificate they're shown and sign in with a 12-hour pass from the online hub, bound to that certificate (`signPass`/`readPass`, `access` in teams.js). The GitHub token only goes to the online hub and the owner's own hub. Passes are only issued for certificates their owner registered (`POST /hubs`), and only that owner's teams are listed from the hub. Tests in test/lan.test.js, plus e2e. **Needs the online hub redeployed** (push `main`) before teams on other Macs work. Mixed versions can't reach each other's Mac hubs. | (decided) |
| D3 | The hub inside the app listened on every network interface, even with "Look for teams on this network" off. | **Done (15 Oct 2026, the recommendation).** It listens on `127.0.0.1` until one of its teams has someone besides the owner, then moves to the network on the same port (`listenOn`, open connections kept) and is advertised. It stays shared until the app restarts. Tests in lan.test.js and e2e. | (decided) |
| D4 | The push guard protected only `main` and `master`, and didn't stop most branch deletions (`git push origin :their-branch`). | **Done (15 Oct 2026).** The default branch (`origin/HEAD`) is protected like main, in the hub (`mainBranch` from lane.js) and in the pre-push hook. Agents on a shared team can't delete any remote branch without a person: Claude is asked, and Codex/OpenCode are stopped. That's stricter than the recommendation, because a session branch is shared by everyone in the session (D8), so deleting "your own" can lose a teammate's work. Existing clones get the new hook at their next session start. | (decided) |
| D5 | `git push --no-verify` skips the pre-push guard for Codex and OpenCode. | **Done (15 Oct 2026): accepted.** The README calls the guard a safeguard, not a lock, and suggests protecting `main` on GitHub when a team needs a guarantee. GitHub branch protection wasn't turned on for this repo: agents push with David's own account, which as admin bypasses it, and private repos need a paid plan for it. | (decided) |
| D6 | When a system notification should fire. | **Kept (15 Oct 2026):** option (a), no notification for an agent visible in a pane while the window is focused. | (decided) |
| D7 (C129) | A Codex or OpenCode agent started while a team has no other members never gets the push guard, even after someone is invited (`PROTO_SHARED_TEAM` is fixed when it starts). | **Done (15 Oct 2026, the recommendation).** Inviting someone says how many of your Codex/OpenCode agents in that team aren't push-guarded, and to restart them (`teams:invite`, `lane.unguarded`). | (decided) |
| D8 | Everyone in a session shares one `session/<slug>` branch, so two people's Commit & Push can collide. | **Done (15 Oct 2026, the recommendation).** The shared branch stays. When you both changed the same lines, the code view shows **Pull**: it merges their work (files.js `pull`), the clashing files are marked C, and after you fix them in the editor Commit & Push finishes the merge and pushes (`finishMerge`). Tests in files.test.js and e2e. | (decided) |

### Known and left alone on purpose
- **C44:** inviting a login with an underscore is refused. Only GitHub Enterprise Managed Users have such logins, and they
  can't use the public device-flow sign-in anyway.
- **C157:** after switching theme, terminal output already on screen keeps the old colours until it's redrawn.
- **Part of C151:** there's no automatic retry when Monaco fails to load, because its AMD loader caches the failure. The
  code view now explains the failure instead.
- **Test gaps** (C107, C109 to C111): most are now covered (hub-live.test.js: hello validation, size clamps, hook
  states, the 15-file cap, the stopped-agents cap; files.test.js: list and search; updates.test.js: no access vs no
  releases). Still not: the slow-viewer drop, the file-relay timeout (10 s), `files.js` watch, and `updates.js`
  stage/sameSigner/swap.sh (they need a signed app to swap).

### Found while writing this handoff (after the recheck)
Mapping the code for AGENTS.md turned up these, and a second pass checked each one. Rows marked **Fixed** are done (see `git log`). They're all
low severity.

| # | Checked | Where | Problem | Fix |
|---|---|---|---|---|
| N1 | **Fixed** (test in files.test.js) | app/files.js `write` | Missing parent folders are created (`mkdirSync`) before the real-path check. Saving `link-to-outside/a/b/x.js` therefore leaves empty folders `a/b` outside the session folder, although the file write is refused. It's hard to reach from the UI. | Before `mkdirSync`, run `inside()` on the nearest existing ancestor of the target. |
| N2 | **Fixed** (the limit is gone) | app/updates.js swap.sh, app/main.js `updates:install` | If the quit after Update now is cancelled (agents running) and the app stays open for over an hour, swap.sh gives up and leaves its temp folder (about 500 MB) behind. The bar still says the update goes in at quit, but quitting installs nothing; the next launch offers it again. | Drop the one-hour limit in swap.sh, or on giving up remove the folder and reset `staging` in main and `staged` in the renderer. |
| N3 | **Fixed** | app/teams.js `stopHosting` | Signing out while the This Mac hub is still starting leaves it running and advertised as the signed-out user's. A later local team then starts a second hub on the same data folder, and the two overwrite each other's teams.json. The window is milliseconds. | In `stopHosting`, first `await` any start under way, then read and clear `local`. |
| N4 | **Fixed** | app/renderer.js `renderTeamList` | The team list is drawn with `innerHTML` but cleared at sign-out with `setHTML`, whose cache never sees the redraws. From the second sign-out on, the clear is skipped: the previous account's teams show at the next sign-in until the new list arrives, and clicking one throws. | Draw the list with `setHTML` and drop `renderTeamList.last`. |
| N5 | **Fixed** (test in hub.test.js) | src/lane.js `connect` | After a Claude agent's trust prompt has been answered, every reconnect re-sends "idle". That overwrites "working" until the next hook, and "needs you" (a pending permission) until someone answers, so that alert disappears. | Re-send the status only when it's live: `if (activity && (byActivity \|\| asking))`. |
| N6 | **Fixed** (e2e checks the notice) | app/main.js `startLane` | A Codex or OpenCode agent in the user's own folder, on a team with members, counts as guarded. No "not guarded" notice is shown, although no pre-push guard is installed there. Claude agents are covered by the hub either way. | Return `guarded: false` for a folder the user picked, and word the notice for that case. |
| N7 | **Fixed** (tests in hub.test.js) | src/hub.js `partsOf` | A here-string (`<<<word`) or arithmetic shift (`$((1<<2))`) is taken for a heredoc, and every following line is skipped until one equals that word. A push or write on a later line of the same command isn't checked; one on the same line still is. | Skip `<<<`, and don't treat `<<` inside `$((` as a heredoc. |
| N9 | **Fixed** | app/renderer.js `pending` | Output for a local agent that has no terminal yet is buffered without limit, e.g. when you switch team while it starts, until you go back or it exits. | Cap the buffer like `tails` (keep the last 1,000,000 characters). |
| N10 | **Fixed** | src/hub.js `lanAddresses`, scripts/icon.js | `lanAddresses` is exported but unused (and is the only user of hub.js's `os` import). icon.js leaves its temp iconset folder behind. | Delete them; remove the folder after `iconutil`. |
| N11 | **Fixed** (regenerated 15 Oct 2026) | docs/*.png, docs/demo.gif | The README images were made on 2026-10-05, before 0.4.0's pane mode, plans, code comments and Conflicts. | `npm run screenshot` and `npm run demo`, then commit. |
| N12 | **Fixed (the message)**: a login that can't see the repo is told so; going public is still David's call | app/updates.js | While the repo is private, installed copies find and download updates only through a `gh` signed in with access. Without gh they say "Couldn't reach GitHub"; signed in without access they wrongly say "No releases yet". The README says gh is needed. | Make the repo public (David's call), or map gh's 404 to "no access to the release repo". |

N8 (renaming a session leaves teammates' presence on the old name) was refuted: each app follows the rename and sends a
new `look` straight away, so presence is right again within one round trip.

## Rules from David that still apply
- The repo goes public (David's decision, 16 Oct 2026); he changes the setting himself.
- Never accept a Claude Code folder-trust prompt for him, and never enter passwords or handle credentials.
- Don't invite real people to teams. Max is a placeholder until David gives his GitHub username.
- Don't change the Railway `PROTO_OWNERS` variable without asking.
- Never regenerate or replace the release signing certificate. See "Releases" in AGENTS.md.
- The layout and wording follow Amoeba (useamoeba.com), so people coming from it understand Protoplasma at once. Teams
  are permanent: deleting or leaving one happens only in Settings → Team.
- The usage limit has been hit often. Work in small sections, write findings to files as you go, and use few subagents.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Suggested next steps
1. ~~Release 0.5.1~~ (done, 16 Oct 2026).
2. David makes the repo public (Settings → Danger Zone → Change visibility), then: check
   `curl -fsSL https://raw.githubusercontent.com/dw8-ro/protoplasma-ide/main/install.sh` and the release zip download
   without signing in, and install once on a Mac. Then Max installs (he uses Codex) and David invites his GitHub login.
3. The remaining test gaps: the slow-viewer drop, the file-relay timeout, `files.js` watch, `updates.js`
   stage/sameSigner/swap.sh.
4. Codex and OpenCode have no hooks, so no overlap warnings or file notes for them (lane.js TODO).

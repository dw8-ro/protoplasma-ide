# Handoff: Protoplasma IDE, 27 October 2026

Read this first in a new session, then [AGENTS.md](AGENTS.md) for how the code fits together. What the last sessions
did: [docs/sessions/2026-10-26.md](docs/sessions/2026-10-26.md) (19–26 Oct) and
[docs/sessions/2026-10-18.md](docs/sessions/2026-10-18.md) (the security audit).

## Where things stand

- **Latest release: v0.5.6** (28 Oct 2026, `cfef8e4`): Invite people on the People page, and Electron 44.10.0.
  Signed, `Protoplasma-0.5.6-mac-arm64.zip`, made with `npm run release`; its Release run is green.
- **v0.5.5** (26 Oct 2026, `5c9632c`), a security follow-up:
  - the hub caps more DoS vectors (path length, per-socket look/replay budget, HTTP timeouts);
  - the push guard catches git run through an inline alias, and the pre-push hook refuses deleting a shared tag;
  - only the person at the agent's Mac can answer its folder-trust prompt;
  - the window clamps hub-sent terminal sizes and survives a malformed `state` frame;
  - Commit & Push times out after 15 minutes.

  Its Release, Package and CI runs are green.
- **On `main`, not released:** `f8bdabb` (26 Oct) adds an "Invite people" section to the People page and removes
  Reload and Toggle Developer Tools from the View menu, also in source runs. CI is green. Releasing it needs
  `docs/release-notes/0.5.6.md` first.
- **v0.5.4** (19 Oct, `6d4d12a`): updates download with a percentage, the app reopens before the old copy is cleaned
  up, and a swap that fails halfway always restores the old app. updates.test.js covers stage, sameSigner and swap.sh.
- **v0.5.3** (18 Oct, `f8d61ac`): the security audit after going public. About 30 fixes, several medium, none
  critical:
  - a team on another Mac must still be its owner's hub at every connection (`access(s, url, owner)`, `vouched`);
  - shared files are checked against the agent's own git report, never a link, never an untracked file older than the
    agent (`code:readLane`);
  - new agents send no PostToolUse hook;
  - a session's repo comes only from its creator's or the owner's agent (`repoBy`);
  - "Show in Finder" selects a clone instead of opening it;
  - hub limits on unseen-token lookups, agents, sessions and file requests;
  - `h-` lane ids made from the hook secret;
  - Electron 44.8.0.

  The audit found no secret in any public ref.
- **Electron 44.10.0** (`~44.10.0`, 27 Oct). 44.9.0 made Chromium refuse the This Mac hub's pinned certificate (e2e
  "creates a This Mac team…", net_error -202). On 44.10.0 the same flow connects: a run of just that e2e step (with
  `teams.isPinned` logged) went live in three of four runs; the first printed nothing,
  most likely the new binary's first launch. The full e2e result is below. Why 44.9.0 failed wasn't found.
- **Known and left (from the audit):**
  - teammates' notes, goals and file names reach agents' prompts (prompt injection by a teammate);
  - git filter drivers in a downloaded folder's own `.git/config` still run when the app reads its status;
  - during a flood of made-up tokens, new sign-ins wait;
  - session-name aliases can be claimed by renames;
  - 2 low DOMPurify advisories in Monaco;
  - `allowScripts` in package.json isn't enforced (see AGENTS.md).
- **Playground `--real`** (23 Oct): `npm run playground -- --real` runs the installed Claude Code, Codex and OpenCode
  in `~/Protoplasma-sim`, signed in as David. Each new session stops at its folder-trust prompt, which is his to
  answer. `scripts/customer/act.js` and `observe.js` drive and watch it from a shell.
- **Hub:** the hosted hub on Railway (`https://hub-production-fba9.up.railway.app`) redeploys on pushes to `main` that
  touch `src/hub.js`. The last one is `8df2f17` (0.5.5). It still accepts apps before 0.5.3.
- **Repo and GitHub:** `dw8-ro/protoplasma-ide`, public since 17 Oct. On 27 Oct, `main` = `origin/main` = `f8bdabb`.
  Secret scanning, push protection, Dependabot alerts and private vulnerability reporting are on. Since 27 Oct, a
  ruleset ("Protect main") blocks force pushes to and deletion of the default branch, and workflows from every outside
  contributor need approval. Default workflow permissions are read-only.
- **History rewritten (17 Oct, David's choice):** every commit on `main` is by `dw8-ro` with GitHub's private address,
  with no AI lines. The tags were moved to the rewritten commits. GitHub still serves the old commits to anyone who has
  their IDs; only GitHub Support can purge them sooner. David's own checkout needs
  `git fetch origin && git reset --hard origin/main` once, if not done.
- **0.5.6's tests** (`docs/release-notes/0.5.6.md` has its notes): the new tests
  cover the slow-viewer drop, the file-relay timeout and `files.js` watch.
- **Checks on 27 Oct** (Electron 44.10.0, before committing):
  - `npm test`: 97 of 97.
  - `npm run e2e`: 126 of 126.
  - The customer simulation: 91 of 91 on a fresh playground. The first run, straight after Electron was downloaded,
    failed scenario 7 (Max didn't find David's team over Bonjour); on 44.8.0 and then again on 44.10.0 it passed.
- **Not checked yet:**
  - the README one-liner hasn't been tried on a real Mac;
  - two physical Macs sharing a Mac-hosted team hasn't been tried.
- **Earlier releases:**
  - **0.5.2** (`b05602d`): the loopback hook relay for hubs on a Mac (teams.js `hookRelay`), and the README redesign
    (`docs/readme/`, `npm run readme-art`).
  - **0.5.1** (`d2d5379`): Codex's trust prompt, an installed-agent fallback, and the customer simulation's fixes,
    including F1 (Quit, Update now and logging out left 0.4.x/0.5.0 running).
  - **0.5.0** (`abc1b9a`): N1–N10 and D1–D8.

## Earlier: the 0.4.1 recheck and its fixes

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
| `746f2a0` | A: hub | Bad WebSocket frames and resets no longer crash the hub. Session names made only of dots are refused (a session named `..` used to turn "Delete session" into "delete the team"). Sockets can send at most 1 MB before sign-in. Malformed tokens are refused without asking GitHub. The push guard understands quoting, `bash -lc`, `eval` and `ssh`. The shell-write check only flags real writes. `teams.json` is validated. Members are included in `state`. |
| `2f4403b` | B: agents and session folders | git status uses `-z`. Lanes ping every 20 s. Trust-prompt detection needs the question and both answers. A session folder holding ignored files that aren't build output (like `.env`) is kept, not deleted. Two agents starting one session share one folder. A renamed default branch is found again. The pre-push hook is written atomically. |
| `e7ba1bf` | C: main process, teams, GitHub, updates | The single-instance lock comes first. The agent login-shell environment has a hard time limit. Sign-out stops hosting, shells and folders. GitHub and hub calls time out. Clones go into `.partial` first. Team keys are `where\|id`. Updates check the signer and bundle id, and the swap logs to `~/Library/Logs/Protoplasma-update.log`. SIGTERM quits without the dialog. |
| `2243974` | D: code view | Subfolder sessions work (`prefix`). Reads and writes are confined to the session folder, symlinks included. Find in files uses `grep -z`. Commit & Push commits only the folder (`add -A -- .`) and refuses during a conflict or on a detached HEAD. Unsaved edits parked for a deleted session folder are dropped, so they no longer block quitting, and saving a deleted file recreates its folder. Also a 3-line hub change. |
| `cd1d970` | E: screens and panes | Watching an agent no longer types your terminal's replies into it. Session aliases are followed after renames. Notifications skip agents already on screen. Keyboard access throughout. Deleted teams stop their agents. |
| `8e44014` | F: markup and styles | Contrast (`--faint`), focus outlines, ARIA tabs, `<bdi>` around paths. The in-app privacy text now says what the hub really relays. |
| `4b76354` | G: tooling, tests, docs | The playground control API needs a token. e2e has a 15-minute limit and an unexpected-alert check, and cleans up. Releases only ship commits on `main`. A Package workflow builds the app. `install.sh` replaces a running copy. Tests use an isolated git config and clean up. The README matches the code. |

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
- **Test gaps** (C107, C109 to C111): all covered now (hub-live.test.js: hello validation, size clamps, hook states,
  the 15-file cap, the stopped-agents cap, the file-relay timeout, the slow-viewer drop; files.test.js: list, search
  and watch; updates.test.js: no access vs no releases; stage, sameSigner and swap.sh with a stand-in app).

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
| N12 | **Fixed (the message)**: a login that can't see the repo is told so; the repo is public since 17 Oct 2026 | app/updates.js | While the repo is private, installed copies find and download updates only through a `gh` signed in with access. Without gh they say "Couldn't reach GitHub"; signed in without access they wrongly say "No releases yet". The README says gh is needed. | Make the repo public (David's call), or map gh's 404 to "no access to the release repo". |

N8 (renaming a session leaves teammates' presence on the old name) was refuted: each app follows the rename and sends a
new `look` straight away, so presence is right again within one round trip.

## Rules from David that still apply
- The repo is public (since 17 Oct 2026).
- Never accept a Claude Code folder-trust prompt for him, and never enter passwords or handle credentials.
- Don't invite real people to teams. Max is a placeholder until David gives his GitHub username.
- Don't change the Railway `PROTO_OWNERS` variable without asking.
- Never regenerate or replace the release signing certificate. See "Releases" in AGENTS.md.
- The layout and wording follow Amoeba (useamoeba.com), so people coming from it understand Protoplasma at once. Teams
  are permanent: deleting or leaving one happens only in Settings → Team.
- The usage limit has been hit often. Work in small sections, write findings to files as you go, and use few subagents.
- Commits are authored as `dw8-ro <61916598+dw8-ro@users.noreply.github.com>`, with no Claude or AI attribution lines
  (no `Co-Authored-By`, no session links).


## Suggested next steps
1. **Dependabot alerts (10 open on 28 Oct):**
   - dompurify (1 critical, 1 high, 3 low) comes from monaco-editor 0.57.0, which bundles its own copy into
     `min/vs`. Overriding the npm package won't change what the app loads; it needs a Monaco release with a newer
     DOMPurify.
   - undici (4 high, 1 medium) is a dev dependency of @electron/packager (via @electron/get) and isn't shipped.
     `npm update` or an override fixes it.
2. **First real install:** the README one-liner on a real Mac, then Max installs (he uses Codex), David invites his
   GitHub login, and two physical Macs share a Mac-hosted team.
3. **On David's GitHub account:** "Keep my email addresses private" and "Block command line pushes that expose my
   email".
4. **Codex and OpenCode have no hooks**, so no overlap warnings or file notes for them (lane.js TODO). Neither CLI is
   installed on David's Mac, so this needs one installed to build and check against.
5. Why Electron 44.9.0 refused the This Mac hub's certificate wasn't found; if a later Electron breaks it again, start
   from e2e's "creates a This Mac team…" step with `teams.isPinned`'s host and result logged.

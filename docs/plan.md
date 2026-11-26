# Plan, from 14 Nov 2026

Where Protoplasma is heading and what to do next, in order. The evidence is in
[docs/research/2026-11-14-market-agents-and-ux.md](research/2026-11-14-market-agents-and-ux.md); the R and U numbers
below are its. Update this file as phases finish. David approves each phase first.

**Where it stands (25 Nov 2026):** phases 1 to 5 are built (all but line ranges in phase 5 and OpenCode 2), reviewed
independently and ready to release as 0.7.0 ([sessions/2026-11-25-review.md](sessions/2026-11-25-review.md)). What
stands between 0.7.0 and a 1.0 that anyone can install and rely on is in **Road to 1.0** below.

## Direction

Protoplasma stays the thin layer: real agent CLIs in real terminals, on each person's own Mac and accounts, with a
hub that makes agents aware of each other. It doesn't become an editor, a chat window, its own agent or a model
reseller, which is where Amoeba and Zed are going.

What nobody else found does, and so what to make excellent:
1. Every agent knows what teammates' agents changed, before each prompt.
2. A person is asked before two agents edit the same file, and before a risky push.
3. It works across Claude Code and Codex today, and should across any CLI.
4. A team can run it on its own Wi-Fi, with nothing kept on a server.

Two things decide whether people stay: the status of each agent has to be true, and the first five minutes have to
be easy. Phases 1 and 3 are those.

## Phases

### 1. Status you can trust, and less sent to the hub (small, first)
**Built on 15 Nov 2026, not released.** Everything below is in, with tests (`npm test` 112 of 112). What it still
needs: the live checks in [first-install.md](first-install.md) ("Status tells the truth"), then a push of `main`
(the hub changed) and a release, both David's call. Notes for the release are in
[release-notes/0.7.0.md](release-notes/0.7.0.md).

How R2 and R4 were done: no hook reports an interrupt or an answered permission, so after a person's Enter, Esc,
Ctrl-C or digit the agent's Mac watches its screen for 2.5 s and tells the hub whether it kept printing (lane.js
`decided`, hub.js `key`).

- R1: keep `hooked` when an agent reconnects.
- R2: an interrupted agent goes Idle (Codex's `Interrupt` hook; for Claude Code, Esc or Ctrl-C followed by quiet).
- R3, R5: a question from the agent shows as Needs you (`AskUserQuestion`, `ExitPlanMode`, Codex's
  `request_user_input`).
- R4: answering a permission clears Needs you at once.
- R7: the relay sends the hub only what it reads. Then change the privacy text in the README and Settings, which
  quote what passes through.
- R12: fix the e2e step that needs a dirty checkout. R14 (Electron 44.11.3) was tried and undone: its canvas refuses
  the font xterm draws letters with, so terminal text came out tiny. (Since: 44.11.4 fixed it; 0.7.0 ships `~44.11.6`.)
- Recheck Codex's hooks on 0.169.0 (`codex app-server`, `hooks/list`), and e2e on Claude Code 2.1.325.

**Done when:** `npm test` and `npm run e2e` pass, with new tests for each of R1 to R5 (hub-live.test.js) and R7
(lan.test.js), and R2 to R5 are ticked in the "Status tells the truth" block of
[first-install.md](first-install.md), which needs real agents. hub.js changes, so push `main` to redeploy the hub.

### 2. One place for agents, and every current CLI working
**Built on 15 Nov 2026, not released.** `src/agents.js` is the table, "Other command" is in Settings → Agents, and
OpenCode 1.19.5 has hooks through a plugin (`src/opencode-plugin.mjs`). Open: OpenCode's hooks haven't run against a
live model (no provider is signed in on David's Mac), and OpenCode 2 needs its own plugin. What was checked is in
[research/2026-11-15-opencode-facts.md](research/2026-11-15-opencode-facts.md).

- `src/agents.js`: one entry per CLI (name, install command, resume and first-prompt arguments, hook settings,
  whether it can ask, its trust-prompt text). main.js, lane.js, teams.js, hub.js, renderer.js and index.html read
  it; the lists and `'claude'`/`'codex'` tests they hold today go. The app's pickers are drawn from it.
- **Other command:** run any CLI as an agent, set in Settings on this Mac. It gets a shared terminal, a guessed
  status, overlaps from git and the pre-push guard. The command is never taken from a session or a teammate.
- **OpenCode:** install it (Q3), check its flags on version 1 and on OpenCode 2, then give it hooks through a plugin
  (team context, ask before an overlapping edit, push guard, true status). It can ask, so no refuse-once.
- Rewrite "Add an agent CLI" in AGENTS.md as: add an entry, and a translation if it has hooks.
- Further CLIs (Copilot CLI, Droid, Cursor's, Gemini or Antigravity) get entries when someone on a team uses one.
  Until then Other command covers them.

**Done when:** adding a CLI without hooks is one entry in one file; OpenCode passes the same live checks as Codex;
tests cover the table (every entry has what the code reads) and the OpenCode plugin's messages.

### 3. Simpler to use (the redesign)
**Partly built on 15 Nov 2026**, without the review page, because David was away and said to go on: U1 (one
question, given to the agent), U3, U5, U9 and the Online-team message (R16). Each is its own small change, easy to
take back. On 16 Nov: U6 (Plan and Memory open in the side panel, the agents stay on screen). Not built: U2, U4, most of U7 and U10. Those change where things are on screen, so they're better shown to David
first.

The order David likes: a review page first, then code.
1. A review page (an artifact) with before and after for U1 (one-box New session), U2 (no team picker in the way),
   U6 (Plan and Memory in the side panel) and U7 (a shorter bar under each terminal). Black and white, as now:
   the changes are in structure, spacing and wording.
2. David pins notes; revise until he's happy.
3. Build in this order, each one releasable: U1 and U3, U2, U5 and U9, U6 and U7, U4, U10.
4. Update what drives the old screens: `scripts/e2e.js`, `scripts/customer/`, `scripts/stage.js`, then
   `npm run screenshot`, `npm run demo` and `npm run readme-art`.

**Done when:** a new person gets from a fresh install to an agent working on their request in three choices (sign
in, say what to do, pick the repo), and e2e plus the customer simulation pass on the new screens.

### 4. Lighter
**Partly built on 15 Nov 2026:** R8 (output only for sessions on screen) and R10 are in, with tests. Of R9, agents in
one folder share a git poll; since 16 Nov a quiet agent whose folder stopped changing is polled every 15 s, so a change
made outside it shows up to 15 s later.

- R8: output only for sessions someone is showing, and terminals made when first shown. Measure before and after
  with `node scripts/memory.js --agents 6`, and the hub's outbound traffic on Railway.
- R9: one git poll per folder, slower when the agent is quiet. R10: build overlap sets once per pair.
- Only if memory still matters after this: the Tauri prototype from the 8 Nov research.

**Done when:** an app watching six busy teammates' agents from the Sessions page holds no terminals for them, and
an idle agent starts fewer than one git process a second.

### 5. Better collision avoidance (pick after real use)
**Built on 15–16 Nov 2026:** each agent's branch is checked against main (`conflicts`) and against the other
sessions' pushed branches (`branchConflicts`), shown on its card and told to the agent; and a file named in a plan step
is brought up to a teammate's agent about to edit it (hub.js `claimsOn`). Not yet: line ranges.

- **Will these branches conflict?** `git merge-tree --write-tree` (git 2.38 or later) answers exactly, without
  touching the folder: each agent's branch against main and against teammates' pushed session branches. Show "will
  conflict with …" on the card before anyone opens a pull request.
- **Same file or same lines?** Report changed line ranges with the file names, so an overlap in different parts of
  a file is a note and one in the same lines is the alert.
- **Before work starts:** a plan step can name files; an agent starting on a file someone's step claims is told.

## Road to 1.0: fully usable and operational

**1.0 means** someone outside the team can install Protoplasma, start working alone, invite people anywhere (not only
on their Wi-Fi), and rely on it daily: agents' status is true, overlaps and risky pushes are caught across Claude Code,
Codex and OpenCode, the hosted hub stays up and keeps their data, updates are safe, and a problem can be reported.

Each step below is a release. **Size:** S is under a day of work, M a few days, L a week or more. **Who:** *David*
(needs him: GitHub, Railway, Apple, people), *code* (a session builds it after David's go-ahead), or *both*.

### 0.7.0: release what's built (now)
Review complete: 23 findings in 8 areas, all fixed; then a second review of the fixes themselves. `npm test`,
`npm run e2e` and `npm run dist` pass. Details: [sessions/2026-11-25-review.md](sessions/2026-11-25-review.md).

| Step | Who | Size |
|---|---|---|
| Commit the work (as dw8-ro, no AI lines), merge to `main`, push; check Railway redeployed the hub (`/` answers) | both | S |
| GitHub → Settings → Environments → `release`: add yourself as required reviewer; move `MAC_CERT_P12` and `MAC_CERT_PASSWORD` into it | David | S |
| `npm version minor`, push the tag, approve the `sign` job, check the release has `Protoplasma-0.7.0-mac-arm64.zip` | both | S |
| `node scripts/update-check.js 0.6.1` (an installed 0.6.1 updates itself to 0.7.0) | code | S |
| `npm run setup` once in every checkout after pulling | David | S |

**Risk:** the release workflow is new (split into build and sign jobs) and runs for the first time on this release. If
it fails, the fix needs a new commit and a new version (0.7.1), so watch the run.

### 0.7.1: proven on real Macs
**Goal:** the first time Protoplasma runs on two real Macs with two real people. Everything so far was one Mac with
stand-in teammates.

| Step | Who | Size |
|---|---|---|
| First install with Max, all four parts of [first-install.md](first-install.md): install, an Online team, working together, a This Mac team on Wi-Fi | David | M (an evening) |
| "Status tells the truth" with real Claude Code and Codex: interrupt → Idle, a question → Needs you, an approval → Working | David | S |
| Codex live: "Hooks need review" for the two new hooks, then `apply_patch` and a push to main stopped once | David | S |
| Rechecks on current CLIs: `node scripts/status-check.js` (Claude Code 2.1.332+), `node scripts/codex-hooks.js` and the trust-prompt texts (Codex 0.172+) | code | S |
| OpenCode against a live model (sign in a provider first) | both | S |
| Fix what the above turns up, with a test for each | code | M |

**Done when:** every box in first-install.md is ticked on two Macs, and each failure found has a fix and a test.
**Risk:** real networks (a Mac hub across Wi-Fi, Bonjour, macOS's local-network prompt) are where stand-ins can't
reach; budget time for that part.

### 0.8: anyone can start
**Goal:** a person new to Protoplasma gets from a download to an agent working on their request without help.

| Step | Who | Size |
|---|---|---|
| Decide notarisation (Q6). If yes: Apple Developer account, sign with a Developer ID and notarise in the `sign` job; a bridge release first, because installed copies only accept updates signed like today's (`sameSigner`) | David, then code | M |
| A download page (zip or dmg) beside the Terminal one-liner; if not notarised, the app's first window explains "Open Anyway" | code | S |
| `install.sh` checks the download's signing certificate before it removes quarantine (today it checks nothing) | code | S |
| First-run walk-through: Just me → "What should the agent do?" → pick a repo → the agent working; the folder-trust prompt and Codex's "Hooks need review" explained where they appear | code | M |
| Empty states and errors on every screen say what to do next (no CLI installed, gh not signed in, offline, hub asleep) | code | M |
| Try it on someone who hasn't seen it; fix what they trip on | David | S |

**Done when:** that person reaches a working agent in three choices (sign in, say what to do, pick the repo), and e2e and
the customer simulation pass on the new screens.

### 0.9: the hosted hub open to everyone, safely (Q1)
**Goal:** anyone can make an Online team, and the hub can take it.

| Step | Who | Size |
|---|---|---|
| Quotas: teams per person (built), plus REST requests per minute, comments, notes and plan steps per team, sessions per person | code | M |
| Invites that need accepting: an invite shows as an alert; until accepted the person isn't a member and sees nothing | code | M |
| Storage: stop rewriting all of `teams.json` on each change (one file per team, written on change, or SQLite on the volume) | code | M |
| Backups: a nightly copy off the volume, and a restore tried once | both | S |
| Railway's paid plan without App Sleeping (hooks give up after 3 s, so cold starts cost asks), and an uptime alert on `/` | David | S |
| The hub on its own domain (`hub.<domain>`): renewal, registrar lock, two-factor sign-in, no dangling DNS; the app's `onlineHub` moves in a release | both | S |
| "Your own hub server": a hub address in the team window, so a team can use a hub it hosts | code | M |
| Load test: many teams and agents against one hub; memory and hook answer times stay well inside Railway's limits | code | S |

**Done when:** `PROTO_OWNERS` is cleared on Railway, a stranger creates a team, and the load test passes.
**Watch:** Railway's CDN can give many users one address, so they'd share the 10-a-minute sign-in budget.

### 1.0: dependable
**Goal:** teams can rely on it for real work.

| Step | Who | Size |
|---|---|---|
| Help → Report a problem: the app's version, recent logs and the update log, shown to the person first, then a GitHub issue or an email | code | S |
| Close the known lows: skip git (with a notice) in a downloaded folder with its own filter drivers; This Mac's hub leaves the network when nobody else is on its teams; the 6 px terminal-width floor | code | M |
| Overlaps by line ranges: different parts of a file is a note, the same lines the alert (phase 5's last item) | code | M |
| OpenCode 2's plugin, if OpenCode 2 is out | code | S |
| Release safety on GitHub: a `v*` tag ruleset, delete `main-lsx6e3`, account email privacy | David | S |
| Docs: a short user guide, final README and in-app privacy text, a page with download, privacy and terms (drafts exist) | both | M |
| Two teams use it for real work for two weeks | David | L (calendar time) |

**Done when:** those two weeks pass with no lost work and no unexplained status, and e2e, the customer simulation and
the update check pass on the release build.

### Every release on the way
- `npm test`, `npm run e2e`, and for packaging changes `npm run dist`; after the release, `node scripts/update-check.js`.
- Electron kept current: e2e's canvas-font check catches the kind of break 44.11.0–44.11.3 had.
- A review of what changed (reviewers in parallel, a skeptic per area, saving as they go: see the 25 Nov review).

## Alongside, needing people
- **The first real install with Max**, from [first-install.md](first-install.md). Still the most useful single
  thing: it's the first run on two real Macs.
- David's GitHub settings from HANDOFF.md (tag ruleset, signing secrets behind approval, the leftover branch).

## Not planned
- Launch and pricing: on hold since 2 Nov, David's call when to pick it up. Conductor's shutdown (its Mac app winds
  down in early 2027) is a reason not to wait too long.
- A chat window over ACP, Windows, a browser viewer, an own agent or model router.

## Decisions for David
- **Q1. Who may create Online teams?** Kept to `dw8-ro` for 0.7.0. For 1.0, open it to everyone once 0.9's quotas,
  invites and storage are in (or keep it closed and make "your own hub server" the way teams go online).
- **Q6. Notarise with Apple** ($99 a year) for 0.8, or keep the self-signed certificate and explain "Open Anyway"?
- **Q7. Launch and pricing:** 1.0 above is about working well for anyone; whether 1.0 is also the public launch
  (website, closed source, paid hub) is the launch plan's question, on hold since 2 Nov.
- Settled: Q2 (yes, built), Q3 (OpenCode 1.19.5 installed), Q4 (Codex updated), Q5 (the order as written).

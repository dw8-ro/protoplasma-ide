# Plan, from 14 Nov 2026

Where Protoplasma is heading and what to do next, in order. The evidence is in
[docs/research/2026-11-14-market-agents-and-ux.md](research/2026-11-14-market-agents-and-ux.md); the R and U numbers
below are its. Update this file as phases finish. Nothing here has been started: David approves each phase first.

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
  the font xterm draws letters with, so terminal text came out tiny. Electron stays at `~44.10.2`.
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
take back. Not built: U2, U4, U6, U7, U10. Those change where things are on screen, so they're better shown to David
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
one folder share a git poll; polling less often when nothing changes isn't built: it needs care with how quickly
changes made outside the agent show up.

- R8: output only for sessions someone is showing, and terminals made when first shown. Measure before and after
  with `node scripts/memory.js --agents 6`, and the hub's outbound traffic on Railway.
- R9: one git poll per folder, slower when the agent is quiet. R10: build overlap sets once per pair.
- Only if memory still matters after this: the Tauri prototype from the 8 Nov research.

**Done when:** an app watching six busy teammates' agents from the Sessions page holds no terminals for them, and
an idle agent starts fewer than one git process a second.

### 5. Better collision avoidance (pick after real use)
**First item built on 15 Nov 2026:** each agent's branch is checked against main (`conflicts`), shown as "N conflicts
with main" and told to the agent. Not yet: against teammates' pushed session branches, line ranges, plan-step claims.

- **Will these branches conflict?** `git merge-tree --write-tree` (git 2.38 or later) answers exactly, without
  touching the folder: each agent's branch against main and against teammates' pushed session branches. Show "will
  conflict with …" on the card before anyone opens a pull request.
- **Same file or same lines?** Report changed line ranges with the file names, so an overlap in different parts of
  a file is a note and one in the same lines is the alert.
- **Before work starts:** a plan step can name files; an agent starting on a file someone's step claims is told.

## Alongside, needing people
- **The first real install with Max**, from [first-install.md](first-install.md). Still the most useful single
  thing: it's the first run on two real Macs.
- David's GitHub settings from HANDOFF.md (tag ruleset, signing secrets behind approval, the leftover branch).

## Not planned
- Launch and pricing: on hold since 2 Nov, David's call when to pick it up. Conductor's shutdown (its Mac app winds
  down in early 2027) is a reason not to wait too long.
- A chat window over ACP, Windows, a browser viewer, an own agent or model router.

## Decisions for David
- **Q1. Who may create Online teams?** Today only `dw8-ro` (the hub's `PROTO_OWNERS`), and the app doesn't say so
  (R16). Either keep it and have the app explain, starting new people on This Mac; or open it to everyone with a
  limit per person. Suggested: explain now, open it when the launch plan resumes.
- **Q2. Should what you type in New session go to the agent as its first message (U1)?** It starts using your model
  plan at once. Suggested: yes, since it's what the box asks for; settle the details on the review page.
- **Q3. Install OpenCode on your Mac** (`npm install -g opencode-ai`), so it can be checked at all?
- **Q4. Update Codex to 0.169.0** before phase 1's recheck? Claude Code updates itself.
- **Q5. This order,** or the redesign (phase 3) before the agent table (phase 2)? The review page can be made
  during phase 1 either way.

# The market, the agent CLIs, open problems and the UI: research, 14 Nov 2026

Done on app 0.6.1 (`bc9d448`, equal to `origin/main`). Nothing in the app was changed. The plan that follows from this
is [docs/plan.md](../plan.md). Items marked **confirm live** come from reading the code and the vendors' docs, and
still need one run with a real agent.

## Short answer

- **The app works today with Claude Code and Codex.** `npm test`: 106 of 106. `npm run e2e`: 137 of 138 at first, and
  the one failure is the test's own (R12); 138 of 138 on a rerun once the checkout differed from main.
- **OpenCode is the weak one.** It has no hooks, nothing checks it live (it isn't installed here), and OpenCode 2's docs
  no longer list the two flags the app passes it.
- **The status pill isn't always true.** Five cases where an agent shows Working, Idle or Needs you wrongly (R1–R5).
  Status and its notifications are what people look at most, so these come first.
- **Two structural costs:** every agent's terminal output goes to every open app on the team, watched or not (R8), and
  each agent runs about a dozen git processes every 5 seconds (R9).
- **The hook relay sends the hub more than it reads** (R7): whole file contents and prompts, where it only needs
  names, commands and the first 300 characters. Trimming it on the Mac is a privacy gain the README can then state.
- **Adding an agent CLI means editing about twelve places in six files.** One table would do.
- **The market moved in the last two weeks.** Meta bought Conductor and is shutting it down, Zed's Delta is in public
  beta, and Amoeba is turning into its own agent and model router. Nobody else found does what Protoplasma's hooks do:
  tell each agent what teammates' agents changed, and ask a person before two of them edit the same file, across
  Claude Code and Codex, on each person's own Mac.
- **The UI is clean but asks too much before anything happens.** A new person makes about nine choices before an
  agent does any work. Three would do.

## 1. Checks run today

| Check | Result |
|---|---|
| `npm test` | 106 of 106, 31 s |
| `npm run e2e` (Electron 44.10.2, after `npm ci` in the worktree) | 137 of 138, then 138 of 138 on a rerun: see R12 |
| Claude Code | 2.1.289 installed, 2.1.325 latest. `--settings`, `--continue` and the prompt argument are still there |
| Codex | 0.166.0 installed (the version checked on 2 Nov), 0.169.0 latest. `[PROMPT]`, `resume --last` and `-c` are still there |
| OpenCode | Not installed. npm's latest is 1.19.5 |
| Electron | 44.10.2 in the app; 44.11.3 is the newest 44; 45.3.2 is the newest overall |
| Monaco 0.57.0, xterm 6.0.0, node-pty 1.1.0 | Current. `ws` 8.23.0 is out (the app allows `^8.22`) |

The main checkout's `node_modules` still holds Electron 44.5.1, so linking it into a worktree gives an old Electron.
`npm ci` in the worktree is the reliable way.

## 2. The market

### Products where several people work with agents together

| Product | What people share | Agents | Two agents, one file | State on 14 Nov 2026 |
|---|---|---|---|---|
| **Amoeba** 0.1.52 (7 Nov) | Live sessions, a shared "Brain", plans, comments, hand-offs, files synced live | Claude Code, Codex, OpenCode, Antigravity, anything over ACP, and since October its own agent with 180+ models | Overlap warnings, a Conflicts tab for shared files, avatars on files being edited | macOS and Windows. The pricing page says free, plus 5% on model usage bought through Amoeba; the 5 Nov changelog adds Free, Pro and Max plans |
| **Zed Delta** | The agent conversation and its worktrees, copied live to teammates (DeltaDB). Review happens in the thread, not in pull requests | "Agents" (not named on the launch page; Zed itself runs Claude, Codex and OpenCode over ACP) | Not described | Public beta since 16 Sep. macOS, Linux, Windows, web, and phones in a browser. Free in beta, paid plans "soon" |
| **Conductor** | Cloud workspaces teammates could prompt together | Claude Code, Codex, Cursor | None: one sandbox per agent | Bought by Meta on 4 Nov. Cloud went read-only on 13 Nov and ends 20 Nov; the Mac app winds down in early 2027 |
| **Nimbalyst** | Documents, trackers, team chat. Sessions stay personal | Claude Code, Codex | Worktrees | Teams in beta, $20 a user a month later |
| **Superconductor** | Teammates join a running agent, steer it or review | Its own cloud agents | Not described | Live |
| **Cursor Teams** | Rules, a marketplace, shared canvases (snapshots) | Cursor's own agent | Branches and pull requests | $40 a user a month. No live shared sessions |
| **GitHub Copilot (Agent HQ)** | The repo, issues and pull requests | Copilot, plus Claude and Codex in preview | Pull requests | Preview |
| **Vibe Kanban** | A task board | Ten or more CLIs | Worktrees | Its company closed in April; kept up by its community |
| Open source: Agor, vibelive, qm, Nuphos, Podium ADE | Canvases, cursors, shared terminals or task lists | Mostly Claude Code and Codex | Worktrees, or nothing | Small projects |

One public list of agent orchestrators counts 358 tools, about 100 of them with some way for agents to coordinate.
Almost all are for one person running many agents.

### How others keep two agents off the same file

1. **Separate folders, and sort it out at merge time.** Nearly everyone: Conductor, Cursor, Codex's app, Claude Code's
   own agent teams, Nimbalyst, Vibe Kanban. The clash shows up as a merge conflict in a pull request, late.
2. **Claims and locks the agent has to ask for.** File reservations (Agora), file leases (Mercury CLI), locks
   (NXTG-Forge), claims over MCP (Concord MCP, swarm-protocol), function-level locks (wit), line-level ownership
   (Zaivern Code). They're advisory: they work when the model remembers to call the tool, and mostly on one machine.
3. **Say what you plan first.** Agents declare their intent and colliding plans are flagged (foremerge), or runs are
   queued around each other (Taskuary).
4. **One working copy, synced live.** Zed Delta, and Amoeba's live file sync. Everyone sees every edit as it happens;
   nothing found says what happens when two agents type into the same lines.
5. **Watch what agents do and step in.** Protoplasma, and Amoeba's overlap warnings. The check runs in the agent's own
   hooks, so it doesn't depend on the model's goodwill.

A survey of these tools (AgentConn, below) says no product combines live presence, handling of conflicts,
agents that know who else is there, and a model for who may approve what. Protoplasma has the first and third, part
of the second (it warns and asks; it doesn't resolve), and part of the fourth (who may type into an agent, the push
guard).

### What this means for Protoplasma

- **Its distinct part is real and uncrowded.** Each agent is told what the others changed before every prompt, a
  person is asked before an edit to a file a teammate's agent changed, and risky pushes are stopped. It works across
  vendors and across Macs, with the real CLIs, and a team can host it on its own Wi-Fi. Keep building on that, not on
  an editor or a chat window.
- **Amoeba is leaving the "bring your own CLI" corner.** Since October it ships its own agent, a model router and
  billing, a simpler "Vibe Coder" view, Windows, and now subscription plans. That's where its money is. Protoplasma
  staying thin (real terminals, no markup, your own accounts) is now a clearer difference than it was.
- **Conductor's users need somewhere to go.** They are Mac people running Claude Code and Codex side by side, which is
  exactly who Protoplasma is for. They're used to a very polished app: one click from an idea to a running agent, and
  a diff to review at the end.
- **Zed Delta sets expectations.** Free, in a browser with no install, and from a known company. Protoplasma can't
  match an editor company feature for feature. It doesn't replace Git or pull requests, and that's an advantage for
  teams that want to keep GitHub as it is.
- **Two gaps worth closing later:** nobody is warned *before* work starts (pattern 3), and an overlap means "same
  file", not "these changes will conflict" (git can answer that exactly: see the plan, phase 5).
- **Watch, don't build:** ACP (about 50 agents speak it; it would mean a chat window instead of terminals), Windows,
  and watching from a browser without installing.

## 3. The agents

### What works today

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Starts, resumes, takes a first prompt | Starts in e2e; the flags are in today's `--help` | Started live on 2 Nov; the flags are in today's `--help` | **Unverified** on current versions |
| Team context before each prompt | Yes | Yes, once its hooks are trusted | No |
| Asked before editing a teammate's file | Yes | Refused once, then let through (Codex can't ask) | No |
| Push guard | Hooks | Hooks and the pre-push hook | Pre-push hook only |
| Status | From hooks | From hooks once trusted, else guessed from output | Guessed from output |
| Checked by a test | e2e, with the real CLI | The hook command only (lan.test.js) | Nothing |

- **Claude Code.** Its hooks reference now lists 33 events. The four the app registers are unchanged. Three things in
  it matter here: `Stop` doesn't run after a user interrupt (R2), `PreToolUse` also fires for `AskUserQuestion` and
  `ExitPlanMode` (R3), and http hooks got an `onFailure` setting in 2.1.295 (the app wants the default, carry on).
- **Codex.** The docs list 14 events, `Interrupt` among them, which the app doesn't register (R2). Hooks still run
  commands only, `ask` is still "parsed but not supported yet" (so the relay's refuse-once stays), and `apply_patch`
  can now also be matched as `Edit` or `Write`. Passing hooks with `-c hooks=…` isn't documented; it worked on
  0.166.0. Recheck on 0.169.0 with `codex app-server`'s `hooks/list`, as on 2 Nov.
- **OpenCode.** Two generations exist. Version 1 (npm `opencode-ai`, 1.19.5) documents `--continue` and `--prompt`,
  which the app passes. OpenCode 2 is what the docs now describe, and its pages list only a folder argument, so
  **Resume, Continue and Ask my agent may fail on OpenCode 2.** It needs an install and `opencode --help` to settle.
  For hooks, OpenCode 2 plugins can do everything Claude Code's hooks do: see a tool before it runs, add context to a
  prompt, and answer a permission with allow, ask or deny. It can ask, so it needs no refuse-once trick.

### Why adding an agent is expensive today

What the app knows about each CLI is spread over these places, which is why AGENTS.md needs a paragraph on keeping
them in step:

- `app/main.js`: `AGENTS`, `RESUME`, `FIRST_PROMPT`, and three tests for `'claude'` (shared-team guard, hook relay,
  unguarded agents)
- `src/lane.js`: `NO_HOOKS`, `TRUST_PROMPT`, `ANSWERS`, two `kind ===` branches for hook settings, `byActivity`
- `app/teams.js`: `to.cmd === 'codex'` in the relay
- `src/hub.js`: `cmd === 'claude'` for the first status, and the tool names `Bash`, `exec_command`, `apply_patch`
- `app/renderer.js`: `agentName`, three menus that each list the three agents, `INSTALL_CLAUDE`
- `app/index.html`: two groups of three radio buttons

One table (`src/agents.js`), read by all of them, replaces these. Roughly:

```js
codex: {
  name: 'Codex',
  install: 'npm install -g @openai/codex',
  resume: ['resume', '--last'],
  firstPrompt: p => [p],
  hooks: url => ({ args: ['-c', codexHookSettings()], env: { PROTO_HOOK_URL: url } }),  // null: no hooks
  canAsk: false,                    // the relay turns "ask" into one refusal
  trustPrompt: /hooks\s*need\s*review/i,   // and its folder question
},
```

The hub already speaks one shape (`hook_event_name`, `tool_name`, `tool_input`), which Claude Code and Codex both
send. A new agent's hooks need a small translation to that shape on the Mac, next to the relay, and nothing in the hub.

### Other agent CLIs

| CLI | Hooks | What it would take |
|---|---|---|
| Any CLI at all (Gemini, Cursor's, Copilot's, Amp, Droid, Aider, Goose…) | None needed | An **Other command** entry: a shared terminal, status guessed from output, overlaps from git, and the pre-push guard. These parts never depended on the agent |
| GitHub Copilot CLI | Commands and http; reported to read Claude Code's settings files | Possibly the Claude Code entry with another command name |
| Factory Droid, Cursor's CLI, Gemini CLI (reported to be giving way to Antigravity CLI) | Command hooks, close to Claude Code's | The same posting command Codex uses, plus name mapping. They read hooks from project or user files, not a flag, so where to put them without dirtying the repo is the open point |
| Amp, Cline | Plugins | Like OpenCode: a plugin file |

## 4. Bugs and inefficiencies

Found today, beyond the open rows of the 8 Nov table (token-flood budgets, git filter drivers, DOMPurify inside
Monaco, `allowScripts`), which stand as they are.

| # | Where | Problem | Fix | Size |
|---|---|---|---|---|
| **Status** | | | | |
| R1 | hub.js `onLane`, close handler | A stopped agent's record doesn't keep `hooked`. An agent that reconnects after the hub saw it go (sleep and wake) is treated as hookless, so Codex's guesses from output overwrite what its hooks said: Needs you can turn into Idle | Keep `hooked` in the record | Small |
| R2 | lane.js, hub.js `onHook` | **Confirm live.** Claude Code runs no `Stop` hook after Esc, so an interrupted agent says Working until its next prompt ends, and "Your agent finished" never fires. Codex has an `Interrupt` event the app doesn't register | Codex: register `Interrupt` as idle. Claude Code: the lane reports "Esc or Ctrl-C, then a quiet screen", and the hub ends Working on it | Small to medium |
| R3 | lane.js `claudeHookSettings` | **Confirm live.** A question from Claude (`AskUserQuestion`) or a plan to approve (`ExitPlanMode`) shows as Working, with no alert | Add both to the `PreToolUse` matcher; the hub sets Needs you | Small |
| R4 | hub.js `onHook` | After you approve a permission, the agent says Needs you until that command ends, which can be minutes | A key typed at the agent's own Mac while it needs you sets Working; the next hook corrects it. lane.js does this already for the trust prompt | Small |
| R5 | lane.js `codexHookSettings` | Known: a Codex question shows as Idle. **Confirm live** whether `PreToolUse` fires for `request_user_input` (the docs say it fires for local tools by name) | Add it to Codex's matcher | Small |
| R6 | lane.js, renderer `notifyChanges` | An agent whose status is guessed (OpenCode; Codex before its hooks are trusted) "finishes" after 3 quiet seconds, so a silent long command sends "Your agent finished" | Goes away with hooks. Until then, a longer wait before that notification | Small |
| **Privacy and reliability** | | | | |
| R7 | teams.js `hookRelay` | The relay sends each hook to the hub whole: the full text of a file being written, both sides of an edit, the full prompt, up to 5 MB. The hub reads only the event, the tool, file names, the command and 300 characters of the prompt. On a slow connection a large write also misses the 2.5 s limit, and the overlap check is skipped without a word | The relay sends only what the hub reads. File contents and full prompts then never leave the Mac, and the privacy text (README, Settings) loses its "some code does pass through" sentence | Small to medium |
| **Efficiency** | | | | |
| R8 | hub.js `toTeam`, renderer `renderRoom` | Every agent's output goes to every open app on the team, whether or not anyone is looking, and each app keeps a terminal for every agent. That's CPU and a few MB per teammate's terminal in every app, and outbound traffic on the hosted hub (a rough guess for a busy five-person team: a few dollars a month, above the Free plan's $1) | Apps say which sessions they're showing; the hub sends output only for those and replays the screen when someone opens one. Older apps keep getting everything | Medium |
| R9 | lane.js `gitStatus` | Each agent starts 11 or 12 git processes every 5 s, changes or not. Agents sharing a session folder each poll it. Six agents: about 14 processes a second | One poll per folder. Every 5 s only after the agent printed something, else every 30 s | Small to medium |
| R10 | hub.js `views` | Overlaps rebuild each pair of agents' file sets once per file, on every update: lanes² × files². Nothing at six agents; it can reach seconds of hub time at the 30 a person may run | Build each pair's sets once | Small |
| R11 | hub.js `broadcastState` | Every update carries all notes, sessions and comments | Leave until a team is big | None now |
| **Tests and dependencies** | | | | |
| R12 | scripts/e2e.js | "live git diff shows on your lane" fails in a clean checkout equal to `origin/main`: with nothing changed there's no diff to show. Confirmed by a rerun that passed once the checkout had one new file in it | Check for the branch name, which is always there | Small |
| R13 | — | Nothing checks OpenCode. It isn't installed here | Install it, check the flags, add it to the live checks | Small |
| R14 | package.json | Electron 44.10.2; 44.11.3 has later backports. A move to 45 must pass e2e's "creates a This Mac team…" (44.9.0 once broke the pinned certificate) | `~44.11.3` | Small |
| **First run** | | | | |
| R16 | index.html `#createTeam`, the hosted hub | The hosted hub lets only its owners create teams (set to `dw8-ro` on 3 Nov), and Create a team defaults to Online. Anyone else gets "This hub only lets its owners create teams." and no way forward | David's decision: see the plan, Q1 | Small |

## 5. The UI

The look is in good shape: monochrome, quiet, consistent. The problems are in how much it asks and how many places
do similar things. All of this is a proposal for a review page, not a decision.

**Before an agent does anything, a new person today:** signs in, enters a code on GitHub, reads the team picker (a
list, a network checkbox with a paragraph about passes, Online or This Mac), names a team, clicks New, names a
session, writes a goal, picks repo or folder, picks the repo, picks an agent, starts it, answers the CLI's
folder-trust question, and then types what they want, again, into the terminal.

| # | Today | Proposal |
|---|---|---|
| U1 | **New session** has six controls. The name and the goal are two fields for one thought, and the goal isn't given to the agent: you type it a second time in the terminal | One box: "What should the agent do?" It becomes the goal and the agent's first message. The name is made from it and can be changed. The repo is the last one used. Options (folder, teammates can type) sit behind one link. The app can already start an agent with a first message (Continue uses it) |
| U2 | The team picker comes first, with network hosting and passes explained in the main flow | Open the last team, or the only one, straight away. A first-time user gets a team without a form. This Mac and nearby teams go under "More" |
| U3 | The three agents are listed in five places, including ones that aren't installed | Show installed agents only, and no picker at all when there's one. "Get another agent" leads to Settings |
| U4 | Two kinds of side by side: **New pane** (sessions) and **Show beside** (agents in one session) | One: "Open beside", for an agent or a session |
| U5 | **Share** in a session opens the team invite | Call it Invite, or leave it to the People page and ⌘I |
| U6 | Plan, Memory, Pull requests and Issues take over the stage, hiding the agent behind a Back bar | Open them in the side panel, so the agent stays on screen |
| U7 | The bar under a terminal holds up to nine things | Status, branch and changes, Stop. Hand off, Continue and who can type go in a menu |
| U8 | Every new session folder brings the CLI's "trust this folder?" question | Look into what the person can do once themselves. The app never answers it |
| U9 | Eight status words, among them Running (means "no status yet") beside Working, and Not synced | Fewer: Working, Needs you, Idle, Overlap, Done |
| U10 | An overlap alert names the people and the file | Add what to do: see both versions, comment to them |

Changing the New session form means updating what drives it by element id: `scripts/e2e.js`, `scripts/customer/`,
`scripts/stage.js` and the README pictures.

## Sources

- Amoeba: [changelog](https://useamoeba.com/changelog), [pricing](https://useamoeba.com/pricing), [docs](https://useamoeba.com/docs)
- Zed: [Replacing pull requests with Delta](https://zed.dev/blog/delta-public-beta), [Introducing Delta](https://zed.dev/blog/introducing-delta), [The ACP registry is live](https://zed.dev/blog/acp-registry)
- Conductor and Meta: [AI Business](https://aibusiness.com/generative-ai/meta-s-conductor-deal-enterprise-ai-coding-workflows-deadline), [AlternativeTo on 0.93.0](https://alternativeto.net/news/2026/11/conductor-0-93-0-sets-cloud-shutdown-dates-after-meta-move/)
- Comparisons: [Nimbalyst, shared workspaces](https://nimbalyst.com/blog/best-shared-workspaces-for-claude-code-and-codex/) (a competitor's own page), [AgentConn, "Your agents can't share a room"](https://agentconn.com/blog/multiplayer-agents-shared-session-primitive/), [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators), [Superconductor](https://superconductor.com/)
- Hooks: [Claude Code](https://code.claude.com/docs/en/hooks), [Codex](https://learn.chatgpt.com/docs/hooks), [OpenCode plugins](https://opencode.ai/docs/plugins/) and [server hooks](https://opencode.ai/docs/build/plugins/server/), [a comparison across twelve tools](https://www.digitalapplied.com/blog/ai-coding-agent-hooks-compared-tool-interception)
- OpenCode's command line: [version 1](https://opencode.ai/v1/docs/cli/), [current](https://opencode.ai/docs/cli/)

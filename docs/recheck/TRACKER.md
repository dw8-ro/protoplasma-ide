# Recheck of Protoplasma 0.4.1 (clean restart): one small section at a time, findings only; fixes after compiling

Recheck folder: docs/recheck (copied from the original session scratchpad). Shared instructions: INSTRUCTIONS.md. Findings: sections/NN-name.md. Compiled list: COMPILED.md. Line numbers in all of these are from 0.4.1 (817f96a) and have moved since.

| # | Section | Scope | Status |
|---|---------|-------|--------|
| 1 | Hub: API and storage | src/hub.js: HTTP routes (teams, members, sessions, memories, comments, steps), identity, sign-in gate, persistence, request parsing | done: 2 high, 2 medium, 12 low |
| 2 | Hub: live | src/hub.js: lanes, watchers, file relay, overlaps, Claude hooks, push guard, shell-write check, heartbeat; src/shared.js; test/hub.test.js | done: 1 high, 3 medium, 14 low |
| 3 | Agents | src/lane.js | done: 0 high, 1 medium, 10 low |
| 4 | Worktrees and push hook | src/workspace.js, test/workspace.test.js | done: 0 high, 3 medium, 15 low |
| 5 | Main process | app/main.js, app/preload.js | done: 0 high, 4 medium, 9 low |
| 6 | Teams, GitHub, updates | app/teams.js, app/github.js, app/updates.js, test/updates.test.js | done: 1 high (same as 1), 4 medium, 16 low |
| 7 | Code view: files | app/files.js, test/files.test.js | done: 0 high, 3 medium, 11 low |
| 8 | Code view: editor | app/code.js | done: 0 high, 1 medium, 17 low |
| 9 | Screens 1 | app/renderer.js lines 1-495 (prefs, helpers, state, sign-in, teams, people, hub connection) | done: 0 high, 2 medium, 11 low |
| 10 | Screens 2 | app/renderer.js lines 496-831 (new session, adding agents, menus, navigation) | done: 0 high, 2 medium, 9 low |
| 11 | Screens 3 | app/renderer.js lines 832-1447 (rendering, panels, memory, plan, file sharing) | done: 0 high, 2 medium, 9 low |
| 12 | Screens 4 | app/renderer.js lines 1448-end (settings, updates, switcher, setup, menu, start), app/panes.js | done: 0 high, 2 medium, 13 low |
| 13 | Markup and CSS | app/index.html | done: 0 high, 2 medium, 11 low |
| 14 | Release and tooling | scripts/, .github/workflows/, install.sh, package.json, README.md | done: 0 high, 3 medium, 11 low |
| 15 | Live: owner and solo | playground, David's copy | done: 1 high, 3 medium, 3 low (mostly confirming earlier ones) |
| 16 | Live: two people | playground, both copies | done: 0 high, 1 medium, 2 low |
| - | Compile | dedupe, rank, COMPILED.md | done: 196 items (2 high, 32 medium, 162 low) + 8 decisions |
| - | Fix | apply fixes from COMPILED.md in batches, tests after each | done: A-G (see FIXLOG.md); final verification next |

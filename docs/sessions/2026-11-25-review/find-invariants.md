# Review: invariants slice (branch 75aaaf3 vs 5e896c4)

Progress: slug byte-identical (shared.js vs renderer.js); MAX_CHANGED 200/200; MAX_SHARED_FILE 1e6 vs renderer answerFile 1e6; slimHook keeps every ev field hub.js reads (hook_event_name, cwd, prompt, tool_name, tool_input.file_path/notebook_path/command/cmd); Interrupt handled in onHook; status strings consistent incl. running; README protocol table lists key {moving}.

Progress: design rule: main.js menuAction list identical to 5e896c4; Settings kbd list unchanged; removed UI = #shareBtn (was only a shortcut to #inviteBtn, still reachable via People page and team menu 'Invite to the team…'), 'New pane' renamed 'Open beside' (menu adds Pick a session), memory/plan tabs moved to data-panel, goal field kept as 'What should the agent do?'. No capability lost found so far. Agent lists now in src/agents.js; hub.js:963 still hard-codes 'claude' for initial status (fine: only sure agent).

Progress: tests: conflicts.test.js isolates git config; new hub-live tests poll for conditions (no bare fixed waits found); agents.test.js covers slimHook/refuseOnce/plugin; no test requires electron. merge-tree loose objects documented in AGENTS.md. Dockerfile ok (hub.js requires only ./shared).

## F1 (low, docs/privacy): "the text an agent writes into a file never leaves" overclaims
- README.md:177, docs/release-notes/0.7.0.md "Privacy and weight". app/teams.js slimHook forwards a Bash/exec_command `command` up to 20,000 chars (shell()), which is how the hub's pushRisk/shellWriteRisk work. A file written by a shell command (`cat > f <<'EOF' ...`, `printf ... > f`, Codex running `apply_patch` through exec_command) carries the file's text to the hub. Only Write/Edit/MultiEdit/apply_patch-as-tool contents are stripped.
- Fix: reword to "the text an agent writes with its edit tools"; or keep the claim and cut heredoc bodies in slimHook (the hub's partsOf drops heredoc bodies anyway).
- on_main_too: no (the claim is new; main sent everything, and said so).

## F2 (low, docs/sync): README wire-protocol table behind the code
- README.md:242,247: `git {...}` lacks `conflicts` and `branchConflicts` (src/lane.js:107-109, read at src/hub.js:~999-1000); `key {moving}` lacks `ago` (src/lane.js:338, used at src/hub.js:1016); `/hooks/:lane` direction says "Claude Code, Codex" but OpenCode's plugin posts there too (src/opencode-plugin.mjs). README:177 and index.html:1087 also say "From Claude Code's and Codex's hooks" only.
- on_main_too: no.

Progress: design rule and agent pickers checked: resume/continue/ask only offer agents with resumes/prompts; Other command goes only from prefs; menu identical. Budget spent; stopping.

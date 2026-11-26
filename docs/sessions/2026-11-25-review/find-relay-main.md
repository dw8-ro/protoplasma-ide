# relay-main review (app/teams.js, app/main.js, app/preload.js)
Progress: read slice diff, agents.js, safeHookReply/refuseOnce, onHook fields; bare Other command gets no hooks or secret (lane.js:216-227) - sound; hookTarget passes cmd; slimHook keeps file_path/notebook_path/cmd/command/cwd/prompt/tool_name - fields match onHook.

## F1: refuseOnce keys the "already asked" pass on the hub's reason text, not the step (low-medium, on_main_too for Codex; branch extends to OpenCode)
- app/teams.js refuseOnce (~line 182-191): key = `${id}|${reason}`. Reasons from hub pushRiskOf are generic: "this force-push can overwrite commits your teammates pushed..." (hub.js ~486), "this pushes straight to main..." (~510).
- Scenario: Codex/OpenCode in a folder the person picked (no pre-push guard; startLane notice) on a shared team runs `git push --force origin session/x` -> refused once. Within 10 min it runs `git push --force origin main` (or any other force push): same reason string -> refuseOnce returns no decision -> runs unasked. Same for any second push to main after the first was refused.
- Also: a hub can make a refusal permanent by varying the reason (e.g. counter), contradicting "a hub still can't refuse anything outright".
- Fix: key on the step (sha of tool_name + slim tool_input from slimHook / the command), e.g. pass the slim body into refuseOnce; optionally also include reason.
- F1 CONFIRMED by repro work/find-relay-main/f1.js: force push to session/x refused, then `git push --force origin main` -> "" (allowed, no refusal) for cmd opencode.
Progress: slimHook fields match onHook (file_path, notebook_path, cmd, command, apply_patch file lines, cwd, prompt 300, tool_name); hub itself truncates commands at 20k so slim truncation is no regression; relay headers OK (no stale content-length); lane.js bare Other command: no hooks, no secret; hookBase for all hooked agents; PROTO_SHARED_TEAM/unguarded use !agent.sure (Other included); preload agents(other) matches handler; Move to a team keeps key (folder/branch) via saveSession(key)+rename - main side unchanged; solo is renderer-only.

## F2: README push-guard paragraph contradicts the branch (low, docs)
- README.md:167 still says "OpenCode has no hooks" and only Codex is refused once; the branch gives OpenCode hooks (src/agents.js opencode.hooks, src/opencode-plugin.mjs) and refuseOnce now covers every non-`asks` agent. Also says "the same step goes through", which F1 shows is "any step with the same reason".
- Fix: update README.md:167 with OpenCode's plugin hooks and the refuse-once wording.

More low: Other command with a relative path (`./scripts/agent.sh`) always reports "isn't installed": lane.js installed() (line 180) checks a path containing '/' against the main process cwd, not the lane's cwd, in both agents:status and startLane.
Progress (final): safeHookReply covers Interrupt/PermissionRequest/Stop (only PreToolUse/UserPromptSubmit context+ask pass); refuseOnce map bounded (~500, evicts oldest, fail-safe); no new IPC handler beyond agents:status (read-only, coerced via commandWords); startLane cmd from table via Object.hasOwn, first-prompt cap and dash handling unchanged; Other command never gets hooks/secret.

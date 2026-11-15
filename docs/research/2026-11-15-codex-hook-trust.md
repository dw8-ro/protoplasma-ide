# Codex hooks and what makes Codex ask to review them, checked 15 Nov 2026

Raw notes from `codex app-server` (`hooks/list`) on Codex 0.166.0 and 0.169.0. No prompt was sent. The check is now
`node scripts/codex-hooks.js`.

# Codex hook facts

Scripts: codex-check/hooks.js (variant A-D), codex-check/list.js (hooks/list over app-server stdio; initialize, initialized, hooks/list {cwds:[tmp]}). Method names from 'codex app-server generate-json-schema'.

## Part 1 on codex-cli 0.166.0 (npm global @openai/codex@0.166.0)
### A baseline (event | matcher | key | hash | trust | source | timeout)
```
cwd <tmp> warnings [] errors []
preToolUse | Bash|exec_command|apply_patch | /<session-flags>/config.toml:pre_tool_use:0:0 | sha256:4d8c7ed09b75d94e8c173f5721ce709397fee8367441820d0c56c4a83ae72302 | trusted | sessionFlags | 5 | true
permissionRequest |  | /<session-flags>/config.toml:permission_request:0:0 | sha256:aa2f81b83a4049a7b341f080ad3ece03429607bb467aa9655bdaf90f17d2d192 | trusted | sessionFlags | 5 | true
userPromptSubmit |  | /<session-flags>/config.toml:user_prompt_submit:0:0 | sha256:23bba2a582cf1e0d1ee437be1e33b7afcb9ddc7802733730fba2068ac98c9d14 | trusted | sessionFlags | 5 | true
stop |  | /<session-flags>/config.toml:stop:0:0 | sha256:3b44cc85fcc09ec58bc9d72909ff1bb7024c7f7648a6140d64c8f70e30875884 | trusted | sessionFlags | 5 | true
```
Trust is 'trusted' (not untrusted) because ~/.codex/config.toml already holds hooks.state entries from an earlier approval; hashes equal them.

### B +Interrupt group (0.166.0), run: node codex-check/list.js B
Accepted. Five hooks listed. warnings: "clamping Interrupt hook timeout to 3s" (listed timeoutSec 3). Interrupt is untrusted, key `/<session-flags>/config.toml:interrupt:0:0`, hash sha256:081a0ae1...161ac. The four baseline hooks keep identical keys and hashes and stay "trusted". Nothing is rejected. (The event enum in the app-server schema includes `interrupt`, plus preModelRequest, postModelRequest, postToolUse, preCompact, postCompact, sessionStart, sessionEnd, subagentStart, subagentStop.)

### C second PreToolUse group matcher "request_user_input" (0.166.0)
Accepted and listed as `pre_tool_use:1:0`, hash sha256:fe2a63f7...3db973, untrusted. Baseline four: same keys and hashes, still trusted. So adding a later group never disturbs earlier ones, but the person must trust the new one (a new review prompt).

### D first PreToolUse matcher changed to "Bash|exec_command|apply_patch|request_user_input" (0.166.0)
Key unchanged (`pre_tool_use:0:0`), hash CHANGED to sha256:ee76a5cf...f126b3c, trust status "modified" (stored trusted_hash no longer matches), so the person is asked again. Other three still trusted.

### E What decides key and hash (0.166.0, measured)
- Key = layer + event + group index + handler index (`/<session-flags>/config.toml:<event>:<group>:<handler>`). Not the command, matcher or timeout.
- Hash changes with matcher (D), with timeout (Stop timeout 5 -> 6 gave a new hash, status modified) and with the command string (one trailing space gave a new hash, modified). Event is in the key. Position is in the key.
- Consequence: adding a new event or a later group adds an untrusted hook but leaves old ones trusted. Editing any existing group's matcher, timeout or command invalidates trust for that hook.

### F ~/.codex/config.toml (read only)
Has `[hooks.state."/<session-flags>/config.toml:{pre_tool_use,permission_request,user_prompt_submit,stop}:0:0"]` with trusted_hash values 4d8c7ed0..., aa2f81b8..., 23bba2a5..., 3b44cc85.... They equal the baseline hashes from A exactly (that is why A shows "trusted"). No entries for interrupt or pre_tool_use:1:0.

## Part 2 update
Installed by: npm global (`/opt/homebrew/bin/codex` -> ../lib/node_modules/@openai/codex/bin/codex.js; brew has no codex). `npm install -g @openai/codex@latest` -> `codex --version` = codex-cli 0.169.0.
A to D re-run on 0.169.0: output IDENTICAL to 0.166.0 (same keys, same hashes, same trust states "trusted"/"untrusted"/"modified", same Interrupt timeout-clamp warning, Interrupt accepted untrusted). Nothing differs.
`codex --help`: `Usage: codex [OPTIONS] [PROMPT]`, `[PROMPT]` present, `-c, --config <key=value>` present. `codex resume --help`: `Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]`, `--last` present, `-c` present. All three still exist. (New in 0.169: `codex resume` takes [SESSION_ID] then [PROMPT]; --last works without id. Not tested beyond help text.)
0.169.0 schema also lists hook events incl. `interrupt` (same as 0.166.0).

## Part 3 documentation (https://learn.chatgpt.com/docs/hooks, fetched; developers.openai.com/codex/hooks returns the same page) and source (raw.githubusercontent.com/openai/codex main, codex-rs)
- Interrupt: fires "when you interrupt an active turn on the main thread". Not for idle threads, not for subagents. Matcher ignored. Input = common fields + `turn_id` (the interrupted turn's id) + `permission_mode`. Timeout default 1 s, configured 1 to 3 s (Codex clamps larger with a warning, as seen). Output cannot stop the interruption; exit 0 with no output or JSON with optional `systemMessage`; plain text output is invalid. So a hook that curls the hub and prints the hub's reply must print nothing or JSON; the relay's answer for Interrupt must be empty/JSON.
- PreToolUse coverage per docs: Bash, exec_command (matches as "Bash"), apply_patch (matches apply_patch, Edit or Write), MCP tools (mcp__server__tool), "other local function tools" (example update_plan; spawn_agent also matches Agent). Hosted tools such as WebSearch: no. Docs add: "Some specialized tool paths can opt out of the default hook path."
- Question tool: in source (main branch, not the installed 0.169.0 tag, so a partial guess) the tool's name is `request_user_input` (const REQUEST_USER_INPUT_TOOL_NAME in core/src/tools/handlers/request_user_input_spec.rs). Its handler (handlers/request_user_input.rs) has no pre_tool_use_payload override, and the registry default (registry.rs ~line 176) returns a payload for any Function-payload tool, using the tool's name. So PreToolUse most likely fires with tool_name "request_user_input". NOT tested live (that would need a model turn). `request_user_input_async` also exists in the 0.169 binary strings (11 hits); I did not find whether it is a tool name or an event/feature name, and did not check whether it fires hooks. Binary also has a restriction: "request_user_input can only be used by the root thread", and it is unavailable in some collaboration modes (request_user_input_unavailable_message).
- Matchers: regex strings. Docs: "The matcher field is a regex string"; `"*"`, `""` or omitted match everything. Source: HookMatcher::new compiles the pattern; tests use "^Bash$", "Edit|Write", "*", "". Pipe-separated names work as alternation, and unanchored patterns would match substrings (e.g. "Bash" also matches a tool whose name contains Bash; use ^...$ to be exact). Events that ignore matcher: UserPromptSubmit, Stop, Interrupt.
- Implication for the app: current matcher "Bash|exec_command|apply_patch" is fine. To catch the question tool either add `|request_user_input` (changes the hook's hash, so trust prompt again, test D) or add a second PreToolUse group (new untrusted hook only, baseline untouched, test C). Adding Interrupt is accepted and independent but is a new untrusted hook; the person approves it on the review screen. All variants leave the other hooks working.

## Cleanup
No codex process left running (checked with ps). No files in the repo or ~/.codex were written by me (the installer updated the global npm package only).

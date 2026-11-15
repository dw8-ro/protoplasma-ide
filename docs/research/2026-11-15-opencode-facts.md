# OpenCode 1.19.5: flags, plugins and loading, checked 15 Nov 2026

Raw notes from a check on David's Mac (OpenCode installed with `npm install -g opencode-ai`). No prompt was sent to a
model, so the plugin hooks themselves were read from the package and the binary, not run. Used for phase 2 of
[the plan](../plan.md).

## Part 1 install
- `npm install -g opencode-ai` OK. `opencode --version` -> 1.19.5. Path /opt/homebrew/bin/opencode -> /opt/homebrew/lib/node_modules/opencode-ai/bin/opencode.exe (native binary in node_modules/opencode-darwin-arm64; no JS source in package).
## A. Flags (opencode --help, default TUI command `opencode [project]`)
- Yes: -c/--continue, -s/--session <id>, --fork, --prompt <text>, -m/--model provider/model, --agent, positional [project] path, --pure (run without external plugins), --auto (auto-approve permissions not denied; dangerous), --mini (minimal interface), --print-logs, --log-level.
- Conclusion: main.js's `--continue` and `--prompt <text>` both exist for the TUI in 1.19.5.
## B. V2
- `opencode upgrade --help` has `--major  upgrade to OpenCode 2 and remove OpenCode 1` (so in-app/CLI upgrade REPLACES V1; not run). `opencode debug v2` exists in 1.19.5 ("debug v2 catalog and built-in plugins"). npm dist-tags of opencode-ai: latest=1.19.5, `tui-v2`=0.0.0-tui-v2-202606261840, next, beta, dev=0.0.0-dev-202611092046, v1=0.0.0-v1-202510310553 (old). @opencode-ai/plugin 1.19.5 ships `./v2/effect` and `./v2/promise` entry points (plugin API v2 preview). Docs check below.
## C. Plugin interface (from npm pack @opencode-ai/plugin@1.19.5, dist/index.d.ts; scratch pk/package)
Plugin = (input:{client,project,directory,worktree,serverUrl,$,experimental_workspace}, options?) => Promise<Hooks>. PluginModule = {id?, server: Plugin}.
Hooks (input -> output):
- event({event})  [all bus events]
- config(cfg)
- tool{name:ToolDefinition}  [custom tools]
- auth, provider
- chat.message({sessionID,agent?,model?,messageID?,variant?}, {message:UserMessage, parts:Part[]})  [user prompt text is in parts (text parts); parts is mutable]
- chat.params, chat.headers
- permission.ask(input:Permission, output:{status:"ask"|"deny"|"allow"})
- command.execute.before({command,sessionID,arguments}, {parts})
- tool.execute.before({tool,sessionID,callID}, {args:any})   [args mutable; throw to block]
- tool.execute.after({tool,sessionID,callID,args}, {title,output,metadata})
- shell.env({cwd,sessionID?,callID?}, {env})
- experimental.chat.messages.transform({}, {messages:{info,parts}[]})
- experimental.chat.system.transform({sessionID?,model}, {system:string[]})
- experimental.provider.small_model, experimental.session.compacting({sessionID},{context[],prompt?}), experimental.compaction.autocontinue, experimental.text.complete, tool.definition({toolID},{description,parameters})
### B (continued): V2
- Docs (https://opencode.ai/docs/migrate-v1/): "OpenCode 1 and OpenCode 2 both use the opencode command and are no longer installed side by side by default. Remove a package-managed V1 installation before installing V2; the V2 curl installer replaces the V1 binary." V1 plugin implementations do NOT run in V2 (new plugin API, `Plugin.define({id, setup(ctx)})` from `@opencode/plugin`). Server API and TUI config (cli.json) also changed. Config locations unchanged. V1 `permission` config still accepted; native V2 uses ordered `permissions` array (actions shell/edit/subagent..., bash->shell, write+patch->edit).
- Ways to V2: `opencode upgrade --major` (upgrades to OpenCode 2 AND removes V1), TUI `/update` (offers OpenCode 2 only when V1 is current), curl installer. npm dist-tag `tui-v2` exists but unverified. Side-by-side: not supported by default; one could in principle install a V2 under a different npm prefix, but NOT TESTED and V1 must not be replaced here. Did NOT install V2.
- V2 TUI docs (https://opencode.ai/docs/cli/tui/, /docs/cli/): no mention of --continue or --prompt anywhere in V2 docs I fetched (cli, tui, config, migrate, plugins). V2 docs only say `opencode mini --help` shows "session, model, agent, prompt, and replay options". UNKNOWN whether V2 TUI keeps them (not checkable without V2 installed). V2 by default uses ONE SHARED background server per user (`--standalone` for a private server, `--server <url>`), which owns config/permissions/tool execution; so a per-run plugin env var may be ignored by an already-running shared service (relevant for hooks). Plugin config key in V2 is `plugins` (V1: `plugin`).
- V2 plugin hook mapping from migration doc: chat.message -> ctx.session.hook("prompt"), tool.execute.before -> ctx.tool.hook("execute.before", ev) (ev.tool, ev.input; throw to block), shell.env -> ctx.shell.hook("create.before"), event -> ctx.event.subscribe().
- V1 docs (https://opencode.ai/v1/docs/plugins/): load from .opencode/plugins/ and ~/.config/opencode/plugins/, or npm names in `plugin` array of opencode.json; example plugin throws Error in tool.execute.before to block a read.
### C (events, from @opencode-ai/sdk@1.19.5 types.gen.d.ts)
- Event union: message.updated/removed, message.part.updated/removed, permission.updated (props = Permission {id,type,pattern?,sessionID,messageID,callID?,title,metadata}), permission.replied {sessionID,permissionID,response}, session.status {sessionID,status: idle|retry|busy...}, session.idle, session.error {sessionID?,error: ProviderAuthError|UnknownError|MessageOutputLengthError|MessageAbortedError|ApiError} (MessageAbortedError = interrupt), session.created/updated/deleted/diff/compacted, file.edited, todo.updated, command.executed, tui.*, pty.*, server.*. (V1 docs list permission.asked; the 1.19.5 SDK type says permission.updated, treat both as possible.)
## D. Loading a plugin for one run (CHECKED with `opencode debug config`, which DOES load plugins without any model call)
- Probe plugins in scratch (probe/abs-plugin.js, probe/cfgdir/plugins/probe.js) append to probe/loaded.log when initialised. Project folder (probe/proj, a fresh git repo) stayed empty: nothing written into it.
- `OPENCODE_CONFIG_CONTENT='{"plugin":["file:///abs/path/plugin.js"]}' opencode debug config` -> printed resolved config with `plugin` and `plugin_origins` (source OPENCODE_CONFIG_CONTENT, scope local), AND the plugin ran (log line "abs loaded dir=<cwd>"). A plain absolute path (no file://) in OPENCODE_CONFIG's JSON also worked (source = that file, scope global).
- `OPENCODE_CONFIG_DIR=<dir>`: plugins in <dir>/plugins/*.js auto-discovered and loaded; <dir>/opencode.json also read (permission block shown). Works.
- `OPENCODE_CONFIG=<file>` works (file merged). `OPENCODE_PERMISSION='{"bash":"ask"}'` shows up as `permission` in the resolved config (in that run it showed only that, merged result not fully explored).
- `--pure` (or OPENCODE_PURE) = run without external plugins: plugin did NOT load. So do not pass --pure.
- Other env vars found in the binary (strings): OPENCODE_CONFIG, OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG_DIR, OPENCODE_PERMISSION, OPENCODE_DISABLE_PROJECT_CONFIG, OPENCODE_DISABLE_DEFAULT_PLUGINS, OPENCODE_DISABLE_AUTOUPDATE, OPENCODE_PURE, OPENCODE_TUI_CONFIG, OPENCODE_DB, OPENCODE_AUTH_CONTENT, OPENCODE_DISABLE_CLAUDE_CODE, OPENCODE_SERVER_PASSWORD/USERNAME, OPENCODE_EXPERIMENTAL*, ... (full list in opencode-check/envs.txt).
- Side effect seen: ~/.config/opencode now has node_modules, package.json, package-lock.json. opencode (not me) created these on a run; was not checked whether they existed before. Content is plugin-dependency install; harmless.
- Caveat: tool.execute.before etc. were NOT exercised, because that needs a model turn. Only loading is verified.
## C (continued): what 1.19.5 really triggers (checked in the binary's bundled JS via `strings`)
- Hooks actually triggered (trigger("...") calls found): chat.headers, chat.message, chat.params, command.execute.before, experimental.chat.messages.transform, experimental.chat.system.transform, experimental.compaction.autocontinue, experimental.provider.small_model, experimental.session.compacting, experimental.text.complete, shell.env, tool.definition, tool.execute.after, tool.execute.before. (`event` is delivered separately.)
- `permission.ask` is declared in @opencode-ai/plugin types but NO trigger("permission.ask") exists in the 1.19.5 binary: treat it as DEAD (never called). Also the event is named `permission.asked` (not permission.updated): properties {id, sessionID, permission, patterns, metadata}; `permission.replied` {sessionID, requestID, reply}.
- tool.execute.before is called inside the tool's execute wrapper right before the tool runs: input {tool: <tool id>, sessionID, callID}, output {args}. Throwing an Error there aborts the call and the model sees the error (documented example: .env protection throws). It cannot make OpenCode ask.
- Answers: (1) see call before it runs: yes, tool.execute.before (tool id + args). (2) block: yes by throwing (no person asked). ASK the person: no direct hook. Ways: config `permission` rules (edit/bash "ask", static patterns, e.g. via OPENCODE_PERMISSION or config JSON) make OpenCode's own prompt appear; a plugin could also register a custom tool of the same name (plugin tools take precedence) that calls context.ask({permission,patterns,always,metadata}) - not tested. (3) add text the model sees: experimental.chat.system.transform (output.system.push) or chat.message (push a synthetic text part into output.parts); both are triggered. (4) turn start: chat.message / event session.status busy; idle: event session.idle or session.status idle; permission asked: event permission.asked (replied: permission.replied); interrupt: event session.error with error MessageAbortedError (per SDK type; not exercised live). (5) person's prompt text: chat.message output.parts (type "text") / message.part.updated events.
- All of this is from types and bundled code; NO hook was run live (needs a model turn, forbidden).
## E. Folder trust / provider
- No folder-trust text found in the binary (search for trust+folder/directory/workspace found only bun's trustedDependencies messages). Docs mention no trust prompt. Safety is by permissions (external_directory defaults to "ask"). Not verified by seeing the TUI: started it under `script` with a pty that never answers terminal queries, output was just the logo + query escapes; killed by alarm; no leftover process.
- `opencode providers list` -> "0 credentials" on this Mac (~/.local/share/opencode/auth.json), and the bundle has "No providers are available" errors, but the docs say the TUI opens and you add one with /connect. Treat "TUI opens without a provider" as documented, not verified.
## F. Tool ids and args (from bundled tool definitions, 1.19.5)
- bash: {command, timeout?, workdir?}   (permission name "bash")
- edit: {filePath, oldString, newString, replaceAll?}
- write: {filePath, content}
- apply_patch: {patchText}   (full patch text with add/update/delete operations; the plugin must parse the file paths from it)
- others: read (filePath), glob, grep, lsp, skill, todowrite, webfetch, websearch, question, plan_exit, task (subagents).
- Permission names: edit covers edit/write/apply_patch (docs); bash; external_directory; etc.
- V1 docs: some models (GPT family) use apply_patch instead of edit/write (not verified here).
- NOTE for hooks: the binary also contains the V2 core (tool id "shell" for bash in V2 plugin API: permission action `shell`), but plugin API in 1.19.5 V1 mode is the string-keyed hooks above.
## Cleanup
- No processes left. Scratch: opencode-check/. Not touched: repo, ~/.codex, ~/.claude. ~/.config/opencode got node_modules/package.json/package-lock.json created by opencode itself (plugin dependency install).

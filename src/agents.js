// Everything the app knows about each agent CLI, in one table. main.js, lane.js and the hook relay read it, and the
// window draws its pickers from what main.js passes on (`agents:status`). The hub doesn't read it: it only sees hooks,
// in one shape, whoever sent them.
// To add a CLI: an entry in AGENTS. Without `hooks` it still gets a shared terminal, a status guessed from its output,
// overlaps from git and the pre-push guard, which is also what "Other command" gets.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EDIT_TOOLS, ASK_TOOLS } = require('./shared');

// Per-run HTTP hooks for Claude Code. --settings merges with the user's own settings rather than replacing them.
// Hooks authenticate with a per-lane secret, so no GitHub or team credential enters Claude's environment.
// If the hub is down the hooks fail open and the agent keeps working.
function claudeHookSettings(url) {
  const hook = { type: 'http', url, timeout: 3, headers: { Authorization: 'Bearer $PROTO_HOOK_SECRET' }, allowedEnvVars: ['PROTO_HOOK_SECRET'] };
  return JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [hook] }],
    // Read: deliver a file's notes before any edit. Bash: confirm risky pushes. Edits are recorded here too: there's no
    // PostToolUse, which would send the hub every tool's whole output (files read, command output, MCP results).
    // The asking tools: a question or a plan to approve shows as "needs you".
    PreToolUse: [{ matcher: ['Read', 'Bash', ...EDIT_TOOLS, ...ASK_TOOLS].join('|'), hooks: [hook] }],
    PermissionRequest: [{ hooks: [hook] }],
    Stop: [{ hooks: [hook] }],
  } });
}

// Codex's hooks for one run (`-c`, its "session flags" layer). Codex runs a command instead of calling an address, so
// the command posts the hook to $PROTO_HOOK_URL with the lane's secret. The command never changes: Codex trusts a hook
// by its hash, so the person approves it once. Outside Protoplasma, with no URL set, it does nothing.
const CODEX_HOOK = '[ -z "$PROTO_HOOK_URL" ] || curl -s --max-time 3 -H "Authorization: Bearer $PROTO_HOOK_SECRET"'
  + ' -H "content-type: application/json" --data-binary @- "$PROTO_HOOK_URL" || true';
function codexHookSettings() {
  // JSON strings are valid TOML strings. apply_patch is Codex's edit tool; exec_command is its other shell.
  // Codex trusts each hook by its place (event, group) and its text (matcher, timeout, command): changing one of the
  // first four would have everyone review it again, and a new one is reviewed once on its own. So those four stay
  // exactly as they are, and later ones go after them: its question tool as a second PreToolUse group, and Interrupt
  // (3 s is the most Codex gives it). Check a change with `node scripts/codex-hooks.js`.
  const group = (matcher, timeout = 5) => `{${matcher ? `matcher=${JSON.stringify(matcher)},` : ''}hooks=[{type="command",command=${JSON.stringify(CODEX_HOOK)},timeout=${timeout}}]}`;
  return `hooks={UserPromptSubmit=[${group()}],PreToolUse=[${group('Bash|exec_command|apply_patch')},${group('request_user_input')}],PermissionRequest=[${group()}],Stop=[${group()}],Interrupt=[${group('', 3)}]}`;
}

// OpenCode's hooks are a plugin (opencode-plugin.mjs), which OpenCode loads from a file. One inside the packaged app
// isn't a file it can read, so a copy goes in this person's temp folder, named by its contents.
function opencodePlugin() {
  const text = fs.readFileSync(path.join(__dirname, 'opencode-plugin.mjs'), 'utf8');
  const file = path.join(os.tmpdir(), `protoplasma-opencode-${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}.js`);
  try { if (fs.readFileSync(file, 'utf8') === text) return file; } catch {}
  fs.writeFileSync(`${file}.${process.pid}`, text, { mode: 0o600 });
  fs.renameSync(`${file}.${process.pid}`, file);
  return file;
}
// OpenCode takes extra settings as JSON in its environment. Whatever the person already passes that way is kept.
function opencodeConfig(env) {
  let config = {};
  try { config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}') || {}; } catch {}
  if (typeof config !== 'object' || Array.isArray(config)) config = {};
  return JSON.stringify({ ...config, plugin: [...(Array.isArray(config.plugin) ? config.plugin : []), `file://${opencodePlugin()}`] });
}

/**
 * One entry per CLI, keyed by its command.
 * - name: what the app calls it. install: the command that gets it.
 * - resume: arguments that pick up its last conversation in the folder. Without it, the app can't resume it.
 * - firstPrompt: how it takes a first message, as arguments of its own (never through a shell). Without it, the app
 *   can't start it with one.
 * - hooks({url, env}): what to add to its arguments and environment so its hooks reach `url` (the relay) in the shape
 *   the hub reads (onHook in hub.js). An agent with hooks also gets PROTO_HOOK_SECRET. Without it, no hooks.
 * - sure: its hooks work from the first prompt, with nothing for the person to approve first. So its status isn't
 *   guessed from its output, and it needs no pre-push guard on a shared team.
 * - asks: a hook's answer can make it ask the person. The others are refused once instead (teams.js refuseOnce).
 * - digits: a digit key answers its dialogs (lane.js `decided`).
 */
const AGENTS = {
  claude: { name: 'Claude Code', install: 'npm install -g @anthropic-ai/claude-code', resume: ['--continue'], firstPrompt: p => [p],
    hooks: ({ url }) => ({ args: ['--settings', claudeHookSettings(url)] }), sure: true, asks: true, digits: true },
  codex: { name: 'Codex', install: 'npm install -g @openai/codex', resume: ['resume', '--last'], firstPrompt: p => [p],
    hooks: ({ url }) => ({ args: ['-c', codexHookSettings()], env: { PROTO_HOOK_URL: url } }) },
  opencode: { name: 'OpenCode', install: 'npm install -g opencode-ai', resume: ['--continue'], firstPrompt: p => ['--prompt', p],
    hooks: ({ url, env }) => ({ env: { PROTO_HOOK_URL: url, OPENCODE_CONFIG_CONTENT: opencodeConfig(env) } }) },
};

/** A command line as its words: quotes keep spaces together and are dropped, as a shell would. Nothing is run through one. */
const commandWords = line => (String(line ?? '').match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) || []).map(w => w.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b));

module.exports = { AGENTS, commandWords, claudeHookSettings, CODEX_HOOK, codexHookSettings, opencodeConfig };

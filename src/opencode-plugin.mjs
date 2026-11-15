// Protoplasma's hooks for OpenCode, as an OpenCode plugin. OpenCode loads this file itself (agents.js names a copy of it
// in OPENCODE_CONFIG_CONTENT), so it runs inside OpenCode, not inside the app. It posts the events Claude Code's hooks
// do, in the same shape, to the app's relay on this Mac ($PROTO_HOOK_URL, with the agent's own secret), and acts on
// the two things an answer can hold: context for the model, and a refusal with its reason.
// ponytail: written from OpenCode 1.19.5's plugin types and checked against a stand-in relay (test/agents.test.js),
// not yet against a live model. docs/research/2026-11-15-opencode-facts.md has what it rests on. OpenCode 2 has
// another plugin API and doesn't load this one; an agent without hooks still works, with its status guessed.
export const Protoplasma = async ({ directory } = {}) => {
  const url = process.env.PROTO_HOOK_URL, secret = process.env.PROTO_HOOK_SECRET;
  if (!url || !secret) return {}; // started outside Protoplasma: nothing to do
  const post = async event => {
    try {
      const res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(3000),
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ cwd: directory, ...event }) });
      const text = res.ok ? await res.text() : '';
      return (text && JSON.parse(text).hookSpecificOutput) || {};
    } catch { return {}; } // the app or the hub is away: OpenCode carries on
  };
  // OpenCode's tools as the hub knows them, each with the one argument the hub reads. Others aren't reported.
  const TOOLS = {
    bash: a => ['Bash', { command: a.command }], read: a => ['Read', { file_path: a.filePath }],
    edit: a => ['Edit', { file_path: a.filePath }], write: a => ['Write', { file_path: a.filePath }],
    apply_patch: a => ['apply_patch', { command: a.patchText }],
    question: () => ['AskUserQuestion', {}], plan_exit: () => ['ExitPlanMode', {}],
  };
  const context = new Map(); // session id -> what the team wants the model to know with its requests this turn
  const tell = (session, text) => { if (text) context.set(session, [context.get(session), text].filter(Boolean).join('\n\n')); };
  return {
    'chat.message': async ({ sessionID } = {}, { parts } = {}) => {
      context.delete(sessionID);
      const prompt = (parts || []).filter(p => p.type === 'text' && !p.synthetic).map(p => p.text).join('\n');
      tell(sessionID, (await post({ hook_event_name: 'UserPromptSubmit', prompt })).additionalContext);
    },
    'experimental.chat.system.transform': async ({ sessionID } = {}, { system } = {}) => { if (context.has(sessionID)) system?.push(context.get(sessionID)); },
    'tool.execute.before': async ({ tool, sessionID } = {}, { args } = {}) => {
      const known = TOOLS[tool]?.(args || {});
      if (!known) return;
      const answer = await post({ hook_event_name: 'PreToolUse', tool_name: known[0], tool_input: known[1] });
      tell(sessionID, answer.additionalContext); // a file's notes go with its next request: a tool call can't carry them
      // OpenCode can't be made to ask from here, so the relay refuses a step once, and lets it through when it's tried again.
      if (answer.permissionDecision === 'deny') throw new Error(answer.permissionDecisionReason || 'Protoplasma stopped this step. Ask the person first.');
    },
    event: async ({ event } = {}) => {
      const type = event?.type;
      if (type === 'permission.asked' || type === 'permission.updated') await post({ hook_event_name: 'PermissionRequest' });
      else if (type === 'permission.replied') await post({ hook_event_name: 'PreToolUse' }); // answered: back at work
      else if (type === 'session.idle') await post({ hook_event_name: 'Stop' });
      else if (type === 'session.error' && event.properties?.error?.name === 'MessageAbortedError') await post({ hook_event_name: 'Interrupt' });
    },
  };
};

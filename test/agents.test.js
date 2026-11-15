// The agent table (src/agents.js), and OpenCode's hooks, which are a plugin OpenCode loads itself: here it's loaded the
// same way and run against a stand-in for the app's relay.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { AGENTS, commandWords, opencodeConfig } = require('../src/agents');

const made = []; // temp files to remove
after(() => { for (const f of made) fs.rmSync(f, { force: true }); });

test('every agent in the table has what the app reads of it', () => {
  for (const [cmd, a] of Object.entries(AGENTS)) {
    assert.match(cmd, /^[a-z][\w-]*$/, cmd);
    assert.ok(a.name && a.install, `${cmd}: a name and how to get it`);
    assert.ok(Array.isArray(a.resume) && a.resume.every(w => typeof w === 'string'), `${cmd}: resume arguments`);
    assert.deepEqual(a.firstPrompt('-do it').length > 0 && a.firstPrompt('do it').at(-1), 'do it', `${cmd}: a first message as its own argument`);
    const hooked = a.hooks?.({ url: 'http://127.0.0.1:1/hooks/h-x', env: {} });
    if (!hooked) continue;
    made.push(...Object.values(hooked.env || {}).flatMap(v => /file:\/\/([^"]+)/.exec(v)?.[1] || []));
    assert.ok((hooked.args || []).every(w => typeof w === 'string') && Object.values(hooked.env || {}).every(v => typeof v === 'string'), `${cmd}: hooks as arguments and environment`);
    assert.ok(JSON.stringify(hooked).includes('127.0.0.1:1/hooks/h-x') || cmd === 'codex', `${cmd}: its hooks are pointed at the relay`); // Codex's command reads it from its environment
  }
  assert.equal(AGENTS.codex.hooks({ url: 'http://r/hooks/x', env: {} }).env.PROTO_HOOK_URL, 'http://r/hooks/x');
  assert.ok(AGENTS.claude.sure && AGENTS.claude.asks && !AGENTS.codex.sure && !AGENTS.codex.asks, 'only Claude Code\'s hooks are sure and can ask');
});

test('an "Other command" is split into words without a shell', () => {
  assert.deepEqual(commandWords('gemini'), ['gemini']);
  assert.deepEqual(commandWords('  cursor-agent --model "gpt 5"  --flag=\'a b\' '), ['cursor-agent', '--model', 'gpt 5', '--flag=a b']);
  assert.deepEqual(commandWords('aider; rm -rf ~'), ['aider;', 'rm', '-rf', '~'], 'a semicolon is just part of a word');
  assert.deepEqual(commandWords(''), []);
  assert.deepEqual(commandWords(undefined), []);
});

test('OpenCode gets the plugin beside whatever settings the person already passes it', () => {
  const config = JSON.parse(opencodeConfig({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'x', plugin: ['their-plugin'] }) }));
  const file = /^file:\/\/(.+)$/.exec(config.plugin[1])[1];
  made.push(file);
  assert.deepEqual([config.theme, config.plugin[0]], ['x', 'their-plugin']);
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(path.join(__dirname, '../src/opencode-plugin.mjs'), 'utf8'), 'a copy OpenCode can read as a file');
  assert.equal(JSON.parse(opencodeConfig({ OPENCODE_CONFIG_CONTENT: 'not json' })).plugin.length, 1, 'settings that aren\'t JSON are left out, not passed on broken');
});

test('OpenCode\'s plugin reports what Claude Code\'s hooks do, and acts on the answers', async () => {
  const seen = [];
  let reply = {};
  const relay = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; }).on('end', () => { seen.push({ auth: req.headers.authorization, ...JSON.parse(body) }); res.writeHead(200).end(JSON.stringify(reply)); });
  });
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  const { Protoplasma } = await import('../src/opencode-plugin.mjs');
  assert.deepEqual(await Protoplasma({ directory: '/r' }), {}, 'outside Protoplasma it does nothing');
  Object.assign(process.env, { PROTO_HOOK_URL: `http://127.0.0.1:${relay.address().port}/hooks/h-oc`, PROTO_HOOK_SECRET: 'a-hook-secret-0123456789' });
  try {
    const hooks = await Protoplasma({ directory: '/r' });
    reply = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Max is on a.ts' } };
    await hooks['chat.message']({ sessionID: 's1' }, { parts: [{ type: 'text', text: 'fix the lobby' }, { type: 'text', text: 'made up', synthetic: true }, { type: 'file' }] });
    assert.deepEqual(seen.pop(), { auth: 'Bearer a-hook-secret-0123456789', cwd: '/r', hook_event_name: 'UserPromptSubmit', prompt: 'fix the lobby' });
    const system = ['You are OpenCode.'];
    await hooks['experimental.chat.system.transform']({ sessionID: 's1' }, { system });
    assert.deepEqual(system, ['You are OpenCode.', 'Max is on a.ts'], 'the team\'s context goes with the model\'s request');
    await hooks['experimental.chat.system.transform']({ sessionID: 'another' }, { system });
    assert.equal(system.length, 2, 'only in the session it was for');

    reply = {};
    for (const [tool, args, as] of [['bash', { command: 'git push' }, ['Bash', { command: 'git push' }]], ['edit', { filePath: '/r/a.ts', oldString: 'x' }, ['Edit', { file_path: '/r/a.ts' }]],
      ['write', { filePath: '/r/b.ts', content: 'secret' }, ['Write', { file_path: '/r/b.ts' }]], ['apply_patch', { patchText: '*** Update File: c.ts' }, ['apply_patch', { command: '*** Update File: c.ts' }]],
      ['question', {}, ['AskUserQuestion', {}]]]) {
      await hooks['tool.execute.before']({ tool, sessionID: 's1' }, { args });
      const { tool_name, tool_input, hook_event_name } = seen.pop();
      assert.deepEqual([hook_event_name, tool_name, tool_input], ['PreToolUse', ...as], tool);
    }
    await hooks['tool.execute.before']({ tool: 'grep', sessionID: 's1' }, { args: {} });
    assert.equal(seen.length, 0, 'tools the hub doesn\'t read aren\'t reported');

    reply = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Protoplasma: Max already edited a.ts. Ask the person.', additionalContext: 'a note on a.ts' } };
    await assert.rejects(hooks['tool.execute.before']({ tool: 'edit', sessionID: 's1' }, { args: { filePath: '/r/a.ts' } }), /Max already edited a\.ts/, 'a refusal stops the step with its reason');
    seen.pop();
    const next = [];
    await hooks['experimental.chat.system.transform']({ sessionID: 's1' }, { system: next });
    assert.match(next[0], /Max is on a\.ts[\s\S]*a note on a\.ts/, 'a file\'s notes join the context');

    reply = {};
    const events = [['permission.asked', 'PermissionRequest'], ['permission.replied', 'PreToolUse'], ['session.idle', 'Stop']];
    for (const [type, name] of events) { await hooks.event({ event: { type } }); assert.equal(seen.pop().hook_event_name, name, type); }
    await hooks.event({ event: { type: 'session.error', properties: { error: { name: 'MessageAbortedError' } } } });
    assert.equal(seen.pop().hook_event_name, 'Interrupt', 'the person stopped the turn');
    await hooks.event({ event: { type: 'session.error', properties: { error: { name: 'ApiError' } } } });
    await hooks.event({ event: { type: 'message.updated' } });
    assert.equal(seen.length, 0, 'nothing else is reported');

    relay.close();
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's1' }, { args: { command: 'ls' } }); // the app is away: it carries on
  } finally { delete process.env.PROTO_HOOK_URL; delete process.env.PROTO_HOOK_SECRET; relay.close(); }
});

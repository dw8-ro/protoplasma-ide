const { js, click, clickText, type, key, until, check, run, sleep, hook, root } = require('./drive');
const fs = require('fs'), path = require('path');
const typeInTerminal = async (who, laneId, text) => {
  await click(who, `[data-lane="${laneId}"] .xterm-screen, .lane[data-id="${laneId}"] .xterm-screen`).catch(async () => { await js(who, `terms.get(${JSON.stringify(laneId)}).term.focus(); return 1`); });
  await js(who, `terms.get(${JSON.stringify(laneId)}).term.focus(); return 1`);
  await type(who, text); await key(who, 'enter');
};
run('2. A session with agents: start, join, overlap', async () => {
  await click('david', '#navSessions'); await click('david', '#new');
  check('New opens the New session dialog', await until('david', `$('#agent').open && $('#agentTitle').textContent === 'New session'`, 3000));
  await click('david', '#session'); await type('david', 'Login page');
  await click('david', '#task'); await type('david', 'Fix the login form');
  await click('david', 'label:has(input[name=source][value=repo])');
  await click('david', '#repo'); await type('david', 'david/playground');
  const picker = await js('david', `return $('#repoPicker').textContent.trim()`);
  check('the repo picker explains itself without a signed-in GitHub CLI', /GitHub CLI|reach GitHub|Not in your list|Start the agent/.test(picker), picker.slice(0, 120));
  await click('david', '#startAgent');
  const started = await until('david', `!$('#agent').open && view === 'session' && current === 'Login page' && local.size === 1`, 20000);
  check('Start the session opens the session with David\'s agent', started, await js('david', `return { err: $('#agentErr').textContent, open: $('#agent').open, view, current, dialogs: window.__dialogs }`));
  const davidLane = await js('david', 'return [...local.keys()][0]');
  const folder = path.join(root, 'david/home/Protoplasma/david/playground@login-page');
  check('it works in its own folder on session/login-page', fs.existsSync(folder) && require('child_process').execFileSync('git', ['branch', '--show-current'], { cwd: folder, encoding: 'utf8' }).trim() === 'session/login-page');
  check('the agent\'s terminal shows it running', await until('david', `terms.get(${JSON.stringify(davidLane)})?.term.buffer.active.getLine(0)?.translateToString().includes('Claude Code')`, 8000));
  check('the goal is shown', await js('david', `return $('#roomTask').textContent`) === 'Fix the login form');

  // Max finds it.
  await click('max', '#navSessions');
  check('Max sees the session, with David\'s agent', await until('max', `!!$('#sessions [data-session="Login page"]') && hubLanes.some(l => l.session === 'Login page' && l.login === 'david')`, 8000));
  await click('max', '#sessions [data-session="Login page"]');
  check('Max opens it and sees David\'s terminal', await until('max', `view === 'session' && current === 'Login page' && terms.has(${JSON.stringify(davidLane)}) && !terms.get(${JSON.stringify(davidLane)}).el.hidden`, 8000));
  check('and its screen', await until('max', `terms.get(${JSON.stringify(davidLane)}).term.buffer.active.getLine(0)?.translateToString().includes('Claude Code')`, 8000));
  // Max adds his own agent to the session.
  await js('max', `openNewAgent('Login page'); return 1`);
  check('Add an agent prefills the session, its goal and repo', await until('max', `$('#agent').open && $('#agentTitle').textContent === 'Add an agent' && $('#task').value === 'Fix the login form' && $('#repo').value === 'david/playground'`, 4000),
    await js('max', `return { title: $('#agentTitle').textContent, task: $('#task').value, repo: $('#repo').value, source: $('input[name=source]:checked').value }`));
  await click('max', '#startAgent');
  check('Max\'s agent starts in the same session', await until('max', `local.size === 1 && hubLanes.filter(l => l.session === 'Login page').length === 2`, 20000), await js('max', `return { err: $('#agentErr').textContent, dialogs: window.__dialogs }`));
  const maxLane = await js('max', 'return [...local.keys()][0]');
  // Both edit the same file through their agents.
  await typeInTerminal('david', davidLane, `echo '// david was here' >> src/lobby/join.ts`);
  await typeInTerminal('max', maxLane, `echo '// max was here' >> src/lobby/join.ts`);
  check('both see an overlap on src/lobby/join.ts', await until('david', `/join\\.ts/.test($('#alerts').textContent) && /Max/.test($('#alerts').textContent)`, 15000) && await until('max', `/join\\.ts/.test($('#alerts').textContent)`, 5000),
    { david: await js('david', `return $('#alerts').textContent.replace(/\\s+/g, ' ').slice(0, 200)`), max: await js('max', `return $('#alerts').textContent.replace(/\\s+/g, ' ').slice(0, 200)`) });
  // David's Claude is about to edit that file: the hub asks first.
  const r = await hook('david', { lane: davidLane, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(folder, 'src/lobby/join.ts') } });
  check('editing a file a teammate changed makes Claude ask', r?.hookSpecificOutput?.permissionDecision === 'ask', r?.hookSpecificOutput?.permissionDecisionReason || JSON.stringify(r));
  const ctx = await hook('david', { lane: davidLane, hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
  check('a prompt gets team context naming Max\'s agent and the goal', /Max/.test(ctx?.hookSpecificOutput?.additionalContext || '') && /Fix the login form/.test(ctx?.hookSpecificOutput?.additionalContext || ''), (ctx?.hookSpecificOutput?.additionalContext || '').slice(0, 300));
  check('David\'s agent shows as working to Max', await until('max', `hubLanes.find(l => l.id === ${JSON.stringify(davidLane)})?.status === 'working'`, 5000));
  await hook('david', { lane: davidLane, hook_event_name: 'PermissionRequest' });
  check('a permission request shows Needs you to David', await until('david', `/needs you/i.test($('#alerts').textContent) || hubLanes.find(l => l.id === ${JSON.stringify(davidLane)})?.status === 'needs you'`, 5000));
  await hook('david', { lane: davidLane, hook_event_name: 'Stop' });
  check('and Stop sets it idle', await until('max', `hubLanes.find(l => l.id === ${JSON.stringify(davidLane)})?.status === 'idle'`, 5000));
});

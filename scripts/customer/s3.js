const { js, click, clickText, type, key, until, check, run, sleep, hook } = require('./drive');
run('3. Plan, notes, comments and renaming', async () => {
  const davidLane = await js('david', 'return [...local.keys()][0]');
  await click('max', '[data-tab="plan"]');
  check('Plan opens from the session panel', await until('max', `!$('#planPanel').hidden`, 3000));
  await click('max', '#stepText'); await type('max', 'Validate the email field'); await key('max', 'enter');
  check('Max adds a plan step', await until('max', `/Validate the email field/.test($('#stepList').textContent)`, 5000), await js('max', `return $('#stepErr').textContent`));
  check('David sees the plan update in the session panel', await until('david', `/0 of 1|1 step|0\\/1/.test($('#panelBody').textContent) || recordFor('Login page')?.steps?.length === 1`, 5000), await js('david', `return $('#panelBody').textContent.replace(/\\s+/g,' ').slice(0,200)`));
  const ctx = await hook('david', { lane: davidLane, hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
  check('agents are told about the plan', /Validate the email field/.test(ctx?.hookSpecificOutput?.additionalContext || ''));
  // tick it off
  const tick = await js('max', `const b = $('#stepList input[type=checkbox], #stepList [data-done], #stepList button'); return b ? b.outerHTML.slice(0, 160) : null`);
  if (tick) { await click('max', '#stepList input[type=checkbox], #stepList [data-done], #stepList button'); }
  check('a step can be ticked off', await until('max', `recordFor('Login page')?.steps?.[0]?.done === true`, 5000), tick);

  await click('david', '#backToAgents').catch(() => {});
  await js('david', `tab = 'memory'; render(); return 1`).catch(() => {});
  await click('david', '[data-tab="memory"]').catch(() => {});
  check('Memory opens', await until('david', `!$('#memoryPanel').hidden`, 3000));
  await click('david', '#memoryText'); await type('david', 'Run npm test before pushing'); await key('david', 'enter');
  check('David adds a team note', await until('david', `/Run npm test before pushing/.test($('#memoryList').textContent)`, 5000), await js('david', `return $('#memoryErr').textContent`));
  check('Max sees it', await until('max', `memories.some(m => /npm test/.test(m.text))`, 5000));
  const ctx2 = await hook('david', { lane: davidLane, hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
  check('and agents get it with each prompt', /npm test/.test(ctx2?.hookSpecificOutput?.additionalContext || ''));

  await click('max', '#backToAgents').catch(() => {});
  await click('max', '#commentText'); await type('max', 'I\'m taking the email validation'); await key('max', 'enter');
  check('Max leaves a comment, and David sees it', await until('david', `/taking the email validation/.test($('#panelBody').textContent + JSON.stringify(sessionRecords))`, 5000));

  // Rename while both agents run.
  await js('david', `tab = 'agents'; panelTab = 'environment'; render(); return 1`);
  await clickText('david', '#panelBody button, #panelBody .panel-row', 'Rename session');
  check('Rename session asks for a new name', await until('david', `$('#renameDlg').open`, 3000));
  await js('david', `$('#renameInput').select(); return 1`);
  await type('david', 'Login form'); await key('david', 'enter');
  check('David renames it', await until('david', `current === 'Login form' && !$('#renameDlg').open`, 5000), await js('david', `return { current, err: $('#renameErr').textContent }`));
  check('Max follows the rename, still in the session', await until('max', `current === 'Login form' && hubLanes.filter(l => l.session === 'Login form').length === 2`, 8000), await js('max', `return { current, sessions: hubLanes.map(l => l.session) }`));
  check('the branch keeps its name', await js('david', `return hubLanes.every(l => l.branch === 'session/login-page')`));
  await js('david', `panelTab = 'session'; render(); return 1`);
});

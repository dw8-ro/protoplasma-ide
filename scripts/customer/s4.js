const { js, click, clickText, type, key, menu, until, check, run, sleep, root } = require('./drive');
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
run('4. Code view: commit, a clash on the shared branch, Pull and fix', async () => {
  if (await js('david', `return $('#code').hidden`)) await click('david', '#codeToggle');
  check('Code opens the code view on the session folder', await until('david', `!$('#code').hidden && code.root && /login-page/.test(code.root)`, 8000));
  check('Source control shows the agent\'s change', await until('david', `code.changes.get('src/lobby/join.ts') === 'M' && $('#changeCount').textContent === '1'`, 8000), await js('david', `return [...code.changes]`));
  await click('david', '[data-code-view="changes"]');
  await click('david', '#commitMessage'); await type('david', 'Note who was here');
  await click('david', '#commitBtn');
  check('David commits and pushes', await until('david', `/Committed and pushed/.test($('#commitNote').textContent)`, 20000), await js('david', `return $('#commitNote').textContent`));

  if (await js('max', `return $('#code').hidden`)) await click('max', '#codeToggle');
  check('Max\'s code view shows his own change', await until('max', `code.changes.get('src/lobby/join.ts') === 'M'`, 8000));
  await click('max', '[data-code-view="changes"]');
  await click('max', '#commitMessage'); await type('max', 'Max was here too');
  await click('max', '#commitBtn');
  check('Max\'s push clashes and offers Pull', await until('max', `/changed the same lines/.test($('#commitNote').textContent) && !$('#pullBtn').hidden`, 20000), await js('max', `return $('#commitNote').textContent`));
  await click('max', '#pullBtn');
  check('Pull marks join.ts C and explains', await until('max', `code.underWay === 'merge' && code.changes.get('src/lobby/join.ts') === 'C' && /Commit & Push finishes it/.test($('#commitNote').textContent)`, 15000), await js('max', `return { u: code.underWay, c: [...code.changes], note: $('#commitNote').textContent }`));
  // Open the file, as a person would, and fix it in the editor.
  await clickText('max', '#codeChanges [data-file]', 'join.ts');
  check('the conflicted file opens in the editor (not a diff) with git\'s conflict lines', await until('max', `code.active === 'src/lobby/join.ts' && !code.diff && /<<<<<<<[\\s\\S]*>>>>>>>/.test(editor.getModel()?.getValue() || '')`, 8000), await js('max', `return { active: code.active, diff: code.diff }`));
  await js('max', `const m = editor.getModel(); editor.focus();
    editor.executeEdits('me', [{ range: m.getFullModelRange(), text: m.getValue().replace(/<<<<<<< [^\\n]*\\n([\\s\\S]*?)=======\\n([\\s\\S]*?)>>>>>>> [^\\n]*\\n/, '$1$2') }]); return 1`);
  await menu('max', 'save');
  check('Save writes it', await until('max', `!isDirty(models.get('src/lobby/join.ts'))`, 5000));
  await click('max', '#commitBtn');
  check('Commit & Push finishes the merge', await until('max', `/Merged and pushed/.test($('#commitNote').textContent)`, 20000), await js('max', `return $('#commitNote').textContent`));
  const remote = execFileSync('git', ['--git-dir', path.join(root, 'origin.git'), 'show', 'session/login-page:src/lobby/join.ts'], { encoding: 'utf8' });
  check('the remote branch has both lines and no conflict lines', /david was here/.test(remote) && /max was here/.test(remote) && !/<<<<<<<|>>>>>>>/.test(remote));
  check('Max has nothing left to commit', await until('max', `code.changes.size === 0 && !code.underWay`, 8000));
  check('David is told he\'s behind (the background fetch uses the repo\'s own ssh command)', await until('david', `hubLanes.find(l => l.login === 'david')?.git?.behind > 0`, 75000), await js('david', `return hubLanes.find(l => l.login === 'david')?.git`));
});

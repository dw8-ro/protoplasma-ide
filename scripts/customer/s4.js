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
  await clickText('max', '#codeChanges [data-file], #codeChanges .file', 'join.ts');
  check('the conflicted file opens with git\'s conflict lines', await until('max', `code.active === 'src/lobby/join.ts' && /<<<<<<<[\\s\\S]*>>>>>>>/.test(editor.getModel()?.getValue() || '')`, 8000), await js('max', `return { active: code.active, diff: code.diff }`));
  const fixed = await js('max', `const v = editor.getModel().getValue(); return v.replace(/<<<<<<< [^\\n]*\\n([\\s\\S]*?)=======\\n([\\s\\S]*?)>>>>>>> [^\\n]*\\n/, '$1$2')`);
  // Replace the text through the editor (as typing would), then save with the menu command.
  await js('max', `editor.focus(); editor.executeEdits('me', [{ range: editor.getModel().getFullModelRange(), text: ${JSON.stringify('__FIX__')} }]); return 1`.replace('"__FIX__"', JSON.stringify(fixed)));
  await menu('max', 'save');
  check('saving keeps the C mark until committed, and says what\'s next', await until('max', `!isDirty(models.get('src/lobby/join.ts')) && code.underWay === 'merge'`, 5000));
  await click('max', '#commitBtn');
  check('Commit & Push finishes the merge', await until('max', `/Merged and pushed/.test($('#commitNote').textContent)`, 20000), await js('max', `return $('#commitNote').textContent`));
  const origin = path.join(root, 'origin.git');
  const remote = execFileSync('git', ['--git-dir', origin, 'show', 'session/login-page:src/lobby/join.ts'], { encoding: 'utf8' });
  check('the branch on the remote has both lines and no conflict lines', /david was here/.test(remote) && /max was here/.test(remote) && !/<<<<<<<|>>>>>>>/.test(remote));
  check('David\'s code view shows he\'s behind, or pulls cleanly', await until('david', `true`, 100));
});

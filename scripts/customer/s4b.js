const { js, click, clickText, type, key, menu, until, check, run, sleep, root } = require('./drive');
const path = require('path'), { execFileSync } = require('child_process');
run('4b. Fixing the conflict and finishing the merge', async () => {
  await clickText('max', '#codeChanges [data-file]', 'join.ts');
  check('clicking the C file shows it with the conflict lines (as a diff)', await until('max', `code.active === 'src/lobby/join.ts' && /<<<<<<</.test(models.get('src/lobby/join.ts')?.model?.getValue() || '')`, 8000), await js('max', `return { diff: code.diff }`));
  await js('max', `const m = models.get('src/lobby/join.ts').model;
    const fixed = m.getValue().replace(/<<<<<<< [^\\n]*\\n([\\s\\S]*?)=======\\n([\\s\\S]*?)>>>>>>> [^\\n]*\\n/, '$1$2');
    (code.diff ? diffEditor.getModifiedEditor() : editor).executeEdits('me', [{ range: m.getFullModelRange(), text: fixed }]); return 1`);
  await menu('max', 'save');
  check('Save writes it', await until('max', `!isDirty(models.get('src/lobby/join.ts'))`, 5000));
  await click('max', '#commitBtn');
  check('Commit & Push finishes the merge', await until('max', `/Merged and pushed/.test($('#commitNote').textContent)`, 20000), await js('max', `return $('#commitNote').textContent`));
  const remote = execFileSync('git', ['--git-dir', path.join(root, 'origin.git'), 'show', 'session/login-page:src/lobby/join.ts'], { encoding: 'utf8' });
  check('the remote branch has both lines and no conflict lines', /david was here/.test(remote) && /max was here/.test(remote) && !/<<<<<<<|>>>>>>>/.test(remote));
  check('Max has nothing left to commit', await until('max', `code.changes.size === 0 && !code.underWay`, 8000));
  check('David is told he\'s behind', await until('david', `hubLanes.find(l => l.login === 'david')?.git?.behind > 0 || /behind/i.test($('#panelBody').textContent)`, 70000), await js('david', `return hubLanes.find(l => l.login === 'david')?.git`));
});

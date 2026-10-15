const { js, click, clickText, type, key, menu, until, check, run, sleep } = require('./drive');
const termText = (who, id) => js(who, `const b = terms.get(${JSON.stringify(id)})?.term.buffer.active; if (!b) return ''; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i)?.translateToString(true) + '\\n'; return s;`);
run('5. Typing into agents, sharing files, stopping, panes, switcher', async () => {
  for (const w of ['david', 'max']) { if (!(await js(w, `return $('#code').hidden`))) await click(w, '#codeToggle'); }
  const davidLane = await js('david', 'return [...local.keys()][0]'), maxLane = await js('max', 'return [...local.keys()][0]');
  // Max's agent isn't open: David can only watch.
  await js('david', `focus = ${JSON.stringify(maxLane)}; tab = 'agents'; render(); return 1`);
  check('a teammate\'s agent that isn\'t open says View only', await until('david', `/View only/.test(document.querySelector('.lane:not([hidden]) .access, [data-lane] .access')?.textContent || $('#room').textContent)`, 4000));
  const before = await termText('max', maxLane);
  await js('david', `terms.get(${JSON.stringify(maxLane)}).term.focus(); return 1`); await type('david', 'echo should-not-arrive'); await key('david', 'enter');
  await sleep(1200);
  check('typing into it does nothing', !(await termText('max', maxLane)).includes('should-not-arrive'));
  // David starts a second agent that teammates may type into.
  await js('david', `openNewAgent(current); return 1`);
  await until('david', `$('#agent').open`, 3000);
  if (!(await js('david', `return $('#open').checked`))) await click('david', 'label:has(#open)');
  await click('david', '#startAgent');
  check('David adds an open agent', await until('david', `local.size === 2`, 15000), await js('david', `return $('#agentErr').textContent`));
  const openLane = await js('david', `return [...local.keys()].find(id => id !== ${JSON.stringify(davidLane)})`);
  await until('max', `hubLanes.some(l => l.id === ${JSON.stringify(openLane)})`, 8000);
  await js('max', `focus = ${JSON.stringify(openLane)}; tab = 'agents'; render(); return 1`);
  check('Max sees "You can type" on it', await until('max', `/You can type/.test($('#room').textContent)`, 4000));
  await click('max', `.xterm-screen`).catch(() => {});
  await js('max', `terms.get(${JSON.stringify(openLane)}).term.focus(); return 1`); await type('max', 'echo typed-by-max'); await key('max', 'enter');
  check('Max\'s typing reaches David\'s open agent', await until('david', `(() => { const b = terms.get(${JSON.stringify(openLane)}).term.buffer.active; for (let i = 0; i < b.length; i++) if (b.getLine(i)?.translateToString().includes('typed-by-max')) return true; })()`, 6000));
  check('and David sees who typed last', await until('david', `/max|Max/.test($('#room').textContent) && /typed|Typed/.test($('#room').textContent)`, 4000), await js('david', `return $('#room').textContent.replace(/\\s+/g, ' ').match(/.{0,40}yped.{0,40}/)?.[0]`));

  // Opening a teammate's changed file: sharing is off by default.
  const davidFirst = davidLane;
  await js('max', `focus = null; tab = 'agents'; render(); return 1`);
  await js('david', `terms.get(${JSON.stringify(davidFirst)}).term.focus(); return 1`); await type('david', `echo '// more' >> src/net/socket.ts`); await key('david', 'enter');
  const canOpen = await until('max', `!!document.querySelector('[data-theirs="${davidFirst}"]')`, 10000);
  check('Max gets an Open link for a file David\'s agent changed', canOpen, await js('max', `return $('#panelBody').textContent.replace(/\\s+/g, ' ').slice(0, 300)`));
  if (canOpen) {
    await click('max', `[data-theirs="${davidFirst}"]`);
    check('with sharing off, opening it explains instead of showing it', await until('max', `/doesn't share files/.test($('#codeBanner')?.textContent || '') && !editor?.getModel()?.getValue()`, 8000),
      await js('max', `return { active: code.active, banner: $('#codeBanner')?.textContent, note: document.body.innerText.match(/.{0,80}(isn't shar|not shar|turn on|Share the files).{0,80}/)?.[0] }`));
    await js('david', `prefs.shareFiles = true; savePrefs(); return 1`);
    await click('max', `[data-theirs="${davidFirst}"]`).catch(() => js('max', `document.querySelector('[data-theirs="${davidFirst}"]').click(); return 1`));
    check('with sharing on, Max opens David\'s version read-only', await until('max', `editor?.getOption(monaco.editor.EditorOption.readOnly) && /more/.test(editor.getModel()?.getValue() || '')`, 10000),
      await js('max', `return { active: code.active, ro: editor?.getOption(monaco.editor.EditorOption.readOnly), text: editor?.getModel()?.getValue()?.slice(-60) }`));
    await js('david', `prefs.shareFiles = false; savePrefs(); return 1`);
  }
  // Stopping an agent; its last screen stays viewable.
  await js('max', `focus = ${JSON.stringify(maxLane)}; tab = 'agents'; render(); if ($('#code') && !$('#code').hidden) showCode(false); return 1`);
  await click('max', `[data-stop="${maxLane}"]`);
  check('Stop stops Max\'s agent', await until('max', `!local.has(${JSON.stringify(maxLane)})`, 8000), await js('max', `return window.__dialogs`));
  check('David sees it under stopped agents', await until('david', `stoppedAgents.some(s => s.id === ${JSON.stringify(maxLane)})`, 8000));
  await js('david', `focus = null; render(); return 1`);
  await click('david', `[data-replay="${maxLane}"]`).catch(e => js('david', `document.querySelector('[data-replay="${maxLane}"]')?.click(); return 1`));
  check('and can look at its last screen', await until('david', `!$('#replayPanel').hidden && $('#replayGone').hidden && !!$('#replayScreen .xterm')`, 8000), await js('david', `return { shown: !$('#replayPanel').hidden, gone: !$('#replayGone').hidden }`));

  // Pane mode and the quick switcher.
  await js('david', `tab = 'agents'; render(); return 1`);
  await click('david', '#newPane');
  check('New pane opens pane mode with the session', await until('david', `view === 'panes' && document.querySelectorAll('#paneGrid [data-pane]').length >= 1`, 5000), await js('david', `return { view, panes: document.querySelectorAll('#paneGrid [data-pane]').length }`));
  await menu('david', 'switcher');
  check('⌘K opens the switcher', await until('david', `$('#switcher').open`, 3000));
  await type('david', 'peo'); await key('david', 'enter');
  check('typing a page name and Enter goes there', await until('david', `view === 'people' && !$('#switcher').open`, 3000));
  await click('david', '#navSessions');
});

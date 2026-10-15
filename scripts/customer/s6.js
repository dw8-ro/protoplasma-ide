const { js, click, clickText, type, key, menu, until, check, run, sleep } = require('./drive');
run('6. Removing, inviting back, leaving, deleting', async () => {
  await js('max', `go('sessions'); openSession('Login form'); openNewAgent('Login form'); return 1`);
  await until('max', `$('#agent').open`, 3000);
  await click('max', '#startAgent');
  check('Max starts an agent again', await until('max', `local.size === 1 && hubLanes.some(l => l.login === 'max')`, 15000));
  const maxLane = await js('max', 'return [...local.keys()][0]');
  await click('david', '#navPeople');
  await clickText('david', '#memberList button', 'Remove');
  check('removing asks first', await until('david', `window.__dialogs.some(d => /max/i.test(d))`, 3000), await js('david', 'return window.__dialogs'));
  check('David removes Max', await until('david', `!/max/.test($('#memberList').textContent)`, 8000));
  check('Max is told he was removed, and the team closes for him', await until('max', `!$('#removedNote').hidden || /removed/i.test(document.body.innerText)`, 8000),
    await js('max', `return { note: $('#removedNote').textContent, team: currentTeam?.name, start: $('#start').open }`));
  check('his agent keeps running on his Mac, no longer shared', await until('max', `local.has(${JSON.stringify(maxLane)})`, 2000) && await until('david', `!hubLanes.some(l => l.login === 'max')`, 8000));
  await click('david', '#inviteBtn'); await type('david', 'max'); await key('david', 'enter');
  check('inviting him back works', await until('david', `/max/.test($('#memberList').textContent)`, 8000));
  const back = await until('david', `hubLanes.some(l => l.id === ${JSON.stringify(maxLane)})`, 40000);
  check('Max\'s running agent rejoins by itself', back, await js('david', `return hubLanes.map(l => l.login)`));
  check('Max can open the team again', await (async () => { await js('max', `showTeams(me); return 1`); await until('max', `[...listedTeams.values()].some(t => t.name === 'Acme')`, 10000); await clickText('max', '#teamList .team', 'Acme'); return until('max', `currentTeam?.name === 'Acme' && $('#conn').className.includes('live')`, 8000); })());
  // Deleting the team while agents run.
  await js('david', `window.__confirmAnswer = true; openSettings('team'); return 1`);
  await until('david', `$('#settings').open`, 3000);
  await click('david', '#teamPane [data-drop-team]').catch(() => {});
  check('deleting a team with agents running is refused, with a reason', await until('david', `/agents|Stop/i.test($('#teamPane').textContent + (window.__dialogs || []).join(' ') + document.body.innerText.match(/.{0,60}(Stop the|agents run).{0,60}/)?.[0])`, 5000),
    await js('david', `return { pane: $('#teamPane').innerText.slice(0, 300), dialogs: window.__dialogs }`));
  await click('david', '#settingsDone');
  // Max leaves.
  await js('max', `window.__confirmAnswer = true; openSettings('team'); return 1`);
  await until('max', `$('#settings').open`, 3000);
  const leave = await js('max', `const b = [...$('#teamPane').querySelectorAll('button')].find(b => /Leave/.test(b.textContent)); return b ? b.textContent : null`);
  check('Max finds Leave team in Settings → Team', !!leave, await js('max', `return $('#teamPane').innerText.slice(0, 200)`));
  if (leave) await clickText('max', '#teamPane button', 'Leave');
  check('Max leaves; his agents in that team stop being shared', await until('max', `currentTeam === null && ![...listedTeams.values()].some(t => t.name === 'Acme')`, 8000) && await until('david', `!/max/.test($('#memberList').textContent)`, 8000),
    await js('max', `return { team: currentTeam?.name, listed: [...listedTeams.values()].map(t => t.name), local: local.size, dialogs: window.__dialogs }`));
});

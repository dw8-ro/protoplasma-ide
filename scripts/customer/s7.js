const { js, click, clickText, type, key, menu, until, check, run, sleep } = require('./drive');
run('7. A team on David\'s Mac, found by Max over the network', async () => {
  await js('david', `showTeams(me); return 1`);
  await until('david', `$('#start').open`, 3000);
  await click('david', 'label:has(input[name=where][value=mac])').catch(() => js('david', `$('input[name=where][value=mac]').click(); return 1`));
  check('choosing This Mac explains who can join', await until('david', `/same Wi-Fi|this network|teammate/i.test($('#whereHint').textContent)`, 2000), await js('david', `return $('#whereHint').textContent`));
  await click('david', '#teamName'); await type('david', 'Garage'); await key('david', 'enter');
  check('David creates a This Mac team', await until('david', `currentTeam?.name === 'Garage' && currentTeam.where === 'This Mac' && $('#conn').className.includes('live')`, 15000),
    await js('david', `return { team: currentTeam?.name, err: $('#createErr').textContent, conn: $('#connText').textContent }`));
  check('its hub is encrypted', await js('david', `return currentTeam?.hub || ''`).then(h => h.startsWith('https://127.0.0.1:')));
  await click('david', '#navPeople'); await click('david', '#inviteBtn'); await type('david', 'max'); await key('david', 'enter');
  check('David invites Max to it', await until('david', `/max/.test($('#memberList').textContent)`, 8000));
  // Max looks for teams on the network.
  await js('max', `showTeams(me); return 1`);
  await until('max', `$('#start').open`, 3000);
  if (!(await js('max', `return $('#findNearby').checked`))) await click('max', 'label:has(#findNearby)').catch(() => click('max', '#findNearby'));
  check('Max turns on Look for teams on this network', await js('max', `return $('#findNearby').checked && prefs.findNearby`));
  const found = await until('max', `[...listedTeams.values()].some(t => t.name === 'Garage')`, 45000);
  check('Max finds David\'s team on the network', found, await js('max', `return { listed: [...listedTeams.values()].map(t => t.name + ' @ ' + t.where), note: $('#teamsNote').textContent }`));
  if (!found) return;
  check('it is labelled as David\'s Mac', await js('max', `return [...listedTeams.values()].find(t => t.name === 'Garage').where`).then(w => /david's Mac/i.test(w)));
  await clickText('max', '#teamList .team', 'Garage');
  check('Max opens it and connects over the encrypted connection', await until('max', `currentTeam?.name === 'Garage' && $('#conn').className.includes('live')`, 15000), await js('max', `return { conn: $('#connText').textContent, hub: currentTeam?.hub }`));
  await js('max', `go('sessions'); openNewAgent('Garage work'); return 1`);
  await until('max', `$('#agent').open`, 3000);
  await click('max', '#startAgent');
  check('Max\'s agent joins the team on David\'s Mac, and David sees it', await until('david', `hubLanes.some(l => l.login === 'max' && l.session === 'Garage work')`, 20000),
    await js('max', `return { err: $('#agentErr').textContent, local: local.size, refused: [...local.values()].map(l => l.refused) }`));
});

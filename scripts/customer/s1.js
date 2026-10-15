const { js, click, clickText, type, key, until, check, run, sleep } = require('./drive');
run('1. First day: create a team, invite a teammate', async () => {
  await click('david', '#teamName'); await type('david', 'Acme');
  await click('david', '#createTeam button[type=submit], #createTeam .btn.primary');
  check('David creates an online team and lands in it', await until('david', `currentTeam?.name === 'Acme' && currentTeam.where === 'Online' && !$('#start').open`, 8000),
    await js('david', `return { team: currentTeam?.name, err: $('#createErr').textContent }`));
  check('it connects to the hub', await until('david', `$('#conn').className.includes('live')`, 8000), await js('david', `return $('#connText').textContent`));
  check('the Sessions page invites starting one', await js('david', `return /No sessions yet/.test($('#sessions').textContent) && !$('#sessionsPage').hidden`));
  await click('david', '#navPeople'); await click('david', '#inviteBtn');
  check('Invite opens a dialog with the field focused', await until('david', `$('#inviteDlg').open && document.activeElement === $('#inviteLogin')`, 3000));
  await type('david', 'max'); await key('david', 'enter');
  check('inviting max works and shows him as a member', await until('david', `!$('#inviteDlg').open && /max/.test($('#memberList').textContent)`, 8000),
    await js('david', `return { err: $('#inviteErr').textContent, list: $('#memberList').textContent.replace(/\\s+/g, ' ') }`));
  // Max: his team list refreshes on its own (or when he looks at it).
  const seen = await until('max', `[...listedTeams.values()].some(t => t.name === 'Acme')`, 35000);
  check('Max sees the team he was invited to without doing anything', seen, await js('max', `return [...listedTeams.values()].map(t => t.name)`));
  if (!seen) await js('max', 'showTeams(me); return 1');
  await until('max', `[...listedTeams.values()].some(t => t.name === 'Acme')`, 8000);
  await clickText('max', '#teamList .team', 'Acme');
  check('Max opens it and connects', await until('max', `currentTeam?.name === 'Acme' && $('#conn').className.includes('live')`, 8000));
  check('both see each other on the People page', await until('david', `/max/.test($('#memberList').textContent)`) && await (async () => { await click('max', '#navPeople'); return until('max', `/david/i.test($('#memberList').textContent) && /Owner/.test($('#memberList').textContent)`); })());
});

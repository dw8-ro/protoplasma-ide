// End-to-end check of the real app: drives the window through its main flows and prints PASS/FAIL per step.
// GitHub is replaced by a local hub with two made-up people, so it runs on any network. David's agents are real
// Claude Code processes (they are never sent a prompt); Max's is a script.
// Usage: npm run e2e
const { app, safeStorage } = require('electron');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hubModule = require('../src/hub');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const people = { 'tok-david': { login: 'david', name: 'David', avatar: '' }, 'tok-max': { login: 'max', name: 'Max', avatar: '' } };
const verifyUser = async token => people[token] || null;
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
// Temporary folders made for the run, removed at the end.
const temps = [];
const tempDir = prefix => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temps.push(dir); return dir; };
// Electron writes its own folder until after the last exit handler, so that one is removed once this process is gone.
process.on('exit', () => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  spawn('sh', ['-c', 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; rm -rf "$2"', 'sh', String(process.pid), app.getPath('userData')], { detached: true, stdio: 'ignore' }).unref();
});
// A run that hangs (a page stuck, a step waiting forever) ends with a failure instead of running on.
setTimeout(() => { console.log('FAIL  the run took longer than 15 minutes'); process.exitCode = 1; app.exit(1); }, 15 * 60_000).unref();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();

// A local "GitHub repo": a bare remote plus the clone the app expects at ~/Protoplasma/<owner>/<name>.
const demoOwner = path.join(os.homedir(), 'Protoplasma', 'protoplasma-e2e');
const hadProtoplasmaDir = fs.existsSync(path.join(os.homedir(), 'Protoplasma'));
function makeDemoRepo() {
  fs.rmSync(demoOwner, { recursive: true, force: true });
  const tmp = tempDir('protoplasma-e2e-remote-');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', path.join(tmp, 'demo.git'));
  fs.mkdirSync(demoOwner, { recursive: true });
  const clone = path.join(demoOwner, 'demo');
  git(demoOwner, 'clone', '-q', path.join(tmp, 'demo.git'), clone);
  git(clone, 'checkout', '-q', '-B', 'main');
  fs.writeFileSync(path.join(clone, 'README.md'), 'demo\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-qm', 'first');
  git(clone, 'push', '-q', '-u', 'origin', 'main');
  git(clone, 'remote', 'set-head', 'origin', 'main');
  return clone;
}

(async () => {
  hubModule.githubUser = verifyUser;
  const hub = `http://127.0.0.1:${(await hubModule.startHub({ port: 0, host: '127.0.0.1', verifyUser })).port}`;
  process.env.PROTO_ONLINE_HUB = hub;
  app.setPath('userData', tempDir('protoplasma-e2e-'));
  await app.whenReady();
  fs.writeFileSync(path.join(app.getPath('userData'), 'github-token'), safeStorage.encryptString(JSON.stringify({ token: 'tok-david', user: people['tok-david'] })));
  app.on('browser-window-created', (_, win) => win.webContents.once('did-finish-load', () => run(win, hub)));
  require('../app/main');
})();

async function run(win, hub) {
  const js = s => win.webContents.executeJavaScript(s);
  const until = async (expr, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(100); } return false; };
  const secretOf = pid => { try { return /PROTO_HOOK_SECRET=(\w+)/.exec(execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }))?.[1]; } catch { return undefined; } };
  // This run's agents only: processes descended from this one (an installed copy or a playground runs its own).
  const claudePids = () => {
    const rows = execFileSync('ps', ['-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n')
      .map(l => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid, ppid, command }));
    const ours = new Set([String(process.pid)]);
    for (let grew = true; grew;) { grew = false; for (const r of rows) if (!ours.has(r.pid) && ours.has(r.ppid)) { ours.add(r.pid); grew = true; } }
    return rows.filter(r => ours.has(r.pid) && r.command.includes('claude --settings') && !r.command.includes('protoplasma-teammate')).map(r => r.pid).filter(pid => secretOf(pid));
  };
  const hook = async (lane, secret, body) => {
    const res = await fetch(`${hub}/hooks/${lane}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ cwd: root, ...body }) });
    return (await res.json().catch(() => null))?.hookSpecificOutput ?? null;
  };
  const secretFile = path.join(os.tmpdir(), `protoplasma-e2e-${process.pid}`);
  let teammate;
  // A native alert would block the page (and every check after it); they're kept for looking at instead. Agents this
  // script stops straight after starting them say "stopped as soon as it started", which is expected here.
  await js(`window.alert = message => (window.__alerts ||= []).push(String(message)); 0`);
  try {
    check('signs in from the saved profile', await until('!!me && me.login === "david"'));
    check('own avatar falls back to an initial', await js(`$('#meAvatar').textContent.trim() === 'D'`));

    await js(`showTeams(me); $('#teamName').value = 'E2E'; $('#createTeam').requestSubmit()`);
    check('creates an online team and connects', await until('!!currentTeam && currentTeam.where === "Online" && $("#conn").className.includes("live")'));
    const team = await js('currentTeam.id');
    check('a new team opens on an empty Sessions page', await until(`!$('#sessionsPage').hidden && /No sessions yet/.test($('#sessions').textContent)`));
    await js(`$('#navPeople').click(); $('#inviteBtn').click(); $('#inviteLogin').value = 'max'; $('#inviteForm').requestSubmit()`);
    check('invites Max from the People page', await until(`currentTeam.members.includes('max') && !$('#inviteDlg').open && /max/.test($('#memberList').textContent) && /Owner/.test($('#memberList').textContent)`));
    await js(`$('#inviteBtn').click(); $('#inviteLogin').value = 'MAX'; $('#inviteForm').requestSubmit()`);
    check('inviting someone twice says so', await until(`/already on the team/.test($('#inviteErr').textContent)`), await js(`$('#inviteErr').textContent`));
    await js(`$('#inviteDlg').close(); $('#navSessions').click()`);

    const fake = path.join(tempDir('protoplasma-teammate-'), 'claude');
    fs.writeFileSync(fake, `#!/bin/sh\necho "$PROTO_HOOK_SECRET" > ${secretFile}\nprintf 'teammate ready\\r\\n'\nexec cat\n`, { mode: 0o755 });
    teammate = spawn('node', [path.join(root, 'src/lane.js'), hub, team, 's1', fake], { cwd: root, env: { ...process.env, PROTO_TOKEN: 'tok-max' }, stdio: 'ignore' });
    check('Max\'s agent appears under his name', await until('hubLanes.length === 1 && hubLanes[0].name === "Max"'));

    // ---- repo picker
    await js(`openNewAgent('s1')`);
    const loaded = await until('!!repos || !!reposError', 20000);
    const online = await js('!!repos');
    // Without GitHub (offline, no GitHub CLI, or not signed in to it) the picker says why instead.
    check(online ? 'repo list loads from GitHub' : 'repo list explains why it can\'t load', loaded && (online || await js(`/reach GitHub|Install the GitHub CLI|Sign in to the GitHub CLI/.test($('#repoPicker').textContent)`)),
      online ? `${await js('repos.length')} repos` : await js(`$('#repoPicker').textContent.trim()`));
    await js(`reposError = ''; repos = [{ name: 'david/lobby', description: 'Game lobby service', private: true, mine: true }, { name: 'david/site', description: '', private: false, mine: true }, { name: 'max/engine', description: 'Shared engine', private: true, mine: false }];
      $('input[name=source][value=repo]').checked = true; syncSource(); $('#repo').value = ''; renderRepoPicker()`);
    check('picker lists your repos and shared ones in groups', await js(`[...$('#repoPicker').querySelectorAll('.repo-group')].map(g => g.textContent).join('|') === 'Yours|Shared with you' && $('#repoPicker').querySelectorAll('.repo-row').length === 3`));
    await js(`$('#repo').value = 'eng'; renderRepoPicker()`);
    check('typing filters the list', await js(`$('#repoPicker').querySelectorAll('.repo-row').length === 1 && $('#repoPicker').textContent.includes('max/engine')`));
    await js(`$('#repoPicker .repo-row').click()`);
    check('clicking a repo selects it', await js(`$('#repo').value === 'max/engine' && $('#repoPicker .repo-row.on')?.dataset.repo === 'max/engine' && $('#repoPicker').querySelectorAll('.repo-row').length === 3`));
    const height = await js(`$('#agent').getBoundingClientRect().height`);
    await js(`$('#session').value = ''; $('#agentForm').requestSubmit()`);
    check('a form error shows without moving the dialog', await js(`$('#agentErr').textContent === 'Name the session.' && $('#agent').getBoundingClientRect().height === ${height}`));
    await js(`$('#session').value = 's1'`);

    // ---- an agent in a folder
    await js(`$('input[name=source][value=folder]').checked = true; syncSource(); $('#cwd').value = ${JSON.stringify(root)}; $('#task').value = 'E2E goal'; $('#agentForm').requestSubmit()`);
    check('starts a real Claude Code agent', await until('local.size === 1 && hubLanes.length === 2', 15000));
    const mine = await js('[...local.keys()][0]');
    const theirs = await js(`hubLanes.find(l => l.id !== ${JSON.stringify(mine)}).id`);
    check('teammate output reaches the window', await until(`(terms.get(${JSON.stringify(theirs)})?.term.buffer.active.getLine(0)?.translateToString() || '').includes('teammate ready')`));
    check('the session opens on your own agent, with its goal', await until(`view === 'session' && current === 's1' && focus === ${JSON.stringify(mine)} && !terms.get(${JSON.stringify(mine)}).el.hidden && terms.get(${JSON.stringify(theirs)}).el.hidden && $('#roomTask').textContent === 'E2E goal' && $('#roomWho').textContent === 'Your agent'`));
    check('the session panel lists both people and their agents', await until(`$('#panelBody').querySelectorAll('.person').length === 2 && $('#panelBody').querySelectorAll('.agent-card').length === 2 && !!$('#panelBody [data-add]')`));
    check('the sidebar lists the workspace with its session', await js(`!!$('#workspaces .ws') && $('#workspaces .ws-session.on')?.textContent.trim() === 's1'`), await js(`$('#workspaces').textContent.replace(/\\s+/g, ' ')`));
    check('live git diff shows on your lane', await until(`!!terms.get(${JSON.stringify(mine)}).bar.querySelector('.diff')`, 12000));
    await js(`$('#panelBody [data-focus="${theirs}"]').click()`);
    check('clicking a teammate\'s agent shows it full size', await until(`focus === ${JSON.stringify(theirs)} && terms.get(${JSON.stringify(mine)}).el.hidden && !terms.get(${JSON.stringify(theirs)}).el.hidden && $('#roomWho').textContent === "Max's agent" && !$('#myAgent').hidden`));
    const large = await js(`terms.get(${JSON.stringify(theirs)}).term.options.fontSize`);
    await js(`$('#myAgent').click(); $('#panelBody [data-beside="${theirs}"]').click()`);
    check('⧉ on a teammate\'s agent card shows it beside yours', await until(`focus === ${JSON.stringify(mine)} && split === ${JSON.stringify(theirs)} && !terms.get(${JSON.stringify(mine)}).el.hidden && !terms.get(${JSON.stringify(theirs)}).el.hidden && terms.get(${JSON.stringify(theirs)}).term.options.fontSize <= ${large}`));
    check('Stop button is fully visible on your pane', await js(`(() => { const t = terms.get(${JSON.stringify(mine)}); return t.bar.querySelector('[data-stop]').getBoundingClientRect().right <= t.el.getBoundingClientRect().right; })()`));
    await js(`$('#panelBody [data-beside="${theirs}"]').click(); panelTab = 'environment'; render()`);
    check('the Environment tab shows the branch and changes', await js(`split === null && /Changes/.test($('#panelBody').textContent) && /Branch/.test($('#panelBody').textContent) && /Mark done/.test($('#panelBody').textContent) && !/Delete session/.test($('#panelBody').textContent)`), await js(`$('#panelBody').textContent.replace(/\\s+/g, ' ')`));
    await js(`panelTab = 'session'; render()`);

    for (const cli of ['codex', 'opencode']) { // either starts, or says it isn't installed
      await js(`openNewAgent('s1'); $('input[name=cmd][value=${cli}]').checked = true; $('#agentForm').requestSubmit()`);
      const started = await until(`local.size === 2 || /isn't installed/.test($('#agentErr').textContent)`, 15000) && await js('local.size === 2');
      check(started ? `starts a ${cli} agent` : `a missing ${cli} CLI is reported, not silently dropped`, started || await js(`$('#agent').open && local.size === 1`), await js(`$('#agentErr').textContent`));
      // Max is on the team and the folder was picked, not made by the app, so no push guard stops this agent: it says so.
      if (started) check(`the ${cli} agent is told it isn't push-guarded`, await until(`(window.__alerts || []).some(a => /only installs its push guard/.test(a))`, 3000), await js('JSON.stringify(window.__alerts || [])'));
      if (started) { await js(`proto.kill([...local.keys()].find(id => id !== ${JSON.stringify(mine)})); 0`); await until('local.size === 1'); }
    }
    await js(`$('#agent').close(); showTeams(me)`);
    await until('listedTeams.size > 0');
    check('team list marks the open team and its size', await js(`/Open/.test($('.team.on .agents').textContent) && /2 people/.test($('.team.on .where').textContent)`), await js(`$('#teamList').textContent.replace(/\\s+/g, ' ')`));
    await js(`openTeam(listedTeams.get(currentTeam.key)); 0`);
    check('opening a team shows its Sessions page', await until(`view === 'sessions' && !$('#sessionsPage').hidden && $('#room').hidden && !!$('#sessions [data-session="s1"]')`));
    await js(`$('#search').value = 'zzz'; $('#search').oninput()`);
    check('search narrows the sessions', await js(`!$('#sessions [data-session]') && /No sessions match/.test($('#sessions').textContent)`));
    await js(`$('#search').value = ''; $('#search').oninput(); $('#sessions [data-session="s1"]').click()`);
    check('clicking a session card opens it', await until(`view === 'session' && current === 's1' && !$('#room').hidden`));

    // ---- settings
    await js(`$('#settingsBtn').click()`);
    check('Settings opens as a page from the gear', await until(`$('#settings').open && !$('#settings').matches(':modal') && !$('.settings-body [data-pane=general]').hidden`));
    await js(`showPane('agents')`);
    check('Settings shows which agents are installed', await until(`/Claude Code/.test($('#providers').textContent) && /Installed/.test($('#providers').textContent)`), await js(`$('#providers').textContent.replace(/\\s+/g, ' ')`));
    await js(`$('input[data-pref=theme][value=light]').click()`);
    check('light theme applies to the app and terminals', await js(`document.documentElement.dataset.theme === 'light' && terms.get(${JSON.stringify(mine)}).term.options.theme.background === '#ffffff' && getComputedStyle(document.body).backgroundColor === 'rgb(243, 243, 245)'`));
    await js(`$('[data-step="0.5"]').click(); $('[data-step="0.5"]').click()`);
    check('terminal text size changes your pane', await js(`terms.get(${JSON.stringify(mine)}).term.options.fontSize === 13.5 && $('#fontSize').textContent === '13.5px'`));
    await js(`(() => { const select = $('select[data-pref=fontFamily]'); select.value = 'Menlo'; select.dispatchEvent(new Event('change', { bubbles: true })); $('[data-line="0.1"]').click(); })()`);
    check('terminal font and line height apply', await js(`terms.get(${JSON.stringify(mine)}).term.options.fontFamily.startsWith('"Menlo"') && terms.get(${JSON.stringify(mine)}).term.options.lineHeight === 1.3 && $('#lineHeight').textContent === '1.3'`));
    await js(`showPane('data')`);
    check('Data & privacy explains what the hub keeps', await js(`/Kept on the hub/.test($('.settings-body [data-pane=data]').textContent) && !$('.settings-body [data-pane=data]').hidden`));
    await js(`$('input[data-pref=notifyNeeds]').click(); $('input[data-pref=agent][value=codex]').click(); $('input[data-pref=open]').click()`);
    check('preferences are saved', await js(`(() => { const p = JSON.parse(localStorage.getItem('prefs')); return p.theme === 'light' && p.fontSize === 13.5 && p.notifyNeeds === false && p.agent === 'codex' && p.open === true; })()`));
    await js(`showPane('about')`);
    check('About shows the app version', await until(`/Protoplasma \\d+\\.\\d+\\.\\d+/.test($('#aboutPane').textContent)`), await js(`$('#aboutPane b')?.textContent`));
    await js(`showPane('account')`);
    check('Account shows the profile and GitHub CLI status', await until(`/David/.test($('#accountPane').textContent) && /Signed in as|Not installed|not signed in/.test($('#ghStatus')?.textContent || '')`, 12000), await js(`$('#ghStatus')?.textContent`));
    await js(`showPane('team')`);
    check('Team lists the members', await js(`/E2E/.test($('#teamPane').textContent) && /max/.test($('#teamPane').textContent)`));
    await js(`$('#settingsDone').click(); openNewAgent('s1')`);
    check('the New session form uses the saved defaults', await js(`$('input[name=cmd]:checked').value === (isInstalled('codex') ? 'codex' : 'claude') && $('#open').checked === true`));
    await js(`$('#agent').close(); $('#settingsBtn').click(); $('input[data-pref=theme][value=dark]').click(); $('input[data-pref=agent][value=claude]').click(); $('input[data-pref=open]').click(); $('input[data-pref=notifyNeeds]').click(); $('[data-step="-0.5"]').click(); $('[data-step="-0.5"]').click(); $('#settingsDone').click()`);
    check('switching back to dark works', await js(`document.documentElement.dataset.theme === 'dark' && terms.get(${JSON.stringify(mine)}).term.options.fontSize === 12.5`));

    // ---- guard rails, driven by the hook events Claude Code would send
    await sleep(3000);
    const mySecret = secretOf(claudePids().pop());
    const theirSecret = fs.readFileSync(secretFile, 'utf8').trim();
    const editFile = { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') } };
    await hook(theirs, theirSecret, { hook_event_name: 'PostToolUse', ...editFile });
    check('asks before editing a file Max\'s agent changed', (await hook(mine, mySecret, { hook_event_name: 'PreToolUse', ...editFile }))?.permissionDecision === 'ask');
    await hook(mine, mySecret, { hook_event_name: 'PostToolUse', ...editFile });
    check('overlap alert names both people', await until(`/Max & David edited|David & Max edited/.test($('#alerts').textContent)`));
    const push = await hook(mine, mySecret, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
    check('pushing to main asks first', push?.permissionDecision === 'ask' && /straight to main/.test(push.permissionDecisionReason));
    const force = await hook(mine, mySecret, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force origin session/x' } });
    check('force-pushing asks first', /force-push/.test(force?.permissionDecisionReason || ''));
    check('an ordinary branch push is not interrupted', await hook(mine, mySecret, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push -u origin session/x' } }) === null);

    await js(`go('sessions')`);
    await hook(mine, mySecret, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
    check('"needs you" alert shows', await until(`$('#alerts').textContent.includes('Your agent needs you')`));
    await hook(mine, mySecret, { hook_event_name: 'Stop' });
    check('status returns to idle', await until(`hubLanes.find(l => l.id === ${JSON.stringify(mine)}).status === 'idle'`));
    await js(`openSession('s1')`);
    await hook(mine, mySecret, { hook_event_name: 'UserPromptSubmit', prompt: 'make the lobby faster' });
    check('an agent card shows its latest prompt', await until(`$('#panelBody').textContent.includes('make the lobby faster')`));
    await hook(mine, mySecret, { hook_event_name: 'Stop' });
    await js(`$('#commentText').value = 'I take the auth part'; $('#commentForm').requestSubmit()`);
    check('comments appear in the session panel', await until(`/I take the auth part/.test($('#panelBody').textContent) && $('#commentText').value === ''`));
    await js(`$('#panelBody [data-uncomment]').click()`);
    check('and can be removed', await until(`!/I take the auth part/.test($('#panelBody').textContent)`));
    await js(`toggleSidebar(true)`);
    check('the sidebar can be hidden', await js(`document.body.classList.contains('sidebar-hidden') && getComputedStyle($('.sidebar')).display === 'none'`));
    await js(`toggleSidebar(false); $('#workspaces [data-ws-menu]').click()`);
    check('a workspace has its own menu', await js(`/Hide from sidebar/.test($('.menu')?.textContent || '')`));
    await js(`[...document.querySelectorAll('.menu button')].find(b => /Hide from sidebar/.test(b.textContent)).click()`);
    check('hiding a workspace tucks it away, with a way back', await until(`!$('#workspaces .ws') && /Show 1 hidden workspace/.test($('#workspaces').textContent)`));
    await js(`$('#workspaces [data-unhide]').click()`);
    check('showing it again', await until(`!!$('#workspaces .ws')`));

    await js(`proto.addMemory(currentTeam.key, { text: 'Never cache totals', file: 'src/x.ts' }); 0`);
    check('memory note appears', await until('memories.length === 1'));
    check('Claude gets the note before reading the file', /Never cache totals/.test((await hook(mine, mySecret, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/x.ts') } }))?.additionalContext || ''));

    // ---- an agent from a GitHub repo: its own branch and folder
    const clone = makeDemoRepo();
    await js(`openNewAgent('Fix Login'); $('input[name=source][value=repo]').checked = true; syncSource(); $('#repo').value = 'protoplasma-e2e/demo'; $('#task').value = ''; $('#agentForm').requestSubmit()`);
    check('starts an agent from a repo', await until('local.size === 2', 15000), await js(`$('#agentErr').textContent`));
    const second = await js(`[...local.keys()].find(id => id !== ${JSON.stringify(mine)})`);
    check('the session works on its own branch', await until(`hubLanes.find(l => l.id === ${JSON.stringify(second)})?.branch === 'session/fix-login'`, 12000),
      await js(`hubLanes.find(l => l.id === ${JSON.stringify(second)})?.branch`));
    check('in its own folder, leaving the clone on main', fs.existsSync(path.join(demoOwner, 'demo@fix-login', 'README.md')) && git(clone, 'branch', '--show-current') === 'main');
    check('the clone gets the push guard', /Added by Protoplasma/.test(fs.readFileSync(path.join(clone, '.git/hooks/pre-push'), 'utf8')));

    // main moves on the remote: the lane notices it's behind and its agent is told
    const other = tempDir('protoplasma-e2e-other-');
    git(other, 'clone', '-q', git(clone, 'remote', 'get-url', 'origin'), 'c');
    fs.writeFileSync(path.join(other, 'c', 'new.txt'), 'x\n');
    git(path.join(other, 'c'), 'add', '.');
    git(path.join(other, 'c'), 'commit', '-qm', 'teammate work');
    git(path.join(other, 'c'), 'push', '-q', 'origin', 'HEAD:main');
    check('shows when the branch falls behind', await until(`hubLanes.find(l => l.id === ${JSON.stringify(second)})?.git?.behind === 1 && !!terms.get(${JSON.stringify(second)}).bar.querySelector('.behind')`, 75000));
    const secondSecret = secretOf(claudePids().find(pid => secretOf(pid) !== mySecret));
    check('its agent is told to pull first', /1 commit behind/.test((await hook(second, secondSecret, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }))?.additionalContext || ''));

    // ---- the code view, the way Amoeba does it: the session's files in an editor, the agents in a panel underneath
    const work = path.join(demoOwner, 'demo@fix-login');
    const inShell = text => `(() => { const b = shells.get(code.root)?.term.buffer.active; if (!b) return false; for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString().includes(${JSON.stringify(text)})) return true; return false; })()`;
    await js(`openSession('Fix Login'); showCode(); 0`);
    check('Code opens the session\'s folder in an editor', await until(`code.on && code.root === ${JSON.stringify(work)} && !!editor && $('#room').classList.contains('coding') && /README\.md/.test($('#codeTree').textContent)`, 20000), await js('code.root'));
    check('with the agents in a panel underneath', await js(`!$('#dockTabs').hidden && !$('#lanes').hidden && $('.stage').getBoundingClientRect().top > $('#code').getBoundingClientRect().top`));
    await js(`goToFile(); 0`);
    check('⌘P lists the folder\'s files', await until(`$('#switcher').open && /README\.md/.test($('#switcherList').textContent)`));
    await js(`$('#switcher').close(); $('#codeTree [data-file="README.md"]').click(); 0`);
    check('clicking a file opens it in a tab', await until(`code.active === 'README.md' && editor.getModel()?.getValue() === 'demo\\n' && /README\.md/.test($('#codeTabs').textContent)`));
    await js(`editor.getModel().setValue('demo, edited here\\n'); 0`);
    check('an edit marks the tab unsaved', await until(`$('#codeTabs .code-tab.on').classList.contains('dirty')`));
    await js(`saveActive(); 0`);
    check('saving writes it to disk', await until(`!$('#codeTabs .code-tab.on').classList.contains('dirty')`) && /edited here/.test(fs.readFileSync(path.join(work, 'README.md'), 'utf8')));
    check('and the Explorer marks it changed', await until(`code.changes.get('README.md') === 'M' && $('#codeTree [data-file="README.md"] .state')?.textContent === 'M'`));
    fs.writeFileSync(path.join(work, 'README.md'), 'demo, edited by the agent\n');
    check('an agent\'s edit shows up in the open file', await until(`editor.getModel().getValue() === 'demo, edited by the agent\\n'`, 5000));
    fs.writeFileSync(path.join(work, 'notes.txt'), 'new file from the agent\n');
    check('and a new file appears in the Explorer', await until(`/notes\.txt/.test($('#codeTree').textContent) && code.changes.get('notes.txt') === 'U'`, 5000));
    await js(`$('[data-code-view="search"]').click(); $('#codeQuery').value = 'FROM THE AGENT'; $('#codeQuery').dispatchEvent(new Event('input')); 0`);
    check('Find in files finds text in any case', await until(`/notes\.txt/.test($('#codeHits').textContent) && !!$('#codeHits .hit')`));
    await js(`$('#codeHits .hit').click(); 0`);
    check('and opens the hit', await until(`code.active === 'notes.txt'`));
    await js(`$('[data-code-view="changes"]').click(); 0`);
    check('Source control lists the changes', await until(`/README\.md/.test($('#codeChanges').textContent) && /notes\.txt/.test($('#codeChanges').textContent) && $('#changeCount').textContent === '2'`));
    await js(`$('#codeChanges [data-file="README.md"]').click(); 0`);
    check('and shows a file\'s changes since the last commit', await until(`code.diff === 'README.md' && diffEditor.getModel()?.original.getValue() === 'demo\\n'`));
    await js(`$('#dockTabs [data-dock="terminal"]').click(); 0`);
    check('the Terminal tab opens a shell in the session\'s folder', await until(`shells.has(code.root) && !$('#shellPane').hidden && $('#lanes').hidden`));
    await js(`proto.shell.write(shells.get(code.root).id, 'echo shell-$((6*7))\\r'); 0`);
    check('and it runs commands', await until(inShell('shell-42'), 10000));
    await js(`$('#dockTabs [data-dock="agent"]').click(); $('#commitMessage').value = 'Edit the readme'; $('#commitBtn').click(); 0`);
    check('Commit & Push commits and pushes the session branch', await until(`/Committed and pushed/.test($('#commitNote').textContent)`, 20000), await js(`$('#commitNote').textContent`));
    check('the branch is on the remote', git(clone, 'ls-remote', 'origin', 'session/fix-login').includes('session/fix-login'));
    check('and nothing is left to commit', await until(`code.changes.size === 0 && $('#changeCount').hidden`, 5000));

    // A teammate pushed first and changed the same line: Pull, fix the file, Commit & Push.
    const maxRepo = path.join(tempDir('protoplasma-e2e-max-'), 'repo');
    git(root, 'clone', '-q', '-b', 'session/fix-login', git(clone, 'remote', 'get-url', 'origin').trim(), maxRepo);
    fs.writeFileSync(path.join(maxRepo, 'README.md'), 'demo, edited by Max\n');
    git(maxRepo, '-c', 'user.name=Max', '-c', 'user.email=max@example.com', 'commit', '-qam', 'Max edits the readme');
    git(maxRepo, 'push', '-q', 'origin', 'session/fix-login');
    fs.writeFileSync(path.join(work, 'README.md'), 'demo, edited by David\n');
    await until(`code.changes.get('README.md') === 'M'`, 5000);
    await js(`$('#commitMessage').value = 'David edits the readme'; $('#commitBtn').click(); 0`);
    check('a clash with a teammate\'s push offers Pull', await until(`/changed the same lines/.test($('#commitNote').textContent) && !$('#pullBtn').hidden`, 20000), await js(`$('#commitNote').textContent`));
    await js(`$('#pullBtn').click(); 0`);
    check('Pull marks the clashing file C and says how to finish', await until(`code.underWay === 'merge' && code.changes.get('README.md') === 'C' && /Commit & Push finishes it/.test($('#commitNote').textContent) && !$('#commitBtn').disabled`, 15000),
      await js(`JSON.stringify({ underWay: code.underWay, state: code.changes.get('README.md'), note: $('#commitNote').textContent })`));
    fs.writeFileSync(path.join(work, 'README.md'), 'demo, edited by David and Max\n'); // fixed, as in the editor
    await js(`$('#commitBtn').click(); 0`);
    check('Commit & Push finishes the merge and pushes it', await until(`/Merged and pushed/.test($('#commitNote').textContent)`, 20000), await js(`$('#commitNote').textContent`));
    git(maxRepo, 'pull', '-q', '--no-rebase', 'origin', 'session/fix-login');
    check('with both of them on the branch', fs.readFileSync(path.join(maxRepo, 'README.md'), 'utf8') === 'demo, edited by David and Max\n');
    await js(`showCode(false); 0`);
    check('Code again goes back to just the agents', await until(`!$('#room').classList.contains('coding') && $('#code').hidden && $('#dockTabs').hidden`));

    // ---- a plan, renaming with agents running, comments on lines, conflicts, and pane mode (as in Amoeba)
    await js(`openSession('Fix Login'); tab = 'plan'; render(); $('#stepText').value = 'Lock the seat row'; $('#stepForm').requestSubmit(); 0`);
    check('a session gets a plan with steps', await until(`recordFor('Fix Login')?.steps?.length === 1 && /Lock the seat row/.test($('#stepList').textContent)`));
    await js(`$('#stepList input[type=checkbox]').click(); 0`);
    check('a step can be ticked off', await until(`recordFor('Fix Login').steps[0].done === true`));
    await js(`go('sessions')`);
    check('and the session card counts the steps', await until(`/1 of 1 steps/.test($('#sessions').textContent)`));
    await js(`proto.renameSession(currentTeam.key, 'Fix Login', 'Login work').then(r => { sessionRecords = r; render(); }); 0`);
    check('a session can be renamed while its agent runs, and the agent moves with it', await until(`hubLanes.find(l => l.id === ${JSON.stringify(second)})?.session === 'Login work' && local.get(${JSON.stringify(second)}).session === 'Login work' && /Login work/.test($('#sessions').textContent)`));
    await js(`proto.renameSession(currentTeam.key, 'Login work', 'Fix Login').then(r => { sessionRecords = r; render(); }); 0`);
    await until(`local.get(${JSON.stringify(second)}).session === 'Fix Login'`);
    await js(`openSession('Fix Login'); openFile('README.md'); 0`);
    await until(`code.active === 'README.md' && !!editor.getModel()`);
    await js(`editor.setSelection(new monaco.Selection(1, 1, 1, 4)); editor.getAction('protoplasma.comment').run(); 0`);
    check('Comment on this points the next comment at those lines', await until(`commentRef?.file === 'README.md' && commentRef.line === 1 && !$('#commentRef').hidden && document.activeElement === $('#commentText')`));
    await js(`$('#commentText').value = 'Say what this repo is for'; $('#commentForm').requestSubmit(); 0`);
    check('the comment shows the line it is about, and the editor marks the line', await until(`recordFor('Fix Login')?.comments?.at(-1)?.line === 1 && /README\.md:1/.test($('#panelBody').textContent) && editor.getModel().getAllDecorations().some(d => d.options.glyphMarginClassName === 'comment-glyph')`));
    await js(`$('[data-explorer="conflicts"]').click(); 0`);
    check('the Explorer has a Conflicts tab', await until(`code.explorer === 'conflicts' && !$('#codeConflicts').hidden && $('#conflictCount').textContent === '0' && /Nothing here/.test($('#codeConflicts').textContent)`));
    await js(`$('[data-explorer="files"]').click(); showCode(false); $('#newPane').click(); 0`);
    check('New pane opens pane mode with the session and room for another', await until(`view === 'panes' && panes.length === 2 && $('#panesView').querySelector('[data-pane="0"] .pane-body').contains(terms.get(${JSON.stringify(second)}).el) && !terms.get(${JSON.stringify(second)}).el.hidden && /room for another/.test($('#panesTitle').textContent)`));
    await js(`$('#paneGrid [data-pane-pick][data-name="s1"]').click(); 0`);
    check('a second session opens beside it, with its agent', await until(`panes[1] === 's1' && $('#paneGrid [data-pane="1"] .pane-body').contains(terms.get(${JSON.stringify(mine)}).el) && !terms.get(${JSON.stringify(mine)}).el.hidden`));
    await js(`$('#singlePane').click(); 0`);
    check('Single goes back to one session, terminals and all', await until(`view === 'session' && current === 'Fix Login' && $('#lanes').contains(terms.get(${JSON.stringify(second)}).el) && $('#lanes').contains(terms.get(${JSON.stringify(mine)}).el)`));

    // ---- with session branches off, a repo session works on the clone's own branch
    await js(`$('#settingsBtn').click(); $('input[data-pref=sessionBranches]').click(); $('#settingsDone').click();
      openNewAgent('Plain'); $('input[name=source][value=repo]').checked = true; syncSource(); $('#repo').value = 'protoplasma-e2e/demo'; $('#agentForm').requestSubmit()`);
    check('starts a third agent with session branches off', await until('local.size === 3', 15000), await js(`$('#agentErr').textContent`));
    const third = await js(`[...local.keys()].find(id => id !== ${JSON.stringify(mine)} && id !== ${JSON.stringify(second)})`);
    check('it stays on the repo\'s own branch', await until(`hubLanes.find(l => l.id === ${JSON.stringify(third)})?.branch === 'main'`, 12000), await js(`hubLanes.find(l => l.id === ${JSON.stringify(third)})?.branch`));
    await js(`proto.kill(${JSON.stringify(third)}); $('#settingsBtn').click(); $('input[data-pref=sessionBranches]').click(); $('#settingsDone').click()`);

    // ---- sessions after their agents stop
    await js(`proto.kill(${JSON.stringify(second)}); proto.kill(${JSON.stringify(mine)}); 0`);
    teammate.kill();
    await js(`go('sessions')`);
    check('sessions stay on the board after their agents stop', await until(`hubLanes.length === 0 && local.size === 0 && $('#sessions').textContent.includes('No agents running') && $('#sessions').textContent.includes('E2E goal')`));
    await js(`openSession('s1')`);
    check('a stopped agent is listed in its session', await until(`$('#panelBody [data-replay]') && /Stopped agents/.test($('#panelBody').textContent)`));
    await js(`[...document.querySelectorAll('#panelBody [data-replay]')].find(b => /Max/.test(b.textContent)).click()`);
    check("its last screen can be looked at", await until(`tab === 'replay' && !$('#replayPanel').hidden && (() => { const b = replayTerm.buffer.active; for (let y = 0; y < b.length; y++) if (b.getLine(y).translateToString().includes('teammate ready')) return true; return false; })()`, 10000));
    await js(`$('#backToAgents').click()`);
    check('Resume offers the last agent', await js(`!$('#resumeBtn').hidden && $('#resumeBtn').textContent === 'Resume Claude Code'`), await js(`$('#resumeBtn').textContent`));
    await js(`$('#resumeBtn').click(); 0`);
    const resumed = await (async () => {
      for (let i = 0; i < 60; i++) {
        if (execFileSync('ps', ['-Ao', 'command='], { encoding: 'utf8' }).split('\n').some(l => l.includes('claude --settings') && l.includes('--continue'))) return true;
        await sleep(100);
      }
      return false;
    })();
    check('and starts it with --continue', resumed);
    await js(`for (const id of local.keys()) proto.kill(id); 0`);
    await until('local.size === 0', 10000);
    await js(`go('sessions')`);
    // The demo remote is a local path, so the hub has no GitHub repo for it; test/hub.test.js covers recording one.
    check('a stopped session with a repo keeps its GitHub links', await js(`recordFor('Fix Login').repo = 'david/lobby'; openSession('Fix Login'); panelTab = 'environment'; render();
      /david\\/lobby/.test($('#panelBody').textContent) && !!$('#panelBody [data-tab=pulls]') && /Mark done/.test($('#panelBody').textContent)`));
    await js(`openSession('s1'); $('#panelBody [data-act=done]').click()`);
    check('Mark done', await until(`recordFor('s1')?.done === true`));
    check('a finished session leaves the sidebar but stays on the Sessions page', await js(`go('sessions'); !$('#workspaces [data-session="s1"]') && /Done/.test($('#sessions [data-session="s1"]').textContent)`));
    await js(`window.confirm = () => true; openSession('s1'); tab = 'memory'; render(); $('#panelBody [data-act=delete]').click()`);
    check('Delete removes it', await until(`!recordFor('s1')`));
    check('and you land back on the Sessions page', await until(`view === 'sessions' && !$('#sessionsPage').hidden && $('#room').hidden && !$('#sessions [data-session="s1"]')`));
    await js(`$('#sessions [data-menu="Fix Login"]').click()`);
    check('a session card has its own menu', await js(`/Mark done/.test($('.menu')?.textContent || '') && /Delete session/.test($('.menu').textContent)`));
    await js(`closeMenu(); openRename('Fix Login'); $('#renameInput').value = 'Login flow'; $('#renameForm').requestSubmit()`);
    check('a stopped session can be renamed, keeping its branch', await until(`recordFor('Login flow')?.key === 'fix-login' && !recordFor('Fix Login') && !$('#renameDlg').open`), await js(`JSON.stringify(sessionRecords.map(x => [x.name, x.key]))`));
    await js(`recordFor('Login flow').repo = 'protoplasma-e2e/demo'; deleteSession('Login flow'); 0`);
    check('deleting a repo session can remove its folder too', await until(`!recordFor('Login flow')`) && await (async () => { for (let i = 0; i < 50 && fs.existsSync(path.join(demoOwner, 'demo@fix-login')); i++) await sleep(100); return !fs.existsSync(path.join(demoOwner, 'demo@fix-login')); })());

    // ---- quick switcher and setup checklist
    await js(`openSwitcher(); $('#switcherInput').value = 'peo'; $('#switcherInput').oninput()`);
    check('⌘K finds pages by name', await js(`$('#switcher').open && /People/.test($('#switcherList').textContent)`));
    await js(`$('#switcherInput').onkeydown(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    check('and goes there', await until(`!$('#switcher').open && view === 'people'`));
    await js(`go('sessions'); renderSetup([{ cmd: 'claude', installed: false }], { ok: false, detail: 'Not installed. Run "brew install gh", then "gh auth login".' })`);
    check('the setup checklist lists what is missing', await js(`!$('#setup').hidden && $('#setup').querySelectorAll('.setup-item').length === 2`));
    await js(`checkSetup(); 0`);
    check('and disappears once this Mac is set up', await until(`$('#setup').hidden`, 15000));

    // ---- a team on This Mac: its own hub, encrypted, and vouched for by the online hub
    const mainTeam = await js('currentTeam.key');
    await js(`showTeams(me); $('input[name=where][value=mac]').checked = true; syncWhere(); $('#teamName').value = 'Spare'; $('#createTeam').requestSubmit()`);
    check('creates a This Mac team and connects to its hub over TLS', await until(`currentTeam?.name === 'Spare' && currentTeam.where === 'This Mac' && currentTeam.hub.startsWith('https://127.0.0.1:') && $('#conn').className.includes('live')`, 15000),
      await js(`JSON.stringify({ where: currentTeam?.where, hub: currentTeam?.hub, conn: $('#conn').className, err: $('#createErr').textContent })`));
    // Nobody else is on it, so it listens on this Mac alone.
    const lanIp = Object.values(os.networkInterfaces()).flat().find(a => a.family === 'IPv4' && !a.internal)?.address;
    const macPort = Number(new URL(await js('currentTeam.hub')).port);
    const fromNetwork = lanIp && await new Promise(resolve => require('net').connect(macPort, lanIp, function () { this.destroy(); resolve('reachable'); }).on('error', e => resolve(e.code)));
    check('its hub can\'t be reached from the network while the team is just you', !lanIp || fromNetwork === 'ECONNREFUSED', `${lanIp}: ${fromNetwork}`);
    const macCert = new (require('crypto').X509Certificate)(fs.readFileSync(path.join(app.getPath('userData'), 'hub', 'tls-cert.pem')));
    const pass = async () => (await fetch(`${hub}/passes`, { method: 'POST', headers: { authorization: 'Bearer tok-max' },
      body: JSON.stringify({ aud: require('../src/shared').fingerprint(macCert.raw) }) })).json();
    let issued = null;
    for (let i = 0; i < 50 && !issued?.pass; i++) { issued = await pass(); if (!issued?.pass) await sleep(100); }
    check('its hub is registered, so a teammate can get a pass for it', /^p1\./.test(issued?.pass) && issued.owners.includes('david'), JSON.stringify(issued));
    await js(`openNewAgent('mac-session'); $('input[name=source][value=folder]').checked = true; syncSource(); $('#cwd').value = ${JSON.stringify(root)}; $('#agentForm').requestSubmit()`);
    check('an agent joins it over the encrypted connection', await until(`currentTeam?.where === 'This Mac' && hubLanes.some(l => l.session === 'mac-session')`, 15000));
    await js(`proto.kill([...local].find(([, l]) => l.session === 'mac-session')?.[0]); 0`);
    await until(`!hubLanes.some(l => l.session === 'mac-session')`, 10000);

    // ---- deleting a team
    await js(`window.confirm = () => false; openSettings('team'); $('#teamPane [data-drop-team]').click()`);
    check('cancelling Delete team leaves Settings open on the same team', await js(`$('#settings').open && !$('#start').open && currentTeam?.name === 'Spare'`));
    check('the team list has no delete buttons', await js(`!document.querySelector('#teamList [data-drop]')`));
    await js(`window.confirm = () => true; $('#teamPane [data-drop-team]').click()`);
    check('the owner can delete the open team from Settings', await until(`currentTeam === null && !$('#settings').open && $('#start').open && listedTeams.size === 1 && !$('#teamList').textContent.includes('Spare')`, 12000), await js(`$('#teamList').textContent.replace(/\\s+/g, ' ')`));
    await js(`openTeam(listedTeams.get(${JSON.stringify(mainTeam)})); 0`);
    await until(`currentTeam?.key === ${JSON.stringify(mainTeam)}`);

    // ---- an agent waiting on Claude's folder trust prompt needs you
    const untrusted = tempDir('protoplasma-e2e-trust-');
    await js(`openNewAgent('trust-check'); $('input[name=source][value=folder]').checked = true; syncSource(); $('#cwd').value = ${JSON.stringify(untrusted)}; $('#agentForm').requestSubmit()`);
    const asked = await until(`hubLanes.some(l => l.session === 'trust-check' && l.status === 'needs you')`, 20000);
    check('a folder trust prompt shows as Needs you', asked && await js(`$('#alerts').textContent.includes('Your agent needs you') || view === 'session'`),
      await js(`hubLanes.find(l => l.session === 'trust-check')?.status`));
    await js(`proto.write([...local.keys()][0], '\\x1b'); 0`); // Esc: "No, exit"
    check('answering it clears Needs you', await until(`!hubLanes.some(l => l.session === 'trust-check' && l.status === 'needs you')`, 10000));
    await until('local.size === 0', 10000);
    check('a differently written name joins the existing session', await js(`existingSession('TRUST CHECK') === 'trust-check'`));
    fs.rmSync(untrusted, { recursive: true, force: true });

    // ---- signing out stops your agents and clears the board
    await js(`openNewAgent('bye'); $('input[name=source][value=folder]').checked = true; syncSource(); $('#cwd').value = ${JSON.stringify(root)}; $('#agentForm').requestSubmit()`);
    await until('local.size === 1 && hubLanes.length === 1', 15000);
    await js(`$('#signout').click()`);
    check('signing out stops your agents and returns to sign-in', await until(`local.size === 0 && me === null && currentTeam === null && $('#start').open && !$('#signinView').hidden && terms.size === 0`, 10000),
      await js(`JSON.stringify({ local: local.size, terms: terms.size, me: !!me })`));
  } catch (e) {
    check('no unexpected errors', false, e.message);
  } finally {
    // Alerts are the app's error messages; the only expected ones are for agents this script stops right after starting.
    const alerts = await js('window.__alerts || []').catch(() => []);
    const unexpected = alerts.filter(a => !/stopped as soon as it started|only installs its push guard/.test(a));
    check('no unexpected error alerts', !unexpected.length, unexpected.slice(0, 3).join(' | '));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    if (results.includes(false)) process.exitCode = 1;
    teammate?.kill();
    fs.rmSync(secretFile, { force: true });
    fs.rmSync(demoOwner, { recursive: true, force: true });
    if (!hadProtoplasmaDir) try { fs.rmdirSync(path.join(os.homedir(), 'Protoplasma')); } catch {}
    for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
    // Quits the way logging out does (SIGTERM: no "agents are still running" question), through the real quit path, and
    // must really exit: a quit that's ignored leaves the app running with no window (F1 in docs/usage-test).
    // If it doesn't, it says how far the quit got.
    const quitAt = Date.now(), reached = [];
    for (const step of ['before-quit', 'will-quit', 'quit']) app.on(step, () => reached.push(`${step} at ${Date.now() - quitAt} ms`));
    process.kill(process.pid, 'SIGTERM');
    setTimeout(() => { console.log(`FAIL  the app exits when it's quit  (reached: ${reached.join(', ') || 'nothing'})`); app.exit(1); }, 8000).unref();
  }
}

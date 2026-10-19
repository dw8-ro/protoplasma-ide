// Integration tests: a real hub and real lanes running shell commands in place of agents.
// GitHub identity is faked: the token "tok-<name>" belongs to <name>.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { startHub } = require('../src/hub');
const { repoFromRemote, startLane: startLaneHere } = require('../src/lane');
const { appendScrollback, SCROLLBACK } = require('../src/shared');

const LANE = path.join(__dirname, '../src/lane.js');
const SECRET = 'a-test-hook-secret'; // what raw test agents use for their hooks
// Lanes started here report this as their git root. A repo of its own that nothing changes: in this checkout, a push
// to GitHub (seen by the lanes' fetch) or an edit made while the tests run would send a new git report, which drops the
// made-up hook edits some tests rely on. Its remote names a GitHub repo, so both lanes count as the same repo, and its
// fetches go to a dead local proxy, so they fail at once without reaching GitHub.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-hub-')));
for (const args of [['init', '-q', '-b', 'main'], ['remote', 'add', 'origin', 'https://github.com/acme/hub-test.git'],
  ['config', 'http.proxy', 'http://127.0.0.1:9'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start']]) {
  execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}
// "tok-slow-<name>" takes a moment to verify, to exercise connections that drop mid-check.
const verifyUser = async token => {
  const [, slow, login] = /^tok-(slow-)?(\w+)$/.exec(token) || [];
  if (slow) await sleep(300);
  return login ? { login, name: login[0].toUpperCase() + login.slice(1), avatar: '' } : null;
};

let hub, url, team, watcher, alice, bob;
const outputs = [];
const processes = [];

const api = async (token, method, route, body) => {
  const res = await fetch(`${url}${route}`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const connectWatcher = (token, teamId, onMessage = () => {}) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/watch`);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'watch', token, team: teamId })));
  ws.on('message', raw => onMessage(JSON.parse(raw)));
  ws.once('message', () => resolve(ws));
  ws.on('close', code => reject(Object.assign(new Error(`closed ${code}`), { code })));
});
const nextState = match => new Promise(resolve => watcher.on('message', function onMessage(raw) {
  const m = JSON.parse(raw);
  if (m.t === 'state' && match(m.lanes)) { watcher.off('message', onMessage); resolve(m.lanes); }
}));
const startLane = (login, ...args) => processes.push(spawn('node', [LANE, url, team.id, 's1', ...args],
  { cwd: root, env: { ...process.env, PROTO_TOKEN: `tok-${login}` }, stdio: ['ignore', 'ignore', 'inherit'] }));
const outputOf = lane => outputs.filter(m => m.lane === lane.id).map(m => m.d).join('');
const hookSecret = lane => /secret:(\w+)/.exec(outputOf(lane))?.[1];
const postHook = (lane, body, secret = hookSecret(lane)) => fetch(`${url}/hooks/${lane.id}`,
  { method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ cwd: root, ...body }) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const printSecretThenCat = ['sh', '-c', 'echo "secret:$PROTO_HOOK_SECRET"; cat'];

before(async () => {
  hub = await startHub({ port: 0, host: '127.0.0.1', owners: ['alice'], verifyUser });
  url = `http://127.0.0.1:${hub.port}`;
  team = (await api('tok-alice', 'POST', '/teams', { name: 'Lobby' })).body;
  await api('tok-alice', 'POST', `/teams/${team.id}/members`, { login: '@Bob' });

  watcher = await connectWatcher('tok-alice', team.id, m => { if (m.t === 'out') outputs.push(m); });
  const ready = nextState(lanes => lanes.length === 2);
  // A lane's first git report (about 5 s in) drops hook edits git doesn't see, like the made-up src/x.ts below; waiting
  // for it here keeps it from landing between two tests that use those edits.
  const reported = nextState(lanes => lanes.length === 2 && lanes.every(l => l.git));
  startLane('alice', '--open', ...printSecretThenCat); // prints before it can reach the hub
  startLane('bob', ...printSecretThenCat);
  const lanes = await ready;
  await reported;
  alice = lanes.find(l => l.login === 'alice');
  bob = lanes.find(l => l.login === 'bob');
  while (!hookSecret(alice) || !hookSecret(bob)) await sleep(20);
});

after(async () => {
  for (const p of processes) p.kill();
  watcher.close();
  await hub.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('only owners create teams, and only members see them', async () => {
  assert.equal((await api('nope', 'GET', '/teams')).status, 401);
  assert.equal((await api('tok-bob', 'POST', '/teams', { name: 'Mine' })).status, 403);
  assert.deepEqual((await api('tok-bob', 'GET', '/teams')).body.map(t => t.name), ['Lobby']);
  assert.deepEqual((await api('tok-carol', 'GET', '/teams')).body, []);
  assert.equal((await api('tok-bob', 'POST', `/teams/${team.id}/members`, { login: 'carol' })).status, 403, 'only the owner invites');
});

test('refuses people who are not signed in or not on the team', async () => {
  await assert.rejects(connectWatcher('nope', team.id), { code: 4001 });
  await assert.rejects(connectWatcher('tok-carol', team.id), { code: 4003 });
});

test('agents show up under their GitHub identity', () => {
  assert.equal(alice.name, 'Alice');
  assert.equal(bob.name, 'Bob');
});

test('shows output an agent printed before it connected', () => {
  assert.match(outputOf(alice), /secret:/);
});

test('teammates can type into open agents only', async () => {
  watcher.send(JSON.stringify({ t: 'in', lane: alice.id, d: 'ping\r' }));
  watcher.send(JSON.stringify({ t: 'in', lane: bob.id, d: 'nope\r' }));
  await sleep(500);
  assert.match(outputOf(alice), /ping/);
  assert.doesNotMatch(outputOf(bob), /nope/);
  const now = nextState(() => true);
  watcher.send(JSON.stringify({ t: 'look', session: 'typing' })); // any state will do; only a change of session sends one
  assert.equal((await now).find(l => l.id === alice.id).typedBy, '', 'typing into your own agent isn\'t worth a note');

  // Bob types into Alice's agent: she's told who.
  const bobs = await connectWatcher('tok-bob', team.id);
  const told = nextState(lanes => lanes.find(l => l.id === alice.id)?.typedBy === 'Bob');
  bobs.send(JSON.stringify({ t: 'in', lane: alice.id, d: 'from bob\r' }));
  const lane = (await told).find(l => l.id === alice.id);
  assert.ok(Date.now() - Date.parse(lane.typedAt) < 5000);
  bobs.close();
});

test('hooks only accept the agent\'s own secret', async () => {
  assert.equal((await postHook(alice, { hook_event_name: 'Stop' }, 'wrong')).status, 401);
  assert.equal((await postHook(alice, { hook_event_name: 'Stop' }, hookSecret(bob))).status, 401);
});

test('asks before an agent edits a file a teammate already edited', async () => {
  const edit = { tool_name: 'Edit', tool_input: { file_path: path.join(root, 'src/x.ts') } };
  await postHook(alice, { hook_event_name: 'PostToolUse', ...edit });

  const { hookSpecificOutput: pre } = await (await postHook(bob, { hook_event_name: 'PreToolUse', ...edit })).json();
  assert.equal(pre.permissionDecision, 'ask');
  assert.match(pre.permissionDecisionReason, /Alice.*src\/x\.ts/);

  const own = await postHook(alice, { hook_event_name: 'PreToolUse', ...edit });
  assert.equal(await own.text(), '', 'no warning for your own file');
});

test('tells each agent what its teammates are doing', async () => {
  await sleep(6000);
  const { hookSpecificOutput } = await (await postHook(bob, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).json();
  assert.match(hookSpecificOutput.additionalContext, /Alice.*src\/x\.ts/);
});

test('shared memory: anyone on the team adds notes; only the author or owner removes them', async () => {
  const route = `/teams/${team.id}/memories`;
  assert.equal((await api('tok-bob', 'POST', route, { text: 'Totals recompute on promo change, do not cache', file: './src/cart/totals.ts' })).status, 200);
  const notes = (await api('tok-alice', 'POST', route, { text: 'Use pnpm, not npm' })).body;
  assert.equal(notes.length, 2);
  assert.equal(notes[0].file, 'src/cart/totals.ts');
  assert.equal((await api('tok-carol', 'POST', route, { text: 'hi' })).status, 404, 'not on the team');
  assert.equal((await api('tok-bob', 'POST', route, { text: ' ' })).status, 400);
  const alices = notes.find(n => n.author === 'alice');
  assert.equal((await api('tok-bob', 'DELETE', `${route}/${alices.id}`)).status, 403, 'bob is neither author nor owner');
});

test('agents get general notes with each prompt, and a file\'s notes before touching it', async () => {
  const { hookSpecificOutput: prompt } = await (await postHook(bob, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).json();
  assert.match(prompt.additionalContext, /Use pnpm/);
  assert.doesNotMatch(prompt.additionalContext, /do not cache/, 'pinned notes wait for their file');

  const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/cart/totals.ts') } };
  const { hookSpecificOutput: pre } = await (await postHook(alice, read)).json();
  assert.match(pre.additionalContext, /src\/cart\/totals\.ts[\s\S]*do not cache/);
  assert.equal(pre.permissionDecision, undefined, 'notes alone never block');
});

test('shows who is watching which session', async () => {
  const looked = new Promise(resolve => watcher.on('message', function onMessage(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'state' && m.watchers.some(w => w.login === 'alice' && w.session === 's1')) { watcher.off('message', onMessage); resolve(m); }
  }));
  watcher.send(JSON.stringify({ t: 'look', session: 's1' }));
  const state = await looked;
  assert.equal(state.watchers.find(w => w.session === 's1').name, 'Alice');
});

test('connections that drop while being verified leave no ghosts', async () => {
  const lane = new WebSocket(`${url.replace('http', 'ws')}/lane`);
  await new Promise(resolve => lane.on('open', resolve));
  lane.send(JSON.stringify({ t: 'hello', token: 'tok-slow-alice', team: team.id, id: 'ghost-lane', hookSecret: SECRET, session: 's1', cmd: 'sh' }));
  const viewer = new WebSocket(`${url.replace('http', 'ws')}/watch`);
  await new Promise(resolve => viewer.on('open', resolve));
  viewer.send(JSON.stringify({ t: 'watch', token: 'tok-slow-bob', team: team.id }));
  await sleep(50);
  lane.terminate();
  viewer.terminate();
  await sleep(500);

  let state;
  const snapshot = await connectWatcher('tok-alice', team.id, m => { state ??= m; });
  snapshot.close();
  assert.ok(!state.lanes.some(l => l.id === 'ghost-lane'), 'no ghost lane');
  assert.ok(!state.watchers.some(w => w.login === 'bob'), 'no ghost watcher');
});

test('sessions outlive their agents, carry a goal, and can be finished', async () => {
  const route = `/teams/${team.id}/sessions`;
  const sessions = (await api('tok-alice', 'POST', route, { name: 's1', task: 'Fix the lobby race' })).body;
  assert.equal(sessions.find(x => x.name === 's1').task, 'Fix the lobby race');
  const { hookSpecificOutput } = await (await postHook(bob, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).json();
  assert.match(hookSpecificOutput.additionalContext, /goal: Fix the lobby race/);

  await api('tok-alice', 'POST', route, { name: 'planning', task: 'Plan the next release' });
  assert.equal((await api('tok-bob', 'POST', `${route}/planning`, { done: true })).status, 403, 'only its creator or the owner');
  const done = (await api('tok-alice', 'POST', `${route}/planning`, { done: true })).body;
  assert.equal(done.find(x => x.name === 'planning').done, true);
  assert.equal((await api('tok-alice', 'DELETE', `${route}/s1`)).status, 409, 'agents still running');
  const left = (await api('tok-alice', 'DELETE', `${route}/planning`)).body;
  assert.ok(!left.some(x => x.name === 'planning'));
});

test('git progress and branch switches reach teammates', async () => {
  const lane = new WebSocket(`${url.replace('http', 'ws')}/lane`);
  await new Promise(resolve => lane.on('open', resolve));
  const joined = nextState(lanes => lanes.some(l => l.id === 'git-lane'));
  lane.send(JSON.stringify({ t: 'hello', token: 'tok-alice', team: team.id, id: 'git-lane', hookSecret: SECRET, session: 's1', cmd: 'sh', branch: 'main' }));
  await joined;
  const updated = nextState(lanes => lanes.some(l => l.id === 'git-lane' && l.git?.added === 3));
  lane.send(JSON.stringify({ t: 'git', branch: 'fix/lobby', added: 3, removed: 1, files: 2 }));
  const gitLane = (await updated).find(l => l.id === 'git-lane');
  assert.deepEqual(gitLane.git, { added: 3, removed: 1, files: 2, behind: 0, ahead: 0, unpushed: 0 });
  assert.equal(gitLane.branch, 'fix/lobby');
  const gone = nextState(lanes => !lanes.some(l => l.id === 'git-lane'));
  lane.close();
  await gone;
});

// A lane driven directly over the socket, so its repo, branch and git stats are whatever the test needs.
async function rawLane(id, hello = {}) {
  const lane = new WebSocket(`${url.replace('http', 'ws')}/lane`);
  await new Promise(resolve => lane.on('open', resolve));
  const joined = nextState(lanes => lanes.some(l => l.id === id));
  lane.send(JSON.stringify({ t: 'hello', token: 'tok-alice', team: team.id, id, hookSecret: SECRET, session: 's1', cmd: 'claude', root: '/r', ...hello }));
  await joined;
  const hook = async body => {
    const res = await fetch(`${url}/hooks/${id}`, { method: 'POST', headers: { authorization: `Bearer ${hello.hookSecret || SECRET}` }, body: JSON.stringify({ cwd: '/r', ...body }) });
    return (await res.json().catch(() => null))?.hookSpecificOutput ?? null;
  };
  const close = async () => { const gone = nextState(lanes => !lanes.some(l => l.id === id)); lane.close(); await gone; };
  return { socket: lane, hook, close };
}

test('pushing to main or force-pushing needs a person to confirm', async () => {
  const onMain = await rawLane('push-main', { branch: 'main', repo: 'acme/app' });
  const onBranch = await rawLane('push-branch', { branch: 'session/fix', repo: 'acme/app' });
  const push = (lane, command) => lane.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

  for (const command of ['git push', 'git push -u origin', 'git push origin HEAD', 'git add . && git commit -m x && git push']) {
    assert.equal((await push(onMain, command))?.permissionDecision, 'ask', `on main: ${command}`);
  }
  for (const command of ['git push origin main', 'git push origin HEAD:main', 'git push origin session/fix:refs/heads/master']) {
    assert.match((await push(onBranch, command)).permissionDecisionReason, /straight to (main|master)/, command);
  }
  for (const command of ['git push -f origin session/fix', 'git push --force', 'git push origin +session/fix', 'git push --force-with-lease origin session/fix']) {
    assert.match((await push(onBranch, command)).permissionDecisionReason, /force-push/, command);
  }
  for (const command of ['git push --all origin', 'git push --mirror']) {
    assert.match((await push(onBranch, command)).permissionDecisionReason, /every branch/, command);
  }
  assert.match((await push(onBranch, "git push origin 'HEAD:refs/heads/main'")).permissionDecisionReason, /straight to main/, 'quoted refspec');
  for (const command of ['git push origin --delete main', 'git push origin :main']) {
    assert.match((await push(onBranch, command)).permissionDecisionReason, /deletes main/, command);
  }
  // A second push in a chain, and wrappers that leave quotes or brackets around the branch name, are still seen.
  for (const command of ['git push origin feature && git push origin main', 'git push; git push origin main', 'bash -c "git push origin main"',
    "sh -c 'git push origin main'", '(git push origin main)', 'ssh box "cd repo && git push origin main"', '/usr/bin/git push origin main',
    'git -C ../app push origin main', 'echo $(git push origin main)', 'git push \\\n  origin main',
    'git -C "path with spaces" push origin main', "git -c user.name='a b' push origin main", 'GIT_DIR=/srv/git git push origin main',
    'sudo -u git git push origin main', 'git submodule foreach git push origin main', 'out=$(git push origin main)', 'git push 2>&1 origin main',
    'bash -lc "git push origin main"', "zsh -ic 'git push origin main'", 'git checkout main && git push',
    // A here-string or a shift isn't a heredoc, so the lines after it are still read.
    'cat <<<EOF\ngit push origin main', 'echo $((1<<2))\ngit push origin main', '(( n = 1 << 2 ))\ngit push origin main']) {
    assert.match((await push(onBranch, command))?.permissionDecisionReason || '', /straight to main/, command);
  }
  for (const command of ['git push', 'git push -u origin session/fix', 'git status', 'echo push main',
    'git stash push -m wip', 'git push --tags', 'git commit -m "fix push to main"', 'git commit -m "Never git push --force to main"',
    'git log --grep="git push origin main"', 'echo done # git push origin main',
    'git commit -m "$(cat <<\'EOF\'\nwip\ngit push --force origin main\nEOF\n)"', 'git commit -m "first line\ngit push origin main"']) {
    assert.equal(await push(onBranch, command), null, `fine: ${command}`);
  }
  // Deleting any remote branch needs a person, a session branch included: teammates in the session push to it too.
  for (const command of ['git push origin --delete session/old', 'git push origin :session/fix', 'git push origin --delete feature']) {
    assert.match((await push(onBranch, command))?.permissionDecisionReason || '', /deletes .* on the remote/, command);
  }
  // The repo's default branch is shared like main, whatever it's called.
  const onDevelop = await rawLane('push-develop', { branch: 'session/x', repo: 'acme/app', git: { branch: 'session/x', mainBranch: 'develop' } });
  assert.match((await push(onDevelop, 'git push origin HEAD:develop')).permissionDecisionReason, /straight to develop/);
  assert.match((await push(onDevelop, 'git push origin --delete develop')).permissionDecisionReason, /deletes develop/);
  assert.equal(await push(onDevelop, 'git push origin session/x'), null);
  await onDevelop.close();
  assert.equal(await push(onMain, 'git stash push'), null, 'a stash is not a push, on main either');
  assert.equal(await push(onMain, 'git commit -m "Fix git push hook"'), null, 'a commit message mentioning a push, on main');
  // A huge command is answered quickly rather than holding up the hub.
  const started = Date.now();
  await push(onBranch, 'git '.repeat(200_000));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
  await onMain.close();
  await onBranch.close();
});

test('overlap warnings, notes and teammate context stay within a repo', async () => {
  const app = await rawLane('repo-app', { repo: 'acme/app', session: 'app-work' });
  const other = await rawLane('repo-other', { repo: 'acme/other' });
  const appToo = await rawLane('repo-app-2', { repo: 'acme/app' });
  const edit = { tool_name: 'Edit', tool_input: { file_path: '/r/README.md' } };
  await app.hook({ hook_event_name: 'PostToolUse', ...edit });
  assert.equal(await other.hook({ hook_event_name: 'PreToolUse', ...edit }), null, 'a different repo\'s README is not an overlap');
  assert.equal((await appToo.hook({ hook_event_name: 'PreToolUse', ...edit })).permissionDecision, 'ask');

  await api('tok-alice', 'POST', `/teams/${team.id}/memories`, { text: 'The app uses yarn', repo: 'acme/app' });
  const prompt = { hook_event_name: 'UserPromptSubmit', prompt: 'hi' };
  const sameRepo = (await appToo.hook(prompt)).additionalContext;
  assert.match(sameRepo, /README\.md/, 'sees its repo-mate\'s edits');
  assert.match(sameRepo, /The app uses yarn/);
  assert.doesNotMatch((await other.hook(prompt))?.additionalContext || '', /The app uses yarn|README\.md/, 'another repo\'s notes and agents stay out');

  const sessions = (await api('tok-alice', 'POST', `/teams/${team.id}/sessions`, { name: 'app-work' })).body;
  assert.equal(sessions.find(x => x.name === 'app-work').repo, 'acme/app', 'the session remembers its repo');
  await Promise.all([app.close(), other.close(), appToo.close()]);
});

test('sessions have comments, and agents show their latest prompt', async () => {
  const route = `/teams/${team.id}/sessions/s1/comments`;
  assert.equal((await api('tok-carol', 'POST', route, { text: 'hi' })).status, 404, 'not on the team');
  assert.equal((await api('tok-alice', 'POST', route, { text: ' ' })).status, 400);
  const sessions = (await api('tok-alice', 'POST', route, { text: 'I take the auth part' })).body;
  const comment = sessions.find(x => x.name === 's1').comments[0];
  assert.equal(comment.text, 'I take the auth part');
  assert.equal(comment.author, 'alice');
  assert.equal((await api('tok-alice', 'DELETE', `${route}/${comment.id}`)).status, 200);
  assert.equal((await api('tok-alice', 'POST', `/teams/${team.id}/members/bob/comments`, { text: 'x' })).status, 404, 'comments only exist on sessions');

  const shown = nextState(lanes => lanes.find(l => l.id === alice.id)?.prompt === 'make the lobby faster');
  await postHook(alice, { hook_event_name: 'UserPromptSubmit', prompt: 'make the lobby\n  faster' });
  await shown;
});

test('a session has a plan its agents are told about, and comments can point at lines of a file', async () => {
  const steps = `/teams/${team.id}/sessions/s1/steps`;
  assert.equal((await api('tok-bob', 'POST', steps, { text: ' ' })).status, 400);
  let sessions = (await api('tok-bob', 'POST', steps, { text: 'Lock the seat row', owner: '@bob' })).body;
  sessions = (await api('tok-alice', 'POST', steps, { text: 'Add the race test' })).body;
  const [lock, race] = sessions.find(x => x.name === 's1').steps;
  assert.deepEqual([lock.owner, lock.done], ['bob', false]);
  sessions = (await api('tok-alice', 'POST', `${steps}/${lock.id}`, { done: true })).body;
  assert.equal(sessions.find(x => x.name === 's1').steps[0].doneBy, 'alice');
  const ctx = (await (await postHook(alice, { hook_event_name: 'UserPromptSubmit', prompt: 'next' })).json()).hookSpecificOutput.additionalContext;
  assert.match(ctx, /- \[x\] Lock the seat row \(bob\)\n- \[ \] Add the race test/);
  assert.equal((await api('tok-alice', 'DELETE', `${steps}/${race.id}`)).status, 200);
  assert.equal((await api('tok-alice', 'DELETE', `${steps}/${race.id}`)).status, 404);

  const comments = `/teams/${team.id}/sessions/s1/comments`;
  sessions = (await api('tok-bob', 'POST', comments, { text: 'Why a loop here?', file: 'src/join.ts', line: 9, endLine: 13, snippet: 'for (let n = 0' })).body;
  const comment = sessions.find(x => x.name === 's1').comments.at(-1);
  assert.deepEqual([comment.file, comment.line, comment.endLine, comment.snippet], ['src/join.ts', 9, 13, 'for (let n = 0']);
});

test('a teammate\'s file is passed between apps only by its owner\'s', async () => {
  const nextMessage = (ws, match) => new Promise(resolve => ws.on('message', function on(raw) {
    const m = JSON.parse(raw);
    if (match(m)) { ws.off('message', on); resolve(m); }
  }));
  const bobs = await connectWatcher('tok-bob', team.id);
  // Bob asks for a file from Alice's agent; Alice's app (the test's watcher) is asked and answers.
  const asked = nextMessage(watcher, m => m.t === 'file:get');
  bobs.send(JSON.stringify({ t: 'file:get', lane: alice.id, path: 'src/join.ts', ask: 'q1' }));
  const ask = await asked;
  assert.deepEqual([ask.lane, ask.path, ask.from], [alice.id, 'src/join.ts', 'Bob']);
  bobs.send(JSON.stringify({ t: 'file:put', req: ask.req, text: 'forged' })); // not his to answer
  const got = nextMessage(bobs, m => m.t === 'file:put');
  watcher.send(JSON.stringify({ t: 'file:put', req: ask.req, text: 'export const join = 1;' }));
  assert.deepEqual(await got, { t: 'file:put', ask: 'q1', text: 'export const join = 1;' });
  // No app open for that agent: said straight away.
  const none = nextMessage(watcher, m => m.t === 'file:put');
  watcher.send(JSON.stringify({ t: 'file:get', lane: 'no-such-lane', path: 'x', ask: 'q2' }));
  assert.equal((await none).error, 'That agent has stopped.');
  bobs.close();
});

test('session names that differ only in case or punctuation are the same session', async () => {
  const a = await rawLane('same-a', { session: 'Fix Login', repo: 'acme/app' });
  const joined = nextState(lanes => lanes.some(l => l.id === 'same-b'));
  const b = await rawLane('same-b', { session: 'fix-login', repo: 'acme/app' });
  assert.equal((await joined).find(l => l.id === 'same-b').session, 'Fix Login', 'it joins the existing session');
  const sessions = (await api('tok-alice', 'GET', '/teams')).status === 200 && (await api('tok-alice', 'POST', `/teams/${team.id}/sessions`, { name: 'FIX  login!' })).body;
  assert.equal(sessions.filter(x => /fix.*login/i.test(x.name)).length, 1);
  await Promise.all([a.close(), b.close()]);
});

test('uncommitted changes count as edits, whoever or whatever made them', async () => {
  // Two checkouts of one repo. Neither agent edited through Claude's tools; git reports the changes.
  const one = await rawLane('git-one', { repo: 'acme/git', root: '/one' });
  const two = await rawLane('git-two', { repo: 'acme/git', root: '/two' });
  const git = changed => ({ t: 'git', branch: 'session/x', added: 1, removed: 0, files: changed.length, behind: 0, ahead: 0, changed });
  one.socket.send(JSON.stringify(git(['src/a.ts'])));
  await nextState(lanes => lanes.find(l => l.id === 'git-one')?.files.includes('src/a.ts'));
  const edit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/two/src/a.ts' }, cwd: '/two' };
  const res = await fetch(`${url}/hooks/git-two`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(edit) });
  assert.equal((await res.json()).hookSpecificOutput.permissionDecision, 'ask', 'Claude is asked before touching a file changed in another checkout');
  const both = nextState(lanes => ['git-one', 'git-two'].every(id => lanes.find(l => l.id === id)?.overlaps.includes('src/a.ts')));
  two.socket.send(JSON.stringify(git(['src/a.ts'])));
  await both;

  // Agents sharing one checkout share its changes, so they don't overlap with each other.
  const twin = await rawLane('git-twin', { repo: 'acme/git', root: '/one' });
  twin.socket.send(JSON.stringify(git(['src/b.ts'])));
  one.socket.send(JSON.stringify(git(['src/a.ts', 'src/b.ts'])));
  const after = await nextState(ls => ls.find(l => l.id === 'git-one')?.files.includes('src/b.ts') && ls.find(l => l.id === 'git-twin')?.files.includes('src/b.ts'));
  assert.ok(!after.find(l => l.id === 'git-one').overlaps.includes('src/b.ts'));
  const twinEdit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/one/src/b.ts' }, cwd: '/one' };
  const twinRes = await fetch(`${url}/hooks/git-twin`, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, body: JSON.stringify(twinEdit) });
  assert.equal((await twinRes.json().catch(() => null))?.hookSpecificOutput?.permissionDecision, undefined,
    "a change in its own folder isn't blamed on the other agent there");
  await Promise.all([one.close(), two.close(), twin.close()]);
});

test('checkouts of the same pushed branch only overlap on what neither has pushed', async () => {
  const git = (changed, local) => JSON.stringify({ t: 'git', branch: 'session/shared', added: 1, removed: 0, files: changed.length, behind: 0, ahead: 1, changed, local });
  const david = await rawLane('shared-david', { repo: 'acme/shared', root: '/david', branch: 'session/shared' });
  const max = await rawLane('shared-max', { repo: 'acme/shared', root: '/max', branch: 'session/shared' });
  // David pushed a change to store.ts; Max's checkout started from that push. Both differ from main there, neither collides.
  david.socket.send(git(['store.ts'], []));
  max.socket.send(git(['store.ts'], []));
  let lanes = await nextState(ls => ls.find(l => l.id === 'shared-max')?.files.includes('store.ts') && ls.find(l => l.id === 'shared-david')?.files.includes('store.ts'));
  assert.deepEqual(lanes.find(l => l.id === 'shared-max').overlaps, [], 'a shared commit is not an overlap');
  assert.equal(await max.hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/max/store.ts' }, cwd: '/max' }), null);
  const bash = command => max.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: '/max' });
  assert.match((await bash('git push origin -d session/shared'))?.permissionDecisionReason || '', /deletes session\/shared on the remote, which Alice also work/,
    'deleting the branch a teammate works on asks');
  // Now both change it without pushing.
  david.socket.send(git(['store.ts'], ['store.ts']));
  max.socket.send(git(['store.ts'], ['store.ts']));
  lanes = await nextState(ls => ['shared-david', 'shared-max'].every(id => ls.find(l => l.id === id)?.overlaps.includes('store.ts')));
  assert.equal((await max.hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/max/store.ts' }, cwd: '/max' }))?.permissionDecision, 'ask');
  for (const command of ["sed -i '' 's/a/b/' store.ts", 'echo x > store.ts', 'cat new.ts | tee ./store.ts', 'rm /max/store.ts']) {
    assert.equal((await bash(command))?.permissionDecision, 'ask', command);
  }
  for (const command of ['cat store.ts', 'sed -i "" s/a/b/ other.ts', 'echo store.ts']) assert.equal(await bash(command), null, command);
  await Promise.all([david.close(), max.close()]);
});

test('a teammate\'s file is recognised whichever way the path to it is written', async () => {
  // macOS resolves /var to /private/var: git reports one, an agent's shell may use the other.
  const one = await rawLane('sym-one', { repo: 'acme/sym', root: '/private/var/one', roots: ['/private/var/one', '/var/one'] });
  const two = await rawLane('sym-two', { repo: 'acme/sym', root: '/private/var/two', roots: ['/private/var/two', '/var/two'] });
  one.socket.send(JSON.stringify({ t: 'git', branch: 'session/x', added: 1, removed: 0, files: 1, behind: 0, ahead: 0, changed: ['src/a.ts'] }));
  await nextState(lanes => lanes.find(l => l.id === 'sym-one')?.files.includes('src/a.ts'));
  for (const file_path of ['/var/two/src/a.ts', '/private/var/two/src/a.ts', 'src/a.ts']) {
    const out = await two.hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path }, cwd: '/var/two' });
    assert.equal(out?.permissionDecision, 'ask', file_path);
  }
  await Promise.all([one.close(), two.close()]);
});

test('a Codex or OpenCode agent is working while it prints and idle once it goes quiet', async () => {
  const dir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'protoplasma-codex-'));
  const codex = path.join(dir, 'codex');
  require('node:fs').writeFileSync(codex, '#!/bin/sh\nfor i in 1 2 3; do echo step $i; sleep 0.3; done\nexec cat\n', { mode: 0o755 });
  const working = nextState(lanes => lanes.some(l => l.session === 'activity' && l.status === 'working'));
  processes.push(spawn('node', [LANE, url, team.id, 'activity', codex], { cwd: root, env: { ...process.env, PROTO_TOKEN: 'tok-alice' }, stdio: ['ignore', 'ignore', 'inherit'] }));
  const lane = (await working).find(l => l.session === 'activity');
  await nextState(lanes => lanes.find(l => l.id === lane.id)?.status === 'idle');
  const gone = nextState(lanes => !lanes.some(l => l.id === lane.id));
  processes.pop().kill();
  await gone;
  require('node:fs').rmSync(dir, { recursive: true, force: true });
});

test('agents without hooks report working and idle themselves', async () => {
  const lane = await rawLane('no-hooks', { cmd: 'codex', repo: 'acme/app' });
  for (const status of ['working', 'idle']) {
    const seen = nextState(lanes => lanes.find(l => l.id === 'no-hooks')?.status === status);
    lane.socket.send(JSON.stringify({ t: 'status', status }));
    await seen;
  }
  let sawHacked = false;
  const working = nextState(lanes => { const s = lanes.find(l => l.id === 'no-hooks')?.status; sawHacked ||= s === 'hacked'; return s === 'working'; });
  lane.socket.send(JSON.stringify({ t: 'status', status: 'hacked' }));
  lane.socket.send(JSON.stringify({ t: 'status', status: 'working' }));
  await working;
  assert.equal(sawHacked, false, 'an unknown status is ignored');
  await lane.close();
});

test('an agent waiting on its folder trust prompt needs you until someone answers', async () => {
  const asking = nextState(lanes => lanes.some(l => l.session === 'trust' && l.status === 'needs you'));
  processes.push(spawn('node', [LANE, url, team.id, 'trust', '--open', 'sh', '-c', 'printf "Do you trust the files in this folder?\\n ❯ 1. Yes, proceed\\n   2. No, exit"; cat'],
    { cwd: root, env: { ...process.env, PROTO_TOKEN: 'tok-alice' }, stdio: ['ignore', 'ignore', 'inherit'] }));
  const lane = (await asking).find(l => l.session === 'trust');
  const answered = nextState(lanes => lanes.find(l => l.id === lane.id)?.status === 'idle');
  watcher.send(JSON.stringify({ t: 'in', lane: lane.id, d: '\r' }));
  await answered;
  const gone = nextState(lanes => !lanes.some(l => l.id === lane.id));
  processes.pop().kill();
  await gone;
});

test('Codex asking to trust its folder needs you too (its answers aren\'t Yes and No)', async () => {
  const asking = nextState(lanes => lanes.some(l => l.session === 'codex-trust' && l.status === 'needs you'));
  // Codex 0.163's screen, as the lane sees it once escape sequences are gone (cursor moves leave no spaces).
  const lane = startLaneHere({ hub: url, team: team.id, token: 'tok-alice', session: 'codex-trust', cmd: 'sh',
    args: ['-c', 'printf "Folderaccess\\nTrustthisfolder?Codexcanread,edit,andrunfileshere.\\n› 1. Trust and continue\\n  2. Back to Agent Command Center\\n"; cat'] });
  try {
    await Promise.race([asking, sleep(5000).then(() => { throw new Error('never needed you'); })]);
  } finally {
    const gone = nextState(lanes => !lanes.some(l => l.id === lane.id));
    lane.term.kill();
    await gone;
  }
});

test('a reconnecting agent keeps the status its hooks gave it, after its trust prompt was answered', async () => {
  const asking = nextState(lanes => lanes.some(l => l.session === 'reconnect' && l.status === 'needs you'));
  const lane = startLaneHere({ hub: url, team: team.id, token: 'tok-alice', session: 'reconnect', cmd: 'sh',
    args: ['-c', 'echo "secret:$PROTO_HOOK_SECRET"; printf "Do you trust the files in this folder?\\n ❯ 1. Yes, proceed\\n   2. No, exit"; cat'] });
  let out = '';
  lane.term.onData(d => { out += d; });
  await asking;
  const answered = nextState(lanes => lanes.find(l => l.id === lane.id)?.status === 'idle');
  lane.write('\r');
  await answered;
  // Another connection with its id (and secret: the id is made from it) drops the agent's own, as a network blip would;
  // a pending permission then needs you.
  const blip = await rawLane(lane.id, { session: 'reconnect', hookSecret: /secret:(\w+)/.exec(out)[1] });
  const needs = nextState(lanes => lanes.find(l => l.id === lane.id)?.status === 'needs you');
  await blip.hook({ hook_event_name: 'PermissionRequest' });
  await needs;
  let status;
  const track = raw => { const m = JSON.parse(raw); if (m.t === 'state') status = m.lanes.find(l => l.id === lane.id)?.status; };
  watcher.on('message', track);
  await new Promise(resolve => blip.socket.on('close', resolve)); // the agent is back, and took its id over again
  await sleep(300);
  watcher.off('message', track);
  const gone = nextState(lanes => !lanes.some(l => l.id === lane.id));
  lane.term.kill();
  await gone;
  assert.equal(status, 'needs you', 'the reconnect didn\'t reset it to idle');
});

test('an agent is told when its branch has fallen behind', async () => {
  const lane = await rawLane('behind-lane', { branch: 'session/fix', repo: 'acme/app' });
  lane.socket.send(JSON.stringify({ t: 'git', branch: 'session/fix', added: 0, removed: 0, files: 0, behind: 2, ahead: 1 }));
  await nextState(lanes => lanes.some(l => l.id === 'behind-lane' && l.git?.behind === 2));
  const out = await lane.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.match(out.additionalContext, /2 commits behind/);
  await lane.close();
});

test('removes an agent when its process exits, keeping its last screen to look back at', async () => {
  const joined = nextState(lanes => lanes.some(l => l.session === 's1' && l.login === 'alice' && l.id !== alice.id));
  startLane('alice', 'sh', '-c', 'echo farewell-from-the-agent; sleep 0.5');
  const extra = (await joined).find(l => l.login === 'alice' && l.id !== alice.id);
  const ended = new Promise(resolve => watcher.on('message', function onMessage(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'state' && !m.lanes.some(l => l.id === extra.id) && m.stopped?.some(x => x.id === extra.id)) { watcher.off('message', onMessage); resolve(m.stopped); }
  }));
  const record = (await ended).find(x => x.id === extra.id);
  assert.equal(record.session, 's1');
  assert.equal(record.history, undefined, 'the screen itself is only sent on request');
  const replay = new Promise(resolve => watcher.on('message', function onMessage(raw) {
    const m = JSON.parse(raw);
    if (m.t === 'replay') { watcher.off('message', onMessage); resolve(m); }
  }));
  watcher.send(JSON.stringify({ t: 'replay', id: extra.id }));
  assert.match((await replay).d, /farewell-from-the-agent/);
});

test('a session can be renamed, with or without agents in it, keeping its branch name', async () => {
  const route = `/teams/${team.id}/sessions`;
  await api('tok-alice', 'POST', route, { name: 'old-name' });
  const followed = nextState(lanes => lanes.some(l => l.session === 'Busy') && !lanes.some(l => l.session === 's1'));
  assert.equal((await api('tok-alice', 'POST', `${route}/s1`, { rename: 'Busy' })).status, 200, 'renamed with agents running in it');
  await followed; // they move with it
  const again = (await api('tok-alice', 'POST', route, { name: 's1' })).body; // as an agent rejoining under its old name would
  assert.ok(!again.some(x => x.name === 's1') && again.some(x => x.name === 'Busy'), 'the old name still finds it');
  assert.equal((await api('tok-alice', 'POST', `${route}/Busy`, { rename: 's1' })).status, 200);
  let sessions = (await api('tok-alice', 'POST', `${route}/old-name`, { rename: 'New Name' })).body;
  const renamed = sessions.find(x => x.name === 'New Name');
  assert.equal(renamed.key, 'old-name', 'the branch and folders keep the original name');
  sessions = (await api('tok-alice', 'POST', route, { name: 'old-name' })).body;
  assert.equal(sessions.filter(x => /old-name|New Name/.test(x.name)).length, 1, 'the old name still finds it');
  assert.equal((await api('tok-alice', 'POST', `${route}/New%20Name`, { rename: 'S1' })).status, 409, 'names stay unique');
  assert.equal((await api('tok-bob', 'POST', `${route}/New%20Name`, { rename: 'x' })).status, 403);
});

test('removing someone from the team disconnects their agents, and inviting them back lets the agents rejoin', async () => {
  let refused = '';
  const joined = nextState(lanes => lanes.some(l => l.session === 'comeback'));
  const lane = startLaneHere({ hub: url, team: team.id, token: 'tok-bob', session: 'comeback', cmd: 'sh', onRefused: reason => { refused = reason; } });
  await joined;
  const gone = nextState(lanes => !lanes.some(l => l.login === 'bob'));
  assert.equal((await api('tok-alice', 'DELETE', `/teams/${team.id}/members/bob`)).status, 200);
  await gone;
  assert.deepEqual((await api('tok-bob', 'GET', '/teams')).body, []);
  await sleep(200);
  assert.equal(refused, 'Removed from the team.');

  const back = nextState(lanes => lanes.some(l => l.id === lane.id));
  assert.equal((await api('tok-alice', 'POST', `/teams/${team.id}/members`, { login: 'bob' })).status, 200);
  lane.rejoin(); // what the app does when it reconnects; otherwise it tries again on its own every 30 seconds
  await back;
  lane.term.kill();
});

test('members can leave, and the owner can delete a team only while no agents run in it', async () => {
  const members = `/teams/${team.id}/members`;
  assert.equal((await api('tok-alice', 'POST', members, { login: 'carol' })).status, 200);
  assert.equal((await api('tok-alice', 'POST', members, { login: 'Carol' })).status, 409, 'already on the team');
  assert.equal((await api('tok-carol', 'DELETE', `${members}/alice`)).status, 403, 'only yourself');
  assert.equal((await api('tok-carol', 'DELETE', `${members}/carol`)).status, 200);
  assert.deepEqual((await api('tok-carol', 'GET', '/teams')).body, []);

  assert.equal((await api('tok-alice', 'DELETE', `/teams/${team.id}`)).status, 409, 'alice still has an agent running');
  const spare = (await api('tok-alice', 'POST', '/teams', { name: 'Spare' })).body;
  assert.equal((await api('tok-alice', 'DELETE', `/teams/${spare.id}`)).status, 200);
  assert.deepEqual((await api('tok-alice', 'GET', '/teams')).body.map(t => t.name), ['Lobby']);
});

test('a missing agent command is an error, not a lane that vanishes', () => {
  assert.throws(() => startLaneHere({ hub: url, team: team.id, token: 'tok-alice', session: 's1', cmd: 'no-such-agent-cli' }), /isn't installed/);
});

test('reads the GitHub repo from a clone\'s remote', () => {
  assert.equal(repoFromRemote('https://github.com/dw8-ro/protoplasma-ide.git'), 'dw8-ro/protoplasma-ide');
  assert.equal(repoFromRemote('git@github.com:dw8-ro/protoplasma-ide.git'), 'dw8-ro/protoplasma-ide');
  assert.equal(repoFromRemote('https://github.com/a-b/c.d'), 'a-b/c.d');
  assert.equal(repoFromRemote('https://gitlab.com/a/b.git'), '');
});

test('scrollback keeps the latest output within its limit', () => {
  let buf = '';
  for (let i = 0; i < 5000; i++) buf = appendScrollback(buf, `line ${i}\n`.padEnd(200, '.'));
  assert.ok(buf.length <= 2 * SCROLLBACK);
  assert.ok(buf.endsWith(`line 4999\n`.padEnd(200, '.')));
});

test('only a session\'s creator or the team owner changes its goal', async () => {
  const sessions = `/teams/${team.id}/sessions`;
  await api('tok-alice', 'POST', sessions, { name: 'Goal kept', task: 'the goal' });
  const { body } = await api('tok-bob', 'POST', sessions, { name: 'goal-kept', task: 'overwritten' });
  assert.equal(body.find(s => s.name === 'Goal kept').task, 'the goal', 'bob joined it without changing its goal');
  assert.equal((await api('tok-alice', 'DELETE', `${sessions}/Goal%20kept`)).status, 200);
});

test('the hub keeps going when GitHub or its disk lets it down', async () => {
  const fs = require('node:fs'), os = require('node:os'), { once } = require('node:events');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-hub-'));
  fs.writeFileSync(path.join(dataDir, 'teams.json'), '{ not json');
  let down = false;
  const h = await startHub({ port: 0, host: '127.0.0.1', dataDir, verifyUser: async token => { if (down) throw new Error('GitHub is down'); return verifyUser(token); } });
  const u = `http://127.0.0.1:${h.port}`, call = (token, method, body) => fetch(`${u}/teams`, { method, headers: { authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) });
  assert.ok(fs.readdirSync(dataDir).some(f => f.startsWith('teams.json.bad-')), 'a damaged teams.json is kept aside, and the hub starts');
  const made = await (await call('tok-alice', 'POST', { name: 'T' })).json();

  down = true;
  assert.equal((await call('tok-newcomer', 'GET')).status, 503, 'GitHub being down means "try again", not "sign in"');
  const ws = new WebSocket(`${u.replace('http', 'ws')}/watch`);
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'watch', token: 'tok-other', team: made.id }));
  assert.equal((await once(ws, 'close'))[0], 1013, 'a connection is told to try again');
  down = false;

  const big = new WebSocket(`${u.replace('http', 'ws')}/lane`);
  await once(big, 'open');
  big.send('x'.repeat(6 * 1024 * 1024)); // over the frame limit: that socket closes, the hub doesn't
  await once(big, 'close');
  const raw = require('node:net').connect(h.port, '127.0.0.1');
  raw.write('GET /nope HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  raw.resetAndDestroy();
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await fetch(u)).status, 200, 'still answering after a bad frame and a reset');

  fs.rmSync(path.join(dataDir, 'teams.json'));
  fs.mkdirSync(path.join(dataDir, 'teams.json.tmp')); // saving now fails
  assert.equal((await call('tok-alice', 'POST', { name: 'Unsaved' })).status, 201, 'a failed save is logged, not fatal');
  assert.equal((await fetch(u)).status, 200);
  await h.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('session names made of dots are refused, and other bad requests get clear answers', async () => {
  const sessions = `/teams/${team.id}/sessions`;
  for (const name of ['.', '..', '...']) assert.equal((await api('tok-alice', 'POST', sessions, { name })).status, 400, name);
  assert.equal((await api('tok-alice', 'DELETE', `/teams/${team.id}/members/nobody-here`)).status, 404, 'removing someone who isn\'t on the team');
  const res = await fetch(`${url}/teams`, { method: 'POST', headers: { authorization: 'Bearer tok-alice' }, body: '{not json' });
  assert.equal(res.status, 400, 'JSON that doesn\'t parse');
});

test('the shell-write check asks only about files a command really writes', async () => {
  const theirs = await rawLane('w-bob', { token: 'tok-bob', repo: 'acme/web', branch: 'b', root: '/b', git: { changed: ['src/a.js', 'src/match/queue.ts'] } });
  const mine = await rawLane('w-alice', { repo: 'acme/web', branch: 'a' });
  const asks = async command => (await mine.hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }))?.permissionDecision === 'ask';
  for (const command of ['node src/a.js 2>&1 | tail', 'git diff src/a.js 2>/dev/null', 'cat src/a.js > /dev/null', 'cp src/a.js /tmp/x',
    'perl -MList::Util=sum -e 1 src/a.js', 'git checkout -- src/a.js']) { // the last only undoes this folder's own change
    assert.equal(await asks(command), false, `reads only: ${command}`);
  }
  for (const command of ['echo x > src/a.js', 'rm -rf src', 'rm -rf ./src/match/', 'sed --in-place s/a/b/ src/a.js', 'npx prettier --write src/a.js',
    'mv src/a.js src/b.js', 'cp /tmp/x src/a.js', 'bash -lc "rm src/a.js"']) {
    assert.equal(await asks(command), true, `writes: ${command}`);
  }
  await mine.close();
  await theirs.close();
});

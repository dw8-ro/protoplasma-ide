// Session worktrees and git status, against real repositories: a bare remote and two clones standing in for two teammates.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { sessionWorktree, removeSessionWorktree, installPushGuard, slug } = require('../src/workspace');
const { gitStatus } = require('../src/lane');

// The developer's own git config (push.autoSetupRemote, signing) and a shared-team agent's env would change the results.
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
delete env.PROTO_SHARED_TEAM;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo, file, text) => {
  fs.writeFileSync(path.join(repo, file), text);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', `add ${file}`);
};
let tmp, alice, bob, aliceTree;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-ws-'));
  const remote = path.join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  alice = path.join(tmp, 'alice');
  bob = path.join(tmp, 'bob');
  git(tmp, 'clone', '-q', remote, alice);
  git(alice, 'checkout', '-q', '-B', 'main');
  commit(alice, 'README.md', 'hello\n');
  git(alice, 'push', '-q', '-u', 'origin', 'main');
  git(alice, 'remote', 'set-head', 'origin', 'main');
  git(tmp, 'clone', '-q', remote, bob);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('session names become safe branch names', () => {
  assert.equal(slug('Fix Login!'), 'fix-login');
  assert.equal(slug('  ../weird//name  '), 'weird-name');
  assert.equal(slug('Ошибка входа'), 'ошибка-входа', 'letters of any script stay');
  assert.match(slug('🚀'), /^session-\w+$/);
  assert.notEqual(slug('🚀'), slug('🎉'), 'names without letters still differ');
  assert.notEqual(slug('❤️'), slug('⚠️'), 'emoji with a variation selector too');
  assert.equal(slug('नमस्ते'), 'नमस्ते', 'combining marks stay with their letters');
  for (const name of ['a..b', 'x.lock', '???', '日本語 v1.2']) {
    assert.doesNotThrow(() => execFileSync('git', ['check-ref-format', '--branch', `session/${slug(name)}`]), name);
  }
});

test('a session gets its own folder and branch, off the default branch', async () => {
  git(alice, 'checkout', '-q', '-b', 'scratch'); // what the main checkout has out shouldn't matter
  commit(alice, 'scratch.txt', 'local only\n');
  const { dir, branch } = await sessionWorktree(alice, 'Fix Login!', env);
  aliceTree = dir;
  assert.equal(git(alice, 'branch', '--show-current'), 'scratch', 'the main checkout is untouched');
  git(alice, 'checkout', '-q', 'main');
  assert.equal(branch, 'session/fix-login');
  assert.equal(git(dir, 'branch', '--show-current'), branch);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(alice, 'rev-parse', 'origin/main'), 'from the remote default branch');
  assert.deepEqual(await sessionWorktree(alice, 'fix login', env), { dir, branch }, 'reused, not recreated');
});

test('a bare `git push` from a session branch cannot land on main', () => {
  commit(aliceTree, 'login.js', 'export const login = 1;\n');
  assert.throws(() => git(aliceTree, 'push'));
  assert.equal(git(alice, 'rev-parse', 'origin/main'), git(alice, 'rev-parse', 'main'), 'main did not move');
});

test('a teammate continues from the pushed session branch', async () => {
  git(aliceTree, 'push', '-q', '-u', 'origin', 'session/fix-login');
  const { dir } = await sessionWorktree(bob, 'Fix Login!', env);
  assert.ok(fs.existsSync(path.join(dir, 'login.js')), 'has the teammate\'s commit');
  assert.equal(git(dir, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/session/fix-login');

  commit(dir, 'logout.js', 'export const logout = 1;\n');
  git(dir, 'push', '-q');
});

test('git status reports changes and how far behind the branch is', async () => {
  fs.writeFileSync(path.join(aliceTree, 'notes.txt'), 'wip\n');
  fs.appendFileSync(path.join(aliceTree, 'login.js'), 'export const more = 2;\n');
  const status = await gitStatus(aliceTree, { env, fetch: true });
  assert.equal(status.branch, 'session/fix-login');
  assert.equal(status.behind, 1, 'bob pushed one commit');
  assert.equal(status.added, 2, 'the committed line and the uncommitted one: neither is on main yet');
  assert.equal(status.files, 2, 'one changed on the branch, one untracked');
  assert.deepEqual(status.changed.sort(), ['login.js', 'notes.txt'], 'with their paths, for overlap warnings');
  assert.equal(status.ahead, 1, 'one commit main doesn\'t have');
  assert.equal(status.unpushed, 0);
});

test('the push guard stops shared-team agents pushing to main or force-pushing, but not a person', async () => {
  assert.equal(await installPushGuard(alice, env), true);
  const agent = { ...env, PROTO_SHARED_TEAM: '1' };
  const push = (cwd, extra, ...args) => execFileSync('git', ['push', '-q', ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  commit(aliceTree, 'more.js', 'export const more = 3;\n');
  assert.throws(() => push(aliceTree, agent, 'origin', 'HEAD:main'), /don't push straight to main/);
  assert.throws(() => push(aliceTree, agent, '--force', 'origin', 'HEAD:session/fix-login'), /replace commits/, "would drop Bob's commit");
  push(aliceTree, agent, 'origin', 'HEAD:refs/heads/session/elsewhere'); // a new session branch is fine
  push(aliceTree, {}, 'origin', 'HEAD:refs/heads/main'); // a person (no PROTO_SHARED_TEAM) isn't stopped

  fs.writeFileSync(path.join(bob, '.git/hooks/pre-push'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(await installPushGuard(bob, env), false, 'an existing hook is left alone');
  assert.equal(fs.readFileSync(path.join(bob, '.git/hooks/pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n');
});

test('a session folder is removed only when it has nothing uncommitted', async () => {
  fs.writeFileSync(path.join(aliceTree, 'draft.txt'), 'not committed\n');
  await assert.rejects(removeSessionWorktree(alice, 'Fix Login!', env), /modified or untracked|--force/);
  assert.ok(fs.existsSync(aliceTree), 'uncommitted work is kept');
  fs.rmSync(path.join(aliceTree, 'draft.txt'));
  fs.appendFileSync(path.join(aliceTree, 'README.md'), 'edited\n');
  await assert.rejects(removeSessionWorktree(alice, 'Fix Login!', env), /modified or untracked|--force/, 'an edit to a tracked file too');
  git(aliceTree, 'checkout', '--', 'README.md');
  const { dir } = await sessionWorktree(alice, 'Throwaway', env);
  assert.equal(await removeSessionWorktree(alice, 'Throwaway', env), true);
  assert.ok(!fs.existsSync(dir));
  assert.ok(git(alice, 'branch', '--list', 'session/throwaway'), 'the branch is kept');
  assert.equal(await removeSessionWorktree(alice, 'Never existed', env), false);
});

test('pushed work still counts as changed until it reaches main, and main moving on counts as behind', async () => {
  const { dir } = await sessionWorktree(alice, 'Ranked', env);
  commit(dir, 'ranked.js', 'export const ranked = 1;\n');
  git(dir, 'push', '-q', '-u', 'origin', 'session/ranked');
  const teammate = path.join(tmp, 'teammate');
  execFileSync('git', ['clone', '-q', git(alice, 'remote', 'get-url', 'origin'), teammate], { env });
  commit(teammate, 'hotfix.js', 'export const hotfix = 1;\n');
  git(teammate, 'push', '-q', 'origin', 'HEAD:main');
  const status = await gitStatus(dir, { env, fetch: true });
  assert.deepEqual(status.changed, ['ranked.js'], 'committed and pushed, but not on main yet');
  assert.equal(status.behind, 1, "main's new commit, although the branch's own upstream is up to date");
  assert.equal(status.ahead, 1);
  assert.equal(status.unpushed, 0);
  assert.deepEqual(status.local, [], 'everything here is pushed');

  // A teammate pushes to the same branch: that's behind, not a change of ours.
  const mate = path.join(tmp, 'mate');
  execFileSync('git', ['clone', '-q', '-b', 'session/ranked', git(alice, 'remote', 'get-url', 'origin'), mate], { env });
  commit(mate, 'matchmaking.js', 'export const mm = 1;\n');
  git(mate, 'push', '-q');
  fs.writeFileSync(path.join(dir, 'mine.js'), 'export const mine = 1;\n');
  const after = await gitStatus(dir, { env, fetch: true });
  assert.deepEqual(after.local, ['mine.js'], "the teammate's new file isn't counted as ours");
  assert.equal(after.behind, 2, "main's commit and the teammate's");
});

test('two agents starting one new session at once share one folder', async () => {
  const [a, b] = await Promise.all([sessionWorktree(alice, 'Same time', env), sessionWorktree(alice, 'Same time', env)]);
  assert.equal(a.dir, b.dir);
  assert.equal(git(a.dir, 'branch', '--show-current'), 'session/same-time');
});

test('git status keeps odd file names whole', async () => {
  const { dir } = await sessionWorktree(alice, 'Odd names', env);
  fs.writeFileSync(path.join(dir, 'say "hi".txt'), 'x\n');
  fs.writeFileSync(path.join(dir, ' leading space.txt'), 'x\n');
  const status = await gitStatus(dir, { env });
  assert.ok(status.changed.includes('say "hi".txt'), JSON.stringify(status.changed));
  assert.ok(status.changed.includes(' leading space.txt'), JSON.stringify(status.changed));
});

test('a folder holding ignored files that aren\'t build output is kept', async () => {
  const { dir } = await sessionWorktree(alice, 'Has env', env);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\nnode_modules/\n');
  git(dir, 'add', '.gitignore');
  git(dir, 'commit', '-qm', 'ignore');
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'x.js'), '');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
  await assert.rejects(removeSessionWorktree(alice, 'Has env', env), /\.env/);
  assert.ok(fs.existsSync(path.join(dir, '.env')), 'nothing was deleted');
  fs.rmSync(path.join(dir, '.env'));
  assert.equal(await removeSessionWorktree(alice, 'Has env', env), true, 'build output alone doesn\'t stop it');
});

test('new sessions still start after the default branch is renamed on the remote', async () => {
  const remote = path.join(tmp, 'remote.git');
  git(remote, 'branch', '-m', 'main', 'trunk');
  git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  try {
    const { dir } = await sessionWorktree(alice, 'After rename', env);
    assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'started from the renamed default branch');
  } finally {
    git(remote, 'branch', '-m', 'trunk', 'main');
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    git(alice, 'fetch', '-q', '--prune');
    git(alice, 'remote', 'set-head', 'origin', 'main');
  }
});

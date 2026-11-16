// Which files a checkout's branch would conflict with main in (lane.js gitStatus), against real repos.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// The developer's own git settings (signing, hooks, default branch) stay out of it.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const { gitStatus } = require('../src/lane');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-conflicts-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);

test('a branch is told which files it would conflict with main in, and only those', async () => {
  const origin = path.join(tmp, 'origin.git'), mine = path.join(tmp, 'mine'), theirs = path.join(tmp, 'theirs');
  git(tmp, 'init', '-q', '--bare', origin);
  git(tmp, 'clone', '-q', origin, mine);
  write(mine, 'a.txt', 'one\ntwo\nthree\n');
  write(mine, 'b.txt', 'left alone\n');
  git(mine, 'add', '.');
  git(mine, 'commit', '-q', '-m', 'start');
  git(mine, 'push', '-q', '-u', 'origin', 'main');
  git(tmp, 'clone', '-q', origin, theirs);

  git(mine, 'checkout', '-q', '-b', 'session/x');
  assert.deepEqual((await gitStatus(mine)).conflicts, [], 'nothing while main has nothing new');
  write(mine, 'a.txt', 'one\nTWO, mine\nthree\n');
  git(mine, 'commit', '-q', '-am', 'mine');

  // A teammate's change to another file lands on main: both have commits the other lacks, and they merge cleanly.
  write(theirs, 'b.txt', 'changed by them\n');
  git(theirs, 'commit', '-q', '-am', 'theirs, elsewhere');
  git(theirs, 'push', '-q');
  let status = await gitStatus(mine, { fetch: true });
  assert.deepEqual([status.ahead, status.behind, status.conflicts], [1, 1, []], 'behind main, but nothing would conflict');

  // Then one to the same line.
  write(theirs, 'a.txt', 'one\nTWO, theirs\nthree\n');
  git(theirs, 'commit', '-q', '-am', 'theirs, same line');
  git(theirs, 'push', '-q');
  status = await gitStatus(mine, { fetch: true });
  assert.deepEqual(status.conflicts, ['a.txt']);
  assert.equal(git(mine, 'status', '--porcelain'), '', 'asking changes nothing in the folder');
  assert.equal(git(mine, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'session/x');

  // Merged and settled, it goes.
  try { git(mine, 'merge', '-q', 'origin/main'); } catch {} // stops on the conflict
  write(mine, 'a.txt', 'one\nTWO, both\nthree\n');
  git(mine, 'commit', '-q', '-am', 'settled');
  assert.deepEqual((await gitStatus(mine)).conflicts, []);
});

test('a branch is told which other sessions\' pushed branches it would conflict with', async () => {
  const root = path.join(tmp, 'sessions'), origin = path.join(root, 'origin.git'), mine = path.join(root, 'mine'), theirs = path.join(root, 'theirs');
  fs.mkdirSync(root);
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, mine);
  write(mine, 'a.txt', 'one\ntwo\nthree\n');
  write(mine, 'b.txt', 'left alone\n');
  git(mine, 'add', '.');
  git(mine, 'commit', '-q', '-m', 'start');
  git(mine, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'clone', '-q', origin, theirs);

  // My session: one commit, pushed, so my own branch is on the remote too and must not count against me.
  git(mine, 'checkout', '-q', '-b', 'session/x');
  write(mine, 'a.txt', 'one\nTWO, mine\nthree\n');
  git(mine, 'commit', '-q', '-am', 'mine');
  git(mine, 'push', '-q', '-u', 'origin', 'session/x');

  // A teammate's session that changes another file: no conflict.
  git(theirs, 'checkout', '-q', '-b', 'session/y');
  write(theirs, 'b.txt', 'changed by them\n');
  git(theirs, 'commit', '-q', '-am', 'theirs, elsewhere');
  git(theirs, 'push', '-q', '-u', 'origin', 'session/y');
  let status = await gitStatus(mine, { fetch: true });
  assert.deepEqual([status.conflicts, status.branchConflicts], [[], []], 'main hasn\'t moved, and the other session touches another file');

  // Then the same line.
  write(theirs, 'a.txt', 'one\nTWO, theirs\nthree\n');
  git(theirs, 'commit', '-q', '-am', 'theirs, same line');
  git(theirs, 'push', '-q');
  status = await gitStatus(mine, { fetch: true });
  assert.deepEqual(status.branchConflicts, [{ branch: 'session/y', files: ['a.txt'] }]);
  assert.deepEqual(status.conflicts, [], 'main itself is still clean');
  assert.equal(git(mine, 'status', '--porcelain'), '', 'asking changes nothing in the folder');

  // Once their branch is in main, it's main's conflict, not the branch's.
  git(theirs, 'checkout', '-q', 'main');
  git(theirs, 'merge', '-q', 'session/y');
  git(theirs, 'push', '-q', 'origin', 'main');
  status = await gitStatus(mine, { fetch: true });
  assert.deepEqual([status.conflicts, status.branchConflicts], [['a.txt'], []]);
});

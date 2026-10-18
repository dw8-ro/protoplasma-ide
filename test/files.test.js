// The code view's file access (app/files.js): Commit & Push when a teammate pushed first, and the folder boundary.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const files = require('../app/files');

const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-files-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const remote = path.join(tmp, 'remote.git');
git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
const seed = path.join(tmp, 'seed');
git(tmp, 'clone', '-q', remote, seed);
fs.writeFileSync(path.join(seed, 'lobby.js'), 'one\ntwo\nthree\n');
git(seed, 'add', '.');
git(seed, 'commit', '-qm', 'first');
git(seed, 'push', '-q', 'origin', 'HEAD:main');
// David and Max both work on session/lobby, each in their own clone.
const [david, max] = ['david', 'max'].map(name => {
  const dir = path.join(tmp, name);
  git(tmp, 'clone', '-q', remote, dir);
  git(dir, 'checkout', '-q', '-b', 'session/lobby');
  return dir;
});

test('Commit & Push puts your commit on top of a teammate\'s and pushes it', async () => {
  fs.writeFileSync(path.join(david, 'david.js'), 'd\n');
  assert.equal(await files.commitAndPush(david, 'David\'s part', env), 'Committed and pushed.');
  fs.writeFileSync(path.join(max, 'max.js'), 'm\n');
  assert.match(await files.commitAndPush(max, 'Max\'s part', env), /on top of your teammate's work on session\/lobby, and pushed/);
  git(david, 'pull', '-q', 'origin', 'session/lobby');
  assert.ok(fs.existsSync(path.join(david, 'max.js')), 'both parts are on the branch');
  assert.equal((await files.status(max, env)).unpushed, 0);
});

test('a real conflict is left for a person, with the commit kept and nothing half-done', async () => {
  fs.writeFileSync(path.join(david, 'lobby.js'), 'one\nDAVID\nthree\n');
  await files.commitAndPush(david, 'David edits line two', env);
  fs.writeFileSync(path.join(max, 'lobby.js'), 'one\nMAX\nthree\n');
  assert.match(await files.commitAndPush(max, 'Max edits line two', env), /changed the same lines on session\/lobby/);
  assert.equal(git(max, 'status', '--porcelain'), '', 'no rebase left in progress');
  assert.equal(fs.readFileSync(path.join(max, 'lobby.js'), 'utf8'), 'one\nMAX\nthree\n', 'his work is still there');
  assert.equal((await files.status(max, env)).unpushed, 1, 'and shows as not pushed');
});

test('mid-rebase, conflicts are marked and nothing gets committed', async () => {
  assert.throws(() => git(max, 'pull', '--rebase', 'origin', 'session/lobby'), /conflict|CONFLICT|Command failed/);
  const status = await files.status(max, env);
  assert.equal(status.underWay, 'rebase');
  assert.deepEqual(status.changes.find(c => c.path === 'lobby.js'), { path: 'lobby.js', state: 'C' });
  await assert.rejects(files.commitAndPush(max, 'Oops', env), /rebase is under way/);
  assert.match(fs.readFileSync(path.join(max, 'lobby.js'), 'utf8'), /<<<<<<<|=======/, 'left for a person to resolve');
  git(max, 'rebase', '--abort');
  assert.equal((await files.status(max, env)).underWay, null);
});

test('Pull brings in the teammate\'s work, and Commit & Push finishes the merge once the conflict is fixed', async () => {
  assert.match(await files.pull(max, env), /files marked C changed on both sides/);
  const status = await files.status(max, env);
  assert.equal(status.underWay, 'merge');
  assert.deepEqual(status.changes.find(c => c.path === 'lobby.js'), { path: 'lobby.js', state: 'C' });
  await assert.rejects(files.commitAndPush(max, '', env), /still have git's conflict lines/);
  fs.writeFileSync(path.join(max, 'lobby.js'), 'one\nDAVID and MAX\nthree\n'); // fixed in the editor
  assert.equal(await files.commitAndPush(max, '', env), 'Merged and pushed.');
  assert.equal((await files.status(max, env)).underWay, null);
  git(david, 'fetch', '-q');
  assert.equal(git(david, 'show', 'origin/session/lobby:lobby.js'), 'one\nDAVID and MAX\nthree', 'both their work is on the branch');
  fs.writeFileSync(path.join(max, 'lobby.js'), 'not committed\n');
  await assert.rejects(files.pull(max, env), /Commit or undo your changes first/, 'a pull never mixes into uncommitted work');
  git(max, 'checkout', '--', 'lobby.js');
});

test('nothing outside the session folder can be read or written, symlinks included', () => {
  fs.symlinkSync(os.homedir(), path.join(david, 'home-link'));
  // A sibling whose name starts with the session folder's ("david-evil" next to "david") is outside it too.
  fs.mkdirSync(path.join(tmp, 'david-evil'));
  fs.writeFileSync(path.join(tmp, 'david-evil', 'x.js'), 'secret\n');
  fs.symlinkSync(path.join(tmp, 'david-evil'), path.join(david, 'evil-link'));
  for (const rel of ['../max/lobby.js', '/etc/hosts', 'home-link', '../david-evil/x.js', 'evil-link/x.js']) {
    const got = files.read(david, rel); // says why it can't be shown, instead of showing it
    assert.ok(got.outside || got.gone, `${rel}: ${JSON.stringify(got)}`);
    assert.equal(got.text, undefined, rel);
    assert.throws(() => files.write(david, rel, 'x'), /outside the session folder/, rel);
  }
  assert.equal(fs.readFileSync(path.join(tmp, 'david-evil', 'x.js'), 'utf8'), 'secret\n', 'nothing was written through');
  assert.equal(files.read(david, 'lobby.js').text, 'one\nDAVID\nthree\n');
});

test('saving through a link out of the folder makes no folders out there either', () => {
  assert.throws(() => files.write(david, 'evil-link/a/b/x.js', 'x'), /outside the session folder/);
  assert.ok(!fs.existsSync(path.join(tmp, 'david-evil', 'a')), 'no empty folders left outside');
});

test('saving to a link that points nowhere is refused, rather than creating its target', () => {
  const target = path.join(tmp, 'nowhere.js');
  fs.symlinkSync(target, path.join(david, 'nowhere-link'));
  assert.throws(() => files.write(david, 'nowhere-link', 'x'), /doesn't exist/);
  assert.ok(!fs.existsSync(target));
});

test('a renamed file shows once, under its new name', async () => {
  git(max, 'mv', 'max.js', 'moved.js');
  assert.deepEqual((await files.status(max, env)).changes, [{ path: 'moved.js', state: 'R' }]);
  git(max, 'mv', 'moved.js', 'max.js');
});

test('the Explorer lists tracked and new files, not ignored ones; a plain folder skips node_modules', async () => {
  const repo = path.join(tmp, 'listing');
  git(tmp, 'init', '-q', '-b', 'main', repo);
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.env\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'first');
  fs.writeFileSync(path.join(repo, 'new.js'), 'n\n');
  fs.writeFileSync(path.join(repo, 'secret.env'), 'TOKEN=x\n');
  const listed = await files.list(repo, env);
  assert.deepEqual(listed, ['new.js', '.gitignore', 'src/a.js'], 'new files first');
  const plain = path.join(tmp, 'plain');
  fs.mkdirSync(path.join(plain, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'node_modules', 'dep', 'i.js'), '');
  fs.writeFileSync(path.join(plain, 'index.js'), '');
  assert.deepEqual(await files.list(plain, env), ['index.js']);
});

test('Find in files matches any case, keeps CRLF files and odd names whole', async () => {
  const repo = path.join(tmp, 'finding');
  git(tmp, 'init', '-q', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, 'windows.txt'), 'first\r\nHello World\r\n');
  fs.writeFileSync(path.join(repo, 'a:12:b.txt'), 'hello there\n');
  git(repo, 'add', '.');
  const hits = (await files.search(repo, 'HELLO', env)).sort((x, y) => x.path.localeCompare(y.path));
  assert.deepEqual(hits, [{ path: 'a:12:b.txt', line: 1, text: 'hello there' }, { path: 'windows.txt', line: 2, text: 'Hello World' }]);
  assert.deepEqual(await files.search(repo, 'nowhere-to-be-found', env), []);
});

test('reading a folder\'s git status never runs a command its own config names', async () => {
  // Such a folder could be one an agent is still asking whether to trust.
  const repo = path.join(tmp, 'hostile'), mark = path.join(tmp, 'fsmonitor-ran');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a'), 'hi\n');
  git(repo, 'add', 'a');
  git(repo, 'commit', '-qm', 'i');
  git(repo, 'config', 'core.fsmonitor', `touch '${mark}'; echo`);
  fs.writeFileSync(path.join(repo, 'a'), 'changed\n');
  assert.deepEqual((await files.status(repo, env)).changes, [{ path: 'a', state: 'M' }]);
  assert.equal((await require('../src/lane').gitStatus(repo, { env })).files, 1);
  assert.equal(fs.existsSync(mark), false);
});

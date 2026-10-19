// Version comparison for updates from GitHub releases.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isNewer, ownBundle, latestRelease } = require('../app/updates');

test('newer versions are recognised, with or without a leading v', () => {
  assert.equal(isNewer('0.2.0', '0.1.9'), true);
  assert.equal(isNewer('v0.10.0', '0.9.3'), true, 'numbers, not strings');
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', 'v0.2.0'), false);
  assert.equal(isNewer('0.2', '0.2.0'), false, 'missing parts count as 0');
});

test('only an app bundle in a writable folder can update itself', () => {
  assert.equal(ownBundle('/usr/local/bin/node'), null);
  assert.equal(ownBundle('/System/Applications/Calculator.app/Contents/MacOS/Calculator'), null, 'not writable');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-app-'));
  try {
    assert.equal(ownBundle(path.join(dir, 'My.app/Contents/MacOS/My')), path.join(dir, 'My.app'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a GitHub CLI login that can\'t see the private repo is told so, not "no releases yet"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-gh-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 }); // the public API: a private repo is a 404
  try {
    // A stand-in gh: the repo is visible (or not) per CAN_SEE, and it has no releases.
    fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
case "$2" in
  */releases/latest) echo 'gh: Not Found (HTTP 404)' >&2; exit 1;;
  *) [ "$CAN_SEE" = 1 ] && { echo '{"full_name":"dw8-ro/protoplasma-ide"}'; exit 0; }; echo 'gh: Not Found (HTTP 404)' >&2; exit 1;;
esac
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
    assert.equal(await latestRelease({ ...env, CAN_SEE: '1' }), null, 'a repo it can see, with no releases');
    await assert.rejects(latestRelease({ ...env, CAN_SEE: '0' }), /can't see Protoplasma's repo/);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Runs stage() against a tiny stand-in app (ad hoc signed, like a local build) served from a local server, with
// stand-in `open` and `osascript` that record their calls, and a stand-in running app. `setup(dir, installed)` can
// add more stand-ins to bin/ or leave things behind first. Returns what happened once `open` was called.
async function swap(setup = () => {}) {
  const { stage } = require('../app/updates');
  const http = require('node:http');
  const { execFileSync, spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-swap-'));
  const makeApp = (where, version) => {
    const app = path.join(where, 'Protoplasma.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.protoplasma-update-test</string>
<key>CFBundleExecutable</key><string>run</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'run'), '#!/bin/sh\n', { mode: 0o755 });
    execFileSync('codesign', ['--force', '--sign', '-', app]);
    return app;
  };
  const installed = makeApp(path.join(dir, 'Applications'), '1.0.0');
  makeApp(path.join(dir, 'build'), '1.0.1');
  execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(dir, 'build', 'Protoplasma.app'), path.join(dir, 'u.zip')]);
  const zip = fs.readFileSync(path.join(dir, 'u.zip'));
  const server = http.createServer((req, res) => { res.setHeader('content-length', zip.length); res.end(zip); }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const bin = path.join(dir, 'bin'), at = name => path.join(dir, name);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'open'), `#!/bin/sh\necho "$@" > "${at('opened')}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/sh\ntouch "${at('alerted')}"\n`, { mode: 0o755 });
  setup(dir, installed);
  const running = spawn('sleep', ['60']);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const until = async ok => { for (let i = 0; i < 50 && !ok(); i++) await new Promise(r => setTimeout(r, 100)); };
  try {
    const seen = [];
    const release = { version: '1.0.1', public: true, asset: { name: 'Protoplasma-1.0.1-mac-arm64.zip', url: `http://127.0.0.1:${server.address().port}/` } };
    await stage(release, installed, running.pid, env, f => seen.push(f));
    await new Promise(r => setTimeout(r, 700));
    const early = fs.existsSync(at('opened'));
    running.kill();
    await until(() => fs.existsSync(at('opened')));
    await until(() => !fs.existsSync(`${installed}.old`));
    await new Promise(r => setTimeout(r, 300)); // the alert runs in the background
    return { seen, early, installed, opened: fs.readFileSync(at('opened'), 'utf8').trim(), alerted: fs.existsSync(at('alerted')),
      version: /<string>(\d+\.\d+\.\d+)<\/string>/.exec(fs.readFileSync(path.join(installed, 'Contents', 'Info.plist'), 'utf8'))?.[1],
      old: fs.existsSync(`${installed}.old`), apps: fs.readdirSync(path.dirname(installed)) };
  } finally {
    running.kill();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an update downloads with progress, swaps in once the app quits, and reopens the new version', async () => {
  const r = await swap();
  assert.equal(r.seen.at(-1), 1, 'progress reaches the whole download');
  assert.equal(r.early, false, 'nothing happens while the app still runs');
  assert.equal(r.opened, `-n ${r.installed}`, 'the app reopens');
  assert.equal(r.version, '1.0.1', 'on the new version');
  assert.equal(r.old, false, 'the old copy is cleaned up');
  assert.equal(r.alerted, false);
});

test('a swap that fails halfway puts the old version back and says so', async () => {
  // A stand-in mv that moves the app away but then fails to put the new one in, after leaving half of it behind.
  const r = await swap((dir, installed) => fs.writeFileSync(path.join(dir, 'bin', 'mv'),
    `#!/bin/sh\ncase "$1" in */new/*) mkdir -p "$2/Contents"; exit 1;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 }));
  assert.equal(r.version, '1.0.0', 'the old version is back, not deleted');
  assert.equal(r.opened, `-n ${r.installed}`, 'and reopens');
  assert.equal(r.alerted, true);
  assert.deepEqual(r.apps, ['Protoplasma.app']);
});

test('a leftover from an interrupted swap doesn\'t swallow the app', async () => {
  const r = await swap((dir, installed) => fs.mkdirSync(`${installed}.old`));
  assert.equal(r.version, '1.0.1');
  assert.deepEqual(r.apps, ['Protoplasma.app']);
});

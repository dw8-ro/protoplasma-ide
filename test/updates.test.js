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

test('an update downloads with progress, swaps in once the app quits, and reopens the new version', async () => {
  const { stage } = require('../app/updates');
  const http = require('node:http');
  const { execFileSync, spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-swap-'));
  // A tiny stand-in app, ad hoc signed like a local build, in the given version.
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
  // A stand-in `open` that records what it was asked to open, and a stand-in running app to wait for.
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', 'open'), `#!/bin/sh\necho "$@" > "${dir}/opened"\n`, { mode: 0o755 });
  const running = spawn('sleep', ['60']);
  const env = { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` };
  try {
    const seen = [];
    const release = { version: '1.0.1', public: true, asset: { name: 'Protoplasma-1.0.1-mac-arm64.zip', url: `http://127.0.0.1:${server.address().port}/` } };
    await stage(release, installed, running.pid, env, f => seen.push(f));
    assert.equal(seen.at(-1), 1, 'progress reaches the whole download');
    await new Promise(r => setTimeout(r, 700));
    assert.equal(fs.existsSync(path.join(dir, 'opened')), false, 'nothing happens while the app still runs');
    running.kill();
    const plist = path.join(installed, 'Contents', 'Info.plist');
    for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'opened')); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(fs.readFileSync(path.join(dir, 'opened'), 'utf8').trim(), `-n ${installed}`, 'the app reopens');
    assert.match(fs.readFileSync(plist, 'utf8'), /<string>1\.0\.1<\/string>/, 'on the new version');
    for (let i = 0; i < 50 && fs.existsSync(`${installed}.old`); i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(fs.existsSync(`${installed}.old`), false, 'the old copy is cleaned up');
  } finally {
    running.kill();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

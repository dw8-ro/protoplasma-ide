// Version comparison for updates from GitHub releases.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isNewer, ownBundle } = require('../app/updates');

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
});

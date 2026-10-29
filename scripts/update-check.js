// After a release: a copy of an older release updates itself to the latest one, for real. The older release is
// downloaded into a temporary .noindex folder, then app/updates.js does what the app does: finds the latest release,
// downloads it, checks who signed it and its version, and swaps it in once a stand-in for the app's process exits.
// `open` and `osascript` are stubbed, so nothing is launched. Also checks that a tampered or unsigned copy is refused.
// Usage: node scripts/update-check.js [older version, default: the release before the latest]
// UPDATER=<path to an updates.js> tests another version's updater (e.g. one from `git show v0.5.3:app/updates.js`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { execFileSync, spawn, spawnSync } = require('child_process');
const updates = require(path.resolve(process.env.UPDATER || path.join(__dirname, '../app/updates.js')));

const API = 'https://api.github.com/repos/dw8-ro/protoplasma-ide/releases';
const tmp = path.join(os.tmpdir(), `protoplasma-update-check-${Date.now()}.noindex`); // .noindex: Spotlight skips it
const sh = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const versionOf = app => sh('/usr/bin/plutil', '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')).trim();
// Who must have signed an app (codesign prints it to stderr or stdout depending on the version).
const designated = app => { const r = spawnSync('codesign', ['-d', '-r-', app], { encoding: 'utf8' }); return /^designated => (.*)$/m.exec(r.stdout + r.stderr)?.[1]; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (name, ok) => { assert.ok(ok, name); console.log(`PASS  ${name}`); };

async function main() {
  const latest = await updates.latestRelease(process.env);
  check(`the latest release is found (${latest?.version})`, latest && /^Protoplasma-[\d.]+-mac-arm64\.zip$/.test(latest.asset.name));
  const from = (process.argv[2] || (await (await fetch(`${API}?per_page=2`, { headers: { 'user-agent': 'protoplasma' } })).json())[1].tag_name).replace(/^v/, '');
  check(`${latest.version} is newer than ${from}`, updates.isNewer(latest.version, from));

  // The older release, as an installed copy would be.
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
  const zip = path.join(tmp, 'old.zip');
  const res = await fetch(`https://github.com/dw8-ro/protoplasma-ide/releases/download/v${from}/Protoplasma-${from}-mac-arm64.zip`);
  assert.ok(res.ok, `downloading ${from}: ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  sh('ditto', '-x', '-k', zip, path.join(tmp, 'old'));
  const bundle = path.join(tmp, 'old', 'Protoplasma.app');
  const signer = designated(bundle);
  check(`the old copy is ${from}, signed with the release certificate, and can update itself`, versionOf(bundle) === from && /certificate/.test(signer)
    && updates.ownBundle(path.join(bundle, 'Contents/MacOS/Protoplasma')) === bundle);

  // What a forged update would look like: a signed copy with a file changed, and the same app signed ad hoc.
  for (const [name, spoil] of [['a tampered copy', app => fs.appendFileSync(path.join(app, 'Contents/Resources/app.asar'), 'x')],
    ['an ad hoc signed copy', app => sh('codesign', '--force', '--deep', '--sign', '-', app)]]) {
    const fake = path.join(tmp, name.replace(/\W/g, '-'), 'Protoplasma.app');
    sh('ditto', bundle, fake);
    spoil(fake);
    check(`${name} is refused`, await updates.sameSigner(bundle, fake, process.env).then(() => false, () => true));
  }

  // The update itself. swap.sh logs to ~/Library/Logs, so HOME points here; `open` and `osascript` only leave a note.
  // Set on this process too: 0.5.3's updater starts swap.sh with this process's environment, not the one it's given,
  // and the real `open` would launch the updated copy.
  process.env.HOME = tmp;
  for (const cmd of ['open', 'osascript']) fs.writeFileSync(path.join(tmp, 'bin', cmd), `#!/bin/sh\necho "$@" >> "${tmp}/${cmd}.log"\n`, { mode: 0o755 });
  process.env.PATH = `${path.join(tmp, 'bin')}:${process.env.PATH}`;
  const env = { ...process.env };
  const app = spawn('sleep', ['600']); // stands in for the running app: the swap waits for it to quit
  const staging = new Set(fs.readdirSync(os.tmpdir()));
  let progress = 0;
  await updates.stage(latest, bundle, app.pid, env, f => { progress = f; });
  if (!process.env.UPDATER) check('the download reported its progress', progress > 0.99);
  await sleep(1000);
  check('nothing is swapped while the app still runs', versionOf(bundle) === from);
  app.kill();
  const opened = path.join(tmp, 'open.log');
  for (let i = 0; i < 120 && !fs.existsSync(opened); i++) await sleep(500);
  await sleep(2000); // the clean-up after reopening
  check(`once it quits, ${latest.version} is in its place`, versionOf(bundle) === latest.version);
  check('and is signed with the same certificate', designated(bundle) === signer && spawnSync('codesign', ['--verify', '--deep', '--strict', bundle]).status === 0);
  check('it reopens the app', fs.readFileSync(opened, 'utf8').includes(bundle));
  check('no failure alert', !fs.existsSync(path.join(tmp, 'osascript.log')));
  check('the old copy and the download are cleaned up', !fs.existsSync(`${bundle}.old`)
    && !fs.readdirSync(os.tmpdir()).some(f => !staging.has(f) && f.startsWith('protoplasma-update-')));
}

main().then(() => console.log('Update check passed.'), e => { console.error(`FAIL  ${e.message}`); process.exitCode = 1; })
  .finally(() => { if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); });

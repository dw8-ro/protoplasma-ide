// Updates from GitHub releases, without Apple's paid signing. The release workflow (.github/workflows/release.yml)
// publishes a zipped app for every version tag; this finds the newest, downloads it, and swaps it in for the running
// app once that has quit. Downloads made by the app aren't quarantined, so macOS opens the new version without a prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'dw8-ro/protoplasma-ide';
const ASSET = /^Protoplasma-[\d.]+-mac-arm64\.zip$/;

/** Whether version `a` ("0.2.3" or "v0.2.3") is newer than `b`. */
function isNewer(a, b) {
  const parts = v => String(v).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

const run = (cmd, args, env) => new Promise((resolve, reject) => execFile(cmd, args, { env, maxBuffer: 10e6, timeout: 300_000 },
  (err, out, errOut) => (err ? reject(new Error(errOut.trim().split('\n').pop() || err.message)) : resolve(out))));

/**
 * The newest release with a Mac build: { version, notes, url, asset, public }, or null if there isn't one or GitHub
 * can't be reached. A public repo is read directly; a private one through the GitHub CLI, so its collaborators get
 * updates too.
 */
async function latestRelease(env) {
  const shape = (r, isPublic) => {
    const asset = r?.assets?.find(a => ASSET.test(a.name));
    return asset ? { version: r.tag_name.replace(/^v/, ''), notes: r.body || '', url: r.html_url, asset: { name: asset.name, url: asset.browser_download_url }, public: isPublic } : null;
  };
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'user-agent': 'protoplasma' } }).catch(() => null);
  if (res?.ok) return shape(await res.json(), true);
  try { return shape(JSON.parse(await run('gh', ['api', `repos/${REPO}/releases/latest`], env)), false); } catch { return null; }
}

/** The .app bundle this process runs from, if it can be replaced in place. */
function ownBundle(exe) {
  const bundle = path.resolve(exe, '../../..');
  if (!bundle.endsWith('.app')) return null;
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); return bundle; } catch { return null; }
}

/**
 * Downloads `release` and arranges for it to replace `bundle` as soon as process `pid` exits, then reopens it.
 * If the swap fails, the old version is put back.
 */
async function stage(release, bundle, pid, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-update-'));
  const zip = path.join(dir, release.asset.name);
  if (release.public) {
    const res = await fetch(release.asset.url, { headers: { 'user-agent': 'protoplasma' } });
    if (!res.ok) throw new Error(`Couldn't download the update (GitHub answered ${res.status}).`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  } else {
    await run('gh', ['release', 'download', `v${release.version}`, '-R', REPO, '-p', release.asset.name, '-D', dir], env);
  }
  await run('ditto', ['-x', '-k', zip, path.join(dir, 'new')], env);
  const fresh = path.join(dir, 'new', 'Protoplasma.app');
  if (!fs.existsSync(path.join(fresh, 'Contents', 'Info.plist'))) throw new Error('The update didn\'t contain the app.');
  await run('xattr', ['-dr', 'com.apple.quarantine', fresh], env).catch(() => {}); // usually there's nothing to remove
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, `#!/bin/sh
while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done
if mv "$1" "$1.old" && mv "$2" "$1"; then rm -rf "$1.old"; elif [ -d "$1.old" ] && [ ! -d "$1" ]; then mv "$1.old" "$1"; fi
open "$1"
`, { mode: 0o755 });
  spawn('/bin/sh', [script, bundle, fresh], { detached: true, stdio: 'ignore' }).unref();
}

module.exports = { isNewer, latestRelease, ownBundle, stage, REPO };

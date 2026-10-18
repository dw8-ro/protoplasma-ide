// Updates from GitHub releases, without Apple's paid signing. The release workflow (.github/workflows/release.yml)
// publishes a zipped app for every version tag; this finds the newest, downloads it, and swaps it in for the running
// app once that has quit. Downloads made by the app aren't quarantined, so macOS opens the new version without a prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const REPO = 'dw8-ro/protoplasma-ide';
const ASSET = /^Protoplasma-[\d.]+-mac-arm64\.zip$/;

/** Whether version `a` ("0.2.3", "v0.2.3", "0.3.0-beta.1") is newer than `b`. A release is newer than its prereleases. */
function isNewer(a, b) {
  const split = v => { const [nums, pre = ''] = String(v).replace(/^v/, '').split('-', 2); return [nums.split('.').map(n => parseInt(n, 10) || 0), pre]; };
  const [[x, xPre], [y, yPre]] = [split(a), split(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  if (xPre === yPre) return false;
  return !xPre || (!!yPre && xPre.localeCompare(yPre, undefined, { numeric: true }) > 0);
}

const run = (cmd, args, env, timeout = 300_000) => new Promise((resolve, reject) => execFile(cmd, args, { env, maxBuffer: 10e6, timeout },
  (err, out, errOut) => (err ? reject(new Error(errOut.trim().split('\n').pop() || err.message)) : resolve(out))));

/**
 * The newest release with a Mac build: { version, notes, url, asset, public }, or null if there isn't one. Throws when
 * GitHub can't be reached. A public repo is read directly; a private one through the GitHub CLI, so its collaborators
 * get updates too.
 */
async function latestRelease(env) {
  const shape = (r, isPublic) => {
    const asset = r?.assets?.find(a => ASSET.test(a.name));
    return asset ? { version: r.tag_name.replace(/^v/, ''), notes: r.body || '', url: r.html_url, asset: { name: asset.name, url: asset.browser_download_url }, public: isPublic } : null;
  };
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'user-agent': 'protoplasma' }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (res?.ok) { const body = await res.json().catch(() => null); if (body) return shape(body, true); }
  let out;
  try { out = await run('gh', ['api', `repos/${REPO}/releases/latest`], env, 20_000); } catch (e) {
    if (!/HTTP 404|Not Found/i.test(e.message)) throw new Error('Couldn\'t reach GitHub to check for updates.');
    // GitHub says 404 both for "no releases yet" and for a repo this login can't see; only the first means up to date.
    const visible = await run('gh', ['api', `repos/${REPO}`], env, 20_000).then(() => true, () => false);
    if (visible) return null;
    throw new Error('Your GitHub CLI login can\'t see Protoplasma\'s repo, so it can\'t check for updates.');
  }
  return shape(JSON.parse(out), false);
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
  try { await prepare(release, bundle, pid, env, dir); } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true }); // a failed download isn't left taking up space
    throw e;
  }
}
async function prepare(release, bundle, pid, env, dir) {
  const zip = path.join(dir, release.asset.name);
  if (release.public) {
    const res = await fetch(release.asset.url, { headers: { 'user-agent': 'protoplasma' }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`Couldn't download the update (GitHub answered ${res.status}).`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  } else {
    await run('gh', ['release', 'download', `v${release.version}`, '-R', REPO, '-p', release.asset.name, '-D', dir], env);
  }
  await run('ditto', ['-x', '-k', zip, path.join(dir, 'new')], env);
  const fresh = path.join(dir, 'new', 'Protoplasma.app');
  // A real folder (a link to the installed app would pass every check, and the swap would then delete the app).
  if (!fs.lstatSync(fresh, { throwIfNoEntry: false })?.isDirectory() || !fs.existsSync(path.join(fresh, 'Contents', 'Info.plist'))) {
    throw new Error('The update didn\'t contain the app.');
  }
  await run('xattr', ['-dr', 'com.apple.quarantine', fresh], env).catch(() => {}); // usually there's nothing to remove
  await sameSigner(bundle, fresh, env);
  // The signed app must be the version the release says, or an old signed copy could be passed off as an update.
  const inside = (await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(fresh, 'Contents', 'Info.plist')], env).catch(() => '')).trim();
  if (inside !== release.version) throw new Error(`The update is labelled ${release.version} but contains ${inside || 'another version'}, so it wasn't installed.`);
  // $1 the app, $2 the new copy, $3 this folder (the download, about 150 MB), $4 the app's pid. It waits as long as the app
  // runs (a cancelled quit installs at the next one); if the swap fails it says so, and keeps a log, instead of quietly reopening.
  const script = path.join(dir, 'swap.sh'), log = path.join(os.homedir(), 'Library', 'Logs', 'Protoplasma-update.log');
  fs.writeFileSync(script, `#!/bin/sh
exec >>"$5" 2>&1
while kill -0 "$4" 2>/dev/null; do sleep 0.3; done
if mv "$1" "$1.old" && mv "$2" "$1"; then
  rm -rf "$1.old"
else
  [ -d "$1.old" ] && [ ! -d "$1" ] && mv "$1.old" "$1"
  osascript -e 'display alert "Protoplasma couldn’t update itself" message "The new version couldn’t replace the old one, so the old one opens again. Download the update from GitHub instead."' &
fi
open "$1"
rm -rf "$3"
`, { mode: 0o755 });
  fs.mkdirSync(path.dirname(log), { recursive: true });
  spawn('/bin/sh', [script, bundle, fresh, dir, String(pid), log], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * A copy signed with the project's certificate (see scripts/sign.sh) only takes updates signed with that same
 * certificate. An ad hoc signed copy has no certificate to compare with, so it takes an intact update of the same app
 * (the same bundle identifier). If this copy's own signature can't be read, nothing is installed.
 */
async function sameSigner(bundle, fresh, env) {
  const refuse = () => { throw new Error('The update isn\'t signed by Protoplasma, so it wasn\'t installed.'); };
  const own = await run('codesign', ['-d', '-r-', bundle], env).catch(refuse);
  const required = /^designated => (.*certificate.*)$/m.exec(own)?.[1];
  if (!required) {
    // codesign -dv writes its details to stderr.
    const id = app => new Promise(resolve => execFile('codesign', ['-dv', app], { env }, (err, out, errOut) => resolve(/Identifier=(\S+)/.exec(`${out}${errOut}`)?.[1])));
    const [mine, theirs] = await Promise.all([id(bundle), id(fresh)]);
    if (!mine || mine !== theirs) refuse();
  }
  await run('codesign', ['--verify', '--deep', '--strict', ...(required ? [`-R=${required}`] : []), fresh], env).catch(refuse);
}

module.exports = { isNewer, latestRelease, ownBundle, stage, sameSigner, REPO };

// A playground for trying Protoplasma as two people at once, on one Mac: a local hub, a shared repo that looks like
// github.com/david/playground but lives here, and two copies of the app, David's and Max's, each with its own home
// folder and its own control API (see playground-app.js). Needs no GitHub or Claude account.
// Usage: npm run playground   (Ctrl+C stops everything and removes it)
// The control APIs need the token printed at start (also in <folder>/token), sent as an `x-play-token` header, so no web
// page or other program can drive the apps.
// With --real (npm run playground -- --real), agents are the real Claude Code, Codex and OpenCode installed on this Mac,
// signed in as you: they get your own home folder, so your logins and settings. The playground then lives in
// ~/Protoplasma-sim instead of the temp folder, where Codex's sandbox would let an agent write anywhere. Each new session
// folder stops at its CLI's folder-trust prompt, which is yours to answer. Real prompts use your plans' usage.
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron'); // from plain Node: the path to Electron
const hubModule = require('../src/hub');
const { files } = require('./stage');

const people = { 'tok-david': { login: 'david', name: 'David', avatar: '' }, 'tok-max': { login: 'max', name: 'Max', avatar: '' } };
const verifyUser = async token => people[token] || null;
const copies = [{ name: 'david', token: 'tok-david', port: 7801 }, { name: 'max', token: 'tok-max', port: 7802 }];
const real = process.argv.includes('--real');
const base = real ? path.join(os.homedir(), 'Protoplasma-sim') : os.tmpdir();
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'protoplasma-playground-'));
// Real agents are found on your own login shell's PATH: the copies' home folders have no shell setup of their own.
const loginPath = () => execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf __PATH__%s "$PATH"'], { encoding: 'utf8', timeout: 10000 }).split('__PATH__').pop();
const token = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(root, 'token'), token);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const apps = [];

// The copies quit on SIGTERM without asking (main.js); the folder goes once they're gone (or after 5 s, by force).
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  await Promise.all(apps.map(a => new Promise(resolve => {
    if (a.exitCode !== null) return resolve();
    a.once('exit', resolve);
    a.kill('SIGTERM');
    setTimeout(() => { a.kill('SIGKILL'); resolve(); }, 5000);
  })));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); // a quitting copy's helpers may still be writing
  process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

(async () => {
  hubModule.githubUser = verifyUser;
  const hub = `http://127.0.0.1:${(await hubModule.startHub({ port: 0, host: '127.0.0.1', verifyUser, dataDir: path.join(root, 'hub') })).port}`;

  // The shared repo. Fetches and pushes to git@github.com:david/playground.git go to it through a stand-in for ssh.
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), text);
  }
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=David', '-c', 'user.email=david@example.com', 'commit', '-q', '-m', 'Lobby server');
  git(root, 'clone', '-q', '--bare', seed, origin);
  const ssh = path.join(root, 'fake-ssh');
  fs.writeFileSync(ssh, `#!/bin/sh
# Stands in for ssh to github.com: runs git's command (the last argument) against the local repo.
for last; do :; done
exec sh -c "$(printf '%s' "$last" | sed "s#'[^']*playground.git'#'${origin}'#")"
`, { mode: 0o755 });

  // Each person: a home folder with the app's clone of the repo (~/Protoplasma/david/playground), and a copy of the app.
  const realPath = real ? loginPath() : '';
  for (const c of copies) {
    const home = path.join(root, c.name, 'home');
    const clone = path.join(home, 'Protoplasma', 'david', 'playground');
    git(root, 'clone', '-q', origin, clone);
    git(clone, 'remote', 'set-url', 'origin', 'git@github.com:david/playground.git');
    git(clone, 'config', 'core.sshCommand', ssh);
    git(clone, 'config', 'user.name', people[c.token].name);
    git(clone, 'config', 'user.email', `${c.name}@example.com`);
    git(clone, 'remote', 'set-head', 'origin', 'main');
    // The stand-in agents (playground-app.js writes them to <copy>/bin) count as installed in this home's login shell,
    // or with --real, the CLIs on your own PATH, in its order: set in .zprofile, which runs after /etc/zprofile's
    // path_helper has moved /usr/local/bin to the front (where an older copy of a CLI can be).
    const rcs = real ? ['.zprofile', '.bash_profile'] : ['.zshenv', '.bash_profile'];
    for (const rc of rcs) fs.writeFileSync(path.join(home, rc), real ? `export PATH=${JSON.stringify(realPath)}\n` : `export PATH="${path.join(root, c.name, 'bin')}:$PATH"\n`);
    const log = fs.openSync(path.join(root, c.name, 'app.log'), 'a');
    apps.push(spawn(electron, [path.join(__dirname, 'playground-app.js')], { stdio: ['ignore', log, log],
      env: { ...process.env, HOME: home, PROTO_ONLINE_HUB: hub, PROTO_GITHUB_TOKEN: c.token, PLAY_PORT: String(c.port), PLAY_DIR: path.join(root, c.name), PLAY_TOKEN: token,
        PLAY_REAL: real ? os.homedir() : '' } }));
  }
  for (const c of copies) {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = (await fetch(`http://127.0.0.1:${c.port}/js`, { method: 'POST', body: 'return !!me', headers: { 'x-play-token': token } }).then(r => r.json()).catch(() => null))?.value;
      if (!ready) await new Promise(r => setTimeout(r, 300));
    }
    if (!ready) throw new Error(`${c.name}'s copy didn't start (is port ${c.port} taken by another playground?). See ${path.join(root, c.name, 'app.log')}.`);
  }

  console.log(`Playground ready in ${root}${real ? '\n  agents   the real CLIs, signed in as you' : ''}
  hub      ${hub}
  repo     david/playground (pushes go to ${origin})
${copies.map(c => `  ${c.name.padEnd(8)} http://127.0.0.1:${c.port}  home ${path.join(root, c.name, 'home')}  log ${path.join(root, c.name, 'app.log')}`).join('\n')}
  token    ${token}  (send it as the x-play-token header; also in ${path.join(root, 'token')})
Ctrl+C to stop.`);
})().catch(e => { console.error(`The playground couldn't start: ${e.message}`); stop(1); });

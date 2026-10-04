// GitHub integration, split on purpose:
// - Identity: device flow with the read:user scope only. That token is safe to send to hubs.
// - Repos, PRs and issues: the local `gh` CLI and its login, so repo access never leaves this machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, safeStorage } = require('electron');
const { githubUser } = require('../src/hub');
const { sessionWorktree, removeSessionWorktree, installPushGuard, slug } = require('../src/workspace');

const REPO = /^[\w.-]+\/[\w.-]+$/;
const tokenFile = () => path.join(app.getPath('userData'), 'github-token');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const postForm = (url, body) => fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
  body: JSON.stringify(body) }).then(r => r.json());

// ---- Sign-in ----

const saveSignIn = (token, user) => fs.writeFileSync(tokenFile(), safeStorage.encryptString(JSON.stringify({ token, user })));
const signOut = () => fs.rmSync(tokenFile(), { force: true });

/**
 * The saved sign-in, if still valid: { token, user }. Offline, the cached profile is trusted so the app still opens;
 * a token GitHub rejects is deleted. PROTO_GITHUB_TOKEN overrides it in development.
 */
async function savedSignIn() {
  let saved = null;
  try {
    const raw = safeStorage.decryptString(fs.readFileSync(tokenFile()));
    saved = raw.startsWith('{') ? JSON.parse(raw) : { token: raw }; // older builds stored the bare token
  } catch {}
  const token = process.env.PROTO_GITHUB_TOKEN || saved?.token;
  if (!token) return null;
  let user;
  try { user = await githubUser(token); } catch { return saved?.user ? { token, user: saved.user } : null; }
  if (!user) { if (!process.env.PROTO_GITHUB_TOKEN) signOut(); return null; }
  if (!process.env.PROTO_GITHUB_TOKEN) saveSignIn(token, user);
  return { token, user };
}

/** Device flow, step 1: request a user code. */
async function startSignIn(clientId) {
  if (!clientId) throw new Error('GitHub sign-in isn\'t set up yet. Add the OAuth app\'s Client ID to app/config.json.');
  const res = await postForm('https://github.com/login/device/code', { client_id: clientId, scope: 'read:user' });
  if (!res.device_code) throw new Error(res.error_description || 'GitHub didn\'t start the sign-in. Check the Client ID and that Device Flow is enabled.');
  return res; // { device_code, user_code, verification_uri, interval, expires_in }
}

/** Device flow, step 2: poll until the user approves, then store the token encrypted via safeStorage. */
async function finishSignIn(clientId, { device_code, interval, expires_in }, signal) {
  const deadline = Date.now() + expires_in * 1000;
  let wait = interval;
  while (Date.now() < deadline && !signal.aborted) {
    await sleep(wait * 1000);
    if (signal.aborted) break;
    const res = await postForm('https://github.com/login/oauth/access_token',
      { client_id: clientId, device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (res.access_token && !signal.aborted) {
      const user = await githubUser(res.access_token);
      saveSignIn(res.access_token, user);
      return { token: res.access_token, user };
    }
    if (res.error === 'slow_down') wait = res.interval ?? wait + 5;
    else if (res.error === 'access_denied') throw new Error('Sign-in was cancelled on GitHub.');
    else if (res.error !== 'authorization_pending') throw new Error(res.error_description || 'GitHub sign-in failed.');
  }
  throw new Error(signal.aborted ? 'Sign-in cancelled.' : 'The code expired. Try again.');
}

/** The exact login behind a GitHub username, or null if nobody has it. When GitHub can't be asked, the name is taken as typed. */
async function findUser(login, token) {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'protoplasma' } }).catch(() => null);
  if (res?.status === 404) return null;
  return res?.ok ? (await res.json()).login : login;
}

// ---- Repos (gh CLI) ----

function gh(args, env) {
  return new Promise((resolve, reject) => execFile('gh', args, { env, timeout: 120_000, maxBuffer: 20e6 }, (err, out, errOut) => {
    if (!err) return resolve(out);
    const detail = errOut.trim().split('\n').pop() || err.message;
    reject(new Error(err.code === 'ENOENT' ? 'Install the GitHub CLI to use repos here: run "brew install gh", then "gh auth login".'
      : /api\.github\.com|dial tcp|EOF|timed? ?out|connection/i.test(detail) ? 'Couldn\'t reach GitHub. Check your connection, or choose a folder instead.'
      : detail));
  }));
}
const checkRepo = repo => { if (!REPO.test(repo)) throw new Error(`Not a GitHub repo: ${repo}`); return repo; };

/** Every repo the user owns, collaborates on or reaches through an org, most recently updated first. */
async function listRepos(env, login) {
  const pages = JSON.parse(await gh(['api', '--paginate', '--slurp',
    'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'], env));
  return pages.flat().filter(r => !r.archived).map(r => ({ name: r.full_name, description: r.description || '', private: r.private,
    mine: r.owner.login.toLowerCase() === login.toLowerCase() }));
}

const cloneDir = repo => path.join(os.homedir(), 'Protoplasma', ...checkRepo(repo).split('/'));

/** Local path for a repo (~/Protoplasma/<owner>/<name>), cloning it on first use. */
async function cloneRepo(repo, env) {
  const dir = cloneDir(repo);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await gh(['repo', 'clone', repo, dir], env);
  }
  return dir;
}

/**
 * The folder a session works in: its own worktree and branch of the repo's clone (see src/workspace.js).
 * A repo with no commits yet can't have worktrees, so the session uses the clone itself.
 */
async function sessionFolder(repo, session, env, { worktree = true } = {}) {
  const clone = await cloneRepo(repo, env);
  await installPushGuard(clone, env).catch(() => {}); // only ever in clones the app made
  if (!worktree) return clone;
  try { return (await sessionWorktree(clone, session, env)).dir; } catch { return clone; }
}

/** A session's own folder on this Mac, if it has one. */
const sessionFolderPath = (repo, session) => { const dir = `${cloneDir(repo)}@${slug(session)}`; return fs.existsSync(dir) ? dir : null; };
async function removeSessionFolder(repo, session, env) {
  try { await removeSessionWorktree(cloneDir(repo), session, env); }
  catch { throw new Error('Its folder has uncommitted changes, so it was kept.'); }
}

/** Whether the GitHub CLI is installed and signed in: { ok, detail }. */
const ghStatus = env => new Promise(resolve => execFile('gh', ['auth', 'status'], { env, timeout: 10_000 }, (err, out, errOut) => {
  const login = /account (\S+)/.exec(out + errOut)?.[1];
  resolve(err?.code === 'ENOENT' ? { ok: false, detail: 'Not installed. Run "brew install gh", then "gh auth login".' }
    : err || !login ? { ok: false, detail: 'Installed, but not signed in. Run "gh auth login".' }
    : { ok: true, detail: `Signed in as ${login}` });
}));

const pullRequests = async (repo, env) => JSON.parse(await gh(['pr', 'list', '-R', checkRepo(repo), '--limit', '30',
  '--json', 'number,title,author,url,isDraft,updatedAt,reviewDecision'], env));
const issues = async (repo, env) => JSON.parse(await gh(['issue', 'list', '-R', checkRepo(repo), '--limit', '30',
  '--json', 'number,title,author,url,labels,updatedAt'], env));

module.exports = { savedSignIn, signOut, startSignIn, finishSignIn, findUser, listRepos, clonePath: cloneDir, sessionFolder, sessionFolderPath, removeSessionFolder, ghStatus, pullRequests, issues };

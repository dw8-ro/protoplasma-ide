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

const REPO = /^[a-z\d-]+\/(?!\.\.?$)[\w.-]+$/i; // owner/name, never . or ..
const tokenFile = () => path.join(app.getPath('userData'), 'github-token');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const postForm = (url, body) => fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }).then(r => r.json());

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
  const res = await postForm('https://github.com/login/device/code', { client_id: clientId, scope: 'read:user' })
    .catch(() => { throw new Error('Couldn\'t reach GitHub to start signing in. Check your connection and try again.'); });
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
    // A dropped request or an odd answer while someone approves on GitHub is just another wait.
    const res = await postForm('https://github.com/login/oauth/access_token',
      { client_id: clientId, device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).catch(() => ({ error: 'authorization_pending' }));
    if (res.access_token && !signal.aborted) {
      let user = null;
      for (let tries = 0; !user && tries < 3; tries++) user = await githubUser(res.access_token).catch(() => sleep(2000).then(() => null));
      if (!user) throw new Error('GitHub didn\'t recognise the new sign-in. Try again.');
      saveSignIn(res.access_token, user);
      return { token: res.access_token, user };
    }
    if (res.error === 'slow_down') wait = res.interval ?? wait + 5;
    else if (res.error === 'access_denied') throw new Error('Sign-in was cancelled on GitHub.');
    else if (res.error !== 'authorization_pending') throw new Error(res.error_description || 'GitHub sign-in failed.');
  }
  throw new Error(signal.aborted ? 'Sign-in cancelled.' : 'The code expired. Try again.');
}

/**
 * The exact login and numeric id behind a GitHub username, or null if nobody has it. An organisation can't be a
 * teammate. When GitHub can't be asked, the name is taken as typed, with no id (the hub records it at their first sign-in).
 */
async function findUser(login, token) {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'protoplasma' } }).catch(() => null);
  if (res?.status === 404) return null;
  const found = res?.ok ? await res.json().catch(() => null) : null;
  if (found?.type && found.type !== 'User') throw new Error(`${found.login} is a GitHub organisation, not a person. Invite the people in it.`);
  return { login: found?.login || login, id: Number.isSafeInteger(found?.id) ? found.id : undefined };
}

// ---- Repos (gh CLI) ----

// What went wrong with a gh command, in words: the cause where it's recognisable, else gh's own last line.
function gh(args, env, timeout = 120_000) {
  return new Promise((resolve, reject) => execFile('gh', args, { env, timeout, maxBuffer: 50e6 }, (err, out, errOut) => {
    if (!err) return resolve(out);
    const text = String(errOut || ''), detail = text.trim().split('\n').pop() || err.message;
    reject(new Error(err.code === 'ENOENT' ? 'Install the GitHub CLI to use repos here: run "brew install gh", then "gh auth login".'
      : err.killed ? 'The GitHub CLI took too long. Try again.'
      : /gh auth login|not logged in|GH_TOKEN/i.test(text) ? 'Sign in to the GitHub CLI to see your repos here: run "gh auth login" in Terminal. You can still type owner/name.'
      : /unknown (flag|command|shorthand)/i.test(text) ? 'Your GitHub CLI is too old for this. Update it: run "brew upgrade gh".'
      : /SAML|single sign-on/i.test(text) ? 'Your organisation requires single sign-on for the GitHub CLI: run "gh auth refresh" and authorise it.'
      : /HTTP 404|Could not resolve to a Repository/i.test(text) ? 'GitHub says that repo doesn\'t exist, or this GitHub account can\'t see it.'
      : /HTTP 403|rate limit/i.test(text) ? 'GitHub refused: no access, or too many requests. Try again later.'
      : /dial tcp|no such host|i\/o timeout|connection refused|network is unreachable|TLS handshake/i.test(text) ? 'Couldn\'t reach GitHub. Check your connection, or choose a folder instead.'
      : detail));
  }));
}
const checkRepo = repo => { if (!REPO.test(repo)) throw new Error(`Not a GitHub repo: ${repo}`); return repo; };

/** Every repo the user owns, collaborates on or reaches through an org, most recently updated first. */
async function listRepos(env, login) {
  // Only the fields shown, one repo per line: a large organisation's full repo list would be tens of megabytes.
  const lines = await gh(['api', '--paginate', '--jq', '.[] | {name: .full_name, description, private, archived, owner: .owner.login}',
    'user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member'], env);
  return lines.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => !r.archived)
    .map(r => ({ name: r.name, description: r.description || '', private: r.private, mine: same(r.owner, login) }));
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

const cloneDir = repo => path.join(os.homedir(), 'Protoplasma', ...checkRepo(repo).split('/'));

/**
 * Local path for a repo (~/Protoplasma/<owner>/<name>), cloning it on first use. The clone is made beside it and moved
 * into place when it's complete, so an interrupted one never looks finished; two sessions asking at once share it.
 */
const cloning = new Map();
function cloneRepo(repo, env) {
  const dir = cloneDir(repo);
  if (fs.existsSync(path.join(dir, '.git'))) return Promise.resolve(dir);
  if (!cloning.has(dir)) {
    cloning.set(dir, (async () => {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`There's already a folder at ${dir} that isn't a clone of ${repo}. Move it away, then try again.`);
      const partial = `${dir}@.partial`; // a name no repo (no @) or session folder (a slug never starts with .) can have
      fs.rmSync(partial, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await gh(['repo', 'clone', repo, partial], env, 30 * 60_000);
      fs.rmSync(dir, { recursive: true, force: true }); // an empty folder, if anything
      fs.renameSync(partial, dir);
      return dir;
    })().finally(() => cloning.delete(dir)));
  }
  return cloning.get(dir);
}

/**
 * The folder a session works in: its own worktree and branch of the repo's clone (see src/workspace.js), and whether
 * the push guard is in place (a repo with its own hooks keeps them, and then has none).
 * A repo with no commits yet can't have worktrees, so the session uses the clone itself.
 * @returns {Promise<{ dir: string, guarded: boolean }>}
 */
async function sessionFolder(repo, session, env, { worktree = true } = {}) {
  const clone = await cloneRepo(repo, env);
  const guarded = await installPushGuard(clone, env).catch(() => false); // only ever in clones the app made
  if (!worktree) return { dir: clone, guarded };
  try { return { dir: (await sessionWorktree(clone, session, env)).dir, guarded }; } catch (e) {
    const empty = await new Promise(resolve => execFile('git', ['rev-parse', '--verify', 'HEAD'], { cwd: clone, env }, err => resolve(!!err)));
    if (empty) return { dir: clone, guarded };
    // Quietly working in the shared clone would mix this session's work with others'.
    throw new Error(`Couldn't make this session's own folder and branch: ${e.message}. You can turn off "A branch for every session" in Settings → Agents.`);
  }
}

/** A session's own folder on this Mac, if it has one. */
const sessionFolderPath = (repo, session) => { const dir = `${cloneDir(repo)}@${slug(session)}`; return fs.existsSync(dir) ? dir : null; };
async function removeSessionFolder(repo, session, env) {
  try { await removeSessionWorktree(cloneDir(repo), session, env); } catch (e) {
    throw new Error(e.kept ? e.message : /modified or untracked|contains modified|untracked files/i.test(e.message)
      ? 'Its folder has uncommitted changes, so it was kept.' : `Its folder couldn't be removed: ${e.message}`);
  }
}

/**
 * Whether the GitHub CLI is installed and signed in: { ok, detail }. With several accounts, the active one is what
 * counts (gh also fails when some other saved account has a stale token).
 */
const ghStatus = env => new Promise(resolve => execFile('gh', ['auth', 'status'], { env, timeout: 10_000 }, (err, out, errOut) => {
  const accounts = [];
  for (const line of `${out}\n${errOut}`.split('\n')) {
    const account = /(Logged in to|Failed to log in to) \S+ (?:account|as) (\S+)/.exec(line);
    if (account) accounts.push({ login: account[2], ok: account[1] === 'Logged in to' });
    else if (/Active account: true/.test(line) && accounts.length) accounts.at(-1).active = true;
  }
  const active = accounts.find(a => a.active) || accounts[0];
  resolve(err?.code === 'ENOENT' ? { ok: false, detail: 'Not installed. Run "brew install gh", then "gh auth login".' }
    : active?.ok ? { ok: true, detail: `Signed in as ${active.login}` }
    : active ? { ok: false, detail: `${active.login}'s sign-in has expired. Run "gh auth login".` }
    : { ok: false, detail: 'Installed, but not signed in. Run "gh auth login".' });
}));

const pullRequests = async (repo, env) => JSON.parse(await gh(['pr', 'list', '-R', checkRepo(repo), '--limit', '30',
  '--json', 'number,title,author,url,isDraft,updatedAt,reviewDecision'], env));
const issues = async (repo, env) => JSON.parse(await gh(['issue', 'list', '-R', checkRepo(repo), '--limit', '30',
  '--json', 'number,title,author,url,labels,updatedAt'], env));

module.exports = { savedSignIn, signOut, startSignIn, finishSignIn, findUser, listRepos, clonePath: cloneDir, sessionFolder, sessionFolderPath, removeSessionFolder, ghStatus, pullRequests, issues };

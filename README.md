<p align="center">
  <img src="app/icon.svg" width="88" alt="Protoplasma">
</p>

<h1 align="center">Protoplasma</h1>

<p align="center">
  A multiplayer workspace for AI coding agents.<br>
  Run the real Claude Code, Codex or OpenCode on your Mac, every slash command included, and see your team's agents right beside yours.
</p>

<p align="center">
  <a href="https://github.com/dw8-ro/protoplasma-ide/actions/workflows/ci.yml"><img src="https://github.com/dw8-ro/protoplasma-ide/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/macOS-Apple%20silicon-111?logo=apple&logoColor=white" alt="macOS on Apple silicon">
  <img src="https://img.shields.io/badge/Electron-44-111?logo=electron&logoColor=white" alt="Electron 44">
  <img src="https://img.shields.io/badge/license-MIT-111" alt="MIT licence">
</p>

<p align="center">
  <img src="docs/code.png" width="100%" alt="A session in Protoplasma: the repo's files in an editor, with your Claude Code agent and the session panel underneath">
</p>

## Why

Shared spaces for coding agents, like [Amoeba](https://useamoeba.com), drive the agents headlessly, so the CLI you know (its `/goal`, `/compact`, custom commands and skills) isn't there. Protoplasma runs the real interactive CLI in a real terminal and puts the team layer around it: who is working on what, which files are about to collide, and what each agent was last asked. It's laid out the way Amoeba is, so anyone coming from it already knows where things are.

## How you use it

1. **Sign in with GitHub** and create a team. Invite people by their GitHub username.
2. **Start a session** with **New** (⌘N). Say what you're working on, pick one of your GitHub repos (or a folder on your Mac) and an agent: Claude Code, Codex or OpenCode. Protoplasma clones the repo, gives the session its own branch and folder, and opens your agent.
3. **Talk to your agent.** It's the real CLI in a terminal, so you type to it exactly as you would in Terminal, slash commands included.
4. **Open the code.** Click **Code**, or any file the session has changed, or press ⌘P. The repo opens in an editor with its files, search and source control, and your agent moves to a panel underneath. As the agent edits a file you have open, you see the change straight away. A **Terminal** tab beside the agent gives you a plain shell in the same folder, and **Conflicts** lists files you and a teammate are both changing, with a side-by-side compare.
5. **Work alongside your team.** Everyone's agents in the session are listed on the right with what they were last asked. Open any of them full size or beside yours, or a teammate's version of a file their agent is changing (if they share files). Plan the work as steps, comment on lines of code (⇧⌘M), and keep notes the agents read. A file changed in two places is flagged for everyone, and Claude asks before touching it. **New pane** puts several sessions side by side.
6. **Ship it.** Write a message under source control and **Commit & Push**, then open a pull request.

<p align="center">
  <img src="docs/demo.gif" width="100%" alt="Asking an agent for a test, watching it being written in the editor, and a teammate's change to the same file being flagged">
</p>

<details>
<summary>Keyboard shortcuts</summary>

| Keys | Does |
| --- | --- |
| ⌘N | New session |
| ⇧⌘L | Add an agent to this session |
| ⌘K | Go to a session, page or action |
| ⌘P | Go to a file |
| ⇧⌘E | Show or hide the code |
| ⌘S | Save the open file |
| ⇧⌘M | Comment on the selected lines |
| ⌘J | Hide the panel (under the code, or beside the agents) |
| ⌘B | Hide the sidebar |
| ⌘I | Invite someone to the team |
| ⇧⌘T | Switch team |
| ⌘, | Settings |
</details>

## What it does

**The real agent, not a wrapper.** Each agent is the actual `claude`, `codex` or `opencode` process on your Mac, under your own account. Your settings, permission modes and custom commands all work.

**The code beside it.** An editor built on Monaco (the editor inside VS Code), with an Explorer that marks what changed since the last commit and which files teammates' agents are changing.

**Sessions for every piece of work.** Each one keeps its goal, branch and comments, and stays on the board after its agents stop, with **Resume** to pick the conversation back up and the last screen of recently stopped agents one click away.

**Collisions caught early.** Every checkout reports the files it has changed compared with main, committed or not, whoever or whatever changed them. A file changed in two places is an overlap for everyone, before it turns into a merge conflict.

**Plans and shared memory.** Each session can have a plan: steps with owners that anyone ticks off, shown on its card. Notes go with a repo or a single file. Claude gets all of it at the right moment: the plan and repo notes with every prompt, a file's notes just before it reads or edits it.

<p align="center">
  <img src="docs/session.png" width="100%" alt="Your Claude Code agent with its slash-command menu open, beside a teammate's agent, with the session panel">
</p>
<p align="center">
  <img src="docs/sessions.png" width="49%" alt="The Sessions page, with sessions on Claude Code, Codex and OpenCode">
  <img src="docs/new-session.png" width="49%" alt="Starting a session from a GitHub repo">
</p>
<p align="center">
  <img src="docs/settings.png" width="49%" alt="Settings">
  <img src="docs/light.png" width="49%" alt="Light theme, with the Environment tab open">
</p>

## How it works

```mermaid
flowchart LR
  subgraph A[Your Mac]
    appA[Protoplasma] --- laneA[claude in a terminal]
  end
  subgraph B[Teammate's Mac]
    appB[Protoplasma] --- laneB[codex in a terminal]
  end
  hub[(Hub)]
  laneA -- terminal and git status --> hub
  laneB -- terminal and git status --> hub
  laneA -. Claude Code hooks .-> hub
  hub -- live state --> appA
  hub -- live state --> appB
```

- **Lanes** (`src/lane.js`) run an agent in a pseudo-terminal and stream it to the hub, with its branch, what it has changed compared with main, and its status. Claude Code also gets per-run [HTTP hooks](https://code.claude.com/docs/en/hooks) through `--settings`; Codex and OpenCode report working or idle from their terminal activity.
- **The hub** (`src/hub.js`) relays terminals, tracks who changed what, keeps sessions, notes and comments, and answers Claude's hooks with the session's goal, the team's notes and an `ask` before a conflicting edit or a risky push. It never runs agents, and what it keeps or passes along is listed under Security and privacy.
- **The app** (`app/`) is Electron. The renderer has no Node access. The main process launches the agent CLIs (in a clean login-shell environment) and a shell for the Terminal tab, and the code view can only read and write inside a session's own folder.

## Working on the same code

1. **A branch per session.** A session started from a GitHub repo gets its own git worktree on `session/<name>`, branched from the latest default branch, or continuing a teammate's pushed branch. It has no upstream, so a bare `git push` can't land on `main`. Names that differ only in case or punctuation are the same session.
2. **Overlap warnings.** A file changed in two checkouts of the same repo is flagged for everyone, and Claude is asked before it edits one.
3. **Push guard.** When the team has other people, Claude is asked before pushing to `main`, `master` or the repo's default branch, force-pushing, or deleting a branch on the remote. Codex and OpenCode can't be asked, so in repos the app cloned a `pre-push` hook stops those pushes instead. It's a safeguard against mistakes, not a lock: `git push --no-verify` skips the hook. If your team needs a guarantee, protect `main` on GitHub too, for teammates whose agents push with their own accounts. People pushing from their own terminal aren't affected.
4. **Behind notice.** Each lane fetches about once a minute. A branch missing commits from main (or from its own pushed copy) shows `↓3`, and Claude is told to pull before changing more.
5. **Shared session branches.** Everyone in a session works on `session/<name>`, each in their own checkout. **Commit & Push** puts your commit on top of whatever a teammate pushed first. If you both changed the same lines, it stops and offers **Pull**: their work comes in, the files you both changed are marked C, and once you've fixed them in the editor, **Commit & Push** finishes the merge.

Work then reaches `main` the usual way, through a pull request. These layers make collisions visible early; they don't replace review.

## Install

You'll need a Mac with Apple silicon and at least one of [Claude Code](https://code.claude.com), Codex or OpenCode. The [GitHub CLI](https://cli.github.com) powers the repo list, pull requests and issues; the app runs without it, and on first run it checks for both and tells you what's missing. The one-line install below does need it, signed in (`gh auth login`) with access to this repo.

```bash
gh api repos/dw8-ro/protoplasma-ide/contents/install.sh -H "Accept: application/vnd.github.raw" | sh
```

That installs the latest release into Applications, with no "can't be verified" warning (files fetched from Terminal aren't quarantined). You can also download the zip from [Releases](https://github.com/dw8-ro/protoplasma-ide/releases); the first time you open it, macOS asks you to allow it under System Settings → Privacy & Security → Open Anyway.

**Updates install themselves.** The app checks GitHub every few hours and shows a bar when a new version is out: Update now, and it relaunches on the new one. While the repo is private, this needs the GitHub CLI signed in with access to it. Releases are signed with the project's own certificate (no Apple account involved), so macOS knows each version is the same app and your Keychain and privacy permissions carry over.

### From source

```bash
git clone https://github.com/dw8-ro/protoplasma-ide.git
cd protoplasma-ide
npm install
npm start
```

`npm run dist` builds the app into `dist/Protoplasma-darwin-arm64/`, and `npm run release` publishes a new version: it bumps the version and pushes a tag, and GitHub Actions builds the app and attaches it to a release that everyone's copy picks up.

<details>
<summary>Configuration and hosting a hub</summary>

`app/config.json` holds two values:

- `githubClientId`: from a GitHub OAuth app with device flow enabled. It's public, not a secret.
- `onlineHub`: the URL of your hosted hub. Leave it empty to use teams on your own Mac only.

To host a hub, deploy the `Dockerfile` (Railway or any container host) with a volume at `/data` and set `DATA_DIR=/data` and `PROTO_OWNERS` to the GitHub logins allowed to create teams. The volume also keeps `pass-key.pem`, which signs passes for teams on people's Macs, and `hubs.json`, the hub certificates people registered for their Macs.
</details>

<details>
<summary>Wire protocol</summary>

The first message on every WebSocket carries a team id and a GitHub token, or, for a hub on someone's Mac, a pass (below). Anything sent while they're being verified (up to 1 MB) waits, and is handled only once they are.

| Endpoint | Direction | Messages |
| --- | --- | --- |
| `/lane` | lane → hub | `hello {token, team, id, hookSecret, session, cmd, root, roots, repo, branch, git, cols, rows, open, history, machine}`, `out {d}`, `size {cols, rows}`, `git {branch, mainBranch, added, removed, files, behind, ahead, unpushed, changed, local}`, `status {status}` |
| | hub → lane | `in {d}` (only for agents teammates may type into) |
| `/watch` | app → hub | `watch {token, team}`, `look {session}`, `in {lane, d}`, `replay {id}`, `file:get {lane, path, ask}` (a teammate's file), `file:put {req, text, error}` (answering for your own agent) |
| | hub → app | `state {lanes, watchers, members, memories, sessions, stopped}`, `out {lane, d}`, `replay {id, d}`, `file:get {req, lane, path, from}`, `file:put {ask, text, error}` |
| `/teams` | app → hub | REST for teams, members, notes, sessions (renaming, goals, plan steps) and comments |
| `/hooks/:lane` | Claude Code → hub | Hook events, authenticated with a per-lane secret |
| `/hubs` | app → online hub | `POST {fp}`: registers the certificate of the hub on your Mac |
| `/passes` | app → online hub | `POST {aud}`: a pass for the hub whose certificate fingerprint is `aud`, with `owners`, who registered it. `GET /passes/key`: the public key passes are signed with |

A hub on someone's Mac serves https/wss with its own self-signed certificate. Teammates' apps pin the certificate it presents, and sign in with a pass: the online hub's signed word for who they are (Ed25519, `p1.<payload>.<signature>`), naming that certificate's fingerprint and expiring after 12 hours. That hub checks the pass against the online hub's key. Only teams owned by whoever registered the certificate are listed from it.
</details>

## Development

```bash
npm test            # hub, lane, worktree, code view and update tests (node:test)
npm run e2e         # drives the real app through every main flow, the code view included
npm run screenshot  # regenerates the images in docs/
npm run demo        # records docs/demo.gif
npm run playground  # two copies of the app, David and Max, on one local hub and repo, each with a control API
                    # (create a team in David's copy and invite max; the API wants the printed token as x-play-token)
npm run icon        # renders the app icon from app/icon.svg
```

`package.json`'s `allowScripts` names the exact versions of Electron and node-pty whose install scripts may run. When you bump either, update its entry too, or its install step is skipped and `npm start` fails.

```
app/      Electron main process, preload bridge and interface
src/      hub, lane and session worktrees (plain Node, shared by the app and the hosted hub)
test/     integration tests against real hubs, lanes and git repos
scripts/  end-to-end check, screenshots, demo and icon tooling
```

## Security and privacy

- Sign-in asks for read-only access to your public GitHub profile, and nothing else. Repo access stays with the GitHub CLI on your Mac.
- The hub keeps team names, members, notes, and sessions with their goals, repos, who started them, plans and comments (a comment on lines of code keeps the text of those lines). While an agent runs, its terminal output, Claude Code's hook events (which include what a tool is about to change), its latest prompt, its branch, the names of the files its checkout changed and its folder's path pass through the hub. Up to 512 KB of each agent's output is held in memory, along with the last screen of the 20 most recently stopped agents per team; none of it is written to disk.
- Your GitHub sign-in goes only to GitHub, the online hub and the hub on your own Mac. A team hosted on a teammate's Mac is reached over an encrypted connection, pinned to that Mac's certificate, and signed in to with a pass from the online hub that works only on that Mac's hub and expires within 12 hours. The online hub only issues passes for a Mac whose owner registered it, so something on the network pretending to be a teammate's Mac gets nothing it can use. Looking for such teams is off until you turn it on in Your teams, and a team on your Mac can't be reached from the network at all until you invite someone to it.
- The code view reads and writes files on your Mac only, and the hub never stores your code. In the Explorer teammates see which files changed; what your agent prints in its terminal is visible to the whole team. With **Share the files your agents change** on (Settings → Agents, off by default), a teammate can also open those files, read-only; each one passes through the hub on the way and isn't kept.
- Teams are invite-only, and removing someone disconnects them at once. People are recognised by their GitHub account's id, so renaming your account keeps your place, and whoever later takes your old username doesn't get it.
- Letting teammates type into your agent lets them run commands on your Mac, so it's off unless you turn it on, and your agent shows who last typed into it.
- Signing in to a teammate's Mac goes through the online hub, so it needs that hub reachable. Everything else about the team (terminals, typing, files) goes between the two Macs directly.

## Roadmap

- [ ] Notarised builds, so browser downloads open without the first-launch prompt
- [ ] Coordination tools over MCP, so agents can leave notes and message each other
- [ ] Viewer role

## Licence

[MIT](LICENSE). The team features are inspired by [Amoeba](https://useamoeba.com) and built independently from its public documentation.

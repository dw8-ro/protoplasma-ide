# First real install: David and Max, two Macs

Everything so far was tested on one Mac with stand-in teammates. This is the first run on two real Macs with real
people. Tick each box as it works. When something doesn't, write what happened under it (a screenshot helps), and
carry on. Afterwards, a session turns the failures into fixes.

Plan about an evening. Parts 1–3 work from anywhere; part 4 needs both Macs on the same Wi-Fi.

## Before you start

- [ ] Both Macs have Apple silicon.
- [ ] David has Claude Code installed and signed in. Max has Codex installed and signed in (`codex` in Terminal opens it).
- [ ] Both have the GitHub CLI: `brew install gh`, then `gh auth login`.
- [ ] **A scratch repo, not a real project,** so nothing here can hurt real work. For example, David creates a
  private repo `dw8-ro/protoplasma-test` with a README and a couple of small files, and adds Max as a collaborator
  with write access. Max accepts the invitation on GitHub.
- [ ] David gives the session Max's GitHub username (he's only a placeholder in the project notes until then).

Two things you'll see that are expected:
- Each new session folder makes Claude Code or Codex ask whether to trust the folder. Answer it yourselves, at your
  own Mac.
- macOS asks once for local network access when you host a team or look for nearby ones (part 4). Allow it.

## 1. Install (both)

- [ ] In Terminal: `curl -fsSL https://raw.githubusercontent.com/dw8-ro/protoplasma-ide/main/install.sh | sh`
- [ ] Protoplasma opens from /Applications with no "can't be verified" warning.
- [ ] Sign in with GitHub: the app shows a code, github.com asks for it, and you land on the team picker.
- [ ] Settings → Agents shows your agent as Installed (Claude Code for David, Codex for Max).
- [ ] Settings → About says Protoplasma 0.6.1.

## 2. An online team

- [ ] **David:** in the team picker, name a team (say "Test"), keep **Online**, and click **Create**. It opens on an
  empty Sessions page and says Connected.
- [ ] **David:** People → **Invite** → Max's GitHub username. Max shows as a member.
- [ ] **Max:** "Test" appears in his team list on its own within about 30 seconds. He opens it, and both see each
  other on the People page.
- [ ] **David:** Sessions → **New**: session "Try it", a goal ("Tidy the README"), repo `dw8-ro/protoplasma-test`,
  then **Start the session**. Claude Code starts in its own folder
  (`~/Protoplasma/dw8-ro/protoplasma-test@try-it`, branch `session/try-it`). Answer its trust question.
- [ ] **Max:** the session appears with David's agent. Opening it shows David's terminal live.
- [ ] **Max:** **Add an agent** in the same session, with Codex. The goal and repo are filled in. Codex shows
  "Hooks need review" (the card says Needs you): choose **Trust all and continue**. This is asked only once.
- [ ] Both see both agents, and their status changes between Working, Idle and Needs you as they work.

## 3. Working together

Overlaps and the push guard, the core of the app:
- [ ] **David:** ask Claude to add a line to README.md. **Max:** then ask Codex to edit README.md too. Codex is
  stopped once with Protoplasma's reason (README.md was changed by David's agent). If Max tells it to go ahead, it
  does. Both apps show the overlap alert naming both people.
- [ ] **Max:** ask Codex to change another file (say a second file in the repo); Codex edits with its own patch tool.
  **David:** then ask Claude to change that file. Claude asks permission, quoting Protoplasma ("Max … already edited …").
- [ ] **David:** ask Claude "what are the other agents in this repo doing?" It names Max's Codex agent and its files
  (team context in its prompt).
- [ ] **Max:** ask Codex to push to main. It's stopped once with Protoplasma's reason. **David:** ask Claude to run
  `git push origin HEAD:main`. Claude asks first. **Say no both times.**

Sharing work:
- [ ] **David:** open the code view (**Code**), make a change, and **Commit & Push**. It goes to `session/try-it`,
  never main. Within about a minute, Max's agent card says it's behind, and his agent's next prompt is told to pull.
- [ ] Both change the same line in the code view and both press **Commit & Push**. The second person is told to pull.
  **Pull** marks the clash; fix it in the editor, then Commit & Push finishes the merge.
- [ ] **David:** in the session panel, **Memory** → add a note pinned to README.md. Max sees it, and Claude gets it
  before reading that file.
- [ ] **Max:** **Plan** → add two steps, one owned by David. David sees them.
- [ ] **David:** select lines in the code view and press Shift-Cmd-M to comment on them. Max sees the comment and the
  lines. **Max:** **Ask my agent** on it sends it to his Codex.
- [ ] **Max:** **Continue** on David's agent starts his own agent with David's last prompt, changed files and screen.
- [ ] **David:** **Hand off** on his agent → Max. It shows in Max's alerts until he starts an agent in that session.
- [ ] **David:** Settings → **Share the files your agents change** on. Max can open a file David's agent changed,
  read-only. With it off, he's told David doesn't share files.

## 4. A team hosted on David's Mac (same Wi-Fi)

- [ ] **David:** create a second team and choose **This Mac**. Invite Max. Allow local network access if macOS asks.
- [ ] **Max:** in the team picker, tick **Look for teams on this network** (allow local network access). David's team
  appears, labelled with David's name and Mac. Opening it says Connected.
- [ ] Start an agent each in one session. Both terminals reach the other Mac live.
- [ ] Repeat one overlap from part 3 (both agents edit README.md). The ask works the same.
- [ ] David quits Protoplasma: Max's app shows the hub is gone. David reopens it: Max reconnects on his own.

## 5. Wrap up

- [ ] Stop the agents (each card's Stop), then quit the apps. Nothing was pushed to main.
- [ ] Anything that felt slow, confusing, or unlike Amoeba, even if it worked: note it below.
- [ ] Send this file back (or paste the failures into a session).

## Notes

(What went wrong, what felt off, screenshots.)

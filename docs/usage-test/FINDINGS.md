# Customer simulation of 0.5.0: running findings

Written as the run goes, so an interrupted session loses nothing. The finished report is [REPORT.md](REPORT.md).

## How it's run

- **Installed app** (`/Applications/Protoplasma.app`, 0.3.0 at the start), driven on screen with computer use: the
  update to 0.5.0, sign-in, teams on the real online hub and on This Mac, settings, an agent, the code view, quitting.
  Nobody real is invited, no folder-trust prompt is accepted, and nothing is pushed to a real repo.
- **Playground** (`npm run playground`): two copies of the app, David and Max, on a local hub and a local repo, with
  bash stand-ins for agents. Driven through its control API with real clicks, typing and screenshots: invites,
  sessions, plans, notes, comments, overlaps, hooks, Commit & Push with Pull, typing into agents, sharing files, pane
  mode, leaving and removing, and a This Mac team found over the network.

Each finding: what was done, what happened, what should have happened, severity (high, medium, low), and evidence.

## Findings

### Installed app: updating from 0.3.0

- **W1 (works) The update itself.** 0.3.0 found 0.5.0 on its own at launch (bar: "A Protoplasma update is
  available"), and Settings → About said "0.5.0 is available". Update now downloaded it through `gh`, swapped it in and
  reopened 0.5.0 in about 26 s, signed with "Protoplasma Release Signing" (`codesign --verify --deep --strict` passes).
- **F1 (high) Quit doesn't quit.** Protoplasma → Quit (no agents, no team hosted on this Mac) closes the window, but
  the process keeps running with no window. Opening the app again does nothing: the single-instance lock sends the
  launch to the windowless process. Reproduced twice on 0.5.0; SIGTERM ends it. Cause: `will-quit` cancels the quit,
  waits for `teams.stopAnnouncing()`, and calls `app.quit()` again. Without Bonjour (never hosted or browsed, which is
  every online-only user) that promise is already settled, so the second `app.quit()` runs inside the first quit's
  `will-quit`, where Electron ignores it (`is_quitting_` is still set). It was introduced with the 1 s goodbye wait
  (0.4.x).
- **F2 (medium) A signed-in user is shown "Welcome… Continue with GitHub" at every launch** until the saved sign-in
  loads. After the update that took 46 s (21:58:46 launch, sign-in saved 21:59:32), most likely macOS asking about the
  Keychain item "Protoplasma Safe Storage" once for the changed app. Relaunching afterwards was quick. Meanwhile the
  screen invites signing in again, and a click would start a second sign-in.
- **F3 (low) Settings → About covers the update bar.** About says "0.5.0 is available" but has only "Check now"; the
  bar's "Update now" sits behind the Settings panel, so you have to close Settings to install it (seen in 0.3.0; to
  check in 0.5.0).

### Playground: two people (David and Max) on a local hub

- **W2 (works) First day.** Creating an online team, inviting Max from People (the field is focused, Enter submits),
  Max's team list picking the team up by itself, and both seeing each other on People. 8 of 8 checks.
- **W3 (works) A session with two agents.** New session with a goal and a typed repo (the picker explains that the
  GitHub CLI isn't signed in), its own folder on `session/login-page`, Max finding it and adding his agent with
  everything prefilled, an overlap shown to both when both agents changed `src/lobby/join.ts`, Claude being asked
  before editing it, team context in prompts, and working, needs-you and idle states reaching the teammate.
  17 of 17 checks; the screen looks right.
- **W4 (works) Plan, notes, comments, renaming.** A plan step added and ticked off, a team note, a comment, all seen
  by the other person and given to agents with each prompt; renaming the session with both agents running (Max
  follows it, the branch keeps its name). 14 of 14 checks.
- **W5 (works) Commit & Push on a shared session branch, with Pull.** David commits and pushes; Max's push clashes,
  Pull marks `join.ts` C with git's conflict lines, Max fixes it in the editor, saves, and Commit & Push says "Merged
  and pushed"; the remote has both lines and no conflict lines.
- **F4 (medium) The background fetch ignores a repo's `core.sshCommand`.** lane.js `gitEnv` sets `GIT_SSH_COMMAND`
  (`ssh -o BatchMode=yes`), which overrides `core.sshCommand`, so for anyone whose git config picks an ssh command
  (several GitHub accounts, a key per host) every background fetch fails quietly. Then "N commits behind" and a
  teammate's newer pushes are never noticed. Seen in the playground (David stayed "0 behind" after Max pushed; the
  same `git fetch` with that variable fails with "correct access rights", without it finds 2 commits).
- **F5 (low) A conflicted (C) file opens as a diff against the last commit** when clicked in Source control. The
  right-hand side is the file and can be edited, but for a conflict the plain editor (with git's conflict lines) is
  what's needed; the diff is noise.
- **W6 (works) Typing into agents, sharing, stopping, panes.** A teammate's agent that isn't open says "View only"
  and typing into it goes nowhere; an open one says "You can type", Max's typing reaches it and David sees "Max
  typed, just now". Opening a teammate's changed file with sharing off opens a tab explaining "David doesn't share
  files. They can turn it on in Settings → Agents."; with it on, Max gets David's version read-only. Stop works and
  the stopped agent's last screen can be looked at. New pane, ⌘K and the switcher work.
- **W7 (works) Removing, inviting back, leaving.** Removing asks first, Max is told plainly what happened ("Removed
  from the team. Your agents there keep running on this Mac without being shared… and rejoin if you're invited
  back"), his running agent rejoins by itself after the new invite, and Leave team (Settings → Team) works with a
  clear question.
- **F6 (medium) Deleting a team with your own agents running can't work as promised.** The question says "…and your
  agents in it stop", and after you agree the hub refuses with "Stop the team's agents first." The hub refuses while
  any agent runs, yours included, and the app only stops yours after the delete succeeds. The message also doesn't
  say whose agents. Expected: stop your own agents first and then delete; if a teammate's are running, say whose,
  before asking.
- **W8 (works) A team on David's Mac, found by Max over the network.** This Mac explains who can join, the hub is
  `https://127.0.0.1:…` for David, Max's "Look for teams on this network" finds "Garage @ david's Mac" by Bonjour, opens
  it over TLS at `https://192.168.0.107:…` with a pass from the online hub, and Max's agent joins it. 9 of 9 checks:
  the two-copy test that was outstanding.
- **W9 (works) The push guard as a Codex agent on a shared team meets it.** In its terminal, `git push origin
  HEAD:main` is stopped ("don't push straight to main…"), `git push origin :session/login-page` is stopped ("this would
  delete…"), and `git push -u origin HEAD` pushes its own session branch.

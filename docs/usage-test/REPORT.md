# Customer simulation of Protoplasma 0.5.0: report

15 October 2026. The running notes, with evidence, are in [FINDINGS.md](FINDINGS.md).

## What was done

- **Released 0.5.0:** `npm test` 69/69 and `npm run dist` with the asar list checked first. GitHub Actions built,
  signed and published it, and the release notes say Mac-hosted teams need everyone on 0.5.
- **Installed app** (`/Applications/Protoplasma.app`, 0.3.0 at the start), driven on screen:
  - the update to 0.5.0;
  - sign-in, the team list and opening a team on the real online hub;
  - People and every Settings section;
  - quitting and reopening.
- **Playground**, two copies of the app (David and Max) on a local hub and repo, with stand-in agents. Driven with real
  mouse clicks and typing at the elements a person would use, in 9 scenarios:
  - first day: making a team and inviting someone;
  - a session with two agents: overlaps, hooks, statuses;
  - plans, notes and comments, and renaming a session;
  - Commit & Push on a shared branch, a clash, Pull, and fixing it in the editor;
  - typing into agents, sharing files, stopping agents, pane mode, ⌘K;
  - removing someone, inviting them back, leaving, deleting a team;
  - a This Mac team found by the other copy over the network;
  - the push guard, as a Codex agent meets it.
- **Result:** 92 checks passed. The other 9 failures were mistakes in my test script (for example, clicking Code when it
  was already open), each checked by hand and listed in FINDINGS.md. The real problems are below.

## What works

| | Area | Evidence |
|---|---|---|
| W1 | Updating 0.3.0 → 0.5.0 from the update bar | ~26 s, reopened as 0.5.0, signed "Protoplasma Release Signing", `codesign --verify --strict` passes |
| W2 | Making a team, inviting, the invitee seeing it by itself | 8/8 |
| W3 | Sessions with two people's agents: own folders and branch, overlap warnings, Claude asked before editing a teammate's file, team context, statuses | 17/17 |
| W4 | Plan steps, team notes, comments; renaming a session with agents running | 14/14 |
| W5 | Commit & Push on a shared session branch; a clash; Pull; fixing it in the editor; "Merged and pushed" | remote has both changes, no conflict lines |
| W6 | View only vs You can type; who typed last; sharing files off (explained) and on (read-only); Stop and the last screen; panes; ⌘K | all checked on screen |
| W7 | Removing someone (asks first, explains to them), their agent rejoining after a new invite, Leave team | 11/11 |
| W8 | **A This Mac team found by the other copy over the network**, over TLS with a pass, and an agent joining it | 9/9: the test that was outstanding |
| W9 | Push guard: a Codex agent stopped from pushing to main and from deleting a branch; its own branch pushes | 4/4 |
| | Settings → Data & privacy, Agents, Account, About show the right 0.5.0 text | screenshots |

## What doesn't

| | Severity | Problem | Fix |
|---|---|---|---|
| F1 | **High** | **Quit doesn't quit.** The window closes, but the app keeps running with no window, and opening it again does nothing. It happens to anyone who never hosted or looked for a network team, which is almost everyone. It also happens when "Update now" quits to install, when macOS logs out, and on SIGTERM. Present since the 1 s network goodbye in 0.4.x. **Users on 0.4.x or 0.5.0 can only finish an update by force-quitting the app** (then the update installs and opens). | Re-quit on the next tick, so Electron doesn't ignore it. A test that quitting really exits. Release 0.5.1 soon, and its notes should say to Force Quit if the window closes but the update doesn't open. |
| F4 | Medium | **The background fetch ignores a repo's `core.sshCommand`.** Anyone whose git config picks an ssh command (several GitHub accounts, a key per host) never sees "N commits behind" or a teammate's newer pushes. | Keep their `core.sshCommand` and add `-o BatchMode=yes` to it, instead of replacing it. A test. |
| F6 | Medium | **Deleting a team while your own agents run can't work.** The question promises your agents stop, then the hub refuses ("Stop the team's agents first."). | Stop your own agents, then delete. If a teammate's agents run, say whose before asking. |
| F2 | Low | A slow start (46 s on the first launch after the update, probably macOS asking about the Keychain once) shows "Welcome… Continue with GitHub" to someone already signed in. | Say "Signing in…" while the saved sign-in loads. |
| F3 | Low | Settings → About says an update is available, but the Update now button is in the bar behind the Settings panel. | Put an Update now button in About too. |
| F5 | Low | A conflicted file (C) opens as a diff against the last commit. Editable, but the plain file with git's conflict lines is what you need. | Open C files in the plain editor. |

## Not covered, and why

- **Signing in from scratch:** GitHub's device flow needs you to approve it on GitHub. The saved sign-in was used.
- **A real Claude Code agent in the installed app:** the window was on another desktop Space, and it would have meant a
  real session on your account. e2e runs real Claude Code against a local hub and passes.
- **Two real GitHub accounts on two Macs, and the real online hub issuing passes:** the playground used made-up
  identities on one Mac with a local online hub. The online hub's pass endpoints are live (`/passes/key` answers), and
  lan.test.js covers passes against a TLS hub.
- **Notifications, pull requests/issues tabs, real Codex/OpenCode CLIs:** need GitHub or CLIs this Mac doesn't have.

## Still outstanding from before

- **N12 / making the repo public** (your call). While it's private:
  - customers need `gh` signed in with access to install and update;
  - "Report a problem" (Settings → Data & privacy) opens an issues page they can't see.

  Making it public fixes both.
- **N11:** the README images are from before 0.4.0.
- **Test gaps** (C107, C109–C111): the hub's live side, files.js list/search/watch, updates.js download and swap.
- **Codex and OpenCode have no hooks**, so no overlap warnings or file notes for them. That's a feature, not a fix.

## Plan

1. Fix F1, F4, F6, F2, F3 and F5, with tests where they fit. Then `npm test`, `npm run e2e`, and a re-run of the
   affected scenarios.
2. N11: regenerate the README images.
3. Fill the most useful test gaps: quitting, hub hello validation, the slow-viewer drop, the file-relay timeout.
4. Release 0.5.1 (needs your OK) with a note on force-quitting for anyone updating from 0.4.x or 0.5.0.

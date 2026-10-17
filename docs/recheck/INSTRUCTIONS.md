# Protoplasma recheck: shared instructions for every section

Protoplasma is an Electron app for multiplayer AI coding, laid out like the Amoeba app: a team works in **sessions**;
each person runs real agent CLIs (Claude Code, Codex, OpenCode) in terminals on their own Mac; a **hub** relays the
terminals to teammates, tracks which files each checkout changed (overlaps), and answers Claude Code hooks (team context,
"ask" before risky pushes or edits to files a teammate changed). There's a Monaco code view, pane mode, plans, memory
notes and comments. The repo is the current working directory (version 0.4.1, commit 817f96a).

Layout: `src/hub.js` (server), `src/lane.js` (runs an agent in a PTY, git status), `src/workspace.js` (session
worktrees, pre-push guard), `src/shared.js`; `app/main.js` (Electron main), `app/preload.js`, `app/teams.js` (hub
discovery and API), `app/github.js` (sign-in, gh CLI, session folders), `app/updates.js`, `app/files.js` (code view file
access), `app/renderer.js`, `app/code.js` (code view), `app/panes.js`, `app/index.html` (markup and CSS);
`scripts/` (sign.sh, e2e.js, playground, staging), `.github/workflows/`, `install.sh`, `test/`.

## Your job: find problems, don't fix them
- Check every line in your section's scope, and how it connects to the code around it (callers, IPC, the hub protocol).
- Look for: wrong behaviour, crashes, races, data loss, security issues, broken edge cases (empty, huge, unicode,
  offline, two people at once), dead code, misleading UI text, comments that no longer match the code.
- Verify where you can. `npm test` runs 50 unit tests. Put throwaway scripts in
  `<recheck folder>/scratch/<your section number>/`. Mark each finding CONFIRMED (you ran it) or SUSPECTED (by reading).
- Do NOT edit repo files, commit, push, or touch GitHub, Railway, ~/Protoplasma or the installed app. Don't run the
  app unless your section says to.
- Keep to your scope; if you notice something outside it, add it under "Outside my scope" at the end, one line each.
- Budget (the account has a usage limit, so be economical): read each file in your scope once, in large chunks;
  don't re-read or print whole files again; keep verification scripts short and targeted (only for findings you
  suspect); about 30 tool calls and 15 minutes in all. Write each finding to your file as soon as you have it, so
  nothing is lost if you're cut off.

## Already decided (don't report these as bugs)
- Looking for teams hosted on a teammate's Mac ("Look for teams on this network") is off by default, on purpose: it
  shows the GitHub sign-in to every Mac that answers.
- The push guard and the shell-write check are word heuristics over the command, not a shell parser; the push guard
  reads only the first 20,000 characters. Report real misses or false alarms on ordinary commands, not exotic quoting.
- Teammates' terminals scale down to a 6px font, then scroll sideways.
- Inputs have maxlength limits matching the hub's; text past the limit is cut by the browser.
- A failure to create a session's own worktree is an error (not a silent fallback), except for repos with no commits.

## Write your findings to `<recheck folder>/sections/<NN>-<name>.md`
Start with a **Covered** list (each function, feature or file part you checked, so coverage can be audited), then:

    ## [high|medium|low] Short title
    - Where: file:line
    - What happens: the concrete scenario and its effect
    - Evidence: CONFIRMED (how) or SUSPECTED (why)
    - Suggested fix: one or two lines

high = crash, data loss, security hole, a main feature broken; medium = a feature wrong in a common case;
low = edge cases, wording, polish. Only real problems; no style preferences.

End your final message with: counts by severity, then one line per finding, most severe first.

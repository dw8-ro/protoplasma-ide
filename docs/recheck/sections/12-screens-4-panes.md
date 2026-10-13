# Section 12: screens part 4 and pane mode (app/renderer.js 1448-end, app/panes.js)

## Covered
- renderer.js: applyPrefs (theme to documentElement and proto.setTheme, every terminal's theme/contrast/font/line height, local vs teammate font fit, replayTerm, [data-pref] inputs, font and line-height outputs), savePrefs, the prefers-color-scheme listener.
- showPane, openSettings (team pane, account pane, providers list, ghStatus, About pane, update status, online hub line), settingsBtn/Done, close handler, the `onchange` prefs handler, the `onclick` handler (nav, font and line steps, url, Check now, Delete/Leave team, Sign out, People, Switch team).
- Updates: checkUpdates (staged, downloading, dismissed), updateLater, updateNow, the 6-hour interval, showUpdateStatus wording; checked against main.js `updates:check`/`updates:install` and updates.js `latestRelease`.
- Switcher: switcherCandidates, renderSwitcher (filter, 30 cap), openSwitcher (and the Go to file source from code.js goToFile), keyboard (arrows, Enter, Esc), mouse (row click, backdrop click).
- First-run checklist: renderSetup, checkSetup, the #setup click handler (Copy, Check again), gh/agent detail strings from github.js.
- runMenu (every action and the guards), proto.onMenu, the Esc handler, the Start block (saved sign-in, reopen last team, checkUpdates timer, sidebar state at load).
- esc coverage for every hub-derived value in all of the above (team name/where/owner/members, me.name/login, agent cmd, info.version, hub host, switcher text/kind, gh detail, pane names/tasks/statuses): all escaped.
- panes.js (all 78 lines): openPanes/savePanes/panesKey (per team), paneLane, paneLaneIds, renderPanes (shape check, terminals moved in and back, head, empty states, pick list, fitTeammates), the buttons (+ Pane at max 3, Single, open, close, pick, Add agent, New session), the `#newPane` restore in renderer.js:1249, team switch / sign-out (clearTeamView, closeTeam), rename (followRenames) and delete (deleteSession) interplay.

## Findings

## [medium] Font family, size and line height changes in Settings don't reach the Terminal-tab shells or an open code editor
- Where: app/renderer.js:1450-1461 (applyPrefs); app/code.js:71, 80, 612
- What happens: applyPrefs updates `terms` (agent terminals) and `replayTerm`, nothing else. code.js only hooks the `data-theme` attribute (MutationObserver, code.js:71), which updates the Monaco theme and the shells' theme and contrast, not font. The editor gets `fontFamily: terminalFont(), fontSize: prefs.fontSize + 0.5` only when it is created (code.js:80), and each shell gets its font only in `new Terminal(...)` (code.js:612). So after "Terminal text size", "Terminal font" or "Line height" is changed, agent terminals change at once, but a Terminal tab that is already open (and the editor) keep the old font and spacing until the app restarts (shells live for the whole app run; they are kept per folder).
- Evidence: CONFIRMED by grep: every use of fontSize, lineHeight and fontFamily in code.js and renderer.js was listed; none updates the existing `shells` or `editor`/`diffEditor` after creation.
- Suggested fix: in applyPrefs also loop `shells.values()` (fontSize, lineHeight, fontFamily, then fit) and call `editor?.updateOptions({ fontFamily, fontSize: prefs.fontSize + 0.5 })` (and the diff editor).

## [medium] A pane keeps showing a session that was renamed or deleted, and "Add agent" there brings the old name back
- Where: app/panes.js:8-18, 45-61, 76; app/renderer.js:782-791 (followRenames), 763-767 (deleteSession), 1249 (#newPane)
- What happens: `panes` (and the saved `panes:<team>` list) hold session names. followRenames only updates `current` and your local lanes; deleteSession only does `go('sessions')`; nothing touches `panes` or the saved list. So (a) a teammate deleting a session, or you deleting it from its ⤢ view, leaves a ghost pane "No agents are running in X" with an "Add agent" button; (b) New pane in another session restores the saved list verbatim (`saved.includes(current) ? saved : ...`), so the ghost comes back; (c) for a renamed session the pane keeps the old name, while the new name is offered in other panes' pick lists. Clicking "Add agent" on a ghost sets `current = X` and calls addAgent: if this Mac still has a saved source for X (teammate deleted it) startAgent runs and the hub recreates session X with one click; if not, the New session form opens with the deleted name prefilled.
- Evidence: SUSPECTED (by reading: grep shows `panes` is only touched in panes.js and renderer.js:853/1027/1249).
- Suggested fix: in renderPanes, drop a pane whose name has no record and no lanes (and rewrite the saved list), and map renamed names via the `aliases` that followRenames already reads.

## [low] Update status says "No releases yet" when offline (and when running from source); the "Couldn't reach GitHub" branch can't happen
- Where: app/renderer.js:1520-1522 (showUpdateStatus), app/main.js:119-126, app/updates.js:28-36
- What happens: `updates:check` never rejects. When GitHub (and gh) can't be reached, or the newest release has no Mac asset yet, `latestRelease` returns null and the handler returns `{ latest: null, available: false }`; a source run returns `{ current, available: false }`. showUpdateStatus then prints "No releases yet" for all of these, and `!u` (the only path to "Couldn't reach GitHub") is reached only if the IPC itself throws. Also, once an update is staged or downloading, checkUpdates returns the old `update`, so "Check now" shows "X is available" although it is already downloaded and waits for quit.
- Evidence: SUSPECTED (by reading the three files; I didn't run the check because it would call GitHub).
- Suggested fix: have updates:check return `{ error: true }` (or `reachable: false`) when latestRelease is null because the fetch failed; show "Ready to install when you quit" when `staged` and "Downloading…" when `downloading`.

## [low] A check that is in flight when "Update now" is clicked resets the bar during the download
- Where: app/renderer.js:1549-1558, 1561-1574
- What happens: checkUpdates only tests `staged || downloading` at its start. If the 5-second start-up check, the 6-hour check, or a Settings "Check now" is awaiting the network when the user clicks "Update now", it resumes after `downloading = true`, rewrites `#updateText` to "A Protoplasma update is available" and re-enables `#updateNow`, so a second click starts a second installUpdate while the first is still downloading.
- Evidence: SUSPECTED (by reading; the window is one GitHub round trip).
- Suggested fix: re-check `staged || downloading` after the await (return `update` without touching the bar).

## [low] ⌘K's list is cut at 30 before the pages and actions, so with many sessions Settings, New session and Switch team can't be reached without typing
- Where: app/renderer.js:1580-1596 (switcherCandidates order, `.slice(0, 30)`)
- What happens: sessions and workspaces come first, then 7 page/action rows. With no query only the first 30 rows show: at 21 sessions (plus 3 workspaces) 6 of the 7 pages/actions are visible, at 25 only 2, at 40 none; Down-arrow can't go past the 30th row. The Go to file list has the same cap with plain substring matching in file order, so in a big repo the best match may not be among the 30.
- Evidence: CONFIRMED (node snippet in scratch/12/sw.js reproduces the counts).
- Suggested fix: put pages and actions first (or reserve rows for them), and rank prefix and filename matches first for Go to file.

## [low] Enter in the ⌘K box while an IME is composing picks a row
- Where: app/renderer.js:1620
- What happens: with a Japanese/Chinese/Korean IME, Enter confirms the composition; `onkeydown` doesn't test `e.isComposing`, so the same Enter runs the highlighted item (opens a session or an action) before the person has finished typing the name.
- Evidence: SUSPECTED (standard keydown behaviour; no `isComposing` check in the code).
- Suggested fix: `if (e.key === 'Enter' && !e.isComposing)`.

## [low] After a failed auto-reopen of the last team the team picker stops refreshing
- Where: app/renderer.js:285-288 (refreshTeams), start-up at 1681
- What happens: `if (last) return openTeam(last);` returns before the `syncWhere()` call, the `#teamsNote` line and the `teamsTimer = setTimeout(...)` at the end. If openTeam then fails (hub unreachable, for example offline at launch), the picker stays open with the error, but it never polls again (new invitations or teams don't show until it is reopened) and `syncWhere()` never ran, so the "Online" radio isn't disabled even when `onlineReady` is false.
- Evidence: SUSPECTED (by reading).
- Suggested fix: schedule the next poll (and call syncWhere) before `return openTeam(last)`, or in openTeam's catch.

## [low] Menu shortcuts still act on the open team while the Switch-team picker is up
- Where: app/renderer.js:1654
- What happens: the guard `dialog[open]:not(#start, #settings)` leaves out #start, so with the picker open over an open team (`me` and `currentTeam` both set) ⌘K, ⌘N, ⇧⌘L, ⌘P and ⌘I still run: a second modal opens on top of the picker, or a session is opened behind it. "Check for Updates…" and Settings also open the Settings page under any open modal (new session form, rename, etc.), where nothing shows until the modal closes.
- Evidence: SUSPECTED (by reading).
- Suggested fix: treat #start as open for every action except 'teams', 'sidebar' and the Settings/updates ones, or close #start first.

## [low] ⌘N inside a session opens the "Add an agent" form, not "New session"
- Where: app/renderer.js:1658; menu label in app/main.js:219; Settings > Keyboard "New session"
- What happens: `openNewAgent(view === 'session' ? current : undefined)` makes `adding` true for the open session, so the dialog is titled "Add an agent" with the current session prefilled, while the menu item and the keyboard list both say New session. The ⌘K "New session" action and the page button open a real new-session form.
- Evidence: SUSPECTED (by reading openNewAgent at renderer.js:551-556; I didn't run the app).
- Suggested fix: pass no session from ⌘N (⇧⌘L already adds an agent to the open session).

## [low] Pane empty state says "Every session is already open in a pane." when the other sessions are only done
- Where: app/panes.js:56-60
- What happens: `choices` leaves out sessions with status `done`, so with one open session in a pane and the rest done (or none), an empty pane says every session is already open, and offers no way to put a done session in a pane at all.
- Evidence: SUSPECTED (by reading).
- Suggested fix: say "No other sessions are running." (or list done sessions below the open ones).

## [low] "Add agent" in a pane ignores whether the default agent is installed, and the pane-mode return is inconsistent
- Where: app/panes.js:76
- What happens: it calls `addAgent(prefs.agent)` even when that CLI isn't installed on this Mac (the menus grey it out), so the start fails with an alert. When `sourceFor` has no folder, addAgent opens the New session form and returns at once, so `openPanes(panes)` runs under the open form, and finishing the form ends in the session view, not the panes (the direct path returns to panes after a flash of the session view).
- Evidence: SUSPECTED (by reading addAgent at renderer.js:685-690 and startAgent ending in openSession at :523).
- Suggested fix: pick the first installed agent when `prefs.agent` isn't installed; after the form, return to panes.

## [low] Settings > Team doesn't update while open; About can stick on "Loading…"
- Where: app/renderer.js:1478-1487, 1515
- What happens: `#teamPane` is built once in openSettings. If someone joins or is removed while it's open, the ws handler replaces `currentTeam` but the member list stays old. Separately `new URL(info.onlineHub)` throws for a malformed hub value, which leaves About on "Loading…", "Checking…" for updates, and skips the update check.
- Evidence: SUSPECTED (by reading; teamPane is only written in openSettings).
- Suggested fix: re-render the team pane from render() when Settings is open; wrap the URL in try/catch.

## [low] Switching theme leaves already-written terminal output coloured for the old theme
- Where: app/renderer.js:1453-1456 with forPage (renderer.js:465)
- What happens: the black-background substitution is applied when output is written, using the theme at that moment. After switching dark to light, text already on screen keeps black cells (Claude Code's mascot) on the white page until the agent redraws, and the reverse after switching to dark; applyPrefs only changes the terminal theme object.
- Evidence: SUSPECTED (by reading).
- Suggested fix: accept it (note it), or redraw on switch (reconnect replays scrollback through forPage for teammates only).

## [low] The first-run checklist can't be dismissed when the GitHub CLI is optional
- Where: app/renderer.js:1633-1637
- What happens: the text says folders work without gh, but "Finish setting up this Mac" stays at the top of Sessions on every team open for anyone who doesn't want gh. It hides only when gh is installed and signed in and an agent CLI is installed. When gh is missing, the same instructions also appear twice (the detail "Run "brew install gh"..." and the Copy button).
- Evidence: SUSPECTED (by reading; no dismiss state).
- Suggested fix: only count a missing gh as setup when no agent is installed, or store a dismissed flag.

## Outside my scope
- app/renderer.js:877-882 (notifyChanges): the "already looking at it" skip tests `view === 'session' && current === l.session`, so in pane mode agents that are on screen in a pane still raise notifications.
- app/github.js:136-140 (ghStatus): a non-zero exit from `gh auth status` (offline, if it exits non-zero there) reports "Installed, but not signed in", which the checklist shows as is.

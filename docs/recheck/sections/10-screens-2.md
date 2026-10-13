# Section 10: screens, part 2 (app/renderer.js 496-831)

## Covered
Every line of 496-831 was read once; helpers (recordFor, sessionList, sessionStatus, followRenames' caller, the global Esc handler, onExit/stopping, `state` handler) and the matching hub/main code (src/hub.js findSession/ensureSession/rename/delete/onLane, app/main.js startLane, app/github.js cloneDir/sessionFolderPath) were read only as needed.
- Where a session works: sourceKey, sourceFor, lastAgentKey (stale after rename by someone else, after delete, alias names).
- startAgent: team pinned (renderer side only), `created` cleanup on failure, `local` entry and `began` (used by onExit at 478, fine), openSession with the renamed name.
- resumable, resumeAgent, addAgent, agentMenu; refreshAgents, isInstalled, syncAgents (hint wording).
- openNewAgent (adding vs new, session list esc'd, goal prefill, showSource, source kind, prefs, repo loading and error), renderRepoPicker (filtering, esc, unlisted owner/name), showFolder/syncSource/pick, syncSessionName.
- slug: CONFIRMED byte-identical to src/shared.js (node compare, scratch/10/t.js); existingSession.
- agentForm submit: validation, REPO, Cancel/Esc during start, forced close + alert, focus afterwards, saved repo/kind.
- showMenu/closeMenu (placement, outside click, Esc handled by the global handler at 1668-1670, keyboard), toggleSidebar, go, openSession (comment ref and code view reset when the name changes), workspaces click handler, sessionAction, deleteSession (navigates only after success, folder confirm), toggleDone, followRenames, openRename/rename submit, stopAgent, statusOf, agentLabel (sort fallback `￿` sorts last: CONFIRMED in node), sessionStatus.
- XSS pass: datalist options, repo rows, repo error, menu text/label/hint all go through esc(); `#agentLede`, `#agentErr`, `#agentHint` use textContent. No unescaped hub data found in this range. A hub-supplied repo reaches main unvalidated, but cloneDir() runs checkRepo(), so there is no path injection.

## [medium] agentLabel never numbers a second agent: `.indexOf(l)` is inside the comment
- Where: app/renderer.js:828 (used at 1041, 1059, 1103)
- What happens: the line ends `.sort(...) // one the hub hasn't reported yet is newest.indexOf(l);`. The comment swallows `.indexOf(l);`, so `nth` is the sorted array, not an index. `[...] > 0` is always false (a one-element array becomes "[object Object]", NaN > 0), so a person's second agent of the same kind is still labelled "Claude Code", never "Claude Code 2". Two same-kind agents in a session look identical on the stage heading, the agent cards and the pane labels. The feature "name a person's second agent" (commit c586dec) does not work since the sort was added.
- Evidence: CONFIRMED. Copied the function into node with two claude agents by the same login: both return "Claude Code" (scratch/10/t.js).
- Suggested fix: put the comment on its own line above and end the code line with `.sort(...).indexOf(l)`.

## [medium] An old name of a renamed session isn't recognised: wrong wording, and a failed start can delete the real session
- Where: app/renderer.js:511-517 (`created`, cleanup), 631-642 (syncSessionName), 655 (existingSession), 657-681 (submit)
- What happens: the hub resolves a typed name through `findSession` (src/hub.js:85-87): exact name, slug, the session's original `key`, or any of its `aliases`. The renderer matches only by exact name (`recordFor`) or the slug of the current name (`existingSession`). After "fix-login" is renamed "Login bug", typing `fix-login` (or `Fix-Login`) in the New session dialog:
  1. keeps the title "New session" / "Start the session" although the hub will join the renamed session (wrong dialog wording, no source or goal prefill);
  2. makes `created = !recordFor(session)` true. With a goal typed, `saveSession` hits the existing session (and overwrites its goal if you are its creator or the owner); if `startLane` then fails (bad repo, clone error, agent missing, offline), `proto.deleteSession(team.key, 'fix-login')` runs and the hub's DELETE resolves the alias to the renamed session and removes it (its goal, plan steps, comments) when it has no running agents and you created it or own the team;
  3. `openSession(...)` after a successful start only maps exact aliases (`aliases.includes(session)`), so "Fix-Login" opens an empty room named "Fix-Login" until the next state push; a session renamed twice (A to B to C) typed as "B" also gets `folderKey` undefined, so the agent uses slug("B") instead of the original key slug("A") and gets another branch and folder.
- Evidence: the mismatch is CONFIRMED in node (scratch/10/alias.js): with a session `{name:'Login bug', key:'fix-login', aliases:['fix-login']}`, typed `fix-login` and `Fix-Login` give hub finds "Login bug" but client existingSession and recordFor give undefined. The deletion is SUSPECTED by reading (hub DELETE at src/hub.js:471-474 uses findSession and only refuses on running agents).
- Suggested fix: make existingSession match like findSession (name, slug, `rec.key`, `rec.aliases`) and return the record's current name; derive `created` from that, and never delete in the cleanup unless the record's `createdAt` is newer than the click (or only delete when the saveSession response shows the session did not exist before).

## [low] startLane isn't told which team; a team switch during the goal save starts the agent in the wrong team
- Where: app/renderer.js:510-518 (opts has no team), app/main.js:139-148 (`openTeam()` at call time); also 512, 760, 808
- What happens: `startAgent` pins `team` for its own bookkeeping (local entry, store keys, cleanup delete), but `proto.startLane(opts)` makes main use whatever team is open when it runs. When a goal was typed, `await proto.saveSession(team.key, ...)` comes first; if another team gets opened during that await (menu or switcher, the dialog only blocks pointer input), the agent joins the new team's hub under the old team's session name while the renderer files it under the old team. Likewise `sessionRecords = await ...` in startAgent, sessionAction (760) and rename (808) assign the old team's session list into the new team's state (fixed only by the next hub `state`), and the rename/delete code then calls `sourceKey(name)` with the new `currentTeam`, moving or clearing the wrong team's saved source.
- Evidence: SUSPECTED by reading (narrow window: one hub round trip).
- Suggested fix: pass `teamKey: team.key` in opts and have main throw if `openTeam().key !== o.teamKey`; after each await in these helpers, `if (currentTeam?.key !== team.key) return` before assigning `sessionRecords` or touching the store (capture `team` and use `sourceKey(x, team)`).

## [low] This Mac's saved source and last agent go stale after a rename by someone else, or a delete
- Where: app/renderer.js:499-504 (sourceFor), 782-791 (followRenames), 763-775 (deleteSession)
- What happens: followRenames copies `source:` / `lastAgent:` entries only for this Mac's agents that are still running when the rename arrives (it walks `hubLanes`). If a teammate renames a session while your agents in it have stopped, the entries stay under the old name: the "+" menu loses "Resume", and for a folder session `sourceFor` returns null so "+" opens the dialog and asks for the folder again. The other direction: when a session is deleted by someone else (or never deleted through this Mac), its `source:`/`lastAgent:` entries stay forever; if a new session with the same name is made later (another repo), `sourceFor` prefers the stale saved source over the session's real repo, so "+" and Resume start the agent in the old repo or folder.
- Evidence: SUSPECTED by reading (the hub's rename only renames lanes and stopped entries, not this Mac's localStorage).
- Suggested fix: in followRenames also walk `sessions[].aliases` and copy a missing `source:`/`lastAgent:` key to `r.name`; store `rec.createdAt` inside the saved source and ignore it when the record's createdAt differs.

## [low] "Add an agent" through the dialog ignores the session's saved worktree flag
- Where: app/renderer.js:661 (the submit builds `worktree: prefs.sessionBranches`) vs 500-504 and 685-690 (sourceFor/addAgent use the saved one)
- What happens: for an existing session started while "own branch per session" was off (shared clone, current branch), "+" reuses the saved `{repo, worktree:false}`, but typing the session's name in the New session dialog shows its repo and then starts with the current pref (`worktree: true`): the new agent gets a session branch and folder while the other agents are on the shared clone. The repoHint also describes the pref, not the session.
- Evidence: SUSPECTED by reading.
- Suggested fix: in the submit, use `known.worktree` from sourceFor when the typed repo equals the session's repo.

## [low] syncSessionName overwrites a goal already typed, and keeps the old source after the name stops matching
- Where: app/renderer.js:631-642
- What happens: type a goal first, then a session name that matches an existing session: `if (rec) $('#task').value = rec.task` replaces the typed goal (`dataset.from` is '' so nothing protects it) with no warning, and a keystroke later (name no longer matching) the goal is not restored. The reverse also holds: after the match, `showSource` has put that session's repo or folder in the form and nothing resets it when the name changes again to a new session, so a new session can be started in the other session's repo by Enter. If you are not the creator or owner, the hub also ignores a changed goal silently (src/hub.js:449), while the dialog looks as if it will be saved.
- Evidence: SUSPECTED by reading.
- Suggested fix: only prefill the goal when the field is empty or still holds the previous prefill; remember the source shown by syncSessionName and put the user's repo/folder back when the match goes away.

## [low] Repo list failure silently flips the dialog to "Folder", hiding the error
- Where: app/renderer.js:578-584, 589-590
- What happens: when `proto.repos()` fails (offline, rate limit), the radio is switched to Folder, which hides `#repoField` where the only error text (`reposError` in `#repoPicker`) lives, so the user sees a mode switch with no explanation. It also overrides what the user did meanwhile: if they already chose "GitHub repo" and typed an owner/name while the (slow) request was pending, the failure flips them to Folder and the typed repo is in a hidden field. `repos` is also cached until sign-out, so a repo created later doesn't appear until restart (typing owner/name still works).
- Evidence: SUSPECTED by reading.
- Suggested fix: keep the Repo mode when the user typed a valid owner/name or picked the radio themselves; otherwise show the error text outside the hidden field (e.g. `#agentErr`) when switching.

## [low] Pop-up menu: no keyboard route in, and disabled items can still run
- Where: app/renderer.js:691-713
- What happens: (a) the menu is appended at the end of `<body>` and focus is never moved into it, with no arrow-key handling, so a keyboard user pressing Enter on "+" (or a session's menu button) can only reach the items by tabbing through the whole page; only Esc (global handler at 1668) works. (b) The `pointerdown` handler closes the menu before the anchor's click reopens it, so clicking "+" again can't close it (it flickers). (c) `menu.onclick` does not check `it.disabled`: a click on the hint `<span>` inside a disabled button ("Not installed", "Stop its agents first") bubbles with `closest('button')` = the disabled button, and `it.run()` may run in Chromium (a child of a disabled button still receives the event); the hub still refuses the delete, and an uninstalled agent fails with an alert, so the damage is an error dialog. (d) "Resume X" in agentMenu ignores `isInstalled(last)`, so it's offered for an agent that isn't installed and then fails.
- Evidence: SUSPECTED by reading (no run).
- Suggested fix: focus the first enabled button after append and add ArrowUp/Down handling; skip the anchor in the pointerdown check; `if (it && !it.disabled)`; pass `disabled: !isInstalled(last)` for Resume.

## [low] Repo picker and failed start: keyboard focus is dropped
- Where: app/renderer.js:606-609 (row click re-renders), 657-681 (submit finally)
- What happens: picking a repo row with Enter/Space re-renders the whole list through `setHTML`, replacing the focused button, so focus falls to the dialog body and the next Tab starts from the top. Each row is also a separate tab stop inside `role="listbox"` (no arrow-key navigation, no roving tabindex), so with hundreds of repos Tab walks the whole list. After a failed start the Start button, disabled while focused, is re-enabled but focus is not put back, so Enter does nothing until the user tabs.
- Evidence: SUSPECTED by reading.
- Suggested fix: after picking, focus the repo input (or the same row after re-render); in `finally`, `if ($('#agent').open) button.focus()`.

## [low] Wording and comments that no longer match
- Where: app/renderer.js:547 (agentHint), 793, 764
- What happens: (a) `${missing.join(' and ')} aren't installed` reads "Claude Code and Codex and OpenCode aren't installed on this Mac." when all three are missing. (b) The comment above openRename says "the hub refuses while agents run"; the hub does the opposite (src/hub.js:459-470 moves running agents and keeps the old name as an alias), and followRenames exists for that case. (c) deleteSession's confirm says "Its agents have already stopped", but the session panel's Delete (line 1242) isn't disabled while agents run, so a user can confirm and then get the hub's "Stop its agents first." (the sidebar menu does disable it).
- Evidence: CONFIRMED for (a) and (b) by reading the code line and hub; (c) SUSPECTED.
- Suggested fix: join with ", " and a final " and "; fix the comment; in (c) disable Delete in the panel while agents run or reword the confirm.

## [low] Rename dialog reads module state after the await
- Where: app/renderer.js:802-817
- What happens: the submit handler uses the module variable `renaming` after `await proto.renameSession(...)` (to move the store keys and fix `current`). If the dialog is cancelled and rename is opened for another session while the request is in flight, `renaming` has changed: the first rename moves the second session's saved source to the first session's new name. The Cancel and Esc paths are not blocked during the request.
- Evidence: SUSPECTED by reading (narrow window).
- Suggested fix: `const old = renaming;` at the top of the handler and use it throughout.

## Outside my scope
- app/github.js:131-133: removeSessionFolder turns every failure into "Its folder has uncommitted changes, so it was kept." even when git is missing or the path is gone.
- src/hub.js:449: the hub silently ignores a changed goal from someone who is neither the session's creator nor the owner; the renderer never learns it (see the syncSessionName finding).

# Section 15: live, the owner working alone (David, port 7801)

## Covered
(all driven live on David's copy, port 7801, team Solo; 7 screenshots, ~75 calls; Max's copy untouched)
1 Teams: empty name, Online/This Mac switch (error clears, button stays put), Online "Solo" and This Mac "Local Mac", picking the open team -> Sessions, People: "a--b" and "" refused with messages, "max" accepted then removed (confirm shown).
2 New session: repo david/playground with goal on the card; folder source (plain folder under the playground); names of 60 chars, emoji, Cyrillic, "My Session: #1/2" (all fine, slugged folders/branches), ".." (finding 1).
3 Agents: added 2nd/3rd Claude Code + Codex (finding 2); Stop with busy confirm (recorded in __dialogs), stopped agent's last screen (shows the shell output), Resume, quick-exit agent shows "stopped as soon as it started ... It said:" with the shell's last lines.
4 Session panel: Environment (branch, +1-0, files), Plan add/tick/untick/remove incl. 200-char step (wraps), Memory repo note / pinned to README.md / "package" -> package.json / unknown file error, hook delivers the pinned note on Read, Comments plain and on lines with the marker and the link.
5 Code view: Explorer, Find in files (finding 3), open/edit/save via /menu save, changed-on-disk banner (agent shell append) with Keep mine, diff vs last commit, Commit & Push empty message then real (pushed to origin), Terminal tab, font size (finding 4), go-to-file via /menu, dock height drag (clamps 220..height-220, persists).
6 Pane mode: New pane, + Pane to 3 (button disables), pick, open then New pane restores, x close, Single, rename then reopen (finding 5), light screenshot.
7 Settings: all eight panes read, About Check now (no releases, no error), light theme in session/code view, panes, Sessions page and Settings (all fine; Monaco and xterm follow the theme live), back to dark.
8 Switcher with 32 sessions (finding 6), /menu sidebar, invite, teams, updates, panel, new-agent, add-agent, code.
9 Sessions page: sort (Last modified/Name), search by name/goal/Cyrillic/none, card menu rename/clash message/mark done/reopen, delete with confirm + folder prompt (folder removed, branch kept, renamed session's folder path uses its original key correctly), workspaces hide and unhide.

- Teams: empty-name error, Online/This Mac switch clears error and button stays at 850,575 (CONFIRMED OK); Online "Solo" and This Mac "Local Mac" created; picking open team -> Sessions page (OK); invite "a--b" refused with message, "" refused, "max" accepted, Remove max works (confirm dialog recorded).
- Session creation: goal shows on card (OK); folder-source session (OK); odd names 60-char, emoji, Cyrillic, "My Session: #1/2" all accepted, worktrees/branches made with sane slugs (session-3hmqp etc.), see finding 1 for "..".

## [high] A session named ".." makes "Delete session" delete the whole team (and Mark done / Rename fail)
- Where: app/teams.js:80-84 (sessionRoute uses encodeURIComponent, which leaves ".." untouched; fetch normalises `/sessions/..` to the team's own URL), src/hub.js:363 (`!sub && DELETE` = delete team)
- What happens: the New session form accepts the name "..". The session then works as a card, but every call that addresses it by name goes to `/teams/<id>/` instead of `/teams/<id>/sessions/..`. DELETE therefore hits the team-delete route: for the owner, once no agent runs in the team, the delete-session card menu removes the entire team (all sessions, memory, plans). While an agent runs it only answers "Stop the team's agents first.", which is a confusing message for a session delete. Mark done and Rename answer "Not found." and comments/plan routes for it resolve wrong too, so such a session can never be marked done or renamed.
- Evidence: CONFIRMED live: created session ".." in Solo (accepted, worktree/branch made as session-3hmqp). On a throwaway online team, `proto.saveSession(team, {name:'..'})` ok; `proto.setSessionDone(.., '..', true)` -> "Not found."; `proto.deleteSession(team, '..')` -> ok, and `proto.teams()` no longer listed the throwaway team. `new URL('http://h/teams/ID/sessions/..').pathname` is `/teams/ID/`. (I did not delete Solo's own ".." session, to keep Solo.)
- Suggested fix: refuse names whose slug-less form is "." or ".." (client and hub), or percent-encode dots in sessionRoute segments (`.replace(/\./g,'%2E')` - the hub already decodes).

## [medium] A second (third) agent of the same kind is never numbered: all read "Claude Code"
- Where: app/renderer.js:827-830 (`agentLabel`)
- What happens: the `// one the hub hasn't reported yet is newest` comment sits on the same line as `.sort(...)`, so it swallows the trailing `.indexOf(l);`. `nth` is the sorted array, not an index; `nth > 0` is always false, so no label ever gets " 2" or " 3". With three Claude Code agents in one session the panel, the room caption ("Your agent, Claude Code") and the "several" caption cannot tell them apart (and the teammate-side cards likewise).
- Evidence: CONFIRMED live: 3 Claude Code + 1 Codex in session alpha; `agentLabel(l, inRoom)` returns ["Claude Code","Claude Code","Codex","Claude Code"], panel rows show the same (screenshot too). Section 10's claim is right.
- Suggested fix: move the comment above the line (or after `.indexOf(l);`), and keep `(a.startedAt || '￿')` ordering.

## [medium] Find in files finds nothing in files with Windows (CRLF) line endings
- Where: app/files.js:117-120 (`/^(.*?):(\d+):(.*)$/` over each `git grep` line)
- What happens: `.` does not match `\r`, so every `git grep` line from a CRLF file (ending in `\r`) fails the regex and is dropped by `.filter(hit => hit.path)`. A search for a word that is plainly in a CRLF file says "Nothing found." (Windows-origin repos, checked-in .bat/.cmd/.csv files, anything `autocrlf` produced.)
- Evidence: CONFIRMED live: untracked `crlf.txt` ("alpha\r\nbeta needle here\r\ngamma\r\n") in session alpha. `git grep -n -I -i -F --untracked -e needle` prints `crlf.txt:2:beta needle here`; `proto.code.search(root,"needle")` and the Find box return [] / "Nothing found.", while LF files (README.md, newfile.txt) are found. `/^(.*?):(\d+):(.*)$/.exec("crlf.txt:3:gamma\r")` is null in node.
- Suggested fix: use `([^]*)` (or `/s` flag, or strip a trailing `\r` first) for the text group.

## [low] Settings font size / line height do not reach the code editor or the Terminal tab until the app restarts
- Where: app/renderer.js:1456-1459 (only `local` agent terminals get the new size), app/code.js:80 and :612 (size read once when the editor / shell terminal is created)
- What happens: changing the font size in Settings updates the agent terminals but the open Monaco editor and the Terminal tab keep the old size. Sections 8 and 12 were right.
- Evidence: CONFIRMED live: with the code view and Terminal tab open, Settings font size 12.5 -> 14: `prefs.fontSize` 14 but `editor.getOption(fontSize)` stayed 13 and the Terminal tab's `.xterm-rows` stayed 13px (also after stepping back).
- Suggested fix: on a prefs change call `editor.updateOptions({fontSize: prefs.fontSize + 0.5, lineHeight...})` and set the shell term's `options.fontSize/lineHeight`.

## [medium] Renaming a session leaves a ghost pane in pane mode ("No agents are running in <old name>")
- Where: app/renderer.js:802-815 (`renameForm` / `followRenames` never touch `panes` or the saved `panes:<team>` list), app/panes.js:9-16, :52-60, :67-77
- What happens: a session that is in a saved pane layout is renamed (only possible with no agents running). Reopening the layout ("New pane" from another session in it, which restores `panes:<team>`) shows a pane titled with the OLD name, no goal, no avatars, "No agents are running in <old name>." and an "Add agent" button; the pane counts toward "2 sessions". The real session sits under its new name and is not offered by the pick list for that pane. "Add agent" in the ghost pane runs `addAgent` for the old name (see the line after "Evidence").
- Evidence: CONFIRMED live: panes ["Привет мир","🚀🚀"] saved; stopped the agent, renamed to "ru-renamed" (record has alias "Привет мир"); from session 🚀🚀 clicked New pane: heads "Привет мир | ⤢ | ×" with empty text "No agents are running in Привет мир. / Add agent", title "2 sessions, room for another".
- Suggested fix: in `followRenames`/`renameForm` map `panes` and the saved list through the rename, and have `recordFor`/`renderPanes` resolve aliases (drop panes whose session no longer exists).
- Follow-up (CONFIRMED live): "Add agent" in the ghost pane starts no agent (no lane for either name); it falls through to the New session dialog (the stored source was moved to the new name, so addAgent finds no source) and the pane stays a ghost until closed with the x.

## [low] With 30 or more sessions, the empty ⌘K switcher lists no pages, workspaces or actions
- Where: app/renderer.js:1593-1597 (`.slice(0, 30)` on a list that has sessions first, pages/actions last)
- What happens: the default (empty query) list is the first 30 sessions only; Sessions, People, Settings, New session, Invite, Switch team and the workspaces are cut off until you type a name. Nothing says there is more.
- Evidence: CONFIRMED live: 32 sessions in Solo (25 added through the hub API): empty switcher shows 30 rows, all kind "Session"; typing "settings" finds Settings|Page.
- Suggested fix: put pages and actions first (or reserve a few rows for them), or show a "type to see more" row.

## [low] A one-line comment's link only puts the cursor at column 1; it does not select the line
- Where: app/code.js:252-254 (`showActive`: `last > line ? Selection(...) : new Selection(line, 1, line, 1)`)
- What happens: clicking the "README.md:3" link of a comment made on a single line opens the file and reveals the line, but the selection is empty (3,1,3,1); only comments over two or more lines select their lines. The selection the comment was made with (a line) is not shown back.
- Evidence: CONFIRMED live: comment on README line 1 (endLine 1, later relocated to line 3 by the snippet); clicking its link gave `editor.getSelection()` = [3,1,3,1]. (Relocation itself works: the link read README.md:3 after two lines were inserted above, and the gutter marker is drawn.)
- Suggested fix: when `last === line` select `Selection(line, 1, line, getLineMaxColumn(line))`.

## Outside my scope
- src/hub.js hook context: an agent's "Teammates working in this repo right now" list shows the same person's own agents in other sessions as "David's claude agent ..." and ends "Check with the user before editing files a teammate has edited." (solo user sees teammates that are themselves; wording only).
- Sessions page "Last modified" sort puts a just-created record-only session below older ones that have agents (sorted by agent activity first); not verified further.
- Playground-only: the "Finish setting up this Mac" banner stays because `gh` is not signed in; expected here.

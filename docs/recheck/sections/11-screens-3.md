# Section 11: screens, part 3 (app/renderer.js lines 832-1447)

## Covered
Every line of 832-1447, plus helpers read for context (esc/setHTML/avatar/STATUS/whoEdited/ago/sessionStatus, statusOf/agentLabel, go/openSession/sessionAction/toggleDone/deleteSession, the hub's state/views/relayFile/memory/comment/step handlers, lane.js gitStatus, files.read/inside, main.js code:readLane/repo:reveal/openExternal, code.js sessionFiles/theirsKey/askFile/fileAnswered).
- render(): order (lanes = hub + unsynced local, assignColors, `look`, nav state, alerts, workspaces, sessions/people, room, panes, notify); re-entrancy through `go('sessions')` in renderRoom.
- renderAlerts (waiting, clashes, 4 cap, click handler); notifyChanges (first-sight skip, focus suppression, prune, badge); canAnswer.
- sessionList, hidden workspaces, renderWorkspaces (sort, `||` fallback, "Show N hidden"), workspaceMenu.
- renderSessions (search, sort/rank, card fields, "Marked done, N still running", branchLine, behindChip, diffStat, fileList, people, stepsDone), card click/keyboard, sessionMenu.
- renderRoom (focus/split defaults, onStage, terminal create/drop/hide/gpu/resize, lane bar, roomWho, empty state, Resume, replay bits, watching), renderPanel, agentCard, environment, stoppedRows, whose, openReplay/showReplay/fitReplay.
- Panel click handler (all branches), #lanes/#emptyNew/#myAgent/#newPane/#panelToggle/#ghPanel handlers.
- Comments: lineRef, setCommentRef, linesNow, comments(), comment form.
- Plan: stepsDone, renderPlan, step form, tick/undo, remove.
- answerFile (checks, readLane confinement, size) and the hub relay; renderMemory, roomNotes, memoryFile suggestions, memory form (pin completion + errors), remove note.
- loadPanel (stale guard, escaping); gpu(); dropTerminal; createTerminal; fitFont/fitTeammates; refit observers; 30s tick.
- XSS pass over every innerHTML in the range: all hub strings go through esc(); the numbers (git.added/removed/files/behind/ahead/unpushed, cols/rows) are coerced with `|0` in the hub (gitStats, size), so no injection route found. `openExternal` is limited to https://github.com/ and `repo:reveal` goes through checkRepo.
- There is no "behind" alert: behind shows only as chips (card, lane bar) and a row in Environment. The header comment on renderAlerts matches the code.

## Findings

## [medium] Viewers of an open agent send their terminal's automatic replies into the owner's agent
- Where: app/renderer.js:1437 (`term.onData(d => ws.send({ t: 'in', ... }))` for teammates' terminals), 1418 (`disableStdin: !mine && !l.open`); hub src/hub.js:612-618 forwards `in` to open lanes and sets `typedBy`.
- What happens: for an open agent, a teammate's xterm has stdin enabled. xterm.js fires `onData` for everything it sends back to the program, not only keystrokes (device attributes `ESC[?1;2c`, cursor position reports, and so on). The teammate's terminal parses the agent's output, including the whole scrollback the hub replays on every (re)connect, and each query in it produces a reply. Every reply goes to the hub as `in` and is typed into the owner's PTY. The owner's own terminal already answered, so the agent gets duplicates, once per viewer. Agents that query the terminal (cursor position, device attributes) can show stray `[?1;2c` or `[24;80R` text in their input. The hub also records it as the viewer typing, so the owner sees "bob typed, just now" on the lane bar when bob only opened the team.
- Evidence: SUSPECTED, not run (needs the app). In node_modules/@xterm/xterm/lib/xterm.mjs `triggerDataEvent(data, wasUserInput=false)` returns early only when `disableStdin` is set, and the DA1 handler calls `triggerDataEvent(ESC+"[?1;2c")`. renderer.js 1437 does not filter these. `disableStdin` is true only for lanes that are not open, so the leak is open lanes only.
- Suggested fix: send from a teammate's terminal only real user input, for example in `onData` check `document.activeElement === term.textarea`, or use `term.onKey` and the paste event instead of `onData`.

## [medium] Overlap labels say "1 of David's agents" when the other editor is in another session
- Where: app/renderer.js:1012 (fileList, used by session cards at 958 and Environment at 1210), whoEdited at 65.
- What happens: `fileList` builds the who-label from `lanes` of this session only (`lanes.filter(l => l.overlaps.includes(f))`), but the hub computes overlaps across all checkouts of the repo (hub.js views(), different `tree`, same repo, any session). When David's agent in session A overlaps with Max in session B, A's card and Environment list show `1 of David's agents`, with no hint that someone else is involved. It also reads as a count of one agent. The top-bar alert (all lanes) names both people, so the two screens disagree.
- Evidence: CONFIRMED in node (`whoEdited(['David'])` returns `1 of David's agents`, scratch/11/t1.js). The cross-session shape comes from hub.js:141-142 (overlap needs only `o.tree !== l.tree` and same repo).
- Suggested fix: build the label from all of `board` (the files' overlap partners), not just the session's lanes; make `whoEdited` never print "1 of".

## [low] Alerts merge two different overlaps that have the same path in different repos
- Where: app/renderer.js:862-865 (renderAlerts).
- What happens: clashes are grouped by file path only: `new Set(lanes.flatMap(l => l.overlaps))`, then `who = lanes.filter(l => l.overlaps.includes(file))`. Two unrelated clashes on `package.json` or `README.md` in repo A and in repo B give one alert whose names are the union ("Ann & Bob & Cy & Di edited"), and its click opens the first lane's session. The second clash has no alert of its own.
- Evidence: SUSPECTED, by reading (overlaps are per repo in the hub, the alert key is not).
- Suggested fix: key the alert by `repo|file` (lane.repo or lane.tree) and take `who` from that group.

## [low] Card and session totals drop other people's changes when checkouts share a branch name such as main
- Where: app/renderer.js:980-989 (diffStat), comment at 978-979.
- What happens: lanes are de-duplicated by `repo|branch` and only the largest is kept. That suits session branches (the pushed commits are shared) but not `main`/a folder the person picked: there each lane's numbers are only that person's own uncommitted work (diff against merge-base with main), so two people with different edits show only the larger one. The comment "Uncommitted changes" is also wrong: lane.js gitStatus counts committed-on-branch plus uncommitted changes.
- Evidence: CONFIRMED in node (two lanes on `o/r|main` with +50/-0 and +40/-5 show `+50 -0`, files 2; scratch/11/t1.js).
- Suggested fix: only de-duplicate when the branch is not the repo's main (or when both lanes share an upstream with no local changes); fix the comment.

## [low] Pin-to-file suggests files that the submit check then rejects
- Where: app/renderer.js:1336-1337 (suggestions) vs 1347-1357 (check).
- What happens: the datalist lists `changed` first, which is every lane's changed files in the session, including a teammate's new, unpushed file. On submit the note is checked against `sessionFiles()` (this Mac's checkout), so the same file is refused with "There's no src/new.ts in this repo". The message is wrong, since the file exists on the teammate's Mac. Choosing a suggested file fails.
- Evidence: SUSPECTED, by reading (`changed` comes from hubLanes, `known` from `proto.code.list(root)` of the local checkout).
- Suggested fix: accept paths found in `changed` as well as in `known`, or leave them out of the suggestions.

## [low] Notes written in a session with no GitHub repo become team-wide, and pinned ones match same-named files in every repo
- Where: app/renderer.js:1341 (`repo: roomRepo`), 1323 (`roomNotes`), 1330 (`m.repo ? 'Whole repo' : 'Every repo'`).
- What happens: for a folder session `roomRepo` is `''`, so the note is saved with no repo. The hub's `notesFor` (hub.js:137, `!m.repo || same(...)`) then gives it to every agent in every repo. A note pinned to `package.json` or `src/index.js` is delivered before each agent in any repo reads that path. The list shows only the file name for pinned notes, so nothing tells the writer.
- Evidence: SUSPECTED, by reading.
- Suggested fix: in a session with no repo, say "Applies to every repo" next to the form, or refuse a file pin without a repo.

## [low] Comment form has no double-submit guard, and clears the next session's draft
- Where: app/renderer.js:1168-1176.
- What happens: the text is cleared only after the request returns, and the submit button is not disabled (unlike the step and note forms). Pressing Enter twice, or Enter plus a click, within the round trip posts the comment twice. After the await it clears `#commentText` and the line reference of whatever session is open by then, not the one the comment was for.
- Evidence: SUSPECTED, by reading.
- Suggested fix: disable the form while the request runs, and clear only if `current` is unchanged.

## [low] Notifications fire in pane mode, and the click can open the wrong team's session
- Where: app/renderer.js:882 (suppression test) and 889 (onclick).
- What happens: the "already looking at it" test requires `view === 'session'`. In pane mode (`view === 'panes'`) the agent is on screen, but a system notification still fires for every needs-you or finished event. A notification's click runs `openSession(l.session, l.id)` against whichever team is open now. After a team switch, a same-named session in the new team opens (or the Sessions page shows if there is none), which is the wrong team's session.
- Evidence: SUSPECTED, by reading (`paneLaneIds()` is used by renderRoom for view 'panes').
- Suggested fix: also skip when the lane is in `paneLaneIds()`; capture `currentTeam.key` and ignore the click if it changed.

## [low] Wording and affordances that don't match what they do
- Where: app/renderer.js:1012 (card file rows), 1187 (agent card), 1227 (dock), 1208 (Ahead of main), 1139-1142 (fitReplay).
- What happens: (a) file rows on session cards carry `title="Open <file>"`, but the Sessions page has no `data-open-file` handler, so a click opens the session, not the file. (b) Agent cards have `role="button" tabindex="0"` but no key handler (only session cards have one), so Enter and Space on a focused agent card do nothing. (c) Clicking "Open <file>" on a teammate's card also sets `code.dock = 'agent'` because `closest('[data-focus]')` matches the card, so opening a file flips the Terminal dock back to the agent. (d) Environment says "Ahead of main" even when the repo's default branch is another name (lane.js compares with origin/HEAD). (e) The replay terminal's font floor is 8px and ignores the stage height, while teammates' terminals use 6px and fit both, and fitReplay does not rerun when the font-size preference changes.
- Evidence: SUSPECTED, by reading (c: the `closest` check is at line 1227, before the `data-theirs` check).
- Suggested fix: handle `data-open-file` on cards or drop the title; add Enter/Space to agent cards; test `[data-theirs]` first; word it "Ahead of the default branch".

## [low] WebGL: a failed or lost context is retried on every render, and some contexts are never released
- Where: app/renderer.js:1392-1400 (gpu), 1030-1035, 1125.
- What happens: (a) the comment says a lost context "falls back to the DOM renderer", but the next `render()` (every hub state message, every 30 s) calls `gpu(t, true)` again, so it is recreated; if WebGL2 can't be created, `loadAddon` throws after the addon was already registered, so each render adds another dead addon for each visible terminal. (b) renderRoom only toggles `gpu` for lanes of the current team; local terminals of another team are hidden (`t.el.hidden = true`) but keep their context until that team is opened again, against the browser's roughly 16-context limit. (c) `gpu({ term: replayTerm }, true)` is created once and never turned off.
- Evidence: SUSPECTED, by reading.
- Suggested fix: remember a failed attempt (`t.webglFailed`), turn gpu off for every hidden terminal in the first loop of renderRoom, and turn the replay terminal's off when the replay panel is hidden.

## [low] answerFile reads and sends up to 2 MB, but the hub only relays 1,000,000 characters
- Where: app/renderer.js:1317-1318; hub src/hub.js:25 and 594; app/files.js:7.
- What happens: `files.read` allows 2,000,000 bytes, the hub drops text over 1,000,000 characters and answers "too big". The app still sends the full text first, and JSON escaping can multiply it (quotes, newlines, control characters), toward the hub's 5 MB socket limit. The requester gets the right message; the cost is wasted upload on the owner's side.
- Evidence: SUSPECTED, by reading.
- Suggested fix: in answerFile, answer "too big" when `file.text.length > 1_000_000`.

## Outside my scope
- app/renderer.js:828 (agentLabel never numbers a second agent: `.indexOf(l)` is inside the comment) is already in section 10; it affects every label in this range (lane tag, roomWho, agent cards, replay rows).
- app/code.js:613 (the Terminal tab's shell) uses `gpu({ term }, true)` with a throwaway object like the replay terminal, so those contexts are never released either.
- app/renderer.js:1324 `renderMemory(lanes)` takes a parameter it never uses.

# Section 8: the code view's editor (app/code.js, all 698 lines)

## Covered
- State and helpers: `code`, `models`, `parked`, `base/dirOf/unbom/isDirty/unsavedFiles`, `replaceText` (fuzzed 200,000 random old/new strings with emoji and lone surrogates through a stubbed model: result always equals the new text, and the edit never splits a real surrogate pair).
- Monaco: `loadMonaco` (0.57.0 has the top-level `monaco.typescript`, so `setDiagnosticsOptions` is right), `editorTheme` (all colours are hex, so the `99` suffix is valid), the theme MutationObserver, `ensureEditor` (concurrent calls), editor and diff-editor options, commands (⌘S, ⌘K, ⇧⌘L, ⌘I, the ⇧⌘M comment action) against the menu accelerators in main.js and `runMenu`.
- `showCode`, `rootFor`, `sessionFiles`, `openRoot` (parking, restore, reload on return, state reset, Terminal follow, `code.session`), `refreshFiles` (list:false poll, `refreshFiles.last` dedupe, commit-note clearing), the `onChanged` watcher callback, the 3 s poll, `reload` (savedText vs disk, stale, deleted, BOM, force), `modelFor` (double open, binary / too big / not UTF-8 / gone notes).
- `openFile`, `rememberView`, `showActive` (line / endLine / match clamping, plain vs committed diff vs a teammate's copy, `compareNote`, `committedModel`), `closeFile`, `saveActive`.
- `renderCode`, `renderTabs` (unsaved count to main, scrollIntoView), `renderBanner`, `treeOf`, `treeRows`, `teammatesFiles`, `fileRow`, `conflictRows` (against the hub's `overlaps`, hub.js:139).
- Teammate files: `askFile` (against hub relayFile and its 10 s timeout), `fileAnswered`, `theirModel`, `openTheirs`, the 1.5 s poll and its `polling` guard.
- Line comments: `commentOn`, `blockAt`, `linesOf` (tested), `marks` and its key/debounce, `openComment`.
- Search (debounce, stale results, `snippet`), `goToFile`, `commit()`, `showShell` and the shell exit handler (against main.js `shell:*`), all click handlers, the dock grip drag (CSS clamps with `min(var(--dock), 100% - 220px)`, so small windows are fine), the saved dock height.
- Checked that every `$('#id')` in code.js exists in index.html (none missing).

## [medium] Settings font size / font / line height never reach the editor or the Terminal tab
- Where: app/code.js:80-83 (editor options set once), app/code.js:612 (shell created once), app/code.js:71 (the observer only handles theme); app/renderer.js:1450-1460 (`applyPrefs` loops only `terms`)
- What happens: the editor is created with `fontSize: prefs.fontSize + 0.5` and `fontFamily: terminalFont()`, and each Terminal-tab shell with `prefs.fontSize/lineHeight/fontFamily`. Changing "Terminal text size", "Terminal font" or line height afterwards updates only the agent terminals. The code view and any open Terminal tab keep the old size until the app restarts (the theme alone is applied live, line 71).
- Evidence: SUSPECTED (by reading; grep finds no `monaco`/`editor`/`shells` in renderer.js, and `applyPrefs` has no hook into code.js).
- Suggested fix: in `applyPrefs` (or a small `codeApplyPrefs()` in code.js) call `editor?.updateOptions({ fontSize, fontFamily })`, the same for `diffEditor`, and set `term.options.*` plus `fit.fit()` for each `shells` entry.

## [low] The Plan panel stays visible under the Terminal tab
- Where: app/code.js:304
- What happens: in shell mode `renderCode` hides `#lanes, #replayPanel, #ghPanel, #memoryPanel, #backBar` but not `#planPanel`. With the code open, click Plan in the session panel (`[data-tab]` sets `tab = 'plan'` and `code.dock = 'agent'`, renderer.js:1227/1238), then click the Terminal dock tab: `render()` leaves `#planPanel` visible and the shell is shown too, so both split the stage (`.shell` and `.gh-panel` are both `flex: 1`).
- Evidence: SUSPECTED (by reading the two lists and the CSS at index.html:416, 503).
- Suggested fix: add `'#planPanel'` to the hidden list (better: derive the list from one place so the next panel isn't forgotten).

## [low] `linesOf` can't find a block when the file shrank below the comment's old line
- Where: app/code.js:513-516
- What happens: the nearest-first search runs `d` from 0 to `count - 1` and tries `c.line - d` and `c.line + d`. If `c.line - count >= 1`, the lines `1 .. c.line - count` are never tried. A comment on line 100 whose text is now on line 20 of a 50-line file reports "lines changed, can't be found" (no marker, `openComment` shows the banner) although the text is there.
- Evidence: CONFIRMED (stubbed model, scratch/08/t.js: comment at 100 or 500, 50-line file, snippet on line 20 gives `null`; comment at line 60 gives line 20).
- Suggested fix: loop `d` up to `Math.max(count, c.line)`.

## [low] A failed `read` in `openFile` leaves a ghost tab and shows nothing
- Where: app/code.js:210-221, 193-195
- What happens: `openFile` pushes the tab and sets `code.active` before `await modelFor(path)`. `proto.code.read` throws (it isn't `{gone}`) for a tracked symlink that points outside the folder ("That file is outside the session folder.") and for any other fs error such as EACCES. The rejection is unhandled, `render()`/`showActive()` never run, so the editor still shows the previous file while the new tab is active and the Welcome text is hidden; nothing tells the user why.
- Evidence: CONFIRMED for the throw (scratch/08/w.js: `files.read` on a symlink to a file outside the folder throws); the tab state is by reading.
- Suggested fix: wrap `modelFor` in try/catch, store `{ note: errorText(e) }` as the entry so the banner explains it.

## [low] Saving a "deleted" file whose folder is gone fails with a raw error
- Where: app/code.js:180, 286-289 (with files.js `write`)
- What happens: the banner says "This file has been deleted. Saving puts it back." (e.g. an agent removed the folder, or a branch switch did). `files.write` -> `inside(..., {exists:false})` calls `realpathSync(dirname)`, which throws ENOENT when the parent folder is gone too. The user gets an alert like `ENOENT: no such file or directory, lstat '/…/gone-dir'` and the edits stay unsaved.
- Evidence: CONFIRMED (scratch/08/w.js: `files.write(dir, 'gone-dir/x.txt', 'hi')` throws that message).
- Suggested fix: `mkdirSync(dirname, { recursive: true })` inside the folder check in `write` (or change the banner text when the parent is missing).

## [low] `reload` misreports and hides some disk states
- Where: app/code.js:179-186
- What happens: (1) `.catch(() => ({ gone: true }))` turns every read error (EACCES, outside-folder, IPC failure) into "This file has been deleted". (2) If the file on disk becomes binary, too big or not UTF-8, `file.text == null && !file.gone` keeps `entry.note` as it was: the old text stays on screen as if current, no banner, and the next edit plus ⌘S overwrites the new content without the "changed on disk" confirm. (3) `entry.stale` is not cleared when the disk goes back to `savedText` (the early return at 185), so the banner "changed on disk" stays although nothing differs. (4) The early return when disk text equals the buffer also skips updating `bom`, so a BOM added or removed on disk is not followed on the next save.
- Evidence: SUSPECTED (by reading).
- Suggested fix: use `file.gone` / `file.binary|tooBig|notUtf8` to set a note (and `stale` when dirty) per case, clear `stale` when `file.text === entry.savedText`, update `bom` before the early returns.

## [low] `showActive` doesn't re-check what is active after its awaits
- Where: app/code.js:228-244
- What happens: `showActive` awaits `theirModel` (up to 12 s when the teammate's app doesn't answer) and `proto.code.committed`, then writes to the diff editor and hides the plain editor, using the `entry`/`code.active` it read before. Click "Compare with Anna's", then open another file within the wait: when the answer or timeout arrives, the diff of the first file replaces the second file's view while the second tab is highlighted, and `code.against = null` (line 237) is cleared on the new active file's state. Two quick `showActive` calls (diff of A, then B) can also finish out of order and show A's diff under B.
- Evidence: SUSPECTED (by reading).
- Suggested fix: after each await, `if (code.active !== path || code.diff !== path) return;` (capture `path` at the top), and clear `code.against` only when it still belongs to that path.

## [low] "Compare with" in Conflicts lists teammates from other repos
- Where: app/code.js:477
- What happens: `others` is every non-local lane whose `overlaps` contains the path, in any repo or session. The hub computes `overlaps` per repo (hub.js:141), so two teammates in another repo who both changed `package.json` (or README.md) each have it in `overlaps`; if you also overlap on `package.json` in this repo, the Conflicts row offers "Compare with X's" for them, and Compare asks for a file from a different repo.
- Evidence: SUSPECTED (by reading code.js against hub.js:139-141).
- Suggested fix: filter `others` with the same repo test as `teammatesFiles` (`roomRepo ? same(o.repo || '', roomRepo) : o.session === current`).

## [low] Two sessions with no folder on this Mac share tabs, models and `code.session`
- Where: app/code.js:121-123
- What happens: `openRoot` returns early when `root === code.root`; with both roots `null` it never resets. View a teammate's file (`openTheirs`, which works without a folder) in session A, go to session B (no folder either) and open the code: A's `theirs:` tabs and `models` are still there (and `code.active` may point at A's file, so B shows it). `code.session` also stays A's, so renderer.js:1158 (`linesNow`) stops mapping comment lines.
- Evidence: SUSPECTED (by reading `openSession` renderer.js:737, which only clears `code.on`).
- Suggested fix: compare `session` as well: `if (root === code.root && code.session === current) return;` (keeping the shared-folder case cheap), or reset open/active/models when only the session changed.

## [low] A commit's result lands in whichever session is open when it finishes
- Where: app/code.js:582-593
- What happens: `commit()` can run for up to 15 minutes (push). If you switch sessions meanwhile, `note.textContent = await …` writes "Committed and pushed." into the other session's note, the `committing` flag keeps the other session's Commit button disabled, and the `finally` block runs `refreshFiles()` plus `code.diff = null; showActive()` for the other session's state. After your own commit `code.diff` is also cleared for a diff against a teammate's copy (line 592), although that comparison doesn't depend on the commit.
- Evidence: SUSPECTED (by reading).
- Suggested fix: capture `root`/`session` at the start; in `finally` update the note and diff only if `code.root === root`; reset `code.diff` only when `!code.against`.

## [low] Commit & Push can commit files that are still conflicted
- Where: app/code.js:574-581
- What happens: `commit()` only refuses while `code.underWay` is set. A conflicted state without MERGE_HEAD or a rebase (for example `git stash pop`, `git checkout -m`, `git apply --3way`) shows files as `C` in the Explorer, but Commit & Push calls `git add -A`, which marks them resolved and commits the markers.
- Evidence: SUSPECTED (by reading code.js with files.js status / commitAndPush).
- Suggested fix: refuse (with a note) when any `code.changes` state is `C`.

## [low] Terminal tab edge cases
- Where: app/code.js:602-635
- What happens: (1) When the session has no folder, `showShell` returns after hiding the others, so the dock shows an empty pane with no text. (2) `proto.shell.onExit` flips the dock to Agent whenever `code.dock === 'terminal'`, even if the shell that exited belongs to another root running in the background. (3) Each shell calls `gpu({ term }, true)` on a throw-away object, so it keeps its own WebGL context for as long as it lives, hidden or not; renderer.js:1389 says only terminals on screen get one, and the browser's ~16 context limit can then take a context away from an agent terminal.
- Evidence: SUSPECTED (by reading).
- Suggested fix: show a one-line message when there's no folder; on exit, flip only if the exited shell's root is `code.root`; turn WebGL off for hidden shells.

## [low] Teammate-copy models: unusual URIs and orphaned entries
- Where: app/code.js:420-441, 437
- What happens: (1) The URI is `monaco.Uri.parse(`theirs://${lane}/${path}`)`; `#` and `?` in a path become fragment/query (wrong language mode), `%41` decodes. `Uri.from({ scheme, authority, path })` avoids that. (2) `theirModel` captures its `entry` before the (up to 12 s) wait. If the tab is closed (`closeFile` deletes the entry) or the session is switched (`models.clear()`) during that wait and the answer then carries text, `entry.model = createModel(…, theirs://lane/path)` is made for an entry that is no longer in `models`; re-opening that teammate file later calls `createModel` with a URI Monaco already holds, which throws "Cannot add model because it already exists". If the entry already had a model, `closeFile` disposed it without nulling `entry.model`, so the late answer throws "Model is disposed" in the poll instead.
- Evidence: SUSPECTED (by reading; Monaco's duplicate-URI error is from memory).
- Suggested fix: after the await, `if (models.get(key) !== entry) return entry;` and null `entry.model` in `closeFile`.

## [low] Diff views: stale original after a commit by an agent, and deleted files show nothing
- Where: app/code.js:228-244, 210
- What happens: (1) The committed version is read once in `showActive`. When an agent (not the Commit button) commits, the Changes list drops the file but an open diff of it keeps showing the old original. (2) Clicking a deleted (`D`) file in Changes opens it with `diff: true`, but `modelFor` finds it gone and creates no model, so the editor is empty with only "This file has been deleted."; you can't see what was deleted although `proto.code.committed` could supply it.
- Evidence: SUSPECTED (by reading).
- Suggested fix: re-run `showActive()` in `refreshFiles` when `unpushed`/`changes` for the diffed path changed; for a gone file in diff mode, show the committed text as a read-only model.

## [low] The file watcher keeps refreshing and re-rendering while the code view is hidden
- Where: app/code.js:169-174
- What happens: `onChanged` runs `reload` and a debounced `refreshFiles()` (a full `git ls-files`, `git status` and a whole-app `render()`) whenever `root === code.root`, although the status poll is gated on `code.on`/`view === 'session'`. `code.root` stays set after you leave the session, so a busy agent in an old session causes that work about every 0.4 s from anywhere in the app.
- Evidence: SUSPECTED (by reading).
- Suggested fix: in the callback, return early unless `code.on && view === 'session'` (refresh on the next `showCode`), or call `refreshFiles({ list: false })` when no path was added or removed.

## [low] A file that only exists in a teammate's checkout says "This file has been deleted."
- Where: app/code.js:197-199 (note), renderer.js:1012 (the panel's edited-files list)
- What happens: the session panel's "Edited files" list includes teammates' files and `data-open-file` calls `openFile(path)` on your own checkout. For a file a teammate's agent just created, `read` returns `{gone}` and the tab says "deleted", although it never existed here.
- Evidence: SUSPECTED (by reading).
- Suggested fix: word the note as "This file isn't in your folder" when the path isn't in `code.files` and isn't tracked (or open it with `openTheirs` when a teammate's lane has it).

## [low] Errors are swallowed or unhandled in several async paths
- Where: app/code.js:49-56, 99-106, 139-140, 173, 549, 648
- What happens: (1) `loadMonaco` caches a rejected promise forever; `showCode` has already set `code.on = true`, so every later open fails the same way with an unhandled rejection. (2) The Changes activity tab calls `refreshFiles()` with no folder: `proto.code.status(null)` rejects ("That folder isn't open here") unhandled. (3) The `setTimeout(refreshFiles, 250)` and `proto.code.watch(root)` calls have no catch; if `list` rejects in `openRoot`, the watcher is never started and the folder looks empty. (4) Search turns any failure into `[]`, which prints "Nothing found." even when git grep failed.
- Evidence: SUSPECTED (by reading).
- Suggested fix: catch at those call sites; reset `monacoReady = null` on reject; show the error text in `#codeHits`.

## [low] Unsaved edits parked for a session you can't return to keep the quit warning on
- Where: app/code.js:34, 127
- What happens: `parked` is only emptied by re-entering that folder. If the session is removed or the folder is gone, `unsavedFiles()` keeps counting those files, and the quit dialog says "unsaved changes are lost" with no way to clear it.
- Evidence: SUSPECTED (by reading).
- Suggested fix: drop `parked` entries whose root `rootFor` no longer resolves, or list them in the dialog.

## Outside my scope
- src/lane.js:77-79: `changed`/`local` come from `git diff --name-only` and `ls-files --full-name`, which are relative to the repo root. files.js strips the session folder's prefix, so for a session folder that is a subfolder of its repo the hub's `files`/`overlaps` paths don't match `code.files` and the Explorer never marks teammates' files there (SUSPECTED).
- The editor reads files up to 2,000,000 bytes (files.js MAX_BYTES), but the hub drops teammates' files over 1,000,000 characters with "too big to share" (hub.js:25, 594); consistent, but the two limits differ.

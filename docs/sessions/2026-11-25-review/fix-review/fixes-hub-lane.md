# Fixes review: hub/lane/opencode plugin

## 1. medium: `send` now terminates a window that is merely receiving one burst of screen replays (src/hub.js:104, callers 1091/1108)
- `send` checks `bufferedAmount > MAX_BUFFERED` before each message. The `look` handler (and the no-`sees` connect path) calls `send` in a synchronous loop, one `out` per lane with up to 512K chars of history each. Nothing drains between iterations, so bufferedAmount is the sum of the whole burst minus the kernel buffer, regardless of how fast the client reads. Past 16 MB the socket is terminated (1006) and every queued byte is dropped: the window got none of the screens.
- Repro: work2/fixes-hub-lane/probe2.js. 20 lanes in one session with ~506K-char escape-heavy histories, a normal (reading) watcher sends `look` -> `WATCHER CLOSED code 1006 after outs 0`; peak server bufferedAmount 17.3 MB. 16 lanes: open, peak 16.2 MB.
- Failure: a team with ~15-25 busy agents across the (up to 8) sessions a window shows. The window reconnects, sends the same `look`, gets terminated again: a reconnect loop, terminals never fill, and the hub serialises ~20 MB per round. Before the fix these went through.
- Fix: don't apply the drop to sends within one burst, e.g. check the threshold once before the replay loop (or only in toTeam/live output), or skip the replay for remaining lanes when over the limit instead of terminating.

## 2. medium (heuristic): the new redirect forms are skipped once quoted, and an alias set for later bypasses the push check (src/hub.js:466-470)
- `wordsOf` strips quotes only at a word's ends, so `GIT_CONFIG_KEY_0="remote.origin.push"` becomes `GIT_CONFIG_KEY_0="remote.origin.push`; `setting()` slices after `=` and gets `"remote.origin.push`, which `PUSH_CONFIG` (anchored `^remote\.`) misses. Same for `--config-env="remote.origin.push=T"`.
- `git config alias.ship "push --force origin HEAD:main" && git ship`: the inline `-c alias.…push` case asks, but the same alias set with `git config` doesn't (PUSH_CONFIG has no alias.*), and `git ship` isn't read as a push. Force-push to main, no ask.
- Repro: work2/fixes-hub-lane/push.js (hub on 127.0.0.1, lane on session/fix, team with a member): `none` for the quoted KEY_0 form, the quoted --config-env form, the alias form; also `url.*.pushInsteadOf` (the pushurl equivalent the test treats as a redirect), `remote.pushDefault`, `GIT_CONFIG_PARAMETERS`. Unquoted KEY_0 -> `ask`.
- Fix: strip quotes inside `setting()`'s result (`.replace(/["']/g, '')`) before testing; add `alias\..+` whose value contains push, and `url\..+\.(pushinsteadof|insteadof)`, `remote\.pushdefault`, `branch\..+\.pushremote` to PUSH_CONFIG; check `GIT_CONFIG_PARAMETERS=` words for a PUSH_CONFIG key. Add the quoted forms to hub.test.js.

## 3. low: the move 409's advice ("Rename this one, then move it again") can't work, and moving a session back is now impossible (src/hub.js:857-858, app/renderer.js moveSession)
- moveSession sends `name: key` (the session's first slug, kept across renames so folder and branch don't move). Renaming either session keeps its `key`, and hub `findSession` matches `keyOf(x) === slug(name)` and aliases, so after any rename the same 409 comes back. The only way out is deleting the other record.
- Move back: Move "fix-login" Just me -> Team X leaves a done "fix-login" in Just me. Moving it back from Team X -> 409 (it's the same session's own old record). Before the fix this joined that record, which here was the right thing.
- Fix: in the hub, let a move join a record that is the same session (e.g. done and created by the mover with the same key), or have the renderer offer "Reopen the one there" on 409; word the error without "rename" (or allow passing a new key).

## 4. low: `quarantined` adds a synchronous git spawn to the poll path, in Electron's main process, and the landed check doubles merge-trees per commit (src/lane.js:128, 163)
- `quarantined` calls the sync `git()` (execFileSync) for `rev-parse --git-path objects` on every mergeTree/mergedTree. lane.js runs inside the app's main process, so each call blocks the UI thread for a git spawn (under 10 ms each, measured). branchConflicts recomputes whenever HEAD moves: per own commit, up to 10 branches x (mergedTree + mergeTree) = up to 20 sync spawns, plus mkdtemp/rm each, per agent. `mergedTree(main, at)` and `main^{tree}` don't depend on HEAD but are recomputed with it.
- Fix: cache the objects path per cwd (it never changes) or get it with the async `line`; cache `landed` by `${at}\n${mainAt}`.

## 5. low: OpenCode subagents now get no team context (src/opencode-plugin.mjs:33)
- `chat.message` returns early for child sessions, so a subagent's requests never get UserPromptSubmit's additionalContext (session goal, plan, other agents and their files, behind warning). A `general` subagent that edits files works without knowing a teammate is on them; only the once-refused PreToolUse remains. Before, children got it (with a wrong "last prompt").
- Its `context` entry is also never reset (the `context.delete` is skipped), so file notes from its tool calls accumulate for the child's whole life rather than per turn.
- Fix: for children, still post UserPromptSubmit for the context but mark it (e.g. `subagent: true`) so the hub doesn't take it as the person's prompt/status; or copy the parent's current context into the child.

Checked and sound: worktree + --shared clone (objects via alternates, recursive) with the quarantine (work2/fixes-hub-lane/alt): conflicts found, no loose objects added, temp dir removed; send on lanes/file relay can not throw; CLIENT_ID export/test; claimsOn 3-then-rest; move flag passes through main.js/teams.js.

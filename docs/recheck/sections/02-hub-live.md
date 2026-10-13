# Section 2: hub live side (src/hub.js lanes, watchers, file relay, overlaps, hooks, push guard, shellWriteRisk; src/shared.js; test/hub.test.js)

## Covered
- onLane: hello validation (id, hookSecret length, session, other login's id, existing id), reconnect and terminate of the old socket, re-registered ids (same team, other team, teammate takeover), terminal size clamps (hello and `size` message), scrollback slice and reset-prefixed replay, `out`, `git` (stats, changed/local caps, files filter), `status`, close handler and `stopped` list (MAX_STOPPED 20, replay, removed on reconnect, other team's replay refused)
- onWatcher: presence and `look`, first-message state plus history replay, `replay` of a stopped agent, `in` only for open lanes of the team, typedBy/typedAt and its 5 s quiet rule, own-agent typing not noted, slow-viewer drop (16 MB buffer; ran a paused viewer)
- relayFile: who may answer, owners' window count (error then text, both error, window closed), 10 s timeout, empty and over-limit text, other team's lane id, object path
- views/overlaps/touchedBy/othersOn: same folder, same branch (pushed vs local), different branches, case-insensitive repo, no repo, no branch; MAX_CONTEXT_FILES cap (15 + "and N more"); inSameRepo
- onHook: UserPromptSubmit (context, prompt capture), PreToolUse (Bash guards, edit asks, notes), PostToolUse, PermissionRequest, Stop, Notification/SessionEnd (ignored), malformed inputs; hook route secret check and unknown lane (401)
- Push guard (pushRisk, pushRiskOf, commandsIn, wordsOf, subcommandAt): corpus of ~100 ordinary commands that must ask or must not ask, plus heredocs, comments, `bash -lc`, wrappers, empty member list (solo team never asks)
- shellWriteRisk: ~65-command corpus (2>&1, > /dev/null, rm -rf dir, sed --in-place, prettier --write, cp, tee, mv, redirects), 4,000-quote command timing
- src/shared.js: appendScrollback, EDIT_TOOLS, slug (20 inputs)
- test/hub.test.js: every test read against its name; coverage gaps listed in the last finding
- Broadcast cost (views/overlaps with 20 lanes x 200 files), early-message queue during verification

## Findings

## [high] Any WebSocket client can crash the whole hub (no 'error' handler on the sockets)
- Where: src/hub.js:650-661 (WebSocketServer maxPayload, `wss.handleUpgrade` callback), 624-648 (authenticate), 544/603 (lane/watcher listeners): no `ws.on('error')` anywhere. (src/lane.js:157 has one on the client side.)
- What happens: `ws` emits 'error' on the socket for a frame over `maxPayload` (5 MB), an invalid frame, a bad opcode, invalid UTF-8 and similar. With no listener, Node throws "Unhandled 'error' event" and the hub process exits. It needs no sign-in: connecting to /lane or /watch and sending one 6 MB frame is enough. All teams on the hub lose their live view until it is restarted (agents reconnect every 30 s, but anyone can repeat it). It can also happen by accident: a file shared through file:put whose JSON form exceeds 5 MB (a 1,000,000-character file full of control characters is 6 MB after escaping, although it passes the MAX_SHARED_FILE check).
- Evidence: CONFIRMED. Ran a hub in a child process, connected unauthenticated to /lane and sent a 6 MB frame: the child exited with code 1, "RangeError: Max payload size exceeded ... Unhandled 'error' event" (scratch/2/crash.js).
- Suggested fix: in the handleUpgrade callback add `ws.on('error', () => {})` (the close event still follows), before authenticate().

## [medium] Push guard misses pushes wrapped in `bash -lc`, `zsh -ic`, `sh -ec` and other combined flags
- Where: src/hub.js:200 (`runs`: `/(^|\s)(-c|eval)\s*$/`)
- What happens: the quoted command after a shell is only read when the word before it is exactly `-c`. `bash -lc "git push -f"`, `bash -lc 'git push origin main'`, `zsh -ic "git push -f"`, `sh -ec "git push -f"` and `bash -xc "git push -f"` are not asked about, while the same with `bash -c` is. `bash -lc` (login shell) is a common way for agents to run a command line, so the force-push / push-to-main guard silently doesn't apply to it.
- Evidence: CONFIRMED. Corpus run (scratch/2/push.js) against a team with a member: all five were answered with no "ask"; `bash -c "git push -f"`, `eval`, `ssh host git push -f` were asked.
- Suggested fix: match any short-flag cluster that ends in c: `/(^|\s)(-\w*c|eval)\s*$/`.

## [low] Push guard asks about text that only mentions a push: multi-line commit/PR messages, heredocs, comments, `;` or `&` inside a message
- Where: src/hub.js:197-205 (`commandsIn` splits the whole text on `|;&` and newlines, including inside quotes, and doesn't strip `#` comments), 206 (`wordsOf`)
- What happens: when a line of a quoted string or heredoc contains `git push --force` / `git push origin main`, or a quoted message has `;`, `&` or a newline after the words, each piece is read as its own command and the push check asks. Examples that wrongly ask: `git commit -m "$(cat <<'EOF' ... Never run git push --force on main. EOF)"`, `git commit -m "feat: x\n\nRun git push origin main manually"`, `git commit -m "wip; git push -f is bad"`, `cat <<EOF > notes.md\ngit push origin main\nEOF`, `echo done # git push -f`, `# do not git push --force here` as a comment line before other commands. A person is asked to confirm a harmless command (the existing test only covers the one-line quoted case).
- Evidence: CONFIRMED (scratch/2/push.js, each of these returned permissionDecision 'ask' on a branch that isn't protected). Everything else in a ~120-command corpus (plain pushes on a session branch, --tags, --dry-run, -o, stash push, grep/log/echo mentions, pull/fetch/rebase, gh pr, remote set-url, other lookalikes) was classified correctly, and all ~45 pushes that must ask did, except the `-lc` family above.
- Suggested fix: cut `#` comments to end of line and treat a heredoc body (lines after `<<WORD` up to WORD) as data; for the split, ignore separators that fall inside quotes.

## [medium] shellWriteRisk calls read-only commands "writes": any `2>&1`, `2>/dev/null`, `> /dev/null` or `cp` makes every file path in the command count as written
- Where: src/hub.js:255-267 (the first test `/>|\b(tee|mv|rm|cp|truncate)\b/` only decides whether to scan; the scan then treats every path-like word in the command as a file being written)
- What happens: a teammate changed `src/a.js`. Then `node src/a.js 2>&1 | tail`, `grep -n foo src/a.js 2>&1`, `git diff src/a.js 2>/dev/null`, `git log -p -- src/a.js 2>&1 | head`, `npm test -- src/a.js 2>&1`, `head -20 src/a.js 2>&1`, `cat src/a.js > /dev/null`, `rg foo src/a.js 2>/dev/null`, `cp src/a.js /tmp/a.js` (source of a copy), `diff src/a.js other.js > /tmp/d.patch` all stop for a confirmation saying "<teammate> already edited src/a.js, and this command changes it". Agents append `2>&1` / `2>/dev/null` to most commands, so on any file a teammate touched, reading it through the shell asks every time, and the text is untrue. People will learn to click through, which weakens the real warnings.
- Evidence: CONFIRMED (scratch/2/shell.js, ~35 read-only commands; 18 wrongly asked). Same cause: `perl -MList::Util=sum ...` is taken as in-place (`\s-[a-zA-Z]*i` matches `-MList`).
- Suggested fix: only count a word as written when it follows a redirect `>`/`>>`/`tee` (ignoring `/dev/*` and `&N`), or is an argument of mv/rm/truncate (and the last one of cp/mv); don't scan every word.

## [medium] shellWriteRisk doesn't see `rm -rf <directory>` that contains a teammate's changed files
- Where: src/hub.js:259-264 (a directory is compared as a file name: `othersOn(lane, 'src')` looks for an exact entry named `src`)
- What happens: a teammate changed `src/components/Button.js`; `rm -rf src`, `rm -rf src/`, `rm -rf src/components`, `rm -rf ./src/components/` pass with no question. `rm -rf dir` is the most destructive shell command in the list the comment promises to catch ("sed -i, a redirect, tee, mv, rm and the like"), and `rm -rf build`-style words with no `/` or extension aren't even looked at.
- Evidence: CONFIRMED (scratch/2/shell.js: all four returned no decision; `rm src/a.js` did ask).
- Suggested fix: for a path that is a directory prefix (`f.startsWith(rel + '/')`) of a teammate file, count it for rm/mv; also look at path words with no slash for rm/mv.

## [low] shellWriteRisk misses writes that don't use `>`, rm/mv/cp/tee/truncate or `sed -i`: `sed --in-place`, formatters, `curl -o`
- Where: src/hub.js:256-257 (`writes` needs `\s-[a-zA-Z]*i`, which `--in-place` never matches; the early return skips every other command)
- What happens: `sed --in-place s/a/b/ src/a.js`, `sed --in-place=.bak ...`, `prettier --write src/a.js`, `eslint --fix src/a.js`, `gofmt -w src/a.js`, `curl -o src/a.js ...`, `dd of=src/a.js`, `ln -sf x src/a.js`, `install x src/a.js` on a teammate's changed file are not asked about, although the file is named in the command (so not the "script that writes files it doesn't name" case the ponytail comment excludes). `prettier --write` / `eslint --fix` on a teammate's file is a very plausible agent action and a classic source of merge conflicts.
- Evidence: CONFIRMED (scratch/2/shell.js: none asked; `sed -i`, `perl -pi`, `tee`, `mv`, `echo > f` did).
- Suggested fix: add `--in-place` to the sed test, and a short list of write flags (`--write`, `--fix`, `-w`, `-o`/`--output`) to the same early test.

## [low] Push guard uses the lane's last-reported branch, so `git checkout main && git push` isn't asked about
- Where: src/hub.js:243 (`t === 'HEAD' ? lane.branch : t`; a push with no refspec means "the branch the lane last reported")
- What happens: `git checkout main && git push`, `git switch main && git merge session/fix && git push origin HEAD` run from a lane that reported branch `session/fix` are answered with no question, although they push straight to main. This is the usual one-line "merge and ship" for an agent working in a normal checkout (in a session worktree `git checkout main` is refused while main is checked out elsewhere, so there it is mostly moot).
- Evidence: CONFIRMED (scratch/2/misc.js: three variants, none asked).
- Suggested fix: when the same command contains `git checkout|switch <protected branch>` before the push, treat HEAD as that branch.

## [low] A reconnecting agent loses its status, latest prompt, hook-reported edits and "typed by" note
- Where: src/hub.js:528-532 (the new lane object starts from the hello only: `status` idle/running, `files: new Set()`, no `prompt`, `typedBy`)
- What happens: after a network blip an agent that is mid-task shows "idle" with no prompt until its next hook event, and the edits Claude reported through hooks (which only the same-checkout rule uses, see `touchedBy`) are forgotten. Only `startedAt` is carried over from the old lane.
- Evidence: CONFIRMED (scratch/2/lanes.js: working / "do the thing" / ["a.js"] became idle / "" / [] after a second hello with the same id).
- Suggested fix: copy `status`, `prompt`, `files`, `typedBy`, `typedAt` from `existing` (and from the stopped entry if the old socket was already seen closing).

## [low] Files outside the checkout are recorded as `../../...` "changed files" and shown to teammates' agents
- Where: src/hub.js:272-274, 303 (`rel = path.relative(root, full)` isn't checked for `..`; PostToolUse adds it to `lane.files`)
- What happens: Claude writes plan and memory files under `~/.claude/...` with the Write tool. The hub records `../../home/.claude/plans/p.md` as a file the agent changed; it appears in the agent's `files`, in teammates' prompt context ("has changed: ../../..."), and PreToolUse can "ask" a teammate whose lane has the same relative path (two people at the same folder depth editing `~/.zshrc` or `~/.claude/CLAUDE.md`). It disappears at the next git report.
- Evidence: CONFIRMED (scratch/2/lanes.js: `files` was ["../../home/.claude/plans/p.md"] after a Write to /home/.claude/plans/p.md).
- Suggested fix: ignore `rel` that starts with `..` (or is absolute) for `files`, `othersOn` and `notesFor`.

## [low] File relay: an error answer waits for windows that have closed or gone stale, and the real error is replaced by "didn't answer" after 10 s
- Where: src/hub.js:583-587 (`waiting: owners.length`), 592; 586 (timer is neither cleared nor unref'd)
- What happens: `waiting` is the number of the owner's windows when the request was made. If one of them closes, or is a half-open socket the heartbeat hasn't dropped yet (up to ~30 s), it never answers, so another window's answer "that file isn't shared / hasn't changed" is held until the 10 s timeout and the requester sees "<name>'s app didn't answer." instead. The 10 s timer also isn't cleared when the request is answered, so it keeps `ws` alive and delays process exit after `hub.close()` (observed: the process stayed up ~7 s after close).
- Evidence: CONFIRMED (scratch/2/relay.js: owner with two windows, one closes, the other answers with an error: requester told after 9,903 ms with the timeout text). Also confirmed: the first-window-error then second-window-text case works, empty and over-limit files are handled, a teammate can't answer.
- Suggested fix: count only windows still open at answer time (or send the first error after a short grace period), and `clearTimeout` when the ask is answered.

## [low] File relay answers for another team's agent with its owner's name
- Where: src/hub.js:584
- What happens: `file:get` with the id of a lane in a different team gives `"<name>'s app isn't open."`, which confirms the id exists and names its owner. Needs the lane's UUID, so it is a small information leak.
- Evidence: CONFIRMED (scratch/2/relay.js case 5).
- Suggested fix: treat a lane of another team like a missing one ("That agent has stopped.").

## [low] A teammate can take over a dropped agent's id, and the real agent is then refused with "Bad hello."
- Where: src/hub.js:522-525 (the only identity check is against a lane currently in `lanes`)
- What happens: ids appear in every teammate's state. While an agent's connection is down (Wi-Fi gap, hub restart) its id is free. A teammate can send a hello with that id and their own hookSecret; the owner's agent then gets close code 4000 "Bad hello." on every retry until the intruder disconnects, and the intruder also clears the agent's "stopped" entry. Teammates are invited, so this is low, but the failure message doesn't say why.
- Evidence: CONFIRMED (scratch/2/lanes.js: after the owner's socket was terminated, bob's hello for the same id was accepted (lane login became bob) and alice's reconnect was closed 4000).
- Suggested fix: remember the owner of recently stopped ids (the `stopped` entries already hold `login`) and refuse a different login for them.

## [low] Messages arriving while a lane/watcher is being verified are cut at 100 without notice
- Where: src/hub.js:629 (`early.length < 100 && early.push(raw)`)
- What happens: terminal output frames sent right after the hello are queued while GitHub is asked who the token is (up to 8 s on a cache miss; a burst arriving in one TCP read hits it even with a cached identity). Past 100 frames the rest are dropped silently, so teammates' copy of the screen (and the scrollback kept for late joiners) has holes. Lane output isn't resent (the lane sets `unsent = ''` on connect).
- Evidence: CONFIRMED for the mechanism (scratch/2/early.js: 300 `out` frames sent straight after a hello, 100 reached the watcher). SUSPECTED that it happens on a real busy agent after a reconnect with a slow GitHub answer.
- Suggested fix: don't count `out` frames against the cap (it is bounded by maxPayload anyway), or close the connection instead of dropping silently.

## [low] Two checkouts with the same login and path count as one folder
- Where: src/hub.js:533 (`tree = hash(login + root)`)
- What happens: one person running the same session on two Macs gets the same root path (the app builds the same folder names), so the hub treats them as one checkout: no overlap between them and no "ask" for edits the other machine made, although they are different clones that can conflict.
- Evidence: SUSPECTED (confirmed that lanes with the same login and root never overlap, scratch/2/lanes2.js "same folder overlaps [] []"; the two-Macs case follows from reading).
- Suggested fix: add something per machine to the hash (hostname or a per-app-run id sent in the hello).

## [low] Every size/git/status message broadcasts the full state, even when nothing changed
- Where: src/hub.js:549-552 (`size` always calls `broadcastState`), 160-164
- What happens: 30 identical `size` messages produce 30 broadcasts. A broadcast with 20 agents and 200 changed files each is ~270 KB per watcher and took ~30 ms of hub CPU (the overlap calculation builds new Sets for every file and lane pair), so a window being dragged keeps the hub busy and sends megabytes to every teammate.
- Evidence: CONFIRMED (scratch/2/perf.js: 30 unchanged size messages gave 30 state messages; 20 lanes x 200 files: 33 ms and 268 KB per state).
- Suggested fix: skip the broadcast when cols/rows are unchanged; coalesce broadcasts to at most a few per second; compute `touchedBy` sets once per lane per broadcast.

## [low] hub.js header comment is wrong: the hub does see code
- Where: src/hub.js:1-2 ("It never runs agents or sees code.")
- What happens: the hub relays every agent's terminal output and 256-512 KB of scrollback, the latest prompt (300 chars, shown to the whole team), and file contents the owner's app passes through for viewing. Anyone reading the comment (or the README) to decide whether the hub can be hosted by a third party gets the wrong picture.
- Evidence: SUSPECTED (by reading; behaviour confirmed in scratch/2/lanes.js: scrollback and replay).
- Suggested fix: reword to "It never runs agents or keeps files; it does relay their terminal output."

## [low] test/hub.test.js: three test names claim more than they check, and large parts of the live side have no test
- Where: test/hub.test.js:445-454, 497-513, 534-546, and gaps
- What happens:
  - 'agents without hooks report working and idle themselves' sends `status: 'hacked'` at the end but never asserts it was ignored (the lane is closed right after), so that line proves nothing.
  - 'a session can be renamed while nothing runs in it, keeping its branch name': the test renames s1 while agents run in it ("renamed with agents running in it"), the opposite of the name.
  - 'members can leave, and the owner deletes a team once its agents have stopped': only an empty spare team is ever deleted; no team whose agents have stopped is deleted.
  - 'overlap ... shell' cases use only `cat store.ts` etc. with no `>`/`2>&1`, so the false alarm in shellWriteRisk isn't caught; no test for `bash -lc`, `rm -rf dir`, `sed --in-place`, heredocs/comments in the push guard.
  - Not tested at all: hello validation (bad id, short secret, blank session), size clamps, reconnect with the same id, reset-prefixed replay, MAX_STOPPED, slow-viewer drop (MAX_BUFFERED), file relay timeout and multi-window answers, PermissionRequest/Stop statuses, the 15-file context cap, same-branch/different-branch/case-insensitive repo overlaps (only same-folder, same-branch and different-checkout-same-repo are).
- Evidence: CONFIRMED by reading the tests against scratch/2 results; the behaviours in the "not tested" list all work as intended when run (scratch/2/lanes.js, lanes2.js, relay.js).
- Suggested fix: rename the two tests; assert the status stays as before after 'hacked'; add the missing cases above (the scratch scripts can be turned into tests).

## [low] shared.js slug: emoji-only names differ with and without a variation selector
- Where: src/shared.js:21-22
- What happens: variation selectors are stripped to make the slug stable, but the fallback code hashes the raw name, so "😀" and "😀️" become `session-6k6d` and `session-61w0k`: two sessions where the comment says same slug means same session. Also `İstanbul` lowercases to a decomposed `i̇stanbul` (normalised before lowercasing), so it differs from a name typed with plain `i`. Names like `x.lock` and `x` map to the same slug (intended).
- Evidence: CONFIRMED (scratch/2/misc.js).
- Suggested fix: hash the stripped, NFC-normalised, lowercased name; normalise after lowercasing.

## Outside my scope
- src/hub.js:628-629, 650: before sign-in a WebSocket can queue up to 100 frames of up to 5 MB (maxPayload = MAX_HOOK_BODY) while a slow token lookup runs, about 500 MB per unauthenticated connection; WebSocket payload cap could be a few KB until the hello is verified (identity/section 1).
- app/renderer.js:431 and the hub's `file:put` size check (MAX_SHARED_FILE counts characters, maxPayload counts bytes of the JSON form): the owner's app should refuse to send a file whose JSON is near 5 MB (see the [high] finding); not checked in app/files.js.

# Protoplasma 0.4.1 recheck: compiled findings

Compiled from the 16 section files (about 215 findings) after merging duplicates and the "Outside my scope" notes. Repo files were not edited. Item numbers C1.. are a global rank: high first, then medium, then low; inside one severity an item CONFIRMED live (sections 15-16) comes before one CONFIRMED by running, which comes before one SUSPECTED by reading; ties go by batch A to G. The items are listed by fix batch, high first inside each batch.

## Summary

- Total after merging: **196 items** (plus 8 decisions in "Needs a decision")
- By severity: high 2, medium 32, low 162
- By evidence: CONFIRMED (live) 12, CONFIRMED (ran) 98, SUSPECTED 86
- By batch: A 33, B 24, C 32, D 32, E 43, F 13, G 19

| Batch | Area | high | medium | low | total |
|---|---|---|---|---|---|
| A | hub | 2 | 5 | 26 | 33 |
| B | agents and worktrees | 0 | 4 | 20 | 24 |
| C | main process, teams, GitHub, updates | 0 | 9 | 23 | 32 |
| D | code view | 0 | 4 | 28 | 32 |
| E | renderer screens and panes | 0 | 5 | 38 | 43 |
| F | markup and CSS | 0 | 2 | 11 | 13 |
| G | tooling, tests and docs | 0 | 3 | 16 | 19 |

### Top 10 by importance

1. C1 [high, batch A] A session named `..` turns "Delete session" into "Delete the whole team" (confirmed live).
2. C2 [high, batch A] One bad WebSocket frame or a reset connection kills the hub (the Electron main process for a This Mac hub); no sign-in needed.
3. C10 [medium, batch A] Unauthenticated sockets can make the hub buffer 100 x 5 MB each (50 MB to 845 MB with 3 sockets).
4. C8 [medium, batch E] Watching an open agent types the viewer's terminal replies into the owner's agent (confirmed live).
5. C23 [medium, batch D] Commit & Push in a session folder that is a repo subfolder commits and pushes the whole repo (`git add -A`).
6. C15 [medium, batch B] Removing a session folder silently deletes .env, local databases and other git-ignored files.
7. C24 [medium, batch E] An old name of a renamed session is not recognised, and a failed start can delete the real session.
8. C12 [medium, batch A] The push guard misses pushes wrapped in `bash -lc`, `zsh -ic`, `sh -ec`.
9. C3 [medium, batch A] The shell-write check calls read-only commands (`2>&1`, `> /dev/null`, `cp`) writes, so agents are asked on every run of a teammate's file (confirmed live).
10. C5 [medium, batch D] Find in files drops every hit in CRLF files (confirmed live) and mis-parses paths containing `:12:`.

Next in line: C22 (a refused push shows no reason), C7 (second agent never numbered, confirmed live), C16 / C17 (wrong login-shell environment), C20 (half-made clone treated as ready), C13 (renamed default branch blocks every new session), C6 (font settings, confirmed live).

---

## Fix batches

## Batch A: hub (src/hub.js, src/shared.js)

### C1 [high] A session named ".." turns "delete this session" into "delete the whole team"
- Sections: 1, 6, 15 | Evidence: CONFIRMED (live)
- Where: src/hub.js:324 (`new URL().pathname` collapses `.`/`..`/`%2e`), 363-371 (team delete), 442 and 461 (session names only trimmed and cut to 60); app/teams.js:80-84 (`sessionRoute`, which the comment and step routes build on; `encodeURIComponent` leaves dots alone)
- Problem: Any member can create a session called `..`; when the owner deletes it the request path collapses to `/teams/<id>/` and the hub deletes the whole team (sessions, plans, comments, notes; refused only with 409 while an agent runs, with the confusing "Stop the team's agents first."). A session called `.` can never be marked done, renamed, commented on or deleted, and `..` cannot be marked done or renamed ("Not found."). Confirmed on a real hub and live in the app: after `deleteSession(team, '..')` the team was gone.
- Fix: Refuse names made only of dots on create, rename and lane hello (hub), and throw in `sessionRoute` when `/^\.+$/.test(name)`; optionally answer 400 for a raw `.`/`..` path segment. Percent-encoding does not help: `%2E%2E` is collapsed too (sections 1 and 6).

### C2 [high] Any WebSocket client can crash the hub (no 'error' handler on sockets)
- Sections: 1, 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:651-661 (upgrade / `handleUpgrade` callback: no `ws.on('error')`; no `sock.on('error')` in the 404 branch at 655), 624-648 (authenticate), 679 (`server.once('error', reject)` only catches the first later server error)
- Problem: `ws` emits 'error' for a frame over maxPayload (5 MB), invalid UTF-8, bad opcode; an upgrade to a path other than /lane or /watch followed by a TCP reset makes `sock.end()` throw EPIPE. With no listener Node exits; no token or sign-in needed. On a hosted hub every team goes down (anyone can repeat it); in the app it takes down the Electron main process. Also happens by accident: a shared file whose JSON form exceeds 5 MB (see C48).
- Fix: `ws.on('error', () => {})` in the handleUpgrade callback before authenticate; `sock.on('error', () => {})` before `sock.end` in the 404 branch; `server.on('error', ...)` for later errors. Add a test that sends an oversized frame and checks the hub still answers.

### C3 [medium] shellWriteRisk calls read-only commands "writes" (`2>&1`, `2>/dev/null`, `> /dev/null`, `cp`)
- Sections: 2, 16 | Evidence: CONFIRMED (live)
- Where: src/hub.js:255-267 (the first test `/>|\b(tee|mv|rm|cp|truncate)\b/` only decides whether to scan; then every path-like word counts as written)
- Problem: The first test only decides whether to scan; the scan then counts every path-like word as written, so with a teammate's change in `src/a.js`, commands like `node src/a.js 2>&1 | tail`, `git diff src/a.js 2>/dev/null`, `cat src/a.js > /dev/null` or `cp src/a.js /tmp/x` stop with "already edited ... and this command changes it" (18 of about 35 read-only commands; confirmed live through POST /hook). Agents append `2>&1` to most runs, so people learn to click through; `perl -MList::Util=sum` is also read as in-place (`\s-[a-zA-Z]*i` matches `-MList`).
- Fix: Count a word as written only after a redirect `>`/`>>`/`tee` (ignoring `/dev/*`, `&N` and `2>&1`) or as an argument of mv/rm/truncate (last one of cp/mv); tighten the perl/sed in-place test. Fix together with C4 and C35.

### C4 [medium] shellWriteRisk does not see `rm -rf <directory>` containing a teammate's changed files
- Sections: 2, 16 | Evidence: CONFIRMED (live)
- Where: src/hub.js:259-264 (a directory is compared as a file name: `othersOn(lane, 'src')` looks for an exact entry)
- Problem: with a teammate's change in `src/components/Button.js`, `rm -rf src`, `rm -rf src/`, `rm -rf src/components`, `rm -rf ./src/components/` pass with no question; words with no `/` or extension are not looked at. Confirmed live: `rm -rf <session folder>`, `rm -rf src` and `rm -rf src/match` all answered null while Max's change was in src/match/queue.ts (`rm src/match/queue.ts` itself asks).
- Fix: for rm/mv count a path that is a directory prefix (`f.startsWith(rel + '/')`) of a teammate file; also look at slash-less words for rm/mv. Treat `rel === ''` (the folder itself) as a hit too.

### C10 [medium] Unauthenticated sockets can make the hub buffer 100 x 5 MB each
- Sections: 1, 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:629 (`early.length < 100 && early.push(raw)`), 650 (`maxPayload: MAX_HOOK_BODY`), 628
- Problem: until the first message is verified (a GitHub round trip, up to 8 s) later frames are queued by count, not bytes; no valid token needed, no cap on unauthenticated sockets. 3 sockets x 100 x 4.9 MB took hub RSS from 50 MB to 845 MB; a few sockets kill a small hosted hub.
- Fix: cap queued bytes (about 64 KB, then close 1009), cap the first message size, limit unauthenticated sockets per address.

### C11 [medium] Every distinct bad token costs a GitHub request; nothing limits it
- Sections: 1 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:108-117 (`identify`), 344 (HTTP), 633 (WebSocket)
- Problem: cache and shared lookup are keyed by token hash, so N different junk tokens make N calls to api.github.com (300 requests -> 300 verifier calls). A public endpoint can burn the hub's quota; GitHub then answers 403/429, which becomes 503 / close 1013 for every real user. (GitHub-side throttling itself not run.)
- Fix: reject tokens that do not look like GitHub tokens (prefix, length) before asking, limit concurrent lookups, rate-limit failed lookups per client address.

### C12 [medium] Push guard misses pushes wrapped in `bash -lc`, `zsh -ic`, `sh -ec` and other combined flags
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:200 (`runs`: `/(^|\s)(-c|eval)\s*$/`)
- Problem: the quoted command after a shell is only read when the word before it is exactly `-c`; `bash -lc "git push -f"`, `zsh -ic ...`, `sh -ec ...`, `bash -xc ...` are not asked about (all five confirmed), while `bash -c` is. `bash -lc` is a common agent wrapper.
- Fix: match any short-flag cluster ending in c: `/(^|\s)(-\w*c|eval)\s*$/`.

### C35 [low] shellWriteRisk misses writes not made with `>`, rm/mv/cp/tee/truncate or `sed -i`
- Sections: 2, 16 | Evidence: CONFIRMED (live)
- Where: src/hub.js:256-257 (`writes` needs `\s-[a-zA-Z]*i`, `--in-place` never matches; the early return skips every other command)
- Problem: `sed --in-place`, `prettier --write`, `eslint --fix`, `gofmt -w`, `curl -o`, `dd of=`, `ln -sf`, `install` on a teammate's changed file are not asked about although the file is named; `prettier --write`/`eslint --fix` are plausible agent actions and a classic merge-conflict source. Confirmed live: `git checkout -- src/match/queue.ts` (and by reading `git restore`, `git reset --hard`, `git stash`, `git clean`) is not in the write list and answers null, so the agent can wipe the file the overlap warning is about.
- Fix: add `--in-place` to the sed test and a short list of write flags (`--write`, `--fix`, `-w`, `-o`/`--output`) to the early test. (Same function as C3; fix both together.) Add `git (checkout|restore|reset|stash|clean)` to the write words.

### C36 [low] The hook context lists a person's own agents in other sessions as "teammates"
- Sections: 15 | Evidence: CONFIRMED (live)
- Where: src/hub.js (hook context text: "Teammates working in this repo right now" and "Check with the user before editing files a teammate has edited.")
- Problem: a solo user's agent is told that "David's claude agent ..." (themselves, in another session) is a teammate to check with; wording only, but it nudges the agent to ask the user pointlessly.
- Fix: leave the same login out of the teammates list (or word those lines "your other agent").

### C39 [low] Output sent while sign-in is pending is silently dropped after 100 messages
- Sections: 1, 2, 3 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:629 (same line as C10)
- Problem: a lane sends `hello` then streams `out`; while the hub asks GitHub the first 100 later messages are replayed and the rest are dropped with no trace, so teammates' screens and the stored scrollback keep a hole (300 `out` frames after hello: 100 reached the watcher). Nothing repairs it on that connection (lane.js:144 only sends its history in the hello). src/hub.js:629 is the same drop seen from the lane side.
- Fix: when the queue is full close the socket with 1013 instead of dropping: the lane reconnects and its hello carries its full local history (lane.js:144), which repairs the hole; also queue by bytes rather than count (see C10).

### C40 [low] A teams.json that parses but is not a list of well-formed teams stops the hub or breaks it for others
- Sections: 1 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:65-70 (only a parse error is handled), 80 (`team.members.some`), 86 (`team.sessions.find`)
- Problem: valid JSON of another shape (`null`, `{}`, `"x"`, `[null]`) throws in `startHub` before it listens (crash-loop; "moved aside" promise does not hold); a team without `members` makes `GET /teams` 500 for non-owners; `sessions: null` makes session create 500. Needs a hand-edited file.
- Fix: after parsing accept only an array of objects with string id and owner and array `members`/`sessions`/`memories` (fill missing with `[]`), else treat as a parse error.

### C41 [low] PROTO_OWNERS set but blank means nobody can create a team
- Sections: 1 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:687 (`owners` is `[]` for an empty variable), 350 (`owners && !owners.some(...)`)
- Problem: `PROTO_OWNERS=` (e.g. a blank Railway template placeholder) gives `[]`, which is truthy, so every create-team request gets 403 and the start-up line prints "teams created by " with nothing after.
- Fix: `owners: owners?.length ? owners : undefined`.

### C42 [low] Input limits are looser than they look (non-strings, bytes vs characters, line wrap)
- Sections: 1 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:59 (`str`), 315 (`body.length > max`), 404 (`line | 0`)
- Problem: `str` turns objects/arrays/numbers into text (a team named "[object Object]"); body limits count characters, not bytes (80,000 bytes pass the 64 KB limit, 5 MB hook limit can be 15-20 MB); a comment line above 2^31 wraps negative and loses file and line.
- Fix: `str` returns '' for non-strings; use `Buffer.byteLength`; clamp line with `Math.min`.

### C43 [low] An unparseable JSON body is treated as an empty one, so the error names the wrong field
- Sections: 1 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:346 (`parse(...) || {}`)
- Problem: `POST /teams` with `{not json` answers "Give the team a name."; a note POST answers "Write the note first." Misleading, no data loss.
- Fix: answer 400 "That wasn't valid JSON." when a non-empty body does not parse to an object.

### C44 [low] The invite pattern rejects logins with an underscore
- Sections: 1 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:17 (`GITHUB_LOGIN`)
- Problem: Enterprise Managed User logins like `dave_corp` get 400 "That isn't a GitHub username." (Whether such accounts can use the hub with the public device flow is SUSPECTED to be never.)
- Fix: allow `_` inside the name, or leave it and note it in the README.

### C45 [low] Comments and docs about the hub no longer match the code
- Sections: 1, 2, 14 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:1-2 ("never runs agents or sees code"), 66-68 (damaged file moved aside "rather than stopping the hub"); README line 150 ("nothing else is accepted until both are verified") (README is in batch G)
- Problem: the hub relays terminal output, 256-512 KB scrollback, the latest prompt and shared file contents, and stores commented line text; up to 100 messages are queued and replayed before sign-in; the moved-aside promise only holds for unparseable files (C40). README.md:183-185 and src/hub.js:2 say the hub never sees code, but it relays terminals and (with sharing on) file text and stores comment snippets.
- Fix: reword the three places (e.g. "It never runs agents or keeps files; it does relay their terminal output.").

### C46 [low] Removing someone who is not on the team succeeds
- Sections: 1 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:496-505
- Problem: the owner's `DELETE /teams/<id>/members/carol` for a non-member returns 200, rewrites teams.json and broadcasts instead of 404; hides a typo.
- Fix: 404 when no member matched.

### C47 [low] Every state broadcast is large and sent far too often
- Sections: 1, 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:163 (`sessions: team.sessions` with all comments and steps in every broadcast), 549-552 (`size` always calls `broadcastState`), 160-164
- Problem: each git report, resize and look and every 30 s sends all sessions with all comments and plan steps (about 20 MB at the caps); 30 identical `size` messages give 30 broadcasts; 20 agents x 200 files = 268 KB and 33 ms per state.
- Fix: skip the broadcast when cols/rows are unchanged; coalesce to a few per second; send comments and steps only for the session a viewer looks at; compute `touchedBy` sets once per lane per broadcast.

### C48 [low] A shared file's JSON form can exceed the 5 MB frame limit although it passes MAX_SHARED_FILE
- Sections: 1, 2, 11 | Evidence: CONFIRMED (ran)
- Where: src/hub.js (`MAX_SHARED_FILE` counts characters; `maxPayload` counts bytes of the JSON text); app/renderer.js:431 and app/files.js (the sender); app/renderer.js:1317-1318 (`answerFile` reads and sends up to 2,000,000 bytes), app/files.js:7 (MAX_BYTES), src/hub.js:25 and 594 (hub relays only 1,000,000 characters)
- Problem: a 1,000,000-character file full of control characters is 6 MB after JSON escaping, so the frame is rejected (before C2 is fixed, it crashes the hub). The sender also pushes the full text first and JSON escaping can multiply it toward the 5 MB socket limit; the requester gets "too big" correctly, the cost is wasted upload.
- Fix: have the owner's app refuse or truncate a file whose JSON form is near 5 MB; count bytes in the hub check. Also have `answerFile` answer "too big" when `file.text.length > 1_000_000` (and check the JSON size) instead of sending.

### C49 [low] Push guard asks about text that only mentions a push (commit messages, heredocs, comments)
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:197-205 (`commandsIn` splits the whole text on `|;&` and newlines including inside quotes, no `#` comment stripping), 206 (`wordsOf`)
- Problem: `git commit -m "$(cat <<'EOF' ... git push --force ... EOF)"`, a multi-line `-m` message, `-m "wip; git push -f is bad"`, `cat <<EOF > notes.md` with a push line, `echo done # git push -f` all wrongly ask for confirmation (about 120 ordinary commands otherwise classified correctly).
- Fix: cut `#` comments to end of line, treat a heredoc body as data, ignore separators inside quotes.

### C50 [low] Push guard uses the lane's last-reported branch, so `git checkout main && git push` is not asked about
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:243 (`t === 'HEAD' ? lane.branch : t`)
- Problem: `git checkout main && git push` or `git switch main && git merge x && git push origin HEAD` from a lane that reported `session/fix` pushes to main unasked (mostly moot inside session worktrees, where main is checked out elsewhere).
- Fix: when the same command has `git checkout|switch <protected branch>` before the push, treat HEAD as that branch.

### C51 [low] A reconnecting agent loses its status, latest prompt, hook-reported edits and "typed by" note
- Sections: 2, 3 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:528-532 (new lane object starts from the hello only; only `startedAt` carried over); src/hub.js:531
- Problem: after a network blip a working agent shows "idle" with no prompt until its next hook event, and hook-reported edits (used by the same-checkout rule via `touchedBy`) are forgotten. Seen from the lane side: after a network blip recorded edited files and a "needs you"/"working" status are lost.
- Fix: copy `status`, `prompt`, `files`, `typedBy`, `typedAt` from `existing` (and from the stopped entry if the old socket was already seen closing).

### C52 [low] Files outside the checkout are recorded as `../../...` "changed files" and shown to teammates' agents
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:272-274, 303 (`rel = path.relative(root, full)` not checked for `..`)
- Problem: a Write to `~/.claude/plans/p.md` is stored as `../../home/.claude/plans/p.md` in the agent's `files`, in teammates' prompt context, and can make PreToolUse "ask" a teammate at the same folder depth editing `~/.zshrc`; it disappears at the next git report.
- Fix: ignore `rel` starting with `..` (or absolute) for `files`, `othersOn` and `notesFor`.

### C53 [low] File relay: an error answer waits for closed or stale windows and then shows "didn't answer"; the 10 s timer is never cleared
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:583-587 (`waiting: owners.length`), 592; 586 (timer not cleared or unref'd)
- Problem: if one of the owner's windows closes (or is a half-open socket), another window's error answer is held for the full 10 s and the requester sees "<name>'s app didn't answer." (9,903 ms observed); the uncleared timer keeps the process alive ~7 s after `hub.close()`.
- Fix: count only windows still open at answer time (or send the first error after a short grace period) and `clearTimeout` when answered.

### C54 [low] File relay answers for another team's agent with its owner's name
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:584
- Problem: `file:get` with the id of a lane in another team answers "<name>'s app isn't open.", confirming the id exists and naming its owner (needs the lane UUID, so small leak).
- Fix: treat a lane of another team like a missing one ("That agent has stopped.").

### C55 [low] A teammate can take over a dropped agent's id; the real agent is then refused with "Bad hello."
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: src/hub.js:522-525 (the only identity check is against a lane currently in `lanes`)
- Problem: while an agent's connection is down its id is free; a teammate's hello with that id is accepted and the owner's agent gets close 4000 on every retry until the intruder leaves; the intruder also clears the agent's "stopped" entry.
- Fix: remember the login of recently stopped ids (the `stopped` entries hold `login`) and refuse a different login.

### C56 [low] shared.js slug: emoji-only names differ with and without a variation selector
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: src/shared.js:21-22
- Problem: variation selectors are stripped for the slug but the fallback hashes the raw name, so two spellings of one emoji become two sessions (`session-6k6d` vs `session-61w0k`); `İstanbul` is normalised before lowercasing and differs from the plain-`i` spelling.
- Fix: hash the stripped, NFC-normalised, lowercased name; normalise after lowercasing.

### C57 [low] slug('x.lock.lock') returns `x.lock`, which is not a valid branch name
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/shared.js:21 (the `.lock` strip does not loop)
- Problem: `session/x.lock` is rejected by git ("not a valid branch name"), so such a session can never start (exotic names only).
- Fix: strip repeatedly: `/(\.lock)+$/`.

### C117 [low] A hosted hub without DATA_DIR says nothing about keeping teams only in memory
- Sections: 1 | Evidence: SUSPECTED
- Where: src/hub.js:688-689, Dockerfile, README line 144
- Problem: with the volume or `DATA_DIR` missing the hub starts normally and every redeploy erases all teams silently.
- Fix: print "teams are kept in memory only (set DATA_DIR)" in the standalone entry when `dataDir` is unset.

### C118 [low] The 10 s sign-in timer closes with 4001 even while verification is pending
- Sections: 1 | Evidence: SUSPECTED
- Where: src/hub.js `authenticate()` (10 s timer); src/lane.js (treats close codes >= 4000 except 4003 as final)
- Problem: on a slow link the timer fires before the GitHub lookup returns and closes with 4001, which lane.js never retries, so the agent stays disconnected.
- Fix: close with a retryable code (1013) while a lookup is pending, or clear the timer once the first message arrives.

### C119 [low] Two checkouts with the same login and path count as one folder
- Sections: 2 | Evidence: SUSPECTED
- Where: src/hub.js:533 (`tree = hash(login + root)`)
- Problem: one person running the same session on two Macs gets the same root path, so the hub sees one checkout: no overlap between them and no "ask", although they are different clones.
- Fix: add something per machine to the hash (hostname or a per-run id sent in the hello).

### C120 [low] The hub silently ignores a changed goal from someone who is neither the session's creator nor the owner
- Sections: 10 | Evidence: SUSPECTED
- Where: src/hub.js:449; app/renderer.js (dialog shows no sign it was ignored)
- Problem: the request succeeds but the goal is not changed, and the renderer never learns it.
- Fix: answer 403 "Only <creator> or the team owner can change the goal." (or return the unchanged session and let the dialog say so).

### C121 [low] Session aliases keep only the last 5 old names
- Sections: 1 | Evidence: SUSPECTED
- Where: src/hub.js:468
- Problem: an agent started under an older name after 6 or more renames is no longer matched by `findSession` (the original `key` still is) and would create a duplicate session.
- Fix: keep more aliases (say 50) or never drop an alias a lane in the session still uses.

## Batch B: agents and worktrees (src/lane.js, src/workspace.js)

### C13 [medium] A renamed default branch makes every new session for that repo fail ("invalid reference: origin/main")
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:33-34 (and :25 `fetch --prune`)
- Problem: base comes from `symbolic-ref refs/remotes/origin/HEAD`; if the default branch was renamed on GitHub after the clone (main -> trunk), origin/HEAD is stale, `fetch --prune` deletes `origin/<old>` and `worktree add ... origin/<old>` throws; no new session can start in that repo until the user runs `git remote set-head origin -a` by hand.
- Fix: use the symbolic-ref result only if `rev-parse --verify` resolves; otherwise run `git remote set-head origin -a` (tryGit) and retry, else fall back to HEAD.

### C14 [medium] Two agents starting at once in the same new session: the second fails with "cannot lock ref ... already exists"
- Sections: 4, 6 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:23-35 (check-then-create, no per-folder lock); app/github.js:103-109 (cloneRepo), 116-126
- Problem: both calls see no `<clone>@<slug>/.git`, both reach `worktree add -b session/<slug>`; the loser throws and startLane shows "Couldn't make this session's own folder" although a retry would work (double click on Start, or app restart resuming several lanes of a session whose folder was deleted). Same race one level up: two sessions on a not-yet-cloned repo both run `gh repo clone` into the same folder ("destination path already exists") (section 6 SUSPECTED).
- Fix: keep a module-level Map of in-flight promises keyed by `dir` and return the same promise to concurrent callers. Also key an in-flight promise by clone dir in cloneRepo.

### C15 [medium] Removing a session folder silently deletes git-ignored files (.env, local databases, node_modules)
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:39-45 (`git worktree remove` without --force; comment says git refuses on uncommitted changes); app/github.js:131-134 (wording "uncommitted changes")
- Problem: `git worktree remove` only refuses for modified or untracked non-ignored files, so a folder with a hand-made `.env`, a local DB or build output is wiped for good with no warning while the UI suggests anything unsaved blocks removal.
- Fix: check `git status --porcelain --ignored` first (skip node_modules and known build dirs) and refuse or ask when other ignored files exist; at least say so in the comment and UI.

### C29 [medium] The lane never notices a dead hub connection (laptop sleep, Wi-Fi change)
- Sections: 3 | Evidence: SUSPECTED
- Where: src/lane.js:139-158 (connect; no ping/pong anywhere); hub side src/hub.js:657-667 (hub pings and terminates sockets that miss a pong); app/main.js (no powerMonitor 'resume' hook)
- Problem: the hub drops a lane whose pongs stop and shows it as "stopped"; if the path was dead (Mac asleep, network switched) the FIN never reaches the Mac, so on wake the socket still reads OPEN, an idle agent writes nothing, nothing errors and nothing reconnects until it prints something. `lanes:rejoin` does not help because connect() returns when readyState is OPEN.
- Fix: in lane.js `ws.ping()` every ~20 s and `ws.terminate()` when no pong within a few seconds (the close handler reconnects); optionally call rejoin/terminate from powerMonitor 'resume'.

### C58 [low] Resizing the window makes a Codex/OpenCode agent show "working" for 3 s
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:172 and 199-203 (resize does not set `lastInput`)
- Problem: output more than 400 ms after a keystroke counts as work; a resize makes the TUI redraw, so every window resize, sidebar toggle or pane switch flips an idle agent to "working" (and bumps lastActive on the hub) for QUIET_MS; dragging keeps it "working".
- Fix: set `lastInput = Date.now()` in resize().

### C59 [low] Ordinary output that mentions "trust this folder" is taken for the trust prompt
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:23 (TRUST_PROMPT), 170-171, 172
- Problem: the regex looks for the phrase anywhere in the last 400 plain-text characters, so an agent quoting that sentence reports "needs you" to the whole team; while `asking` is true the Codex/OpenCode activity logic is off (stuck until someone types, SUSPECTED); for Claude the first keystroke sends "idle" even mid-turn.
- Fix: require the option line too (`1. Yes` / "Yes, continue") in the same 400 chars, or only watch until the first Enter; drop `asking` after some time or on the first non-prompt output.

### C60 [low] Final output is lost when the agent exits while the hub is unreachable
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:197 (`flush(); ws.close()` on a closed socket), 141 (no further connect once exited)
- Problem: output printed just before an exit during an outage is never sent; the hub already moved the lane to "stopped" with the older screen, so teammates never see how it ended.
- Fix: on exit while not OPEN, try one last connect that sends hello with full history and then closes, or document it.

### C61 [low] Paths with a quote, tab, backslash or newline come out C-quoted; first/last paths lose edge spaces
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:62-63 (`core.quotePath=false`, `out.trim()`), 77, 82-88
- Problem: quotePath=false only covers non-ASCII, so `q"uote.txt` is reported as `"q\"uote.txt"` and overlap matching against the path Claude reports never matches; `run()` trims the whole output so the first/last name loses a leading/trailing space.
- Fix: use `-z` for ls-files, diff --name-only and `--numstat -z` (split on \0); trim only the count outputs.

### C62 [low] A branch pushed without -u counts everything since main as unpushed and local
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:70 (upstream auto-set only for `session/`), 78, 90
- Problem: for any other branch with no upstream (`git push origin HEAD`) `unpushed` is computed against main and `local` falls back to the whole `changed` list, although `origin/<branch>` has those commits; two checkouts of the same pushed branch see each other's files as overlaps and the badge shows pushed commits as unpushed.
- Fix: when there is no upstream but `refs/remotes/origin/<branch>` exists, use it for counting (without writing config for non-session branches).

### C63 [low] No origin/HEAD means committed branch work is not reported at all
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:65-66, 74, 77, 81
- Problem: `main` comes only from `origin/HEAD`; a clone of an empty repo or `git init` + `remote add` has none, so `base` is empty, `ahead` is 0 and `changed` is only uncommitted files; committed files drop out of the overlap list. (Same missing-origin/HEAD root as C73 in workspace.js.)
- Fix: fall back to `origin/main`, then `origin/master` (`git rev-parse --verify --quiet`).

### C64 [low] Git stats stall while a fetch runs, and a failed git call looks like "no changes"
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:62-64 (`err ? ''`), 64 (`await run('fetch')` inside the guarded poll), 187-193; src/hub.js:557 (drops recorded files not in `changed`)
- Problem: (1) the once-a-minute fetch is awaited inside the single in-flight poll, so nothing is reported while it runs (up to its 20 s timeout; confirmed with a 7 s shim); (2) any failure (20 s timeout, 10 MB maxBuffer) resolves to '' and reports a clean checkout, and the hub then drops the lane's recorded edited files (SUSPECTED, not forced).
- Fix: start the fetch without awaiting it (own guard); make `run` return null on error and skip the report when numstat/ls-files failed.

### C65 [low] Standalone CLI rough edges
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:208-225
- Problem: (1) a missing command, folder or bad hub URL ends in a raw Node stack trace (confirmed); (2) onRefused uses console.error, repeating every 30 s on a 4003 into the agent's full-screen terminal; (3) stdin chunks are Buffers so `d === '\x1b'` never matches (Esc alone does not answer a trust prompt); (4) background `git fetch` may prompt for an ssh passphrase on the controlling terminal. (2)-(4) SUSPECTED.
- Fix: wrap startLane in try/catch and print `e.message`; send refusals to a status line or log; `lane.write(String(d))`; set GIT_SSH_COMMAND with `-o BatchMode=yes` when unset.

### C66 [low] The JSDoc for startLane is attached to the wrong function
- Sections: 3 | Evidence: CONFIRMED (ran)
- Where: src/lane.js:94-109
- Problem: the `/** Starts an agent CLI ... */` block sits above the `runnable`/`installed` helpers; it also lists only some parameters (not args, cwd, cols, rows, env, onRefused) and @returns omits `repo` and `rejoin`.
- Fix: move the helpers above the comment and add the missing parameters.

### C67 [low] A leftover `<clone>@<session>/.git` whose worktree record is gone is treated as a ready folder
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:23
- Problem: the only check is `fs.existsSync(dir/.git)`; after a re-clone the old folder's `.git` pointer is dead, so the agent starts where every git command fails, status/overlaps silently die, and removeSessionWorktree later fails with "not a working tree" (which github.js reports as "uncommitted changes").
- Fix: validate with `git -C dir rev-parse --git-dir` before the early return; if it fails treat as broken and rebuild or error clearly.

### C68 [low] A non-empty `<clone>@<session>` folder without .git blocks the session with a raw git error
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:23, 29-34
- Problem: a folder with files but no `.git` makes `worktree add` fail with "'<path>' already exists", shown inside the "turn off A branch for every session" advice with no hint to move that folder.
- Fix: catch this case and name the folder in the way (or use it if empty).

### C69 [low] The push guard is silently not installed when the repo has any pre-push hook or hooksPath
- Sections: 4, 6 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:68-72 (returns false for any pre-push hook or `core.hooksPath`; `git config` also reads the global config); app/github.js:118 (`installPushGuard(...).catch(() => {})` ignores the result)
- Problem: husky/lefthook, a global hooks folder (git-secrets, a company template) or any foreign pre-push (git-lfs writes one; that part SUSPECTED) makes the guard silently not install, so shared-team Codex/OpenCode agents get no protection and nobody is told; the hook never chains to an existing one.
- Fix: When `installPushGuard` returns false on a shared team show a one-line notice (github.js), or chain to the existing hook after ours. Note a global `core.hooksPath` overrides `.git/hooks`, so `--local` alone would install a hook that never runs.

### C70 [low] Rewriting a rebased own session branch is blocked with advice that does not help ("Pull them in first")
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:61-63
- Problem: an agent that rebases its own session branch and force-pushes (or uses `--force-with-lease`) is told to pull first, but nobody else pushed so pulling changes nothing; the agent loops or reaches for --no-verify.
- Fix: say "rebuild the branch with a merge instead of rebasing, or push a new branch name", or allow force when the remote tip is the agent's own last push.

### C71 [low] Git error text: only the last stderr line is kept, often a hint or half of a two-line message
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:11 (`errOut.trim().split('\n').pop()`)
- Problem: the text shown in "Couldn't make this session's own folder ... : <text>" can lose the real problem (`x.lock.lock` shows "hint: Disable this message..."; a locked worktree shows "use 'remove -f -f'..." without "cannot remove a locked working tree").
- Fix: keep the last line starting with `fatal:` or `error:` (strip the prefix), fall back to the last line.

### C72 [low] removeSessionWorktree on a missing folder returns false and leaves the worktree registered
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:42
- Problem: if the user deleted the folder by hand, `worktree remove` is never tried and nothing prunes, so `.git/worktrees/<name>` stays and `git branch -d session/<name>` fails with "used by worktree" until some later sessionWorktree call prunes.
- Fix: on a missing folder run `git worktree prune` before returning false.

### C73 [low] If origin/HEAD is missing, a new session starts from whatever the shared clone has checked out
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: src/workspace.js:33 (`|| 'HEAD'`)
- Problem: offline or with no origin/HEAD the base is the clone's HEAD (a leftover feature branch or detached commit), so the new session silently contains those commits and shows them as its changes. (Same missing-origin/HEAD root as C63.)
- Fix: fall back to the local default branch (`main`/`master` if present) before HEAD, or refuse with "can't tell the default branch while offline".

### C122 [low] The hook secret is in every agent's environment, and a blackholed hub adds 3 s to every hook
- Sections: 3 | Evidence: SUSPECTED
- Where: src/lane.js:121 (`PROTO_HOOK_SECRET` always set), 30 (`timeout: 3`)
- Problem: (a) Codex/OpenCode never use the secret but get it, so any command they run can read it (it authenticates hook posts for that lane); (b) with a hub that hangs instead of refusing, each UserPromptSubmit/PreToolUse/PostToolUse waits up to 3 s (about +6 s per tool call), which the "fails open" comment does not mention.
- Fix: set PROTO_HOOK_SECRET only when `path.basename(cmd) === 'claude'`; consider a 1-2 s timeout for PostToolUse or skip hooks after repeated hub failures.

### C123 [low] A new session reusing an old session's name resumes the old local branch even if it was merged and the remote branch deleted
- Sections: 4 | Evidence: SUSPECTED
- Where: src/workspace.js:28-29, 40-45 (branch is kept on removal)
- Problem: after a squash-merge and remote-branch delete the local `session/<slug>` stays; a later session with the same name checks it out as is (behind main, carrying merged commits), so gitStatus lists those files as changed (false overlaps) and a new PR re-includes old commits.
- Fix: when the local branch has no upstream or a gone upstream and its tip is reachable from origin/HEAD, delete and recreate it from origin/HEAD.

### C124 [low] The 120 s limit on `git worktree add` can leave a half-checked-out folder that is then treated as ready
- Sections: 4 | Evidence: SUSPECTED
- Where: src/workspace.js:10 (timeout), 23 (early return on `.git`)
- Problem: on a huge repo the kill happens after `.git` exists but before checkout finishes; the next start returns the partial folder without error (files shown as deleted).
- Fix: on `worktree add` failure run `git worktree remove --force dir` (and delete the folder) before rethrowing; or raise that timeout.

### C125 [low] The pre-push hook is rewritten on every session start, non-atomically
- Sections: 4 | Evidence: SUSPECTED
- Where: src/workspace.js:73-75; called from app/github.js:118 on each sessionFolder
- Problem: `writeFileSync` truncates the live hook and the file is 0644 until the chmod on first install, so a push in another session at that moment can run an empty or partial script or skip the hook; also pointless work since content rarely changes.
- Fix: write only when content differs, via temp file and rename, with `{ mode: 0o755 }`.

## Batch C: main process, teams, GitHub, updates (app/main.js, app/preload.js, app/teams.js, app/github.js, app/updates.js)

### C16 [medium] A slow or unusual .zshrc leaves the app with the wrong environment for its whole life
- Sections: 5 | Evidence: CONFIRMED (ran)
- Where: app/main.js:22-34 (callers 100, 111, 138, 145)
- Problem: `agentEnv` is computed once. (a) If the login shell fails or times out (heavy nvm/conda rc hitting 5 s; SUSPECTED) it resolves `process.env`, which for a Finder launch has a minimal PATH and no LANG (the `LANG ||=` only runs on success), so every agent is "not installed", `gh` is not found and non-ASCII output is mangled until relaunch. (b) If the rc replaces the shell (`exec fish`, `exec tmux`) the command never runs, no `__ENV__` marker, parse yields `{}` and the app gets no PATH and no HOME (confirmed).
- Fix: require the marker and a non-empty PATH in the parsed env, else fall back to `{ ...process.env, LANG: process.env.LANG || 'en_US.UTF-8' }`; apply the LANG default on every path; retry the read lazily (e.g. when `agents:status` finds nothing installed).

### C17 [medium] The login-shell environment drops SSH_AUTH_SOCK and TMPDIR
- Sections: 5 | Evidence: CONFIRMED (ran)
- Where: app/main.js:23-25 (shell started with only HOME, USER, LOGNAME, SHELL, TERM); consumers: agents, `gh`, files.js `commitAndPush`
- Problem: SSH_AUTH_SOCK, TMPDIR, XPC_*, __CF_USER_TEXT_ENCODING are missing from the result (confirmed), so for a user with an SSH remote and a passphrase key loaded with plain `ssh-add` push and clone fail with "Permission denied (publickey)" in the app only (SUSPECTED, depends on the ssh setup); TMPDIR falls back to /tmp.
- Fix: after parsing, copy them from `process.env` when the shell did not set them: `for (const k of ['SSH_AUTH_SOCK','TMPDIR']) env[k] ||= process.env[k]`.

### C18 [medium] Sign-out leaves the in-process hub and its Bonjour ad running; the next account cannot create a team on this Mac
- Sections: 5, 6 | Evidence: CONFIRMED (ran)
- Where: app/main.js:67 with app/teams.js:31, 35-42 (`hosting ??=`, `owners: [user.login]`, `bonjour.publish`)
- Problem: `auth:signOut` does not stop the hub started by `hostHere`, does not unpublish the Bonjour service, does not clear the `folders` allow-list and does not close Terminal-tab shells. Because `hosting` is cached, after signing in as another GitHub user "On this Mac" reuses the hub started with `owners: [first login]` and the hub answers 403 "This hub only lets its owners create teams." until the app is restarted (confirmed with two logins on a real hub).
- Fix: on sign-out call a `teams.stopHosting()` that closes the hub, unpublishes and clears `hosting`/`local` (or key `hosting` by login), and clear `folders` and kill `shells`; or add the new user to the hub's owners.

### C19 [medium] This Mac's own Bonjour entry is never recognised, so "Look for teams on this network" lists your own Mac as a second hub
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/teams.js:19-21 (`svc.name !== local?.name`), 32 (`name: \`${user.login} on ${os.hostname()}\``)
- Problem: bonjour-service rewrites dots in a service name to dashes, and macOS hostnames normally end in `.local`, so the advertised name is "alice on Mac-Home" but `local.name` is "alice on Mac.Home"; the comparison never matches and with nearby lookup on the user's own hub is listed again as "<Name>'s Mac", duplicating the teams and doubling each refresh.
- Fix: compare against `local.name.split('.').join('-')`, or skip any service whose port and address are this hub's (or put a random id in a txt field and ignore your own).

### C20 [medium] An interrupted or timed-out clone leaves a `.git` that is later treated as a finished (or empty) clone
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/github.js:103-109 (`cloneRepo`: `existsSync(dir/.git)`), 116-126 (sessionFolder "empty repo" fallback), 81 (gh timeout 120 s)
- Problem: `git clone` creates `.git` first; after a timeout, quit or crash the next try skips cloning, `sessionWorktree` fails (no HEAD), `sessionFolder` decides the repo "has no commits yet" and starts the agent in an empty, half-made folder on the default branch with no error (confirmed: 0 files, no error). A folder without `.git` makes `gh repo clone` refuse with git's raw text; the timeout kills only `gh`, so git may finish later (SUSPECTED).
- Fix: clone into `dir + '.partial'` and rename on success (remove a stale `.partial` first); longer timeout for clones; treat "no HEAD" as empty only if `git ls-remote --heads origin` is empty.

### C21 [medium] "gh auth status" is read as "the first account is the signed-in one", and any broken saved account says "not signed in"
- Sections: 6, 12 | Evidence: CONFIRMED (ran)
- Where: app/github.js:136-141 (`ghStatus`, regex `/account (\S+)/`)
- Problem: with several `gh` accounts (2.40+) Settings names the first listed rather than the one with `Active account: true`, and `gh auth status` exits non-zero when any saved account has a bad token, so a user whose active login works is told "Installed, but not signed in." (confirmed against a fake `gh` using the remembered 2.40+ format, not a live gh). The first-run checklist (renderer.js) shows the "Installed, but not signed in" result as is, also when `gh auth status` exits non-zero for another reason (offline).
- Fix: use `gh auth status --active` (or read the `Active account: true` entry) and judge by that account instead of the exit code; or `gh api user -q .login`.

### C30 [medium] Closing the window with only a Terminal-tab shell open quits without asking, and nothing can close a shell
- Sections: 5 | Evidence: SUSPECTED
- Where: app/main.js:267-276 (dialog condition at 272), 196-207; app/preload.js:75-81; app/renderer.js:773
- Problem: the warning shows only when agents or unsaved files exist (`shells.size` only adds a sentence), so Cmd+Q/Cmd+W kills a shell running a dev server, a build or a half-done `git rebase` with no prompt. There is also no `shell:kill` IPC: a shell stays alive until it exits or the app quits, even after its session is deleted, its folder removed or the user signs out.
- Fix: add `shells.size && plural(shells.size, 'a terminal is open', 'terminals are open')` to `what`; add a `shell:kill` handler and preload entry and call it when a folder is removed or on sign-out.

### C31 [medium] Any failure sending a Bonjour reply throws in the main process
- Sections: 6 | Evidence: SUSPECTED
- Where: app/teams.js:14 (`new Bonjour()`), node_modules/bonjour-service/dist/lib/mdns-server.js:16, 86; app/main.js (no `process.on('uncaughtException')`)
- Problem: bonjour-service's default `errorCallback` is `err => { throw err }` and it runs in every reply callback; `socket.send` errors (ENETUNREACH, EHOSTUNREACH, EADDRNOTAVAIL on Wi-Fi/VPN change or wake) therefore become an uncaught exception in Electron's main process once this Mac hosts a team.
- Fix: `new Bonjour({}, err => console.error('Bonjour:', err.message))`.

### C32 [medium] A "This Mac" team gets a new key on every launch, so "reopen the last team" and the per-session memory never work for it
- Sections: 9 | Evidence: SUSPECTED
- Where: app/main.js:45 (`key = `${t.hub}|${t.id}``), app/teams.js:~33 (`startHub({ port: 0 ... })`, `local.url = http://127.0.0.1:${hub.port}`); used at app/renderer.js:285 (`store.get('team')`), 345, 499 (`sourceKey`), 508 (`lastAgentKey`)
- Problem: the in-process hub listens on an OS-assigned port (differs per start: 54702, then 54703 confirmed), so the team key changes on every launch: the saved `team` never matches, launch lands on the picker for every team hosted on this Mac (and for nearby Macs), and the `source:<key>:<session>` / `lastAgent:<key>:<session>` entries are lost, so "Resume" is not offered and a session started in a picked folder forgets it. (Consequence SUSPECTED from reading.)
- Fix: key teams by something stable (team id plus the owner's login or a stable host name) for `team` and the localStorage keys, keeping the URL out of it; or give the in-process hub a fixed/persisted port.

### C74 [low] Removing a session folder reports every failure as "Its folder has uncommitted changes, so it was kept"
- Sections: 4, 5, 6, 10 | Evidence: CONFIRMED (ran)
- Where: app/github.js:131-134 (`removeSessionFolder`)
- Problem: a locked worktree, a stale `.git` pointer or a plain folder all throw from removeSessionWorktree and get the same misleading message. Also reached by a missing clone, a git timeout, and an invalid repo name (`checkRepo` runs inside the try); the user then commits or discards changes that do not exist.
- Fix: show git's own message (or "couldn't remove: <reason>") when the failure is not a dirty tree. Keep git's message unless it is about modified/untracked files: `/modified or untracked|contains modified/.test(e.message) ? 'Its folder has uncommitted changes, so it was kept.' : e.message`.

### C75 [low] The login-shell timeout is not enforced, and every code-view call waits for it
- Sections: 5 | Evidence: CONFIRMED (ran)
- Where: app/main.js:24 (`timeout: 5000`), 174-177 (`inFolder` awaits `agentEnv`)
- Problem: `execFile`'s timeout kills only the shell; a child holding the stdout pipe keeps the callback waiting (1.5 s timeout, 7 s rc: callback after 7016 ms). `agents:status`, `startLane`, `repos:list`, `gh:status` and every `code:*` call (even read and write, which never use the env) wait for it, so opening the code view or saving right after launch can stall.
- Fix: race the promise against its own `setTimeout` (resolve the fallback env after 5 s regardless) and let `inFolder` pass the env only to handlers that use it.

### C76 [low] Bonjour goodbye packets are never sent at quit
- Sections: 5, 6 | Evidence: CONFIRMED (ran)
- Where: app/teams.js:93 (`stopAnnouncing`: `bonjour.unpublishAll(); bonjour.destroy();`), app/main.js:283
- Problem: `destroy()` closes the mDNS socket before the goodbye (TTL 0) records go out, so other Macs keep listing "X on Y's Mac" until the records expire; with nearby lookup on every refresh then waits 5 s on the dead entry and shows it "unreachable" (a watcher never saw DOWN in 12 s; with the callback form it saw DOWN in about 2 s).
- Fix: `bonjour.unpublishAll(() => bonjour.destroy())` and in `will-quit` `preventDefault()` until it finishes (short timeout) before quitting again.

### C77 [low] gh error mapping blames the connection for permission, SAML, rate-limit and not-found errors; other failures show raw text
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/github.js:83-87
- Problem: the third branch tests `api\.github\.com` against the last stderr line, which GraphQL errors (`HTTP 403: ... (https://api.github.com/graphql)`) end with, so SAML/rate-limit/not-found/permission errors all become "Couldn't reach GitHub. Check your connection..."; gh older than 2.48 (no `--slurp`) shows its usage line; a 120 s timeout shows "Command failed: gh api --paginate ..." (the real gh URL format is SUSPECTED).
- Fix: test network wording only (`dial tcp|no such host|i/o timeout|connection refused|EOF`), map `HTTP 403/404` and SAML to short messages, say "update the GitHub CLI" for an unknown flag and "took too long" when `err.killed`.

### C78 [low] The swap script fails silently: if the first `mv` fails the old app is simply reopened
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/updates.js:71-75 (swap.sh)
- Problem: no branch for "the first mv failed" (read-only install folder, locked bundle, App Management protection), so the script reopens the unchanged old app with exit 0 and stderr ignored; the UI said "<version> is ready" and after restart nothing says why it is still old.
- Fix: write the script's output to a log (temp dir or `~/Library/Logs`) and on failure open a small notice instead of silently reopening.

### C79 [low] swap.sh cleanup quotes the temp folder with JSON.stringify, which does not stop `$` or backticks expanding
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/updates.js:75 (`rm -rf ${JSON.stringify(dir)}`)
- Problem: a JSON string is a double-quoted shell string, so `$VAR` and backticks in `dir` (os.tmpdir() plus a suffix) still expand and the cleanup misses the 150 MB download or removes another path (confirmed with `$HOME` in the folder name).
- Fix: pass the folder as `$3` and write `rm -rf "$3"`.

### C80 [low] Device-flow polling dies on any network blip or non-JSON answer, with raw error text; a null user gets saved
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/github.js:15-16 (postForm), 51-69 (finishSignIn), 27-40, 20 (saveSignIn)
- Problem: `postForm` has no timeout, no retry and an unguarded `r.json()`, so one dropped request while the user approves ends sign-in with "fetch failed" and an HTML 502 shows `Unexpected token '<'...`; a failing `/user` call after the grant wastes the approval; if `githubUser` returns null (401), `{token, user: null}` is saved and `session.user.login` throws in main.js (repos:list, teams:leave) until the next launch; a safeStorage failure shows Electron's raw text.
- Fix: wrap the poll request in try/catch (treat network errors and non-JSON as pending until the deadline), add `AbortSignal.timeout(15000)`, retry `githubUser` a few times, and throw "GitHub didn't recognise the new sign-in" for a null user.

### C81 [low] findUser has no timeout and lets organisation names through
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/github.js:72-76
- Problem: no fetch signal, so with GitHub unresponsive "invite" hangs until undici's 5 minute timeout (confirmed with a never-resolving stub); `GET /users/{name}` also answers for organisations, so inviting "acme" is accepted as a teammate who can never sign in (SUSPECTED from the API).
- Fix: `signal: AbortSignal.timeout(8000)` and reject when `type !== 'User'`.

### C82 [low] isNewer ignores prerelease suffixes and a fourth number
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/updates.js:13-18
- Problem: `parseInt('0-beta')` is 0 and only three parts are compared, so `0.5.0-beta.1` counts as `0.5.0` (never offered 0.5.0), and `0.4.1.1` is not newer than `0.4.1`; latent because releases are plain x.y.z and `releases/latest` skips prereleases.
- Fix: split off `-suffix` and treat "no suffix" as newer, or state in the release workflow that tags are always x.y.z.

### C83 [low] sameSigner: an ad hoc copy accepts any intact app, and a failed read of its own signature silently relaxes the check
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: app/updates.js:84-88
- Problem: with an ad hoc signed copy `required` is undefined and `codesign --verify` only proves integrity, so an app with a different bundle identifier signed by another certificate is accepted; if `codesign -d -r-` on the running bundle fails, `.catch(() => '')` has the same effect (certificate-signed copies are checked correctly; matches the comment "takes any intact update").
- Fix: when `required` is empty also require the same `CFBundleIdentifier` (`codesign -dv` shows `Identifier=`) and refuse, instead of relaxing, when reading the current signature fails.

### C126 [low] Cancelling sign-in while the code request is in flight opens the browser anyway
- Sections: 5, 9 | Evidence: SUSPECTED
- Where: app/main.js:54-65; app/renderer.js:179-186 (`#signin` button not disabled while `proto.signIn()` waits)
- Problem: `auth:start` does not check `abort.signal.aborted` after `await github.startSignIn(...)`, so a cancel during that request still overwrites the clipboard, opens github.com/login/device and returns `{ code, url }` to a renderer that has left the sign-in screen; two quick starts can return in the wrong order. Seen from the renderer: a double click makes main abort the first flow's controller but the first request still copies its code, opens the browser and replies, so two GitHub tabs open and, if the first reply lands last, the shown and copied code is the aborted one while main polls the second (entering it never signs in; Cancel and retry fixes it).
- Fix: `if (abort.signal.aborted) return null;` right after the await. Also disable `#signin` until the call returns (re-enable in a `finally`).

### C127 [low] Settings -> About says "No releases yet" when GitHub cannot be reached
- Sections: 5, 12 | Evidence: SUSPECTED
- Where: app/main.js:119-126; app/updates.js:28-36 (`latestRelease`); app/renderer.js:1520-1522 (`showUpdateStatus`)
- Problem: `latestRelease` swallows network errors and a missing `gh` and returns null, so offline, rate-limited (60 calls/h per IP), behind a captive portal, from a source run, or when the newest release has no Mac asset yet, Settings -> About says "No releases yet"; the "Couldn't reach GitHub" branch only runs if the IPC throws, which it never does. Once an update is staged or downloading, "Check now" also still says "X is available".
- Fix: Have `latestRelease` throw (or `updates:check` return `{ error: true }`) on network failure; show "Ready to install when you quit" when `staged` and "Downloading..." when `downloading`.

### C128 [low] startLane reads the session after long awaits
- Sections: 5 | Evidence: SUSPECTED
- Where: app/main.js:140-148
- Problem: `session.token` is read at line 148 after `await agentEnv` and `await github.sessionFolder(...)` (a long `gh repo clone`); a sign-out meanwhile gives "Cannot read properties of null (reading 'token')" after the clone ran; a different account signing in meanwhile starts the agent as the new account on the old team.
- Fix: `const { token } = session;` next to `const team = openTeam();`.

### C129 [low] An agent started on a solo team never gets the push guard after teammates are invited
- Sections: 5 | Evidence: SUSPECTED
- Where: app/main.js:147-149 (`PROTO_SHARED_TEAM` from `team.members.length > 0` at spawn; hook reads the env of that process)
- Problem: a Codex/OpenCode agent started while the owner is alone keeps running unguarded after someone is invited; only agents started later get the variable.
- Fix: say so in the invite confirmation (cheap), or make the hook ask the hub (or read a file in the clone) at push time instead of an env var.

### C130 [low] repo:reveal ignores the error shell.openPath returns
- Sections: 5 | Evidence: SUSPECTED
- Where: app/main.js:104-108
- Problem: `shell.openPath` resolves to an error string instead of rejecting; it is discarded, so "Show in Finder" does nothing and says nothing when Finder cannot open the folder.
- Fix: `const err = await shell.openPath(dir); if (err) throw new Error(err);`

### C131 [low] A second copy of the app runs the login shell and joins Bonjour before it quits
- Sections: 5 | Evidence: SUSPECTED
- Where: app/main.js:22-34, 252-253; app/teams.js:17-24 (module-level `new Bonjour()` and `find`)
- Problem: the single-instance check is near the end of main.js, after top-level code has started `zsh -ilc` (running the user's rc files a second time) and the Bonjour browser; the second copy then quits.
- Fix: do `requestSingleInstanceLock()` / `app.quit()` first and skip the rest, or build `agentEnv` lazily.

### C132 [low] swap.sh waits on the pid forever, and a second Install after a cancelled quit stages a second copy
- Sections: 5 | Evidence: SUSPECTED
- Where: app/updates.js:70-76; app/main.js `updates:install`
- Problem: if the user cancels the quit that `updates:install` asked for, the script keeps polling; a second Install stages another 150 MB and a second script that races the first at quit (the renderer has a `downloading` flag, main.js has no in-flight or already-staged guard).
- Fix: add an already-staged / in-flight guard in main.js (or in `stage`), and give swap.sh a timeout or have it exit when the pid wait exceeds a few minutes.

### C133 [low] The update check can hang for minutes on a stalled network
- Sections: 6 | Evidence: SUSPECTED
- Where: app/updates.js:33-35 (latestRelease), 20-21 (run)
- Problem: the public `fetch` has no timeout (undici about 5 minutes) and the `gh` fallback up to 300 s, so Settings shows "Checking..." that long behind a captive portal; a 200 answer that is not JSON makes `latestRelease` throw instead of returning null.
- Fix: `signal: AbortSignal.timeout(10000)` on the fetch, a 20 s timeout for the `gh api` call and a try/catch around `res.json()`.

### C134 [low] teams.js: raw network errors, and one bad hub can sink or hide results
- Sections: 6 | Evidence: SUSPECTED
- Where: app/teams.js:39-45 (hubApi), 49 (listTeams), 59-61
- Problem: (1) a dead or slow hub shows "fetch failed" or "The operation was aborted due to timeout" (the 5 s limit also covers a cold-starting online hub); (2) a non-string `data.error` becomes "[object Object]"; (3) `await hostHere(user)` in listTeams is not caught, so if the local hub cannot start the whole list, online teams included, fails with the raw error; (4) a hub answering 200 with a non-array is neither listed nor reported, and a 401 is reported as "Couldn't reach ...".
- Fix: catch `TimeoutError`/`TypeError` in hubApi and throw "Couldn't reach that hub."; `String(data.error)` only when it is a string; wrap the hostHere resume in try/catch and add the Mac to `unreachable`.

### C135 [low] listRepos reads every repo into one 20 MB buffer with a 120 s limit
- Sections: 6 | Evidence: SUSPECTED
- Where: app/github.js:81, 93-98
- Problem: `gh api --paginate --slurp` returns full repo JSON for every repo; with a few thousand repos in a large organisation it hits `maxBuffer` or the 120 s timeout and shows the raw text instead of a list.
- Fix: pass `--jq` so only name, description, private, archived and owner.login come back.

### C136 [low] `known` keeps teams found on nearby hubs after "Look for teams on this network" is turned off
- Sections: 6 | Evidence: SUSPECTED
- Where: app/main.js (`known` map, cleared only on sign-out); app/teams.js
- Problem: the GitHub sign-in is still sent to those LAN hubs for team actions until sign-out, although the user turned lookup off.
- Fix: drop the nearby-hub entries from `known` when the setting is turned off.

### C137 [low] The Bonjour browser starts at launch regardless of the nearby setting
- Sections: 6 | Evidence: SUSPECTED
- Where: app/teams.js:14-24 (module-level `new Bonjour()` and `find`, required by main.js); packager config (Info.plist keys)
- Problem: macOS 15's Local Network prompt may appear for everyone even though lookup is off by default; NSLocalNetworkUsageDescription / NSBonjourServices are not checked.
- Fix: start the browser lazily when lookup is switched on, and check the Info.plist keys in the packager settings.

### C138 [low] The `folders` allow-list for `code:*` only ever grows
- Sections: 7 | Evidence: SUSPECTED
- Where: app/main.js (`folders`, the allow-list for `code:*`)
- Problem: a removed session's folder stays openable until the app restarts; harmless (same user) but the comment says "nothing else".
- Fix: delete the entry when a session folder is removed (or reword the comment).

## Batch D: code view (app/files.js, app/code.js)

### C5 [medium] Search parses `git grep` text: every hit on a CRLF line is dropped, and paths with `:<digits>:` or quotes come out wrong
- Sections: 7, 15 | Evidence: CONFIRMED (live)
- Where: app/files.js:115-118 (regex `/^(.*?):(\d+):(.*)$/` at 117, `.filter(hit => hit.path)`)
- Problem: `.` does not match `\r`, so a match in a CRLF file (.bat, .sln, .cs, a Windows teammate's files) fails to parse and is discarded silently (only the LF file was returned in the test); text with U+2028/2029 behaves the same. A file named `colon:12:name.txt` is split as path `colon`, line 12 and opens a file that does not exist; a path with a tab or quote is C-quoted by git. Confirmed live: an untracked CRLF file's word was found by `git grep` but `proto.code.search` and the Find box returned "Nothing found." while LF files were found.
- Fix: `git grep -z -n ...` (NUL after the path and after the line number, no quoting) and split on `\0`; at least add the `s` flag or strip a trailing `\r`.

### C6 [medium] Settings font size / font / line height never reach the editor or the Terminal tab
- Sections: 8, 12, 15 | Evidence: CONFIRMED (live)
- Where: app/code.js:71, 80-83 (editor options set once), 612 (shell created once); app/renderer.js:1450-1461 (`applyPrefs` loops only `terms` and `replayTerm`)
- Problem: `applyPrefs` updates only the agent terminals; the Monaco editor and each Terminal-tab shell take their font size, family and line height once at creation (only the theme is observed live). After changing "Terminal text size", "Terminal font" or line height the code view and any open Terminal tab keep the old values until restart (confirmed live: `prefs.fontSize` 14 but the editor stayed 13 and the Terminal tab 13px).
- Fix: In `applyPrefs` (or a `codeApplyPrefs()` in code.js) call `editor?.updateOptions({ fontSize: prefs.fontSize + 0.5, fontFamily })` (and `diffEditor`) and set `term.options.*` plus `fit.fit()` for each `shells` entry (edit spans code.js and renderer.js).

### C22 [medium] Why a push was refused is thrown away: the remote's or hook's message never reaches the user
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:10-17 (`gitError`), 145 (comment "reported as is"), 146, 154, 161
- Problem: a rejected push prints `remote: <reason>`, then `! [remote rejected]`, then `error: failed to push some refs`; `gitError` returns only the last `error:`/`fatal:` line, so the person sees "couldn't be pushed: failed to push some refs to '<url>'" without the GH006 protected-branch text, GH013 rule/secret-scanning violation or their own pre-push hook output (confirmed with a pre-receive and a pre-push hook). A pre-commit hook's output does survive.
- Fix: when the extracted line is "failed to push some refs", also keep the `remote:` lines (and hook output before `To `), e.g. collect `remote: ` lines first and prefer them.

### C23 [medium] In a session folder that is a subfolder of a repo, Commit & Push commits and pushes the whole repo
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:136 (`git add -A`), with `status()` filtering to the prefix at 81
- Problem: `git add -A` stages the whole working tree from the repo root while the code view lists only changes under the folder, so the person approves one file and every other modified or new file in the repo (other work in progress, unignored local config or secrets) goes in and is pushed under their message (confirmed: `outside.txt` was in the commit); anything staged outside is included too.
- Fix: `git add -A -- .` and `git commit -m msg -- .` (cwd is the folder), or refuse with a note when the repo has changes outside the folder.

### C37 [low] A one-line comment's link only puts the cursor at column 1; it does not select the line
- Sections: 15 | Evidence: CONFIRMED (live)
- Where: app/code.js:252-254 (`showActive`: `last > line ? Selection(...) : new Selection(line, 1, line, 1)`)
- Problem: clicking the "README.md:3" link of a single-line comment opens the file and reveals the line but the selection is empty (3,1,3,1); only comments over two or more lines select their lines (confirmed live; relocation itself works).
- Fix: when `last === line` select `Selection(line, 1, line, getLineMaxColumn(line))`.

### C84 [low] A teammate's request for a changed file fails when the agent was opened in a subfolder of a repo
- Sections: 5, 7, 8 | Evidence: CONFIRMED (ran)
- Where: app/main.js:186-190 (`code:readLane` resolves against `lane.cwd`); src/lane.js:77-79 (`--full-name` repo-root paths); app/renderer.js:~1316 (`answerFile` checks `lane.files`); app/code.js (Explorer marks, `conflictRows`)
- Problem: Lane `changed`/`local` paths are repo-root-relative but `readLane` and the code view use the session folder as root, so for an agent started on a repo subfolder every teammate request for a changed file shows "That file can't be shown." (confirmed: `files.read(<repo>/sub, 'sub/a.txt')` returned `{gone:true}`) and the Explorer never marks teammates' files there (SUSPECTED).
- Fix: Keep hub paths root-relative and add the folder's prefix (`git rev-parse --show-prefix`; files.js `status()` at line 81 already strips it) when mapping in `code:readLane` and code.js.

### C85 [low] Opening a named pipe in a non-git session folder freezes the whole app
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:46-55 (`walk` lists every non-directory), 92-102 (`read` never checks `stat.isFile()`)
- Problem: in a folder that is not a git repo `walk()` lists FIFOs; clicking one calls `fs.readFileSync` in Electron's main process, which blocks until a writer appears, hanging every window (read still blocked after 4 s).
- Fix: skip entries that are neither regular files nor symlinks in `walk`; in `read` return `{ binary: true }` unless `stat.isFile()`.

### C86 [low] A push-only Commit & Push can leave conflict markers in the tree and still say "pushed"
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:150 (`pull --rebase --autostash`), 157-159
- Problem: if uncommitted edits touch lines a teammate changed, the rebase succeeds and pushes, then the autostash re-apply conflicts with exit 0: the result says "Put on top of your teammate's work ... and pushed." while the tree has `<<<<<<<` markers (`UU g.txt`) and the edits sit in `stash@{0}`. (A conflicting rebase itself is handled well.)
- Fix: after the pull check status for `C` entries (or stash list growth) and say so; or drop `--autostash` and refuse when the tree is dirty.

### C87 [low] Watcher never fires while anything keeps writing more often than every 150 ms
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:175-176
- Problem: each event restarts the 150 ms timer with no maximum wait, so while a dev server, test watcher or build writes steadily (outside node_modules: `.next/`, `dist/`, a log) `onChange` never runs and open files do not reload with the agent's edits (a file written every 100 ms for 3 s: 0 calls during the writes).
- Fix: also flush when the first pending event is older than about 1 s.

### C88 [low] In a linked worktree (every session the app creates) the watcher sees no git changes; the `.git` filter is dead code
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:171-172
- Problem: in a worktree `.git` is a file and the real git dir is under the main repo's `.git/worktrees/<name>/`, outside the watched folder, so commit, add, checkout and branch switches fire nothing (the comment promises they do); `commit --allow-empty`, `reset --soft` and `push` fire nothing even in a normal clone. Effect is limited to a delay (code.js polls every 3 s).
- Fix: also watch the path from `git rev-parse --git-dir` (and `--git-common-dir` for refs), or say in the comment that the poll covers it.

### C89 [low] Search is silently empty, and status/diff silently "clean", in a folder that is not a git repo
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:86-88, 105, 112-123; app/code.js:549 (`.catch(() => [])`)
- Problem: `list()` has a non-git fallback but `search()` runs `git grep` (fails, "no results"); `status` returns an empty branch-less result, `committed` returns '' for every file (a diff shows the whole file as added), Commit & Push throws git's error; `status()` also turns any git failure (2-minute timeout, broken repo, SUSPECTED) into "There's nothing to commit."
- Fix: `git grep --no-index` (or scan `walk`) when not a repo; hide Commit and search for plain folders; let `status` tell "not a repo" from other errors.

### C90 [low] read() throws for a symlink that leaves the folder or any fs error, and `openFile` then leaves a ghost tab showing nothing
- Sections: 7, 8 | Evidence: CONFIRMED (ran)
- Where: app/files.js:94 (`read`); app/code.js:210-221, 193-195 (`openFile` pushes the tab and sets `code.active` before `await modelFor`)
- Problem: a tracked/untracked symlink to outside the folder (`ln -s ../shared x`) is listed; opening it makes `read` throw "That file is outside the session folder." (or EACCES) instead of returning an object like `binary`/`tooBig`/`gone`; `openFile` has no catch, so the tab is active, the editor still shows the previous file, the Welcome text is hidden and nothing says why.
- Fix: return `{ outside: true }`/`{ binary: true }` from `read`, and wrap `modelFor` in try/catch storing `{ note: errorText(e) }` on the entry so the banner explains it.

### C91 [low] In a non-git folder one unreadable subfolder makes the whole file list fail
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:46-55 (`walk`), called from inside the `catch` of `list`
- Problem: a subfolder the app cannot read (permissions, macOS privacy-protected folders) makes `walk` throw EACCES, so no files are shown at all.
- Fix: wrap the `readdirSync` in try/catch and skip that folder.

### C92 [low] Past 20,000 files, the cut removes exactly the newest (untracked) files
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:40-41
- Problem: `ls-files --cached --others` prints tracked files first, so with over 20,000 tracked files `slice(0, MAX_FILES)` drops every untracked file (the new files an agent just made); they never show in the tree or Go to, and nothing says the list is cut.
- Fix: keep the paths from `status` in the list, or cap tracked and untracked separately; show a "list cut" note.

### C93 [low] Detached HEAD: a commit is made and then orphaned, with a long confusing push error; unpushed is counted against origin/HEAD
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:140 (`push -u origin HEAD`), 75 (unpushed fallback), 10-17
- Problem: on a detached HEAD Commit & Push commits, then the push fails with git's four-line "not a full refname" text; the commit exists only on the detached HEAD and `status` shows `unpushed` 2 so the button looks pushable. With no upstream and no `origin/HEAD` the unpushed count is 0 despite unpushed commits (SUSPECTED).
- Fix: refuse with "Switch to a branch first" when `branch --show-current` is empty, before committing.

### C94 [low] Smaller things in files.js
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: app/files.js:105, 60, 111-124, 132, `list()`
- Problem: (1) `committed()` does not go through `inside()`: `committed(root, '../top.txt')` returns another repo file's committed text (confirmed; boundary slip, not an escape); (2) `list()` returns an untracked nested repo as `nested/` with a trailing slash (confirmed; the tree builder likely sees an empty name, SUSPECTED); (3) `write` to a dangling in-folder symlink says "outside the session folder" and a new file in a missing folder throws raw `ENOENT ... lstat` (confirmed, nothing written); (4) a timeout shows node's `Command failed: git -c ...` text, and a slow fetch killed mid-rebase is reported as a conflict (pull/add share the 2-minute limit, push gets 15; SUSPECTED); (5) `underWay()` uses `execFileSync` with `process.env` rather than the login-shell `env`, so if git is only on the login-shell PATH the rebase guard at 132 switches off (not reproduced).
- Fix: run `committed` through `inside()`; trim the trailing `/` of nested repos; mkdir the parent in `write` and word the dangling-link error; separate timeout messages; pass the shared `env` to `underWay`.

### C95 [low] `linesOf` cannot find a comment's block when the file shrank below the comment's old line
- Sections: 8 | Evidence: CONFIRMED (ran)
- Where: app/code.js:513-516
- Problem: the nearest-first search runs `d` from 0 to `count - 1`, so when `c.line - count >= 1` the lines `1 .. c.line - count` are never tried; a comment on line 100 whose text is now on line 20 of a 50-line file is reported "lines changed, can't be found".
- Fix: loop `d` up to `Math.max(count, c.line)`.

### C96 [low] Saving a "deleted" file whose folder is gone fails with a raw ENOENT
- Sections: 8 | Evidence: CONFIRMED (ran)
- Where: app/code.js:180, 286-289; app/files.js `write` (`inside(..., {exists:false})` calls `realpathSync(dirname)`)
- Problem: the banner says "This file has been deleted. Saving puts it back." but when the parent folder is gone too the user gets `ENOENT: no such file or directory, lstat '/.../gone-dir'` and the edits stay unsaved.
- Fix: `mkdirSync(dirname, { recursive: true })` inside the folder check in `write`, or change the banner text when the parent is missing.

### C139 [low] The Plan panel stays visible under the Terminal tab
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:304 (hidden list lacks `#planPanel`); app/index.html:416, 503 (`.shell` and `.gh-panel` both `flex: 1`)
- Problem: in shell mode `renderCode` hides `#lanes, #replayPanel, #ghPanel, #memoryPanel, #backBar` but not `#planPanel`; open Plan, then the Terminal dock tab: both split the stage.
- Fix: add `'#planPanel'` to the hidden list (better: derive the list from one place).

### C140 [low] `reload` misreports and hides some disk states
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:179-186
- Problem: (1) `.catch(() => ({ gone: true }))` turns every read error into "This file has been deleted"; (2) a file that becomes binary, too big or not UTF-8 keeps the old text on screen with no banner, and the next ⌘S overwrites it without the "changed on disk" confirm; (3) `entry.stale` is not cleared when the disk goes back to `savedText`; (4) the early return skips updating `bom`.
- Fix: use `file.gone` / `file.binary|tooBig|notUtf8` to set a note (and `stale` when dirty), clear `stale` when `file.text === entry.savedText`, update `bom` before the early returns.

### C141 [low] `showActive` does not re-check what is active after its awaits
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:228-244 (line 237 clears `code.against`)
- Problem: it awaits `theirModel` (up to 12 s) and `proto.code.committed`; if another file is opened meanwhile the first file's diff replaces the second file's view while the second tab is highlighted and `code.against` is cleared on the wrong state; two quick calls can finish out of order.
- Fix: capture `path` at the top and `if (code.active !== path || code.diff !== path) return;` after each await; clear `code.against` only when it still belongs to that path.

### C142 [low] "Compare with" in Conflicts lists teammates from other repos
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:477
- Problem: `others` is every non-local lane whose `overlaps` contains the path, in any repo; the hub computes `overlaps` per repo, so teammates in another repo who changed `package.json` get a "Compare with X's" row that asks for a file from a different repo.
- Fix: filter `others` with the same repo test as `teammatesFiles` (`roomRepo ? same(o.repo || '', roomRepo) : o.session === current`).

### C143 [low] Two sessions with no folder on this Mac share tabs, models and `code.session`
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:121-123 (`openRoot` returns early when `root === code.root`); app/renderer.js:737 (`openSession` only clears `code.on`), 1158 (`linesNow`)
- Problem: with both roots null nothing resets: A's `theirs:` tabs and models show in session B, `code.active` may point at A's file, and `code.session` stays A's so comment lines stop mapping.
- Fix: `if (root === code.root && code.session === current) return;` or reset open/active/models when only the session changed.

### C144 [low] A commit's result lands in whichever session is open when it finishes
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:582-593
- Problem: `commit()` can run up to 15 minutes; if you switch sessions meanwhile "Committed and pushed." is written into the other session's note, `committing` keeps its Commit button disabled, and `finally` runs `refreshFiles()` and `code.diff = null; showActive()` for the other session; after your own commit `code.diff` is cleared for a teammate comparison too (line 592).
- Fix: capture `root`/`session` at the start; in `finally` update the note and diff only if `code.root === root`; reset `code.diff` only when `!code.against`.

### C145 [low] Commit & Push can commit files that are still conflicted
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:574-581 (with app/files.js `git add -A`)
- Problem: `commit()` only refuses while `code.underWay` is set; conflicts without MERGE_HEAD or a rebase (`git stash pop`, `checkout -m`, `apply --3way`) show as `C` but `git add -A` marks them resolved and commits the markers.
- Fix: refuse with a note when any `code.changes` state is `C`.

### C146 [low] Terminal tab edge cases
- Sections: 8, 11 | Evidence: SUSPECTED
- Where: app/code.js:602-635; app/code.js:613 (shell uses `gpu({ term }, true)` with a throwaway object, so the context is never released; same as the replay terminal in C173)
- Problem: (1) with no session folder `showShell` leaves an empty dock pane with no text; (2) `proto.shell.onExit` flips the dock to Agent whenever `code.dock === 'terminal'`, even for a shell of another root running in the background; (3) each shell calls `gpu({ term }, true)` on a throw-away object, keeping its own WebGL context hidden or not (renderer.js:1389 says only terminals on screen get one), so the ~16 context limit can take one from an agent terminal.
- Fix: show a one-line message when there is no folder; flip on exit only if the exited shell's root is `code.root`; turn WebGL off for hidden shells.

### C147 [low] Teammate-copy models: unusual URIs and orphaned entries
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:420-441, 437
- Problem: (1) `monaco.Uri.parse(`theirs://${lane}/${path}`)` turns `#` and `?` in a path into fragment/query (wrong language mode) and decodes `%41`; (2) `theirModel` captures its `entry` before the up-to-12 s wait: if the tab is closed or the session switched meanwhile the late answer creates a model for an entry no longer in `models` (re-opening then throws "model already exists", Monaco message from memory), or throws "Model is disposed" because `closeFile` did not null `entry.model`.
- Fix: `monaco.Uri.from({ scheme, authority, path })`; after the await `if (models.get(key) !== entry) return entry;` and null `entry.model` in `closeFile`.

### C148 [low] Diff views: stale original after an agent's commit, and deleted files show nothing
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:228-244, 210
- Problem: (1) the committed version is read once in `showActive`, so when an agent commits the Changes list drops the file but an open diff keeps the old original; (2) clicking a deleted (`D`) file in Changes opens it with `diff: true` but `modelFor` finds it gone and creates no model, so you cannot see what was deleted although `proto.code.committed` could supply it.
- Fix: re-run `showActive()` in `refreshFiles` when `unpushed`/`changes` for the diffed path changed; for a gone file in diff mode show the committed text as a read-only model.

### C149 [low] The file watcher keeps refreshing and re-rendering while the code view is hidden
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:169-174
- Problem: `onChanged` runs `reload` and a debounced `refreshFiles()` (full `git ls-files`, `git status`, whole-app `render()`) whenever `root === code.root`, which stays set after leaving the session, so a busy agent in an old session costs that work about every 0.4 s from anywhere in the app.
- Fix: return early in the callback unless `code.on && view === 'session'` (refresh on the next `showCode`), or call `refreshFiles({ list: false })` when no path was added or removed.

### C150 [low] A file that only exists in a teammate's checkout says "This file has been deleted."
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:197-199 (note); app/renderer.js:1012 (panel's edited-files list, `data-open-file`)
- Problem: the "Edited files" list includes teammates' files and opens them in your own checkout; for a file a teammate just created `read` returns `{gone}` and the tab says "deleted" although it never existed here.
- Fix: word it "This file isn't in your folder" when the path is not in `code.files` and not tracked (or open with `openTheirs` when a teammate's lane has it).

### C151 [low] Errors are swallowed or unhandled in several async paths in code.js
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:49-56, 99-106, 139-140, 173, 549, 648
- Problem: (1) `loadMonaco` caches a rejected promise forever while `showCode` has set `code.on = true`, so every later open fails with an unhandled rejection; (2) the Changes tab calls `refreshFiles()` with no folder and `proto.code.status(null)` rejects unhandled; (3) `setTimeout(refreshFiles, 250)` and `proto.code.watch(root)` have no catch (a rejected `list` in `openRoot` leaves no watcher and an empty-looking folder); (4) search turns any failure into `[]`, printing "Nothing found.".
- Fix: catch at those call sites, reset `monacoReady = null` on reject, show the error text in `#codeHits`.

### C152 [low] Unsaved edits parked for a session you cannot return to keep the quit warning on
- Sections: 8 | Evidence: SUSPECTED
- Where: app/code.js:34, 127
- Problem: `parked` is only emptied by re-entering the folder; if the session or folder is gone `unsavedFiles()` keeps counting those files and the quit dialog says "unsaved changes are lost" with no way to clear it.
- Fix: drop `parked` entries whose root `rootFor` no longer resolves, or list them in the dialog.

## Batch E: renderer screens and panes (app/renderer.js, app/panes.js)

### C7 [medium] agentLabel never numbers a second agent: `.indexOf(l)` is inside a comment
- Sections: 10, 15 | Evidence: CONFIRMED (live)
- Where: app/renderer.js:828 (used at 1041, 1059, 1103)
- Problem: the line ends `.sort(...) // one the hub hasn't reported yet is newest.indexOf(l);`, so the comment swallows `.indexOf(l);` and `nth` is the sorted array; a person's second agent of the same kind is still "Claude Code", never "Claude Code 2", so two same-kind agents look identical on the stage heading, agent cards and pane labels (confirmed in node). Confirmed live: 3 Claude Code + 1 Codex in one session gave labels ["Claude Code","Claude Code","Codex","Claude Code"] on the panel rows and the room caption.
- Fix: put the comment on its own line above and end the code line with `.sort(...).indexOf(l)`.

### C8 [medium] Viewers of an open agent send their terminal's automatic replies into the owner's agent
- Sections: 11, 16 | Evidence: CONFIRMED (live)
- Where: app/renderer.js:1437 (`term.onData(d => ws.send({ t: 'in', ... }))` for teammates' terminals), 1418 (`disableStdin: !mine && !l.open`); src/hub.js:612-618 (forwards `in` to open lanes and sets `typedBy`); src/hub.js:610-618
- Problem: For an open agent a teammate's xterm has stdin enabled and its `onData` also fires for the terminal's automatic replies (cursor position `ESC[6n`, device attributes `ESC[c`), including replies to queries in the scrollback replayed on every connect. Each reply goes to the hub as `in` and is typed into the owner's PTY once per viewer, leaving stray text like `;1R1;2c` at the agent's prompt and showing "Max typed, just now" when Max only watched. Confirmed live: David's `printf '\033[6n\033[c'` left `;1R1;2c;1R1;2c` at his prompt and set `typedBy` to Max (plain viewing alone does not; it needs the agent to emit a query).
- Fix: Send from a teammate's terminal only real user input (check `document.activeElement === term.textarea` in `onData`, or use `term.onKey` plus the paste event), or have the hub ignore `in` that matches terminal-reply patterns (CSI `...R`, `?...c`, focus `I`/`O`).

### C9 [medium] A pane keeps showing a session that was renamed or deleted, and "Add agent" there brings the old name back
- Sections: 12, 15 | Evidence: CONFIRMED (live)
- Where: app/panes.js:8-18, 45-61, 76; app/renderer.js:782-791 (`followRenames`), 763-767 (`deleteSession`), 1249 (`#newPane`)
- Problem: `panes` and the saved `panes:<team>` list hold session names, but `followRenames` and `deleteSession` never touch them, so a renamed or deleted session leaves a ghost pane ("No agents are running in X", counted in "2 sessions") that New pane restores from the saved list; the new name is also offered in other panes' pick lists. "Add agent" on a ghost starts nothing: it opens the New session form or, if this Mac still has a saved source for X, lets the hub recreate session X with one click. Confirmed live for the rename case.
- Fix: In `renderPanes` drop a pane whose name has no record and no lanes (and rewrite the saved list), and map renamed names through the `aliases` that `followRenames` already reads.

### C24 [medium] An old name of a renamed session is not recognised: wrong dialog wording, and a failed start can delete the real session
- Sections: 10 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:511-517 (`created`, cleanup), 631-642 (`syncSessionName`), 655 (`existingSession`), 657-681 (submit); src/hub.js:85-87 (`findSession`), 471-474 (DELETE)
- Problem: The hub resolves a typed name by name, slug, original `key` or alias; the renderer only by exact name or the slug of the current name. After "fix-login" is renamed "Login bug", typing `fix-login` keeps the "New session" wording, sets `created = true`, and if `startLane` then fails the cleanup sends `deleteSession(team.key, 'fix-login')`, which the hub resolves through the alias and uses to delete the renamed session (goal, steps, comments) when no agent runs and you created it or own the team (mismatch confirmed, deletion SUSPECTED). After a successful start `openSession` maps only exact aliases and a twice-renamed session gets another `folderKey` (new branch and folder).
- Fix: make `existingSession` match like `findSession` (name, slug, `rec.key`, `rec.aliases`) and return the record's current name; derive `created` from that and delete in the cleanup only when the saveSession response shows the session did not exist before.

### C25 [medium] Overlap labels say "1 of David's agents" when the other editor is in another session
- Sections: 11 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:1012 (`fileList`, used by session cards at 958 and Environment at 1210), 65 (`whoEdited`); src/hub.js:141-142 (overlap needs only another `tree` and the same repo)
- Problem: `fileList` builds the who-label from this session's `lanes` only, but the hub computes overlaps across all checkouts of the repo, so when David's agent in session A overlaps with Max in session B the card and Environment say `1 of David's agents` with no hint that someone else is involved (and read as a count of one); the top-bar alert names both people, so the two screens disagree (confirmed in node).
- Fix: build the label from all of `board` (the files' overlap partners), not just the session's lanes; make `whoEdited` never print "1 of".

### C38 [low] Cmd+K's list is cut at 30 before the pages and actions are reached
- Sections: 12, 15 | Evidence: CONFIRMED (live)
- Where: app/renderer.js:1580-1596 (`switcherCandidates` order, `.slice(0, 30)`)
- Problem: sessions and workspaces come first, then 7 page/action rows; with 21 sessions plus 3 workspaces 6 of 7 are visible, at 25 only 2, at 40 none, and Down-arrow cannot pass row 30; Go to file has the same cap with plain substring matching in file order, so in a big repo the best match may be missing. Confirmed live with 32 sessions: the empty switcher shows 30 rows, all kind "Session"; typing "settings" finds Settings.
- Fix: put pages and actions first (or reserve rows) and rank prefix and filename matches first for Go to file.

### C97 [low] Delete-team confirmation does not say the user's own agents are stopped
- Sections: 9 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:249-250, 254
- Problem: the "Leave" text says "Your agents in it stop" but the "Delete the team" text does not, while the code kills this Mac's agents in both cases.
- Fix: add "Your agents in it stop." to the delete text.

### C98 [low] Colours are not always distinct, and they change while people come and go
- Sections: 9 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:24-37, 39-47
- Problem: only logins with an agent get a collision-free slot; others get the raw hash slot, so when alice's agent stops grace's colour moves to slot 0 and alice (no lane) also shows slot 0: two people share a colour and a person's colour changes mid-session; the team list also uses `teamColors` left over from the previously open team.
- Fix: assign colours from the full member list ([owner, ...members]) sorted, not from the lanes.

### C99 [low] Avatar initial for a name starting with a flag or ZWJ emoji is a fragment
- Sections: 9 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:44
- Problem: `[...(name)][0]` splits by code point, so `'🇩🇪'` gives `🇩` and `'👩‍💻'` gives `👩`; the comment says "a whole emoji, not half of one".
- Fix: `new Intl.Segmenter().segment(s)` for the first grapheme.

### C100 [low] Misplaced comment above `removedFromTeam`
- Sections: 9 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:206-207
- Problem: "Disconnects from the open team and empties the board." describes `closeTeam` (line 217) but sits over `removedFromTeam`.
- Fix: move the first line down to `closeTeam`.

### C101 [low] Wording and comments that no longer match (agentHint list, openRename comment, delete confirm)
- Sections: 10 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:547 (agentHint), 793, 764
- Problem: (a) `missing.join(' and ')` reads "Claude Code and Codex and OpenCode aren't installed"; (b) the comment above `openRename` says "the hub refuses while agents run" but the hub moves running agents and keeps the old name as an alias; (c) deleteSession's confirm says "Its agents have already stopped" but the session panel's Delete (line 1242) is not disabled while agents run, so a user can confirm and get "Stop its agents first." (SUSPECTED).
- Fix: join with ", " and a final " and "; fix the comment; disable Delete in the panel while agents run or reword the confirm.

### C102 [low] Card and session totals drop other people's changes when checkouts share a branch name such as main
- Sections: 11 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:980-989 (`diffStat`), comment at 978-979
- Problem: lanes are de-duplicated by `repo|branch` and only the largest kept, which suits session branches but not `main` or a picked folder, where each lane's numbers are one person's own work (two lanes on `o/r|main` with +50/-0 and +40/-5 show only `+50 -0`); the comment "Uncommitted changes" is also wrong because `gitStatus` counts committed-on-branch plus uncommitted.
- Fix: de-duplicate only when the branch is not the repo's main (or both lanes share an upstream with no local changes); fix the comment.

### C103 [low] `renderMemory(lanes)` takes a parameter it never uses
- Sections: 11 | Evidence: CONFIRMED (ran)
- Where: app/renderer.js:1324
- Problem: dead parameter (comment-level; no behavioural effect).
- Fix: drop the parameter.

### C153 [low] "Rejoin if you're invited back" is shown even when the team was deleted, and the agents left behind cannot be seen or stopped
- Sections: 9 | Evidence: SUSPECTED
- Where: app/renderer.js:208-216 (`removedFromTeam`)
- Problem: the text "Your agents there keep running ... and rejoin if you're invited back." is appended for every reason, including "This team was deleted." (hub.js:369) where nobody can be invited back; in both cases the agents stay in `local` with their terminals hidden, nothing lists them and there is no Stop (only Sign out or quitting ends them); the lane also retries the hub every 30 s and fires `lane:refused` each time.
- Fix: for a deleted team mark the agents `stopping` and kill them (or say they keep running until you quit); for a removal list them somewhere to be stopped (e.g. the teams sheet).

### C154 [low] State of the previous sign-in survives sign-out: team list, "couldn't reach" note, repo error, "share files" setting
- Sections: 9 | Evidence: SUSPECTED
- Where: app/renderer.js:227-240 (sign-out), 294-308 (`listedTeams`, `renderTeamList.last`), 289 (`#teamsNote`), 92-93, 16
- Problem: sign-out resets `repos`, `me`, the removed note and the stored team but not `#teamList`, `listedTeams`, `renderTeamList.last`, `onlineReady`, `#teamsNote`, `#teamName` or `reposError`, so the next person sees the previous person's team names and avatars until the first `teams:list` returns (display leak, not access); `reposError` flashes in the next repo picker; the `shareFiles` preference lives in the same localStorage `prefs`, so the next person starts with the previous person's "share files" switch, which lets teammates read the files their agents changed.
- Fix: on sign-out set `listedTeams = new Map()`, `renderTeamList.last = ''`, clear `#teamList`, `#teamsNote`, `reposError` and reset `shareFiles` (or key prefs by login).

### C155 [low] `removeMember` and `invite` write back `currentTeam` without checking it is still the same team
- Sections: 9 | Evidence: SUSPECTED
- Where: app/renderer.js:374 and 391
- Problem: `currentTeam = await proto.removeMember(currentTeam.key, login)` (and invite) stores the reply even if another team was opened during the call, so `currentTeam` is team A while the watch socket is on team B until the next `state`/`openTeam`; a failed remove leaves `#peopleErr` standing on any team's People page.
- Fix: `const team = currentTeam; const next = await ...; if (currentTeam?.key === team.key) currentTeam = next;` and clear `#peopleErr` in `openTeam`/`go('people')`.

### C156 [low] Teams poll: errors never clear, and the poll stops for good if the auto-reopen fails
- Sections: 9, 12 | Evidence: SUSPECTED
- Where: app/renderer.js:277-292; app/renderer.js:285-288 (`refreshTeams`), start-up at 1681
- Problem: (1) a later successful poll does not clear `#err`; (2) on launch `return openTeam(last)` skips the `setTimeout`, so if opening the last team fails the sheet never polls again (no nearby teams, `syncWhere()` never called); (3) the catch has no `!me` check, so a poll failing after sign-out writes on the sign-in screen. Rare in practice. Seen again after a failed auto-reopen (offline at launch): the picker stays open with the error but never polls again and the "Online" radio is not disabled when `onlineReady` is false.
- Fix: clear `#err` after a successful poll, call `syncWhere()` and schedule the timer before `openTeam(last)`, and guard the catch with `!me || !$('#start').open`.

### C157 [low] Switching the theme does not recolour terminal output already written
- Sections: 9, 12 | Evidence: SUSPECTED
- Where: app/renderer.js:465-473 (`forPage` runs once at write time), 1472 (`applyPrefs`); app/renderer.js:1453-1456
- Problem: in light mode pure black backgrounds are rewritten to white as the text arrives; after switching to dark the old cells stay white blocks (and the reverse), until the CLI redraws; scrollback keeps them. After dark to light, text already on screen keeps black cells (Claude Code's mascot) on the white page until the agent redraws, and the reverse.
- Fix: accept it, or keep raw output per terminal and replay after a theme change.

### C158 [low] At launch the sign-in screen flashes (or stays, offline) until `savedUser()` resolves
- Sections: 9 | Evidence: SUSPECTED
- Where: app/renderer.js:1681
- Problem: a returning user sees "Sign in with GitHub" before the teams sheet, or for a long time offline.
- Fix: show a neutral loading state until `savedUser()` resolves.

### C159 [low] startLane is not told which team; a team switch during the goal save starts the agent in the wrong team
- Sections: 9, 10 | Evidence: SUSPECTED
- Where: app/renderer.js:509-523 (`startAgent`; opts has no team), 512, 760, 808; app/main.js:139-148 (`openTeam()` at call time)
- Problem: `proto.startLane(opts)` makes main use whichever team is open when it arrives; if another team is opened during `await proto.saveSession(...)` the agent joins the new team's hub under the old team's session name while the renderer files it under the old team. Likewise `sessionRecords = await ...` in startAgent, sessionAction (760) and rename (808) assign the old team's list into the new team's state, and rename/delete then call `sourceKey(name)` with the new `currentTeam`, moving or clearing the wrong team's saved source. Narrow window: one hub round trip.
- Fix: pass `teamKey: team.key` in opts and have main throw if `openTeam().key !== o.teamKey`; after each await in these helpers `if (currentTeam?.key !== team.key) return` before assigning or touching the store. (Related: C128.)

### C160 [low] This Mac's saved source and last agent go stale after a rename by someone else, or a delete
- Sections: 10 | Evidence: SUSPECTED
- Where: app/renderer.js:499-504 (`sourceFor`), 782-791 (`followRenames`), 763-775 (`deleteSession`)
- Problem: `followRenames` copies `source:`/`lastAgent:` only for this Mac's still-running agents; if a teammate renames while yours have stopped the "+" menu loses "Resume" and a folder session asks for its folder again; entries for sessions deleted elsewhere stay forever, and a new session with the same name later gets the stale saved source (old repo/folder).
- Fix: in `followRenames` also walk `sessions[].aliases` and copy a missing key to `r.name`; store `rec.createdAt` in the saved source and ignore it when it differs.

### C161 [low] "Add an agent" through the dialog ignores the session's saved worktree flag
- Sections: 10 | Evidence: SUSPECTED
- Where: app/renderer.js:661 (submit builds `worktree: prefs.sessionBranches`) vs 500-504 and 685-690 (`sourceFor`/`addAgent` use the saved one)
- Problem: for a session started with "own branch per session" off, "+" reuses `{repo, worktree:false}` but typing the session's name in the New session dialog starts with the current pref (`worktree: true`): the new agent gets a session branch and folder while the others are on the shared clone; the repoHint describes the pref, not the session.
- Fix: in the submit use `known.worktree` from `sourceFor` when the typed repo equals the session's repo.

### C162 [low] syncSessionName overwrites a goal already typed, and keeps the other session's source after the name stops matching
- Sections: 10 | Evidence: SUSPECTED
- Where: app/renderer.js:631-642; src/hub.js:449 (ignores a changed goal from non-creator/non-owner)
- Problem: typing a goal first and then a name that matches an existing session replaces the goal with `rec.task` without warning and does not restore it; after the match `showSource` leaves that session's repo/folder in the form when the name changes to a new session, so Enter can start a new session in the other session's repo; for a non-creator the hub silently ignores the changed goal (see C120).
- Fix: prefill the goal only when the field is empty or still holds the previous prefill; remember the source shown by `syncSessionName` and restore the user's repo/folder when the match goes away.

### C163 [low] Repo list failure silently flips the dialog to "Folder", hiding the error
- Sections: 10 | Evidence: SUSPECTED
- Where: app/renderer.js:578-584, 589-590
- Problem: when `proto.repos()` fails the radio switches to Folder, which hides `#repoField` where the only error text lives, so the user sees a mode switch with no explanation; it also overrides a "GitHub repo" choice and typed owner/name made while the request was pending; `repos` is cached until sign-out so a repo created later does not appear until restart.
- Fix: keep Repo mode when the user typed a valid owner/name or picked the radio themselves, otherwise show the error outside the hidden field (e.g. `#agentErr`).

### C164 [low] Pop-up menu: no keyboard route in, and disabled items can still run
- Sections: 10 | Evidence: SUSPECTED
- Where: app/renderer.js:691-713
- Problem: (a) focus never moves into the menu and there is no arrow-key handling, only Esc works; (b) the `pointerdown` handler closes the menu before the anchor's click reopens it, so "+" cannot close it (flicker); (c) `menu.onclick` does not check `it.disabled`: a click on the hint `<span>` inside a disabled button bubbles with `closest('button')` = the disabled button and `it.run()` may run (hub still refuses the delete; an uninstalled agent fails with an alert); (d) "Resume X" ignores `isInstalled(last)`.
- Fix: focus the first enabled button after append and add ArrowUp/Down; skip the anchor in the pointerdown check; `if (it && !it.disabled)`; pass `disabled: !isInstalled(last)` for Resume.

### C165 [low] Repo picker and failed start: keyboard focus is dropped
- Sections: 10 | Evidence: SUSPECTED
- Where: app/renderer.js:606-609 (row click re-renders), 657-681 (submit `finally`)
- Problem: picking a repo row with Enter/Space re-renders the list and drops focus to the dialog body; each row is a separate tab stop in `role="listbox"` (no roving tabindex); after a failed start the re-enabled Start button is not refocused, so Enter does nothing until the user tabs.
- Fix: after picking, focus the repo input (or the same row after re-render); in `finally` `if ($('#agent').open) button.focus()`.

### C166 [low] Rename dialog reads module state after the await
- Sections: 10 | Evidence: SUSPECTED
- Where: app/renderer.js:802-817
- Problem: the submit handler uses the module variable `renaming` after `await proto.renameSession(...)`; if the dialog is cancelled and another rename opened meanwhile, the first rename moves the second session's saved source to the first session's new name.
- Fix: `const old = renaming;` at the top of the handler and use it throughout.

### C167 [low] Alerts merge two different overlaps that have the same path in different repos
- Sections: 11 | Evidence: SUSPECTED
- Where: app/renderer.js:862-865 (`renderAlerts`)
- Problem: clashes are grouped by file path only, so unrelated clashes on `package.json` or `README.md` in repo A and repo B give one alert naming the union of people, whose click opens the first lane's session; the second clash has no alert.
- Fix: key the alert by `repo|file` (lane.repo or lane.tree) and take `who` from that group.

### C168 [low] Pin-to-file suggests files that the submit check then rejects
- Sections: 11 | Evidence: SUSPECTED
- Where: app/renderer.js:1336-1337 (suggestions) vs 1347-1357 (check)
- Problem: the datalist lists every lane's `changed` files, including a teammate's new unpushed file, but the submit checks `sessionFiles()` (this Mac's checkout), so the suggested file is refused with "There's no src/new.ts in this repo" although it exists on the teammate's Mac.
- Fix: accept paths found in `changed` as well as in `known`, or leave them out of the suggestions.

### C169 [low] Notes written in a session with no GitHub repo become team-wide, and pinned ones match same-named files in every repo
- Sections: 11 | Evidence: SUSPECTED
- Where: app/renderer.js:1341 (`repo: roomRepo`), 1323 (`roomNotes`), 1330; src/hub.js:137 (`notesFor`: `!m.repo || same(...)`)
- Problem: in a folder session `roomRepo` is '' so the note has no repo and the hub gives it to every agent in every repo; a note pinned to `package.json` or `src/index.js` is delivered before any agent in any repo reads that path; the list shows only the file name, so the writer is not told.
- Fix: in a session with no repo say "Applies to every repo" next to the form, or refuse a file pin without a repo.

### C170 [low] Comment form has no double-submit guard, and clears the next session's draft
- Sections: 11 | Evidence: SUSPECTED
- Where: app/renderer.js:1168-1176
- Problem: the text is cleared only after the request returns and the submit button is not disabled (unlike the step and note forms), so Enter twice or Enter plus a click posts the comment twice; after the await it clears `#commentText` and the line reference of whatever session is open by then.
- Fix: disable the form while the request runs and clear only if `current` is unchanged.

### C171 [low] A notification's click can open the wrong team's session
- Sections: 11 | Evidence: SUSPECTED
- Where: app/renderer.js:889 (onclick: `openSession(l.session, l.id)` against whichever team is open now)
- Problem: after a team switch a same-named session in the new team opens (or the Sessions page if there is none). (Whether notifications should fire in pane mode at all is in "Needs a decision".)
- Fix: capture `currentTeam.key` when the notification is created and ignore the click if it changed.

### C172 [low] Wording and affordances that do not match what they do (card file rows, agent cards, dock, "Ahead of main", replay font)
- Sections: 11 | Evidence: SUSPECTED
- Where: app/renderer.js:1012 (card file rows), 1187 (agent card), 1227 (dock), 1208 (Ahead of main), 1139-1142 (`fitReplay`)
- Problem: (a) file rows on session cards have `title="Open <file>"` but the Sessions page has no `data-open-file` handler, so a click opens the session; (b) agent cards have `role="button" tabindex="0"` but no key handler (only session cards do); (c) "Open <file>" on a teammate's card also sets `code.dock = 'agent'` because `closest('[data-focus]')` matches the card (the check at 1227 is before `data-theirs`); (d) Environment says "Ahead of main" even when the default branch has another name; (e) the replay terminal's font floor is 8px and ignores stage height (teammates' use 6px and fit both), and `fitReplay` does not rerun when the font-size preference changes.
- Fix: handle `data-open-file` on cards or drop the title; add Enter/Space to agent cards; test `[data-theirs]` first; word it "Ahead of the default branch"; share the font-fit logic.

### C173 [low] WebGL: a failed or lost context is retried on every render, and some contexts are never released
- Sections: 11 | Evidence: SUSPECTED
- Where: app/renderer.js:1392-1400 (`gpu`), 1030-1035, 1125; app/code.js:613
- Problem: (a) a lost context is recreated by the next `render()` (every hub state message and every 30 s), and if WebGL2 cannot be created `loadAddon` throws after registering the addon, so each render adds another dead addon per visible terminal; (b) `renderRoom` toggles `gpu` only for the current team's lanes, so another team's hidden terminals keep their context (about 16 contexts per page); (c) `gpu({ term: replayTerm }, true)` is created once and never turned off (same for the Terminal-tab shells).
- Fix: remember a failed attempt (`t.webglFailed`), turn gpu off for every hidden terminal in the first loop of `renderRoom`, and turn the replay terminal's off when the replay panel is hidden.

### C174 [low] A check in flight when "Update now" is clicked resets the bar during the download
- Sections: 12 | Evidence: SUSPECTED
- Where: app/renderer.js:1549-1558, 1561-1574
- Problem: `checkUpdates` tests `staged || downloading` only at its start; a start-up, 6-hour or "Check now" check awaiting the network when "Update now" is clicked resumes after `downloading = true`, rewrites `#updateText` and re-enables `#updateNow`, so a second click starts a second `installUpdate`.
- Fix: re-check `staged || downloading` after the await (return `update` without touching the bar).

### C175 [low] Enter in the Cmd+K box while an IME is composing picks a row
- Sections: 12 | Evidence: SUSPECTED
- Where: app/renderer.js:1620
- Problem: with a Japanese/Chinese/Korean IME Enter confirms the composition, but `onkeydown` has no `e.isComposing` test, so the same Enter runs the highlighted item.
- Fix: `if (e.key === 'Enter' && !e.isComposing)`.

### C176 [low] Menu shortcuts still act on the open team while the Switch-team picker is up
- Sections: 12 | Evidence: SUSPECTED
- Where: app/renderer.js:1654
- Problem: the guard `dialog[open]:not(#start, #settings)` leaves out `#start`, so with the picker over an open team Cmd+K, Cmd+N, Shift+Cmd+L, Cmd+P and Cmd+I still run (a second modal on top, or a session opened behind it); "Check for Updates..." and Settings open Settings under any open modal.
- Fix: treat `#start` as open for every action except 'teams', 'sidebar' and the Settings/updates ones, or close `#start` first.

### C177 [low] Cmd+N inside a session opens "Add an agent", not "New session"
- Sections: 12 | Evidence: SUSPECTED
- Where: app/renderer.js:1658; app/main.js:219 (menu label); Settings > Keyboard
- Problem: `openNewAgent(view === 'session' ? current : undefined)` makes `adding` true, so the dialog is "Add an agent" while the menu item and keyboard list say "New session"; the Cmd+K action and the page button open a real new-session form.
- Fix: pass no session from Cmd+N (Shift+Cmd+L already adds an agent to the open session) or rename the menu item.

### C178 [low] Pane empty state says "Every session is already open in a pane." when the other sessions are only done
- Sections: 12 | Evidence: SUSPECTED
- Where: app/panes.js:56-60
- Problem: `choices` leaves out sessions with status `done`, so an empty pane claims every session is open and offers no way to put a done session in a pane.
- Fix: say "No other sessions are running." (or list done sessions below the open ones).

### C179 [low] "Add agent" in a pane ignores whether the default agent is installed, and the pane-mode return is inconsistent
- Sections: 12 | Evidence: SUSPECTED
- Where: app/panes.js:76; app/renderer.js:685-690 (`addAgent`), 523
- Problem: it calls `addAgent(prefs.agent)` even when that CLI is not installed (menus grey it out), so the start fails with an alert; when `sourceFor` has no folder `addAgent` opens the New session form and returns at once, so `openPanes(panes)` runs under the form and finishing it ends in the session view, not the panes.
- Fix: pick the first installed agent when `prefs.agent` is not installed; after the form return to panes.

### C180 [low] Settings > Team does not update while open; About can stick on "Loading..."
- Sections: 12 | Evidence: SUSPECTED
- Where: app/renderer.js:1478-1487, 1515
- Problem: `#teamPane` is built once in `openSettings`, so joins/removals while it is open do not show; `new URL(info.onlineHub)` throws for a malformed hub value, leaving About on "Loading...", "Checking..." for updates and skipping the update check.
- Fix: re-render the team pane from `render()` when Settings is open; wrap the URL in try/catch.

### C181 [low] The first-run checklist cannot be dismissed when the GitHub CLI is optional
- Sections: 12 | Evidence: SUSPECTED
- Where: app/renderer.js:1633-1637
- Problem: the text says folders work without gh, yet "Finish setting up this Mac" stays at the top of Sessions on every team open for anyone without gh (it hides only when gh is installed and signed in and an agent CLI is installed); when gh is missing the same instruction appears twice (detail text and Copy button).
- Fix: count a missing gh as setup only when no agent is installed, or store a dismissed flag.

### C182 [low] Sessions page "Last modified" sort puts a just-created record-only session below older ones that have agents
- Sections: 15 | Evidence: SUSPECTED
- Where: app/renderer.js (`renderSessions` sort/rank: agent activity first)
- Problem: a session created a moment ago with no agent sorts below older sessions with agents (observed live, not verified further).
- Fix: sort by the session's `createdAt`/last change when there is no agent activity, or rename the option.

## Batch F: markup and CSS (app/index.html)

### C26 [medium] Keyboard focus is invisible on every checkbox and switch
- Sections: 13 | Evidence: CONFIRMED (ran)
- Where: app/index.html:87 (`input:focus { outline: none; ... }`) against :62 (`:focus-visible` outline); affects `.switch` (631-634), `.toggle input` (577), `.step input`
- Problem: `input:focus` (specificity 0,1,1) beats the global `:focus-visible` rule (0,1,0), so every input except hidden radios loses its focus ring; text inputs get a border-colour change but checkboxes and the `appearance:none` switches show nothing, including the six Settings switches, "Let teammates type into it", "Look for teams on this network" and the plan-step checkboxes, so a keyboard user cannot tell which one they are about to flip.
- Fix: scope the reset: `input:not([type=checkbox], [type=radio]):focus { outline: none; ... }`, or add `.switch:focus-visible, .toggle input:focus-visible { outline: 2px solid ... }` after it.

### C27 [medium] `--faint` text fails contrast in both themes, including a security warning
- Sections: 13 | Evidence: CONFIRMED (ran)
- Where: app/index.html:19 and 39 (the variable); used by `.fine` (90), `.side-label` (148), `.where` (114), `.ago`, `.card-branch`, `.person-meta`, `.panel-label`, placeholders (86), `.code-tab`, `.activity button`
- Problem: computed contrast of `--faint` is 2.37-2.96 (dark) and 2.95-3.42 (light) against the 4.5 needed for 11.5-12px text, including the line under "Look for teams on this network" ("Looking shows your GitHub sign-in to every Mac that answers...", 2.63:1 in the dark dialog), timestamps, branch names and placeholders; `--muted` is fine.
- Fix: lift `--faint` to about #8a8a93 in dark (4.6:1 on main) and about #6b6b74 in light (5.1:1), or use `--muted` for the warning/`.fine` copy and keep `--faint` for decoration.

### C104 [low] Light theme: state colours as small text are just under 4.5:1, and `.lane-label` uses the undarkened teammate colour
- Sections: 13 | Evidence: CONFIRMED (ran)
- Where: app/index.html:40-42 (`--live`, `--needs`, `--overlap` light), 310 (`.lane-label`), 48-49 (the only darkening rule, for `.avatar`)
- Problem: the comment says teammate colours are darkened where used as text on light, but `.lane-label` (the owner's name in each terminal border) uses `color: var(--c)` as is, with contrast 1.38-2.67 (nearly invisible for lime #d9e46a); light `--live` 4.51, `--needs` 4.43, `--overlap` 4.66 on white but 3.9-4.2 on canvas/raised and 3.88/4.01 on the 11% tinted pills.
- Fix: `:root[data-theme=light] .lane-label { color: color-mix(in srgb, var(--c) 62%, black); }` and darken the three light state colours slightly.

### C105 [low] The plan-step "remove" button cannot be reached from the keyboard
- Sections: 13 | Evidence: CONFIRMED (ran)
- Where: app/index.html:448-449 (`.step .stop { visibility: hidden }`, `.step:hover .stop { visibility: visible }`)
- Problem: `visibility: hidden` removes the button from the tab order and the show rule is `:hover` only (no `:focus-within`), so keyboard-only users cannot remove a step (`.ws-row .ws-menu` does it right with opacity plus `:focus-visible`).
- Fix: `.step:hover .stop, .step:focus-within .stop { visibility: visible }` or use `opacity` like `.ws-menu`.

### C106 [low] Privacy copy (in-app Data & privacy and README) understates what the hub relays and keeps
- Sections: 13, 14 | Evidence: CONFIRMED (ran)
- Where: app/index.html:1013-1015; README.md:183-185, 115; src/hub.js:143-145 (`views()`), src/shared.js:4, 16
- Problem: the lists omit what the hub holds and shows teammates for every running agent: names of changed files (up to 200), branch, git summary, last prompt (300 chars), the checkout folder paths (used for hook path checks) and each session's GitHub repo name and creator; the README says teammates see "which files changed, not what's in them" although anyone can open an agent full size and read its terminal (diffs, file contents), and the hub keeps scrollback and the last screen of 20 stopped agents in memory; "the last 256 KB" is the trim target, up to 512 KB is held (`shared.js:16` trims above 512 KB).
- Fix: add "file names changed, branch and last prompt, while an agent runs" to "Passed through the hub", say "up to 512 KB", add "repos" to the kept list, and reword README line 185 ("in the Explorer teammates see which files changed; what your agent prints in its terminal is visible to the team"). (In-app text in index.html is the main fix; README is batch G.)

### C183 [low] Settings is a non-modal overlay: it covers the update bar's buttons, and the page behind stays focusable
- Sections: 13 | Evidence: SUSPECTED
- Where: app/index.html:594-598 (`.settings`, `position: fixed; inset: 48px 0 0 var(--side)`), 139 (`.update-bar`); app/renderer.js:1499 (`.show()`, not `.showModal()`)
- Problem: (1) the update bar sits in grid row 2 right where the fixed Settings page starts, so "Later" and "Update now" are hidden while Settings is open and About has only "Check now" (no way to install from Settings); (2) nothing is `inert`, so Tab from Settings reaches the sessions page, sidebar and terminals behind it, and closing Settings does not return focus.
- Fix: set `top` from the bar's height (a `--top` variable) or give `.update-bar` `position: relative` with z-index above 5; mark `.sidebar`/`main` `inert` while `#settings` is open and focus the opener on close.

### C184 [low] No maxlength on the pinned-file and invite-username inputs
- Sections: 13 | Evidence: SUSPECTED
- Where: app/index.html:794 (`#memoryFile`), 857 (`#inviteLogin`)
- Problem: every other field has the hub's limit, but `#memoryFile` has none against the hub's 300 (`str(body.file, 300)`, hub.js:377) and `#inviteLogin` none against 39; a long pasted path is silently cut so the note is pinned to a path that does not exist, and a long username gets "That isn't a GitHub username" with no hint why.
- Fix: add `maxlength="300"` and `maxlength="39"`.

### C185 [low] Dotfile paths show reordered in the file lists (`direction: rtl`)
- Sections: 13 | Evidence: SUSPECTED
- Where: app/index.html:217 (`.files .path`); app/renderer.js:1012 (path rendered with no bidi isolation)
- Problem: `direction: rtl` keeps the file name visible but a leading neutral character moves to the right (`.github/workflows/ci.yml` shows as `github/workflows/ci.yml.`, `.gitignore` as `gitignore.`, `_private.js` as `private.js_`) in the overlap list on cards and the panel's files lists.
- Fix: prefix the path with a left-to-right mark (U+200E) in the template, or wrap it in `<bdi>`.

### C186 [low] Tab and live-region semantics are incomplete
- Sections: 13 | Evidence: SUSPECTED
- Where: app/index.html:741-742, 804 (`.panel-tabs`), 770 (`.dock-tabs`), 754 (`#codeTabs`); app/code.js:345-346 (editor tabs are `<div role="tab">` and the close control a `role="button"` span, neither with tabindex); `.error:empty` (584) with `role="alert"` at 713, 788, 799, 859, 869, 850
- Problem: (1) the Explorer/Conflicts tabs declare tab roles but `aria-selected` is never set; the Session/Environment and Agent/Terminal switchers have no roles or pressed state; the editor's tabs are not focusable so the only keyboard way to switch files is Cmd+P and tabs cannot be closed; (2) six `role="alert"` paragraphs are `display:none` while empty, which many screen readers do not announce.
- Fix: add `aria-selected` where `.on` is toggled and `tabindex`/arrow keys for the editor tabs and their close control (or drop the tab roles); keep alert paragraphs `display:block` with `min-height:0` or hide visually.

### C187 [low] Long names overflow at narrow window widths (header crumbs, filter chip)
- Sections: 13 | Evidence: SUSPECTED
- Where: app/index.html:246-251 (`.room-head`, `.crumbs b`), 179 (`.chip`), 174 (`.page-head`)
- Problem: `.crumbs b` (session name up to 60 chars) is `nowrap` with no overflow handling, so at the 900px minimum a name over about 45 characters runs under the header buttons; `.chip` is a fixed 26px high with no nowrap/ellipsis, so a long `owner/repo` filter wraps and spills out (about 14+ characters at 900px).
- Fix: `.crumbs b { min-width: 0; overflow: hidden; text-overflow: ellipsis; }` and `.chip { max-width: 100%; white-space: nowrap; }` with the text in an ellipsised span.

### C188 [low] Settings "Default agent" row does not fit between 900 and about 1060px with the sidebar open
- Sections: 13 | Evidence: SUSPECTED
- Where: app/index.html:959 (`style="min-width: 330px"`), 612 (`.setting`), 598 (`grid-template-columns: 212px 1fr`)
- Problem: at 900px the body is 440px, 344px after padding, so the 330px segmented control plus the 20px gap leaves no room and sticks out past the card (the body scrolls sideways); hiding the sidebar fixes it.
- Fix: let `.setting` wrap (`flex-wrap: wrap`) or replace the 330px min-width with `min-width: 0` and shorter labels.

### C189 [low] Keyboard list: Cmd+J is described as "Toggle the session panel", but in the code view it hides the agents dock
- Sections: 13 | Evidence: SUSPECTED
- Where: app/index.html:997, 763; app/renderer.js:1660 (`code.on ? toggleDock() : $('#panelToggle').click()`)
- Problem: with the code view open Cmd+J toggles the dock holding the agents, Terminal tab and session panel; the welcome text says "Toggle the panel", the menu "Toggle Panel", Settings "session panel"; Shift+Cmd+M "Comment on the selected lines" is listed without saying it only works with the editor focused (a Monaco keybinding, not in the menu).
- Fix: "Toggle the panel (the agents dock when a file is open)" and "Comment on the selected lines (in the editor)".

### C190 [low] Error text and most dialog text cannot be selected or copied
- Sections: 13 | Evidence: SUSPECTED
- Where: app/index.html:56 (`body { user-select: none }`), 529 (`dialog { user-select: none }`)
- Problem: `.error` paragraphs, the GitHub CLI status in Settings > Account (`#ghStatus`, which holds `gh`'s error output) and the update error in the bar cannot be selected, so users cannot copy them into a bug report.
- Fix: `.error, #ghStatus, #updateText, .settings-body p { user-select: text; }`.

## Batch G: tooling, tests and docs (scripts/, .github/workflows/, install.sh, package.json, README.md, test/)

### C28 [medium] Ctrl+C in the playground leaves both app copies running when they have agents, and deletes their folders
- Sections: 14 | Evidence: CONFIRMED (ran)
- Where: scripts/playground.js:72-76 (`stop`), 4 (header comment); app/main.js:267-275 (close handler shows `dialog.showMessageBoxSync` whenever `lanes.size > 0`, for any quit request including SIGTERM and `app.quit()`)
- Problem: `stop()` SIGTERMs each Electron copy, then `rmSync(root)` and `process.exit(0)` without waiting; the copy turns SIGTERM into `before-quit` and a close, shows "An agent is still running ... Quit / Cancel" (default Cancel), does not quit, and its home, userData and hub are deleted underneath it while the Node script has exited, leaving orphaned windows with a blocking modal (a stand-in app that cancels `close` was alive 4 s after SIGTERM).
- Fix: `a.kill('SIGKILL')` (the PTYs get SIGHUP), or add a `/quit` route calling `app.exit(0)`; wait for the children's `exit` events before `rmSync`. (Optionally have main.js skip the prompt for signal-driven quits.)

### C33 [medium] Playground control API has no authentication, so any web page or local process can run JavaScript in the app
- Sections: 14 | Evidence: SUSPECTED
- Where: scripts/playground-app.js:60-103 (`/js` at 69, `/type` 88, `/menu` 89, `/hook` 90-98), listening on 127.0.0.1:7801 and :7802 (scripts/playground.js:15)
- Problem: the server binds to loopback but checks no token, Host or Origin; `POST /js` evaluates the body as page JavaScript in the app window, which has the `proto` bridge (`proto.shell.write`, `proto.kill`, `proto.write`). A web page can `fetch('http://127.0.0.1:7801/js', {method: 'POST', mode: 'no-cors', ...})` (text/plain needs no preflight) and DNS rebinding also works, giving code execution as the user while a playground runs (the copies use the developer's real account, only HOME is swapped).
- Fix: generate a random token in playground.js, pass it as PLAY_TOKEN and require it in an `x-play-token` header (forces an unanswered preflight), or reject requests whose Host is not `127.0.0.1:<port>`.

### C34 [medium] e2e's "this run's agents" lookup also matches agents of any other Protoplasma app on the Mac
- Sections: 14 | Evidence: SUSPECTED
- Where: scripts/e2e.js:54-56 (`secretOf`, `claudePids`), 167, 224, 313
- Problem: `claudePids()` keeps every user-owned process whose command contains `claude --settings` and whose env has PROTO_HOOK_SECRET, so the installed app, the playground or a second e2e match too: line 224 (`find(pid => secretOf(pid) !== mySecret)`) can pick another app's agent (hook gets 401, "told to pull first" fails for an unrelated reason), line 167 (`.pop()`) can pick a foreign agent, and line 313 passes if any other `claude --continue` is running.
- Fix: keep only children of this process (`ps -Ao pid=,ppid=,command=` with `ppid === process.pid`, or walk up the parent chain), or have the app expose the lane's pid.

### C107 [low] test/hub.test.js: three test names claim more than they check, and large parts of the live side are untested
- Sections: 2 | Evidence: CONFIRMED (ran)
- Where: test/hub.test.js:445-454, 497-513, 534-546
- Problem: 'agents without hooks report working and idle themselves' never asserts the `hacked` status was ignored; 'a session can be renamed while nothing runs in it' renames while agents run; 'members can leave, and the owner deletes a team once its agents have stopped' only deletes an empty spare team; shell overlap tests use only `cat store.ts` (so C3 is not caught); not tested: hello validation, size clamps, reconnect with same id, reset-prefixed replay, MAX_STOPPED, slow-viewer drop, file relay timeout, PermissionRequest/Stop, the 15-file cap, same-branch and case-insensitive overlaps, `bash -lc`, `rm -rf dir`, `sed --in-place`, heredocs.
- Fix: rename the two tests; assert the status stays after 'hacked'; add the missing cases (the scratch scripts can become tests).

### C108 [low] test/workspace.test.js inherits the developer's environment: two tests fail in normal setups
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: test/workspace.test.js:11 (`env = { ...process.env, ... }`), 58-62, 87-100
- Problem: run from inside a shared-team Codex/OpenCode lane (PROTO_SHARED_TEAM=1) the "a person isn't stopped" push is blocked and the test fails; with `push.autoSetupRemote=true` the bare push succeeds (to a new session branch) and the test asserting git's "no upstream" error fails although the protection holds.
- Fix: build `env` with PROTO_SHARED_TEAM deleted plus `GIT_CONFIG_GLOBAL=/dev/null` / `GIT_CONFIG_NOSYSTEM=1`; assert that origin/main did not move instead of the message.

### C109 [low] test/workspace.test.js: test names claim more than they check
- Sections: 4 | Evidence: CONFIRMED (ran)
- Where: test/workspace.test.js:48, 87, 102
- Problem: "off the default branch" passes if the worktree were cut from HEAD; "and nobody else" checks one push; "removed only when it has nothing uncommitted" checks an untracked file only (misses C15); not covered: offline fetch, folder without .git, prune, concurrent calls, stale pointer, renamed default branch, master, deletions, --no-verify, hooksPath skip.
- Fix: add the missing cases (5-10 lines each with the existing bare-origin fixture).

### C110 [low] test/updates.test.js: the "only an app bundle in a writable folder" test cannot fail for the case it names
- Sections: 6 | Evidence: CONFIRMED (ran)
- Where: test/updates.test.js:15-18
- Problem: both assertions expect `null`, so `ownBundle` could always return null and nothing would notice (mutation run: both tests still pass); latestRelease, stage, sameSigner and swap.sh have no tests.
- Fix: add `ownBundle(tmp + '/My.app/Contents/MacOS/My') === tmp + '/My.app'` using a `mkdtemp` folder; add tests for the others.

### C111 [low] test/files.test.js: names match, but most of files.js is untested and the boundary test is weaker than it reads
- Sections: 7 | Evidence: CONFIRMED (ran)
- Where: test/files.test.js
- Problem: 7 single-line breakages of a copy of files.js all still passed 4/4: `startsWith(base + path.sep)` -> `startsWith(base)` (a sibling folder becomes readable and writable), the dangling-symlink guard removed, the rename `i++` skip removed, `--autostash` removed, node_modules/`.git` filters removed, ENOENT -> `gone` mapping removed; the boundary test accepts `/outside the session folder|ENOENT/`; list/walk, search, committed, watch, gitError, states A/D/R/M/U, the subfolder prefix, BOM/binary/size limits and worktrees are untested; temp repos are never removed (40 piled up) and the test runs with the developer's global git config.
- Fix: add cases for the sibling prefix, dangling symlink and rename first, then CRLF/colon search and a subfolder `add -A` case; `after(() => rmSync(tmp, {recursive:true}))`; set `GIT_CONFIG_GLOBAL=/dev/null` in `env`.

### C112 [low] e2e's repo-list check fails on any Mac where the GitHub CLI is missing or not signed in
- Sections: 14 | Evidence: CONFIRMED (ran)
- Where: scripts/e2e.js:87-90; app/github.js:83-87
- Problem: the check passes if the repo list loads or the text matches `/reach GitHub/`; with no `gh` ("Install the GitHub CLI...") or signed out ("Sign in to the GitHub CLI...") the step FAILs although the header says it runs on any network; with `gh` signed in it reads the developer's real private repo list.
- Fix: accept `/reach GitHub|Install the GitHub CLI|Sign in to the GitHub CLI/`, or stub `gh` through PATH for the run.

### C113 [low] sign.sh restores the keychain search list by word-splitting, which breaks for paths with spaces
- Sections: 14 | Evidence: CONFIRMED (ran)
- Where: scripts/sign.sh:25-27
- Problem: `$SEARCH` is expanded unquoted in `-s "$KC" $SEARCH` and in the EXIT trap, so a home like "/Users/John Smith/..." splits into bogus entries and the trap writes them back, dropping the user's login keychain from the search list on a local run with MAC_CERT_P12 set (CI paths have no spaces, so releases are unaffected).
- Fix: read lines into positional parameters with `IFS` set to newline, or run the local path against a throwaway `HOME`; or document that sign.sh with a certificate is CI-only.

### C114 [low] README: "on one shared team" is not what the playground sets up
- Sections: 14 | Evidence: CONFIRMED (ran)
- Where: README.md:169; scripts/playground.js:1-4
- Problem: the playground starts a hub, a repo and two signed-in copies but never creates a team or invites Max, so the user must create the team in David's copy and invite `max` first.
- Fix: reword to "two copies of the app, David and Max, on one local hub and repo" and say to create a team and invite max first (or have playground.js do it through the hub API).

### C115 [low] README wire-protocol table leaves out messages the hub sends and receives
- Sections: 14 | Evidence: CONFIRMED (ran)
- Where: README.md:152-159 against src/hub.js (onLane 521, relayFile 580, onWatcher 598, broadcastState)
- Problem: missing: `file:get {lane, path, ask}` / `file:put {req, text, error}` (app -> hub) and `file:get {req, lane, path, from}` / `file:put {ask, text, error}` (hub -> app), `members` in `state`, `local`/`unpushed` in the lane `git` message, the steps routes and renaming, and the `hello` field list (id, hookSecret, session, cmd, root, roots, repo, git, cols, rows, open, history).
- Fix: add the four `file:*` rows, `members`, `local`/`unpushed`, steps, and a one-line `hello` field list.

### C116 [low] README install: the documented command needs the GitHub CLI although it calls it optional
- Sections: 14 | Evidence: CONFIRMED (ran)
- Where: README.md:115-121; install.sh:11-17
- Problem: the one-liner is `gh api ... | sh`, needing `gh` installed and signed in, while line 115 says the CLI is optional; install.sh has a curl path for a public repo that the README never shows.
- Fix: say that the one-liner needs `gh auth login` (or, if the repo is public, give the `curl -fsSL https://raw.githubusercontent.com/dw8-ro/protoplasma-ide/main/install.sh | sh` form).

### C191 [low] e2e swallows every alert, has no overall timeout and leaves temp folders
- Sections: 14 | Evidence: SUSPECTED
- Where: scripts/e2e.js:65 (stub; `window.__alerts` never read), 44, 26, 80, 217, 361 (temp dirs), 40-49 and 51-66 (no timeout)
- Problem: the app reports real errors via `alert(errorText(e))` (renderer.js:253, 481, 533, 677, 689, 761; code.js:289, 624) but no check prints or asserts them, so a flow that now alerts can still pass; a hung page or a throw before the try block (line 65) leaves the hub keeping the process alive with no summary or exit code; each run leaves `protoplasma-e2e-*`, `-remote-`, `-other-`, `-teammate-`, `-trust-` folders in the temp dir.
- Fix: print `__alerts` in the `finally` (fail on any besides "stopped as soon as it started"), add a global timeout that sets the exit code and quits, remove the temp dirs in `finally`.

### C192 [low] The release script and workflow check little: any pushed `v*` tag ships to every installed copy
- Sections: 14 | Evidence: SUSPECTED
- Where: package.json (`release`), .github/workflows/release.yml:5-7, 21-25
- Problem: (1) `npm version patch && git push --follow-tags` only checks the branch name, so with local main behind origin/main `npm version` has already made the commit and tag when the push is refused (a skipped version and a stale local tag); (2) release.yml runs on any `v*` tag from any commit and checks the tag against package.json but not that the commit is on main or that CI passed, so a hand-made tag from a branch is published and auto-installed by every copy within hours; (3) a re-run after a partial failure fails at `gh release create`.
- Fix: in the script `git fetch && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]` before `npm version`; in the workflow `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` (with `fetch-depth: 0`) as the first step.

### C193 [low] CI never builds or signs the app, so packaging mistakes surface only when a tag is pushed
- Sections: 14 | Evidence: SUSPECTED
- Where: .github/workflows/ci.yml:12-23, package.json `dist`
- Problem: CI runs `npm ci` with the Electron download skipped and `npm test` only, so a bad `--ignore` regex, a missing file in the asar or a packager/electron problem is first seen in release.yml, after the version commit and tag exist on main.
- Fix: a second CI job (or a step on PRs touching package.json) that runs `npm run dist` and checks the asar lists `src/hub.js`, `app/index.html` and `node_modules/monaco-editor/min`.

### C194 [low] install.sh over a running copy leaves the old version running, and the message says it installed
- Sections: 14 | Evidence: SUSPECTED
- Where: install.sh:21-27 (header comment 20-24)
- Problem: the script replaces /Applications/Protoplasma.app while it may be open, then `open` only brings the old process to the front, so the user sees "Installed Protoplasma" and keeps using the old version; the "a failed move never leaves you with neither" comment holds only until the `rm -rf` on line 23 (if the last `mv` then fails, only `.app.new` remains).
- Fix: quit the app first (`osascript -e 'tell application "Protoplasma" to quit'`) or print "Quit and reopen Protoplasma to use the new version" when `pgrep -x Protoplasma` finds it; move the old copy aside instead of `rm -rf` and delete it after the final `mv`.

### C195 [low] playground.js can print "ready" when nothing is ready, and setup failures leave processes and a temp folder
- Sections: 14 | Evidence: SUSPECTED
- Where: scripts/playground.js:19-64, 66-70; scripts/playground-app.js:103
- Problem: the readiness loop gives up silently after 100 tries (30 s) and the banner prints anyway; the fixed control ports 7801/7802 make a second playground fail `listen` with an uncaught EADDRINUSE while the loop polls the other playground and reports ready; no try/catch around setup, so a failing `git` call after the first copy was spawned leaves the Electron copies and temp folder behind; SIGINT is registered only at the end.
- Fix: register `stop` first, wrap setup in try/catch calling it, pick free ports (listen on 0 and write the port to a file in PLAY_DIR), exit with an error if a copy is not ready in time.

### C196 [low] package.json allowScripts pins exact versions, so a routine bump silently skips Electron's and node-pty's install scripts
- Sections: 14 | Evidence: SUSPECTED
- Where: package.json (`allowScripts`: node-pty@1.1.0, electron@44.5.1)
- Problem: npm 11.19 honours `allowScripts` and rejects ranges, so entries must match locked versions exactly; after `npm update` electron@44.5.2 is not covered, its postinstall (binary download) is skipped and `npm start` fails with "Electron failed to install correctly" until the entry is edited (CI and release use `npm ci`, so only a bump without editing breaks).
- Fix: note the pairing in the README "Development" section (JSON has no comments) or run `npm install-scripts approve` as part of any bump.

---

## Needs a decision (not a plain bug)

Each of these works as designed or has more than one reasonable fix. Pick an option; the related plain items are named so they can be done in the same batch.

### D1. Team identity: GitHub login string or numeric id
- Sections: 1 | Evidence: SUSPECTED | Where: src/hub.js:80 (`onTeam`), 487-494 (invite), 43 (`githubUser` drops the numeric id)
- Today members and the owner are stored as the typed login; if a GitHub account is renamed the old login can be claimed by someone else, who then signs in as that member (or as the owner, who can delete the team and read every shared terminal); the hub never checks an invite against GitHub (the app does, through `findUser`).
- Options: (a) store the numeric id next to the login and match on the id (migrate teams.json on first sign-in; best protection); (b) keep logins but make the hub check an invite with `GET /users/<login>` (and `type === 'User'`); (c) keep as is and say so in the README. Related plain items: C55, C81, C44.

### D2. GitHub token sent in clear text (`ws://`, `http://`) to LAN hubs
- Sections: 9 (also lane.js and teams.js) | Evidence: SUSPECTED | Where: app/renderer.js:408-410 (`/watch` first frame carries `conn.token`), src/lane.js (hello), app/teams.js (REST calls); CSP allows `ws:`
- For "This Mac" and nearby teams the hub URL is `http://<ip>:<port>`, so anyone sniffing the same Wi-Fi can read the user's GitHub (read:user) token. This is separate from the already-decided "Look for teams" opt-in (which is about unknown hubs); here even the chosen hub is reached in clear text.
- Options: (a) the hub issues a short-lived hub-scoped token after one verified sign-in and the app sends only that afterwards; (b) serve LAN hubs over TLS (self-signed with pinning); (c) only send the real token to hubs the user explicitly added and use (a) for nearby ones; (d) accept and document that LAN hubs are clear text. Related plain items: C11, C136.

### D3. The in-process hub listens on every interface even with "Look for teams on this network" off
- Sections: 14 (outside note) | Evidence: SUSPECTED | Where: src/hub.js:55 (`host` defaults to 0.0.0.0), app/teams.js:31 (`PROTO_BIND` unset)
- A team hosted on "This Mac" is reachable from the whole LAN regardless of the nearby setting; together with C2 anyone on the network can take down the Electron main process until that is fixed, and with C11/C10 can burn quota or memory.
- Options: (a) bind to 127.0.0.1 until the user turns on sharing (nearby lookup or "invite from this Mac"); (b) keep 0.0.0.0 (teammates connect by URL) and rely on the fixes in C2, C10, C11; (c) ask once when a This Mac team is created.

### D4. Protecting branches other than main and master, and branch deletions
- Sections: 4 | Evidence: CONFIRMED (ran) | Where: src/workspace.js:57 (names `main`/`master` only), 61 (`[ "$local_sha" != "$zero" ]` skips deletions); README line 107
- A repo whose shared branch is `develop`, `trunk`, `production` or `release` is not protected, and a shared-team Codex/OpenCode agent can also delete any branch except main/master, including a teammate's pushed session branch (`git push origin :session/theirs`), which destroys work as thoroughly as a force push.
- Options: (a) also block the branch `origin/HEAD` points at (the clone already knows it) and deletions of any `refs/heads/*` other than the agent's own `session/*` branch; (b) a per-team protected-branches list set by the owner; (c) keep main/master only and state in the README that deletions and other branches are not covered. Related: C70, C69.

### D5. Should `git push --no-verify` bypass the push guard?
- Sections: 4 | Evidence: CONFIRMED (ran) | Where: src/workspace.js:50-66 (the hook's own header comment says "To push anyway: git push --no-verify"); README ("stops them")
- For Codex/OpenCode the pre-push hook is the only barrier and one flag (or `-c core.hooksPath=...`) skips it (a push to main with PROTO_SHARED_TEAM=1 was allowed). For Claude the guard is a hub-side heuristic that was already decided as acceptable.
- Options: (a) accept it: reword the README to "discourages" and drop the `--no-verify` hint from the hook comment; (b) add server-side branch protection on GitHub for main (outside the app); (c) put a `git` shim first on PATH for Codex/OpenCode lanes that refuses `--no-verify` / `-c core.hooksPath` on push (stronger, more code); (d) have the hub also watch pushes reported by the lane's git status and warn after the fact.

### D6. Notifications policy: when a system notification should fire
- Sections: 11, 12 | Evidence: SUSPECTED | Where: app/renderer.js:877-889 (`notifyChanges`: the "already looking at it" test requires `view === 'session' && current === l.session`)
- In pane mode (`view === 'panes'`) agents that are on screen still raise a notification for every needs-you or finished event; the click handler problem is a plain bug (C171).
- Options: (a) also skip when the lane is in `paneLaneIds()` and the window is focused; (b) notify only when the window is not focused, whatever is on screen; (c) keep as is and add a setting ("Also when the agent is on screen"). Related: the Settings > Notifications copy.

### D7. Agents already running when a solo team gets its first teammate
- Sections: 5 | Evidence: SUSPECTED | Where: app/main.js:147-149 (`PROTO_SHARED_TEAM` fixed at spawn from `team.members.length > 0`)
- A Codex/OpenCode agent started while the owner is alone keeps running without the push guard after someone is invited.
- Options: (a) say so in the invite confirmation ("agents already running are not guarded until restarted"); (b) make the hook ask the hub, or read a file in the clone, at push time instead of an env var; (c) always set the variable and let the hook ignore it for solo teams. (Listed as plain item C129 with option (a).)

### D8. Shared session branch name when two people run the same session
- Sections: 16 (outside note) | Evidence: CONFIRMED (live) | Where: src/workspace.js (`session/<slug>`), app/code.js (Commit & Push)
- Everyone in a session uses the same `session/<slug>` branch on origin, so two people's Commit & Push collide (the refusal text tells them to pull in the Terminal tab). This is how a shared session branch works.
- Options: (a) keep, and make the refusal message offer "Pull" as a button; (b) suffix the branch with the login (`session/<slug>-max`) and compare through the session's base; (c) keep and document.

---

## Reported but not kept, and notes

- Refuted: section 3's outside note that `auth:signOut` leaves agents running with the old token. The renderer stops every local agent before it calls sign-out (app/renderer.js:226-231, `proto.kill` then `proto.signOut()`); section 5 said the same. The part that is true (the hub, Bonjour ad and shells stay running) is in C18 and C30.
- Not a bug: renderer.js `answerFile` trusting `lane.files` from a malicious hub host (section 9 outside note); section 5 checked that `code:readLane` confines paths with the exact-match `folders` allow-list and `inside()` (symlinks, `..`).
- Not a bug: the editor reads files up to 2,000,000 bytes while the hub drops teammates' files over 1,000,000 characters (section 8 outside note); the mismatch only costs a wasted upload, covered in C48.
- Not a bug / latent: renderer.js:1537 `$('#updateStatus').textContent` is unguarded (section 13 outside note); safe today because the button only exists after `appInfo()` resolves.
- Not verified: Monaco workers under the CSP (section 13 outside note); section 15 used the code view live (open, edit, save, diff, find) and no failure was reported.
- Nothing found: section 1's outside question whether a `gh` CLI token (repo scope) is ever sent to a hub; no section reported any.
- Playground-only observations left out (expected, no action): the "Finish setting up this Mac" banner stays because `gh` is not signed in (15); the Terminal prompt shows the real macOS user for both copies (16).
- Section 2 and section 16 both measured `shellWriteRisk`; their findings are merged into C3, C4 and C35. Section 1 and 2 both found the WebSocket crash; the crash is the same defect as the unhandled `error` event in section 1.

# Section 1: hub API and storage (src/hub.js, commit 817f96a)

Throwaway scripts: `scratch/01/` (child.js + lib.js start a hub in its own process with a stub verifier; http.js, crash.js, persist.js, gate.js). No repo files touched.

## Covered
- Constants and `githubUser` (401 -> null, other non-OK -> throws, 8 s timeout, `/user` only).
- `startHub` options; `str`, `same`, `parse`; persistence: load, damaged file moved aside, oddly shaped file, tmp-and-rename save, failed save logged.
- `onTeam`, `keyOf`, `findSession`, `ensureSession` (cap, aliases), rename clash check.
- Identity: `identify` (type and 500-char check, sha256 cache, 2 min / 10 s TTL, shared `lookups`, 503 vs 401), heartbeat pruning of the cache.
- HTTP: `readBody` (413 path, aborted body, chars vs bytes), `bearer`, `secretMatches`, URL parsing (`new URL`, dot segments, `%2e`, `//`, bad `%`), routing and the 404 rules, hooks auth and body handling, error handler (413 / 503 / 500).
- Routes: GET/POST/DELETE `/teams`, `owners` limit, members (invite, remove, leave, owner can't leave, login validation), memories (add, remove, cap, author/owner rule), sessions (create, goal, done, rename, delete, caps, 409s), comments (add, remove, cap, line fields), plan steps (add, edit, tick, remove, cap).
- Permission matrix and status codes (401/403/404/409/400/413/503).
- WebSocket: upgrade routing and the 404 branch, `authenticate` gate (early queue and replay, 1013 / 4001 / 4003 closes, 10 s timer), missing socket `error` handlers before and after sign-in, `maxPayload`.
- Heartbeat (`alive` / ping / terminate, `unref`), `close`, `listen` error handling.
- Standalone startup (PORT, HOST, DATA_DIR, PROTO_OWNERS) and the README/Dockerfile statements about it.

## [high] Anyone can crash the hub with one bad WebSocket frame or a reset connection
- Where: src/hub.js:651-661 (upgrade handler; no `ws.on('error')` anywhere, and no `sock.on('error')` in the 404 branch at 655), 679 (`server.once('error', reject)` stays attached after listening, so it swallows only the first later server error)
- What happens: `ws` emits `'error'` on a connection for a frame over `maxPayload` (5 MB), a text frame that isn't valid UTF-8, and other protocol violations. Nothing listens, so Node throws "Unhandled 'error' event" and the process exits. No token, team or account is needed (it works before sign-in, and the same missing handler applies after sign-in). Separately, an upgrade request to any path other than /lane or /watch followed by a TCP reset makes `sock.end()` fail with EPIPE on a socket with no listener, which also exits the process. On a hosted hub every team goes down until restart (lanes retry every 3 s, so a loop of one request keeps it down); a hub started inside the app takes down the Electron main process.
- Evidence: CONFIRMED (scratch/01/crash.js, each in its own hub process): (A) /watch + one 6 MB frame -> exit 1, "RangeError: Max payload size exceeded ... Unhandled 'error' event"; (B) /lane + raw text frame bytes ff fe fd -> exit 1, "Invalid WebSocket frame: invalid UTF-8 sequence"; (C) 30 upgrade requests to /nope each followed by `resetAndDestroy()` -> exit 1, "write EPIPE".
- Suggested fix: in the `handleUpgrade` callback add `ws.on('error', () => {})` before `authenticate`; in the 404 branch add `sock.on('error', () => {})` before `sock.end`; use `server.on('error', ...)` for later server errors. Add a test that sends an oversized frame and then checks the hub still answers.

## [high] A session named ".." turns "delete this session" into "delete the whole team"
- Where: src/hub.js:324 (`new URL(...).pathname` collapses `.` and `..` segments, including `%2e`), 442 and 461 (a session name is only trimmed and cut to 60 characters), 363-371 (team delete); app/teams.js:80 (`sessionRoute` uses `encodeURIComponent`, which leaves dots alone)
- What happens: any team member can create a session called `..` (POST /sessions, or an agent started with that session name). When the owner then deletes that session in the app, the request path is `/teams/<id>/sessions/..`, which becomes `/teams/<id>/` before the hub sees it, so the hub runs the team delete: all sessions, plans, comments and notes are gone (it only refuses with 409 while an agent runs). A session called `.` can never be finished, renamed, commented on or deleted (its path collapses to `/teams/<id>/sessions/`, 404 / "No such session").
- Evidence: CONFIRMED (scratch/01/http.js): bob created `..` (200) and `.` (200); alice's `DELETE /teams/<id>/sessions/..` returned 200 `{}` and her `GET /teams` went from 1 team to 0; `DELETE .../sessions/.` returned 404; a comment on `.` returned 404 "No such session".
- Suggested fix: refuse session names that are only dots (and ideally any name whose slug differs from what the user typed in a way that matters) when creating, renaming and when a lane joins; optionally have the hub answer 400 for any raw path segment that is `.` or `..` before normalising.

## [medium] Unauthenticated sockets can make the hub buffer 100 x 5 MB each
- Where: src/hub.js:629 (`early.length < 100 && early.push(raw)`), 650 (`maxPayload: MAX_HOOK_BODY`)
- What happens: until the first message has been verified (a GitHub round trip, up to 8 s) every later message from that socket is queued; the cap is a count, not bytes, and each message may be 5 MB. A client needs no valid token: send one first message with a throwaway token, then stream frames. There is also no cap on the number of unauthenticated sockets. A few sockets push a small hosted hub out of memory.
- Evidence: CONFIRMED (scratch/01/crash.js, case D, verifier takes 3 s): 3 sockets x 100 x 4.9 MB: hub RSS 50 MB -> 845 MB while verification was pending.
- Suggested fix: cap queued bytes (for example 64 KB, then close 1009), cap the size of the first message, and limit unauthenticated sockets per address.

## [medium] Every distinct bad token costs a GitHub request; nothing limits it
- Where: src/hub.js:108-117 (`identify`), 344 (HTTP), 633 (WebSocket)
- What happens: the cache and the shared lookup are keyed by the token's hash, so a caller who sends N different junk tokens makes the hub call api.github.com N times (a rejected token is remembered 10 s, but only for that same token). The hub is a public endpoint, so this is a free way to burn its GitHub quota or get its address throttled; GitHub then answers 403/429, which `githubUser` turns into 503 / close 1013 for every real user ("The hub couldn't reach GitHub").
- Evidence: CONFIRMED for the call count (scratch/01/gate.js: 300 requests with 300 different tokens -> 300 verifier calls). SUSPECTED for the GitHub-side throttling (not run against GitHub).
- Suggested fix: reject tokens that don't look like GitHub tokens before asking (prefix and length), limit concurrent lookups, and rate-limit failed lookups per client address.

## [low] A teams.json that parses but isn't a list of well-formed teams stops the hub or breaks it for others
- Where: src/hub.js:65-70 (only a parse error is handled; no shape check), 80 (`team.members.some`), 86 (`team.sessions.find`)
- What happens: valid JSON of another shape (`null`, `{}`, `"x"`, `[null]`) throws a TypeError inside `startHub` before it listens, so a container crash-loops and the "moved aside, hub started empty" promise in the comment doesn't hold. A team record without `members` (or with `members: null`) makes `onTeam` throw for every user who isn't its owner, so their `GET /teams` returns 500. `sessions: null` or `[null]` makes creating a session return 500. (The file is written atomically, so this needs a hand edit or another tool's output.)
- Evidence: CONFIRMED (scratch/01/persist.js): `null`, `{}`, `"x"`, `[null]` -> hub does not start, no file moved aside; empty and truncated files are moved aside and the hub starts; no `members` / `members:null` -> bob (member) gets 500, alice 200; `sessions:null` and `sessions:[null]` -> create session 500.
- Suggested fix: after parsing, accept only an array of objects with string id and owner, an array `members`, `sessions` and `memories` (fill missing ones with `[]`); otherwise treat it like a parse error.

## [low] Output sent while sign-in is pending is silently dropped after 100 messages
- Where: src/hub.js:629
- What happens: a lane sends `hello` and then keeps streaming `out`. While the hub asks GitHub (cold cache after a hub restart, or an expired entry), the first 100 later messages are replayed and the rest are discarded without a trace. Teammates' screens and the hub's scrollback for that agent keep a hole that is never repaired.
- Evidence: CONFIRMED (scratch/01/gate.js, verifier takes 1 s): 150 `out` chunks sent right after hello; a watcher saw 100 (chunks 0-99).
- Suggested fix: queue by bytes, and close the socket (so the lane reconnects and resends its history) instead of dropping.

## [low] PROTO_OWNERS set but blank means nobody can create a team
- Where: src/hub.js:687 (`owners` is `[]` for an empty variable), 350 (`owners && !owners.some(...)`)
- What happens: on a host where the variable exists but is empty (a placeholder in a Railway template, `PROTO_OWNERS=`), `''.split(',')...filter(Boolean)` gives `[]`, which is truthy, so every create-team request gets 403 "only lets its owners create teams" and the start-up line prints "teams created by " with nothing after it.
- Evidence: CONFIRMED (scratch/01/gate.js): `owners: []` -> 403; the split expression gives `[]`.
- Suggested fix: `const owners = ...; startHub({ owners: owners?.length ? owners : undefined })`.

## [low] Input limits are looser than they look
- Where: src/hub.js:59 (`str`), 315 (`body.length > max`), 404 (`line | 0`)
- What happens: (a) `str` turns objects, arrays and numbers into text: `{"name": {"a":1}}` creates a team called "[object Object]", `{"text": ["a","b"]}` saves the note "a,b". (b) The body limits count characters, not bytes: 40,000 two-byte characters (80,000 bytes) pass the 64 KB limit, and the 5 MB hook limit can mean about 15-20 MB of UTF-8. (c) A comment line number above 2^31 wraps (`3e9 | 0` is negative), so the comment silently loses its file and line.
- Evidence: CONFIRMED (scratch/01/http.js): team named "[object Object]" created; 80,000-byte body -> 201; comment with line 3e9 saved with file/line null.
- Suggested fix: make `str` return '' for non-strings; count bytes with `Buffer.byteLength`; clamp line numbers with `Math.min`.

## [low] An unparseable JSON body is treated as an empty one, so the error message points at the wrong thing
- Where: src/hub.js:346 (`parse(...) || {}`)
- What happens: `POST /teams` with `{not json` answers 400 "Give the team a name." and a note POST with `[1,2` answers "Write the note first." A client with a bug gets a message about a field it did send. No crash and no data loss.
- Evidence: CONFIRMED (scratch/01/http.js).
- Suggested fix: answer 400 "That wasn't valid JSON." when the body is non-empty and doesn't parse to an object.

## [low] Team membership is a bare login string
- Where: src/hub.js:80 (`onTeam`), 487-494 (invite checks only the pattern), 43 (`githubUser` drops the numeric id)
- What happens: members and the owner are stored as the login that was typed. If someone renames their GitHub account the old login becomes claimable by anyone; whoever claims it signs in as that member (or as the owner, who can delete the team and read every shared terminal). A mistyped invite is never checked against GitHub, so a stranger can be added.
- Evidence: SUSPECTED (by reading; GitHub allowing a released name to be claimed again was not tested).
- Suggested fix: store the numeric GitHub id with the login and match on it; check an invite with `GET /users/<login>`.

## [low] The invite pattern rejects logins with an underscore
- Where: src/hub.js:17 (`GITHUB_LOGIN`)
- What happens: GitHub Enterprise Managed Users have logins like `name_company`; inviting one answers 400 "That isn't a GitHub username."
- Evidence: CONFIRMED that `dave_corp` gets 400 (scratch/01/http.js); SUSPECTED that such accounts use the hub (they can't sign in with the public device flow, so this may never matter).
- Suggested fix: allow `_` inside the name, or leave it and note it in the README.

## [low] Comments and docs that no longer match the code
- Where: src/hub.js:1-2; README line 150; src/hub.js:66-68
- What happens: the header says the hub "never runs agents or sees code", but it stores the text of commented lines (README line 183 says so) and relays shared files. README line 150 says "nothing else is accepted until both are verified", but up to 100 messages are queued and replayed after sign-in. The comment at 66-68 says a damaged file is moved aside "rather than stopping the hub from starting", which only holds for unparseable files (see the teams.json finding).
- Evidence: CONFIRMED by reading.
- Suggested fix: reword the three places.

## [low] Removing someone who isn't on the team succeeds
- Where: src/hub.js:496-505
- What happens: the owner's `DELETE /teams/<id>/members/carol` for a non-member returns 200 with the team, rewrites teams.json and broadcasts state, instead of 404. Harmless, but it hides a typo.
- Evidence: CONFIRMED (scratch/01/http.js: 200).
- Suggested fix: 404 when no member matched.

## [low] Every state broadcast carries all sessions with all comments and plan steps
- Where: src/hub.js:163
- What happens: `sessions: team.sessions` is sent to every watcher on each git report, resize, look and every 30 s. At the caps (200 sessions x 100 comments x ~1 KB) that is about 20 MB per message per viewer; normal teams are far below that.
- Evidence: SUSPECTED (by reading; sizes from the caps).
- Suggested fix: send comments and steps only for the session a viewer is looking at, or send them on change.

## [low] A hosted hub without DATA_DIR says nothing about keeping teams only in memory
- Where: src/hub.js:688-689, Dockerfile, README line 144
- What happens: if the volume or `DATA_DIR` is missing, the hub starts normally ("Protoplasma hub on port 7681") and every redeploy silently erases all teams. README and Dockerfile mention the variable, but nothing at start-up does.
- Evidence: SUSPECTED (by reading).
- Suggested fix: print "teams are kept in memory only (set DATA_DIR)" when `dataDir` is unset in the standalone entry.

## Checked and fine
- Permissions: team delete (owner only, 409 while agents run, 404 for non-members), invite/remove (owner), leave (self), owner can't leave, notes and comments (author or owner), sessions (creator or owner; anyone can join/create), steps (any member), goal edits only by creator or owner, wrong hook secret 401.
- Limits: 64 KB API body and 5 MB hook body -> 413 with the client receiving it; aborted body does not hurt the hub; notes 200, sessions 200, comments 100, steps 50.
- Identity: 401 for a rejected token, 503 when GitHub fails, close 1013 for the same case, 4001 (bad token / 10 s timeout, confirmed 10003 ms), 4003 (not on team / unknown team).
- Persistence: tmp-and-rename save; empty and truncated files are moved aside and the hub starts.
- Heartbeat logic and `unref`; standalone port/host defaults.

## Outside my scope
- app/github.js:2 says the token sent to hubs is a read:user device-flow token; worth checking in section 6 that nothing sends the `gh` CLI token (repo scope) to a hub.
- app/teams.js:80 builds session URLs with `encodeURIComponent`; the app could also refuse dot-only session names (hub fix above is enough).
- src/lane.js treats every close code >= 4000 except 4003 as final, so a hub-side 4001 "Sign-in timed out" is never retried; check in section 3.
- Session aliases keep only the last 5 old names (hub.js:468); an agent that started under an older name after 6+ renames would make a duplicate session. Section 2 (lanes) may want to look.

## [low] The 10 s sign-in timer closes with 4001 even while a verification is still pending
- Where: src/hub.js authenticate() (the 10 s timer)
- What happens: on a very slow link the timer fires before the GitHub lookup returns and closes with 4001 ("sign in"), which src/lane.js never retries.
- Evidence: SUSPECTED (reading; added by the lead from the agent's final message)
- Suggested fix: close with a retryable code (1013) when the lookup is still pending, or clear the timer once the first message arrives.

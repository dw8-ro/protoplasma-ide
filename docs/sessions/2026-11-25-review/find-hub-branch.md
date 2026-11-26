# hub-branch review (src/hub.js, src/shared.js)

## F1 PUSH_CONFIG misses remote.<name>.mirror, --config-env and GIT_CONFIG_* (medium, on_main_too: yes, no config check at all on main)
src/hub.js:450 (PUSH_CONFIG), 464 (-c redirect), 469-472 (git config key)
Probe (work/find-hub-branch/probe.js + push.js, local hub, lane on session/fix, team with a member): these all PASS without an ask:
- `git -c remote.origin.mirror=true push` -> real git (temp repo): `+ main -> main (forced update)`, plus pushes every ref and prunes. Force-push to main, remote commits lost.
- `git config remote.origin.mirror true && git push` (same)
- `X=HEAD:refs/heads/main git --config-env=remote.origin.push=X push` -> real git: `HEAD -> main`.
- `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main git push`
- `git config remote.origin.push HEAD:main --show-origin` -> real git exit 0 and the value IS set (the read-flag exclusion looks at any word in the part, not just the mode).
Fix: add `mirror` to PUSH_CONFIG (`remote\..+\.(push|pushurl|mirror)`), match `--config-env[= ]key=` like `-c`, treat a `GIT_CONFIG_KEY_n=<PUSH_CONFIG>` word as a redirect; only exempt `--show-origin`/`-l` when there's no value word after the key (or drop --show-origin from the exemption list). Older audit-worktree version is identical (no stronger).
Progress: F1 written; checked views() fields (no root/roots/hookSecret/history), toTeam sees filter is team-scoped, rename moves sees, key handler only from lane socket, lane.js key sender drops when offline, hooked carried via before/stopped, PUSH_CONFIG identical to audit worktree version.

## F2 claimsOn marks every match as told but returns only 3: the 4th+ claims are never said (low, new code)
src/hub.js:583-587 (`lane.toldClaims.add(key); found.push(...)` then `return found.slice(0, 3)`)
Repro (work/find-hub-branch/claims.js): bob has steps "Lock app.js 1..4"; alice's agent edits app.js: told about 3 steps (one a false positive, F3), edits again: nothing. Steps "Lock app.js 3/4" are never told to that agent.
Fix: stop the loop at 3 (`if (found.length === 3) break` before add), so the rest are told on the next edit.

## F3 mentions(): `t.includes(path)` matches inside other names, defeating the boundary regex (low, new code)
src/hub.js:573-574. For a top-level file rel === name, so `"refactor webapp.js".includes("app.js")` is true; nested `lib/a.js` matches `mylib/a.js`.
Repro: step "Refactor webapp.js" -> editing app.js says "app.js is named in bob's plan step "Refactor webapp.js"... Check with them". And it uses up one of the 3 slots (F2).
Fix: apply the same boundary test to the full path (build one regex for `path` with the same left/right classes) instead of plain includes.
Cost checked: 200 sessions x 50 steps, apply_patch of 50 files: ~190-210 ms per hook (single Edit ~ms). Under 3 s, OK.
Progress: F2/F3 written (claims). Checked quotas (3 per person only when no owners; This Mac passes owners=[login]; MAX_TEAMS 503; counting from persisted teams map: sound), overlaps refactor equivalent, authenticate passes hello to onWatcher, renderer resets lookedAt on reconnect, ASK_TOOLS in Claude matcher (agents.js), claims cost ~200ms worst case.

## F4 `look` replays have no backpressure: a teammate's window can make the hub queue ~30 MB/s (low, medium confidence; on_main_too: partly, the stopped-agent replay path does ~1/4 of it)
src/hub.js:1093-1097 (look sees replay via send()), 103 (send() never checks bufferedAmount; only toTeam does, at 16 MB)
Scenario: a team member starts 30 raw lanes in session s, each hello carrying a 256 KB history (onLane keeps history.slice(-SCROLLBACK)); one watcher that never reads its socket sends look with sees alternating [] / ['s'] 40 times per 10 s, keeping `session` constant so no broadcastState (and no toTeam bufferedAmount check) runs. Each look with s newly in view sends 30 x 256 KB = 7.7 MB through send(); 4/s -> ~31 MB/s queued in the hub's memory until the heartbeat drops the socket (15-30 s): ~0.5-1 GB, past the hosted hub's 0.5 GB. Before: replay of stopped agents, 30/s x one history each (~7.7 MB/s).
Not run (needs a non-reading client); reasoning from code.
Fix: in the sees replay (and replay), skip or terminate when ws.bufferedAmount > MAX_BUFFERED, like toTeam does.

More low:
- git config <key> with no value (a read) asks: `git config remote.origin.pushurl` -> PUSH_CONFIG ask (noise, not a bypass); same for benign push.default=current/simple.
- conflicts/branchConflicts add up to ~165 KB per lane to every state frame (50x300 + 10x50x300), on top of files/local; a teammate with 30 lanes adds ~5 MB per broadcast to every window.
- claims match steps in every session of the team, whatever its repo (a README.md step in repo A claims README.md in repo B).

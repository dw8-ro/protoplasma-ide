# verify-fixes-app

## fixes-app-1: CONFIRMED medium
Reproduced on a local hub (scratchpad/work2/verify-fixes-app/move.js): move lobby solo->b 200; move back 409; rename in b to lobby2 (key stays "lobby"), resend key -> 409; rename target lobby->lobby-old -> still 409 (key/alias). Target c with "lobby2" only: save "lobby" 200, rename -> 409 => stray "lobby" left in c and source not marked done. Release notes 0.7.0:67 repeat the advice.

## fixes-app-2: CONFIRMED low
cleanAgent keys omit lastActive; sessions filter only checks name. sessionList `at` can be non-string (lastActive:9 or {} sorts last; createdAt:1 on a record with no lanes), then `b.at.localeCompare` throws in render() (no try). Note: lastActive:123 with a real ISO createdAt sorts before "2026..." so doesn't throw in that exact case; a lane-only session or createdAt:1 does.

## fixes-app-3: CONFIRMED low
movedOn is localStorage-only, name-based. renameForm sets old key to '' (repo undefined -> not matched), so a renamed moved copy is missed; main's guard only covers running agents. removeSessionWorktree refuses uncommitted/.env and keeps the branch, so loss is limited. Stale keys from teammate deletes suppress the prompt (folder leak).

## fixes-app-4: CONFIRMED low
Only new hub has the move 409; renderer ignores saveSession result. Old Mac hubs (0.6.x) join silently.

## fixes-app-5: REFUTED
Inside the sessions route, hub.js:786 redefines a local `const running = name => teamLanes(team.id).some(l => l.session === name)`, which shadows the two-arg module helper. `running(session.name)` at 888 uses the local one, so the 409 does fire.

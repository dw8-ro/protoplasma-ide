# verify-hub-branch

## hub-branch-1: confirmed, LOW (reported medium)
Reran the reviewer's probe.js and push.js (local hub on 127.0.0.1:0, fake tok-* identities). These still get no ask: `-c remote.origin.mirror=true push`, `config remote.origin.mirror true && git push`, `--config-env=remote.origin.push=X push`, the GIT_CONFIG_KEY_0 env form, and `config remote.origin.push HEAD:main --show-origin` / `-l`. In the code, PUSH_CONFIG (hub.js:450) leaves out mirror. `-c` only matches as a separate word before the key. The read-only exemption (hub.js:470) checks every word in the part, not where it sits.
Severity: the push guard is the accepted word heuristic, and the branch made it stronger. 5e896c4 has no PUSH_CONFIG at all, so every one of these passed there too. To bypass it, an agent has to set unusual config on purpose. A prompt-injected agent could just as easily hide the push in base64 or a script. So this is low. The cheap part is still worth doing: `mirror` is the most destructive key in the family the branch chose to cover (it force-updates and prunes).
Fix: add `mirror` to the regex (`(push|pushurl|mirror)`). Drop `--show-origin` and `-l` from the exemption. --config-env and GIT_CONFIG_KEY_n are optional. Add test cases.

## hub-branch-2: confirmed, LOW
Live probe: the first Edit of app.js listed 3 steps. The second gave nothing, so 'Lock app.js 3' and '4' were never said. hub.js:583 adds to toldClaims before `found.slice(0,3)`. claimsOn is new on the branch (it isn't in 5e896c4).
Fix: as suggested, `if (found.length === 3) break;` before `toldClaims.add`. It is correct and minimal.

## hub-branch-3: confirmed, LOW
Live probe: "Refactor webapp.js" is told as a claim on app.js. The scratch mentions.js also shows "Fix src/app.jsx" counting as a claim on src/app.js. The reviewer's second example (mylib/a.js vs lib/a.js) is NOT a defect of includes(). The name regex treats '/' as a boundary, so it matches 'a.js' by design (the ponytail comment says "a step naming index.js claims every index.js"). The `t.includes(path)` check is redundant: any match with a boundary also matches the name regex. Its only extra hits are the false ones.
Minimal fix: delete `t.includes(path) ||`. You don't need a second regex. Verified in work/verify-hub-branch/mentions.js.

## hub-branch-4: confirmed, LOW (with corrections)
`send` (hub.js:103) has no bufferedAmount check. The look replay (hub.js:1093-1094) sends up to SCROLLBACK (256K chars) per lane, with only viewing() limiting it (40 looks per 10 s, per socket).
Corrections:
(a) The look replay is NEW on the branch. 5e896c4 replays only once, on connect, so on_main_too covers only the stopped-agent replay path.
(b) Rate: by alternating looks between sessions A and B (15 lanes each), every look brings a session into view. That's 4 looks/s × 15 × 256 KB ≈ 15 MB/s per socket, not 31. JSON escaping of control characters can multiply it by up to 6×. On main, the stopped replay already allows 30/s × 256 KB ≈ 7.7 MB/s per socket.
(c) Both paths are per socket, and one member can open many watcher sockets, so it was already unbounded on main. Only a team member can do it. The heartbeat (15 s) ends a socket that doesn't read within 30 s.
Better fix: put the guard in `send` itself (`if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate()`), so every caller (replays, file relay) is covered in one place.

# Section 9: screens, part 1 (app/renderer.js lines 1-495)

## Covered
- Lines 1-12: `$`, `esc` (all five characters, checked), `errorText` (strips the Electron prefix, checked), `store`, `setHTML` cache, `GITHUB_LOGIN` (node-checked: 1-39 chars, single hyphens, no trailing newline), `REPO`.
- Preferences 14-18: `DEFAULT_PREFS` (findNearby false, shareFiles false), saved-prefs merge, `effectiveTheme` (and its `change` listener at line 1472).
- Presentation 20-81: colour assignment (`hash`, `assignColors`, `colorFor`), `avatarUrl`/`avatar` plus the image `error` handler, `agentName`, `STATUS`/`pill` (hub only sends 'needs you', 'idle', 'working', see hub.js:560), `people`, `whoEdited`, `ago`, `sessionStatus`.
- State 83-127: all variables, light/dark terminal themes.
- Sign-in 131-192: `showView`, cell art, `#start` dialog guards, sign-in, reopen, cancel, `onSignedIn` (read against main.js `auth:*`).
- Teams 193-357: `clearTeamView`, `removedFromTeam`, `closeTeam`, sign-out, `leaveOrDeleteTeam`, `showTeams`, `refreshTeams`, `renderTeamList`, `syncWhere`, create-team, `openTeam`, `closeTeam` (read against main.js `teams:*`, app/teams.js listing).
- People 359-393: `renderPeople`, remove, invite (read against main.js `teams:invite`/`teams:remove`).
- Hub connection 395-444: `setConnection`, `watch` (generation counting, first-message reset, rejoin, `state`, `out`, `replay`, `file:get`/`file:put` dispatch, `onclose` branches), checked against hub.js `onWatcher`, close codes, and lane.js `connect`/`rejoin`.
- Terminal output 446-473: `whiteForBlack`, `forPage` (node-run), `write`, `tails`, `pending` (flush at createTerminal, drop at `dropTerminal`).
- Agent end 474-494: `proto.onExit` (alert condition and text regex, node-run), `onRefused`.
- Throwaway scripts: `scratch/09/t.js`, `c.js`, `p.js`.

## [medium] A "This Mac" team gets a new key on every launch, so "reopen the last team" and the per-team memory never work for it
- Where: app/main.js:45 (`key = `${t.hub}|${t.id}``), app/teams.js:~33 (`startHub({ port: 0 ... })`, `local.url = http://127.0.0.1:${hub.port}`); used at renderer.js:285 (`store.get('team')`), :345, :499 (`sourceKey`), :508 (`lastAgentKey`)
- What happens: the in-process hub listens on an OS-assigned port, so the hub URL, and therefore the team key, differs each time the app starts. The key saved in localStorage as `team` never matches the listing after a relaunch, so launch always lands on the team picker for any team hosted on this Mac (and for teammates' Macs found nearby, same reason). The same key is part of `source:<key>:<session>` and `lastAgent:<key>:<session>`, so what the app remembers about each session (the folder or repo it was started with, which agent kind to resume) is lost on every relaunch for these teams; "Resume" is then not offered and a session started in a picked folder forgets the folder.
- Evidence: CONFIRMED that the port differs per start (running `startHub({port:0})` twice gave 54702, then 54703). The consequence is SUSPECTED by reading how the key is built and used.
- Suggested fix: key teams by something stable (team id, plus the owner's login or a stable host name) for the localStorage keys and for `team`; keep the URL out of it.

## [medium] The GitHub token is sent in clear text over `ws://` to LAN hubs
- Where: renderer.js:408-410 (`/watch` socket, first message carries `conn.token`); the CSP allows `ws:`
- What happens: for "This Mac" and nearby teams the hub URL is `http://<ip>:<port>`, so the watch socket is `ws://` and the first frame is `{t:'watch', token: <GitHub token>, team}`. Anyone able to sniff the same Wi-Fi can read the user's GitHub token. (Lane connections in lane.js and the REST calls in teams.js do the same.) This is separate from the already-decided "Look for teams" opt-in, which is about asking unknown hubs; here even the hub the user chose is reached in clear text.
- Evidence: SUSPECTED (by reading; not run on a network).
- Suggested fix: have the hub issue a short-lived hub-scoped token after a verified sign-in and send only that, or at least document that LAN hubs are clear text and only use the hub token on `ws://`.

## [low] "Rejoin if you're invited back" is shown even when the team was deleted, and the agents left behind can't be seen or stopped
- Where: renderer.js:208-216
- What happens: `removedFromTeam` appends "Your agents there keep running on this Mac without being shared, and rejoin if you're invited back." for every reason, including the hub's "This team was deleted." (hub.js:369), where nobody can be invited back. In both cases the agents stay in `local` with their terminals hidden, but nothing on screen lists them (the board only shows the open team) and there is no Stop button for them; the only ways to end them are Sign out (which counts them) or quitting. The lane also retries the hub every 30 s (lane.js REJOIN_MS) and fires `lane:refused` each time.
- Evidence: SUSPECTED (by reading renderer.js and lane.js).
- Suggested fix: for a deleted team, stop the agents (mark `stopping`) or say they will keep running until you quit; for a removal, offer them somewhere to be stopped (for example list them on the teams sheet).

## [low] State of the previous sign-in survives sign-out: team list, listed-team map, "couldn't reach" note, repo error, "share files" setting
- Where: renderer.js:227-240 (sign-out), :294-308 (`listedTeams`, `renderTeamList.last`), :289 (`#teamsNote`), :92-93, :16
- What happens: sign-out resets `repos`, `me`, the removed note and the stored team, but not: the `#teamList` DOM, `listedTeams`, `renderTeamList.last`, `onlineReady`, `#teamsNote`, `#teamName`, or `reposError`. The next person who signs in sees the previous person's team names and member avatars until the first `teams:list` call returns (and keeps them if that call fails). Clicking a stale entry gives "That team isn't available any more." (main clears `known`), so it is a display leak, not access. `reposError` is also kept, so the next repo picker flashes the previous user's error before reloading (renderRepoPicker runs before the load at ~line 571). The `shareFiles` preference lives in the same localStorage `prefs`, so a different person signing in on this Mac starts with the previous person's "share files" switch (default off), which lets teammates read the files that the new person's agents changed (renderer.js:1314).
- Evidence: SUSPECTED (by reading; no run).
- Suggested fix: on sign-out set `listedTeams = new Map()`, `renderTeamList.last = ''`, clear `#teamList`, `#teamsNote`, `reposError`, and reset `shareFiles` (or key prefs by login).

## [low] Double click on "Sign in" opens GitHub twice, and crossed replies could show a code that isn't being polled
- Where: renderer.js:179-186 with main.js:54-65
- What happens: the button is not disabled and gives no feedback while `proto.signIn()` is waiting for the device-code request. A second click makes main abort the first flow's controller, but the first request is not cancelled: it still copies its code, opens the browser and replies. Two GitHub tabs open. If the first request finishes after the second, the clipboard and the screen end up with the first (aborted) code while main polls the second, so entering the shown code never signs in; Cancel and retry fixes it.
- Evidence: SUSPECTED (by reading both sides).
- Suggested fix: disable `#signin` until the call returns (re-enable in a `finally`), or make main ignore replies for an aborted attempt.

## [low] `removeMember` and `invite` write back `currentTeam` without checking it is still the same team
- Where: renderer.js:374 and :391
- What happens: `currentTeam = await proto.removeMember(currentTeam.key, login)` (and the same for invite) stores the reply even if the user opened another team during the call (the People page isn't modal, and the team switcher is one click away). The watch socket is then on team B but `currentTeam` is team A, until the next `state`/`openTeam`. Remove failures also leave `#peopleErr` standing (it is only cleared by a later success), so the old message shows again on any team's People page.
- Evidence: SUSPECTED (by reading; needs a slow hub to hit).
- Suggested fix: `const team = currentTeam; const next = await ...; if (currentTeam?.key === team.key) currentTeam = next;` and clear `#peopleErr` in `openTeam`/`go('people')`.

## [low] Teams poll: errors never clear, and the poll stops for good if the auto-reopen fails
- Where: renderer.js:277-292
- What happens: (1) a failed poll writes to `#err`, but a later successful poll doesn't clear it; only `showView` does, so the red text stays while the list updates normally. (2) On launch, `return openTeam(last)` skips the `setTimeout`, so if opening the last team fails (`#err` shown, sheet stays), the sheet never polls again: no nearby teams appear, `syncWhere()` was never called (hint empty, "Online" radio not disabled when the online hub isn't set up). (3) The catch block has no `!me` check, so a poll that fails after sign-out puts its message on the sign-in screen.
- Evidence: SUSPECTED (by reading). In practice rare, since `teams:list` mostly reports unreachable hubs instead of throwing.
- Suggested fix: clear `#err` after a successful poll, call `syncWhere()` and schedule the timer before `openTeam(last)`, and guard the catch with the same `!me || !$('#start').open` test.

## [low] Delete-team confirmation doesn't say the user's own agents are stopped
- Where: renderer.js:249-250 and 254
- What happens: the "Leave" text says "Your agents in it stop", but the "Delete the team" text doesn't, while the code kills this Mac's agents in the team in both cases.
- Evidence: CONFIRMED by reading.
- Suggested fix: add "Your agents in it stop." to the delete text.

## [low] Switching the theme doesn't recolour terminal output already written
- Where: renderer.js:465-473 (`forPage` runs once, at write time), :1472 (theme changes call `applyPrefs`)
- What happens: in light mode pure black backgrounds are rewritten to white as the text arrives. After switching to dark (or when the system theme flips), the cells written earlier stay white blocks on the dark terminal; the other way round, old black cells stay black on white. They clear only when the CLI redraws the area; scrollback keeps them.
- Evidence: SUSPECTED (by reading; `forPage` node-checked to rewrite `48;2;0;0;0` and `48;5;16` only in light mode).
- Suggested fix: accept it, or keep raw output per terminal and replay after a theme change.

## [low] Colours aren't always distinct, and they change while people come and go
- Where: renderer.js:24-37, :39-47
- What happens: only logins with an agent get a collision-free slot; everyone else (People page, team list, a teammate without an agent) gets the raw hash slot. With alice and grace both hashing to slot 0: both running gives alice 0, grace 1; when alice's agent stops, grace's colour moves to 0 and alice (no lane) also shows 0. So two people can share a colour and a person's colour changes mid-session, which the header comment ("a distinct colour... identical in every teammate's app") doesn't promise. Also the team list uses `teamColors` left over from the previously open team.
- Evidence: CONFIRMED (node snippet `scratch/09/c.js`).
- Suggested fix: assign colours from the full member list ([owner, ...members]) sorted, not from the lanes.

## [low] Avatar initial for a name starting with a flag or ZWJ emoji is a fragment
- Where: renderer.js:44
- What happens: `[...(name)][0]` splits by code point, not by grapheme: `'🇩🇪'` gives `🇩` and `'👩‍💻'` gives `👩`. The comment says "a whole emoji, not half of one", which only holds for single-code-point emoji.
- Evidence: CONFIRMED (node: `[...'👩‍💻x'][0]` is `👩`, `[...'🇩🇪'][0]` is `🇩`).
- Suggested fix: `new Intl.Segmenter().segment(s)` for the first grapheme.

## [low] Misplaced comment above `removedFromTeam`
- Where: renderer.js:206-207
- What happens: "Disconnects from the open team and empties the board." describes `closeTeam` (line 217) but sits over `removedFromTeam`, so the function has two unrelated comments and `closeTeam` has none.
- Evidence: CONFIRMED by reading.
- Suggested fix: move the first line down to `closeTeam`.

## Checked, no problem found
- XSS: every hub- or GitHub-supplied string in lines 1-495 goes through `esc` or `textContent`; `t.agents` is coerced to a number in teams.js:60; lane status is whitelisted by the hub; avatar `src` is `esc`'d and the CSP limits `img-src` to GitHub; `data-remove`/`data-key` are `esc`'d.
- `watch`: the generation check in `connect` and `onclose` covers team switches and sign-out; messages from a closed socket aren't delivered; `leavingTeam` handling of 4003 is correct; 4003 vs other 4xxx (30 s) vs network (3 s) paths behave as described. `proto.rejoin` is safe (lane.js `connect` returns if the socket isn't CLOSED).
- First-message reset only resets teammates' terminals; the hub then sends `state` and replays history (hub.js:onWatcher), so no duplicate scrollback. `pending` only fills briefly before the first render creates the terminal.
- `onExit` alert: only fires for agents not in `stopping` and under 5 s; all kill paths (Stop, sign-out, leave) mark `stopping`; `local.set` runs before data/exit events because main replies right after spawn. The regex strips CSI/OSC and keeps the last redrawn line (node-run).
- Create-team: errors cleared on input and on switching "where"; the button is disabled during the call (Enter can't resubmit); name is trimmed and checked.

## Outside my scope
- renderer.js:509-523 `startAgent`: `proto.startLane(opts)` carries no team key, and main uses whichever team is open when the call arrives (main.js:140), so switching teams during the `await proto.saveSession` (line 512) starts the agent in the new team while `local` records the old team's key. SUSPECTED.
- renderer.js:1681: at launch the sign-in screen is shown until `savedUser()` resolves, so a returning user sees a "Sign in with GitHub" flash (or a long wait offline) before the teams sheet.
- renderer.js:1310-1319 `answerFile` trusts `lane.files` from the hub state; a malicious hub host (a teammate's Mac) could list any path there, so `code:readLane` in files.js must itself confine paths to the lane folder.

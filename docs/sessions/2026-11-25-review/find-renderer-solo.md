# Review: renderer-solo (Just me, teams, cleanAgent)

## F1 (medium): deleting the moved-from session offers to remove the folder the moved session still uses
- app/renderer.js deleteSession (~1027-1039) + moveSession (~1285). main.js sessions:removeFolder (~229) has no live-lane check.
- Scenario: move "fix-login" from Just me to Team X (old record stays, marked done, same key and stored source). Start an agent in Team X (same <clone>@fix-login folder). Back in Just me, tidy up: Delete session on the done record -> "Also remove its folder on this Mac?" -> yes. The running check in deleteSession/sessionMenu only looks at the *current* team's hubLanes, and main's removeFolder checks nothing, so `git worktree remove` (no --force) deletes a clean worktree under Team X's running agent, folders.delete(dir) drops it from the allow-list (code view in Team X breaks), and forgetFolder() drops unsaved code-view edits parked for that folder (lost work). Dirty trees are refused by git, but a clean tree with unsaved editor buffers or a running agent is not.
- on_main_too: partly (two teams with the same session name and repo shared the folder at 5e896c4 too), but Move makes it the designed path.
- Fix: in deleteSession skip the folder offer when another team's session (sourceKey for other teams) or any live local lane uses that folder; or have main's sessions:removeFolder refuse while any lanes entry has cwd === dir.

## F2 (medium/low): Move silently joins an existing session of the same name in the target team
- app/renderer.js moveSession (~1291-1293); hub POST /teams/:id/sessions joins on findSession match (src/hub.js ~847-852).
- Scenario: Max already has "fix-login" in Team X. You move your Just me "fix-login" there: saveSession joins Max's session (no 409), and if you own Team X your goal overwrites Max's (task write allowed for the owner). If your session was renamed (key != name), renameSession renames Max's session (owner) or fails 403 (non-owner) after the join, leaving the source not marked done (half-moved). Either way both people's work lands on one session/<slug> branch without warning, while the confirm said "It's made there".
- on_main_too: no (Move is new).
- Fix: before saveSession, check the target's sessions (proto.teams doesn't carry them; fetch or let the hub answer 409 for a `move: true` create) and refuse or ask for a new name.

## F3 (medium): inviting someone into "Just me" shares every private session with no warning
- app/renderer.js renderTeamPane (~1929-1939) solo text "Private, on this Mac" / "Nobody else sees its sessions" / "Invite them here. Your sessions stay where they are."; #inviteBtn/#inviteForm (~469-490) have no solo case; the invite dialog names the team `${login}'s team`, not "Just me".
- Scenario: a solo user (the default for every new user) presses Invite people to work with someone on their Wi-Fi. The team gains a member, the This Mac hub moves to 0.0.0.0 and is advertised, and the invitee immediately gets every existing Just me session's name, goal, plan, notes, comments, and live/stopped agents' screens (up to 512 KB of output each) in broadcastState. Nothing in the flow says the earlier private sessions become visible; the copy says the opposite.
- on_main_too: no (Just me is new).
- Fix: when isSolo(currentTeam), confirm before inviting ("Everything in Just me so far, N sessions and their agents' screens, becomes visible to X. To share only new work, make a team instead and Move sessions you choose."), or make invite-from-solo create a new team.

Progress: read cleanAgent, startSolo/isSolo/soloKey, checkInvites, renderTeamList, openTeam (seen marking), sign-out reset, moveMenu/moveSession, deleteSession, hub sessions create/rename, renderTeamPane, invite flow. Sound: esc() on invite alert, team list, team pane, showMenu; checkInvites bails on sign-out mid-request; per-account solo/seen keys; Move disabled while agents run.

## F4 (low): cleanAgent coerces lists but not scalars, so a hub can still make render() throw
- app/renderer.js cleanAgent (95-96); throw sites diffStat (~1308 `l.branch?.startsWith`, `(l.repo || l.tree).toLowerCase()`), renderSessions sort (~1239 `b.at.localeCompare`, `at` from l.lastActive via sessionList ~1202; `a.name.localeCompare` with a record name that isn't a string). Also m.members (~541) and m.sessions records are not filtered.
- Repro (scratch/work/find-renderer-solo/clean.js, using the clone's own cleanAgent): a lane {id:'x', branch:1, lastActive:123} -> "l.branch?.startsWith is not a function" and "at.localeCompare is not a function". Every state frame then throws out of render() and the window stays blank/stale for as long as that team is open (the exact failure the cleanAgent comment says it prevents).
- on_main_too: yes (main had no cleaning at all); the branch narrowed it but left these.
- Fix: in cleanAgent also coerce the scalars render reads: `branch, repo, tree, name, login, status, lastActive, cmd, prompt` with String(x ?? '') (or '' when not a string), `git` to an object or null; filter m.members with nameList and drop session records whose name isn't a string.

## F5 (low/medium): checkInvites asks the online hub on every window focus, unthrottled
- app/renderer.js 358-370 (`addEventListener('focus', checkInvites)`); app/teams.js listTeams 303-313 always GETs /teams from the online hub (and runs register(), and browse() with findNearby).
- Scenario: Just me is the default for every new user. Each time the window comes to the front (Cmd-Tab back from the editor/browser, dozens of times an hour) the online hub is asked, waking it from App Sleeping and keeping it awake all working day per solo user; each request past the 2-minute identify cache is also a GitHub /user call from the hub. The comment says "so a solo app rarely wakes the online hub from its sleep", which the focus trigger defeats. No in-flight guard either, so quick focus changes overlap requests. On Railway's Free plan ($1/month, App Sleeping required) this burns the budget the sleeping exists to save.
- on_main_too: no.
- Fix: throttle focus checks (e.g. skip if the last check was under 10 minutes ago: `if (Date.now() - checkInvites.at < 600_000) return; checkInvites.at = Date.now();`) and keep one request in flight.

Progress: confirmed cleanAgent throws by running its source; checked new top-level names in renderer/code/panes against each other (no clashes); listTeams contacts every hub per call. Sound: invite alert ignores teams already opened (seen list per login), stale alerts guarded by listedTeams.has, checkInvites returns early after sign-out.

# fixes-app review findings

## F1 (medium) Move to a team: the 409's advice "Rename this one, then move it again" can never work
- renderer moveSession sends `name: key` where key = rec.key when the session was renamed (rec.key !== slug(name)).
  Renaming the session keeps rec.key (hub rename: `session.key = keyOf(session)`), so after the advised rename the move
  sends the same original key and hub findSession (matches slug/key/aliases) hits the same target session -> 409 again.
- Move-back flow: Just me -> Team (Just me's copy kept, marked done) -> move back to Just me: the done original still
  matches by name/key -> 409 forever; renaming either side doesn't help (target's rename keeps key + alias). Only deleting
  the old done session unblocks it.
- Also half-done: for a renamed session the 409 check only covers `key`; if the target has a session called `name`,
  saveSession creates `key` there, then renameSession(key->name) 409s ("There's already a session called ..."), leaving a
  stray session named after the key in the target, and the source not marked done.

## F2 (low) cleanAgent fix (renderer-solo-5) leaves out lastActive, the very field the review's scenario used
- Coerced keys: name, login, cmd, status, branch, repo, tree, prompt. lastActive passes through, and session records'
  createdAt/doneAt too (the sessions filter checks only `name`).
- sessionList (renderer ~1215) builds `at` from l.lastActive / rec.doneAt / rec.createdAt; renderSessions' default sort
  (~1252) runs `b.at.localeCompare(a.at)`. A Mac hub sending lastActive: 123 (or createdAt: 1) with two+ sessions ->
  TypeError out of render() on every state frame, the failure the fix's comment says it prevents.

## F3 (low) movedOn: matches by name in localStorage only; stale keys hide the folder prompt forever, a rename misses it
- Any `source:<otherTeam>:<name>` with the same repo counts, including a session a teammate deleted (your key is only
  cleared when *you* delete), one in a team you left / that was deleted, and the done copy left behind by a move. Then
  "Also remove its folder?" is never offered for that name+repo again (folder leak, no data loss).
- Opposite: the moved copy renamed in the other team (renameSession moves its source key to the new name), so
  endsWith(`:${name}`) misses it and the folder is offered for removal while that team still uses it; only main's
  running-agent guard stops it, so with no agent running the folder goes (branch kept, uncommitted/ignored work refused).
- `endsWith(':'+name)` also matches an unrelated session "a:lobby" for "lobby".

## F4 (low) move:true is ignored by hubs running older code, which silently join the same-named session
- The 409 is only in the new hub. A team on a teammate's Mac running 0.6.x (or the online hub before redeploy) ignores
  `move` and joins someone else's session of that name, which the fix exists to prevent; nothing in the renderer checks
  the reply (e.g. that the returned record's createdBy is me / it's new).

## F5 (low, pre-existing, not from the fixes) session DELETE never refuses for running agents
- hub.js ~888 `if (running(session.name))` but `running = (team, x)`; teamLanes(session.name) filters l.team === name
  -> [] -> false. A creator/owner deleting from another window (or an older app) removes a session with agents running.

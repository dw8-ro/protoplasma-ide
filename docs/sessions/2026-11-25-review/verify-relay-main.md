# verify-relay-main

## relay-main-1: confirmed, medium
- refuseOnce (app/teams.js:182) keys `${id}|${reason}`; identical to codexReply on 5e896c4, branch widens it from codex to every non-`asks` agent (opencode).
- pushRiskOf (src/hub.js:487) gives one fixed reason for every force push, including to main (force check runs before the target check). Push-to-<branch> reason is per branch.
- Reran work/find-relay-main/f1.js as work/verify-relay-main/f1.js: 1st `git push --force origin session/x` -> deny; 2nd `git push --force origin main` -> "" (allowed, no refusal, no cue to ask).
- Conditions: team with members, Codex/OpenCode in a user-picked folder (no pre-push hook) or --no-verify, two risky steps with the same reason within 10 min. An agent that ignores the refusal can retry the identical step anyway (by design), so the gap is that a different step gets no refusal at all.
- Fix: pass slim into refuseOnce, key `${id}|${sha256(slim)}|${reason}`. Keep reason in the key or lan.test.js:201 ("another step is refused once too", same '{}' body, new reason) breaks. Add a case: two different commands, same reason, both refused once. Varying-reason "permanent refusal" by a hub is real but only blocks (low).

## relay-main-2: confirmed, low
- README.md:167 unchanged from 5e896c4 ("OpenCode has no hooks", "the same step"); branch gave OpenCode hooks (src/agents.js opencode.hooks -> opencode-plugin.mjs, which throws on deny) and README.md:103 on the branch already says OpenCode gets a plugin, so the README contradicts itself.
- Fix: reword 167: OpenCode gets the hooks through a plugin and is refused once like Codex; pre-push hook still stops Codex's and OpenCode's pushes in app-made clones. Match whatever relay-main-1's fix does on "same step".

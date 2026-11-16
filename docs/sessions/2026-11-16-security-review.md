# Session 16 November 2026: third security review (online features)

A source review of 0.6.1, focused on what's online today (the hosted hub, sign-in, passes, Mac hubs, hooks, updates,
the installer, CI) and what the launch plan would put online. Then the app side that wasn't covered before: the
window's handling of hub and teammate text, terminals, the code view's file access, and the push guard. Read-only
except for the fixes below; nothing was run against the live hub beyond a health check and one made-up token.

## Fixed and live (pushed to main, hub redeployed from `5e896c4`)

- **High: any GitHub token signed someone in** (`6912c45`). The hub asked GitHub `/user` who a token belongs to and
  trusted the answer, whichever app issued it. A site or tool that got a teammate's token (even one with no scopes, as
  "Sign in with GitHub" gives), or a leaked personal token, let its holder sign in to the hub as them: read their teams'
  terminals and prompts, add notes that reach agents, type into agents started with typing allowed, act as owner.
  - Now `githubUser(token, clientId)` compares GitHub's `X-OAuth-Client-Id` answer header with Protoplasma's sign-in
    app (`CLIENT_ID` in hub.js, the same as `githubClientId` in app/config.json). Personal tokens and other apps'
    tokens get 401. `PROTO_CLIENT_ID` overrides it; blank accepts any token (a hub of your own). A Mac's hub gets the
    id from config.json.
  - The header isn't in GitHub's docs (it's sent, checked with `gh api -i user`). If GitHub drops it, every sign-in
    is refused, never let through. The documented check (`POST /applications/<id>/token`) needs the client secret on
    the hub.
  - `PROTO_TOKEN=<personal token> node src/lane.js …` no longer works against Protoplasma's hubs.
- **Medium: one request a second blocked every new sign-in** (`5e896c4`). Unseen GitHub-shaped tokens shared one budget
  of 60 GitHub checks a minute for the whole hub. Now each client address gets 10 a minute (`MAX_ADDRESS_LOOKUPS`,
  `askedBy`) and the hub 300. The address is `X-Real-IP` on Railway (`addressHeader`, set from `RAILWAY_ENVIRONMENT`
  or `PROTO_ADDRESS_HEADER`), else the socket's.
- **Low: hub owners and Mac-hub registrations were matched by login** (`5e896c4`). Whoever took a renamed login could
  create teams (`PROTO_OWNERS`) or register a look-alike Mac hub and get passes naming that login.
  - `isOwner` records each owner login's GitHub id at its first team (`owners.json`) and refuses that login under
    another id after that.
  - `hubs.json` entries are `{id, prints, at}`; a login is held for its person for 30 days after a rename
    (`LOGIN_HELD_MS`), and anyone else registering under it gets 409. Entries from before ids are read, but their
    certificates aren't carried over to whoever registers next, so a Mac hub registered before today needs its owner's
    app to register it again (it does at its next run) before teammates get passes for it.

Checks: `npm test` 109 of 109 (one earlier run had a single failure, not captured, which didn't come back in two
reruns); `npm run e2e` 138 of 139 on Electron 44.10.2 after `npm ci` in the worktree. The one failure was "Comment on
this points the next comment at those lines", the step 0.6.1 was meant to have fixed (see Known issues). Railway
deployed `5e896c4` (SUCCESS); `/` answers and a made-up token gets 401.

## Fixed, not committed yet (since brought into `claude/fable-5-2-redesign-dd3b36`, not pushed)

- **Low: the hub's push check missed a push to main redirected by git config.** For a Claude agent on a session
  branch, `git -c remote.origin.push=HEAD:refs/heads/main push origin` and `git config remote.origin.push HEAD:main`
  followed by a plain `git push` weren't asked about (confirmed against a local in-memory hub). Now `pushRisk` asks
  when `-c` or `git config` sets `remote.*.push`, `remote.*.pushurl` or `push.default` (`PUSH_CONFIG`); reading or
  unsetting them is fine. The pre-push hook needed no change: it sees the real refs, so Codex and OpenCode were
  already stopped. Tests in hub.test.js ("pushing to main or force-pushing…"). Needs a commit and a push to `main` to
  reach the hosted hub.

## Checked and sound

- Passes: Ed25519, bound to one hub certificate, 12 h, issuer key refetched at most once a minute.
- Mac hubs: pinned certificates, the team-owner check on every connection (`access`, `vouched`), `isPinned` only for
  vouched pins.
- Hooks: per-lane secret compared timing-safe; `h-` ids from the secret; the relay passes back only context and `ask`.
- Hub input: body, frame, path and early-frame caps; session and lane limits; file-relay rate limits.
- Updates: signer, bundle id and version checks; swap.sh rollback.
- CI: read-only default tokens, no persisted credentials in checkouts.
- The window: every hub or teammate string that reaches HTML goes through `esc()`, numbers are coerced, the CSP has
  no inline script. Teammates' terminal output can't write the clipboard (no clipboard add-on) or open pages (OSC 8
  links reach `window.open`, which is denied). Terminal replies aren't typed into teammates' agents.
- File sharing: the answering app checks the team, the share setting, the hub's list and then the agent's own git
  report (`code:readLane`).
- files.js / workspace.js: every path through `inside()` or `within()`; git arguments can't become options; commit
  messages through `-m`; search with `-F -e`; note hashes compared on this Mac only.

## Not covered

The shell-write heuristics (`writtenBy`) beyond reading them, the website draft, the customer simulation, and anything
dynamic against Railway or GitHub beyond the reads listed in HANDOFF.md.

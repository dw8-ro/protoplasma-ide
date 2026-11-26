# verify-hub-signin

## hub-signin-1: uncertain, low
- Code as described (src/hub.js:281 addressOf takes split(',')[0]). Unchanged by the branch (git diff 5e896c4..HEAD has no addressOf change); on main too.
- Already acknowledged in the ponytail comment above it (hub.js ~268): "behind a proxy that passes on a client's own X-Real-IP, made-up ones ... still reaches the hub-wide budget". Outcome = the accepted "sign-in flood" item (new sign-ins wait; known tokens skip budgets).
- Whether Railway overwrites or passes through a client X-Real-IP needs the network. pop() is harmless: same answer when the proxy overwrites, better when it appends; no worse when the proxy adds nothing.

## hub-signin-2: confirmed, low
- README.md:231 names DATA_DIR, PROTO_OWNERS, PROTO_CLIENT_ID, not PROTO_ADDRESS_HEADER; hub.js:1214 sets addressHeader only with PROTO_ADDRESS_HEADER or RAILWAY_ENVIRONMENT. Behind any other proxy every client shares one 10/min bucket (was 60 hub-wide before 5e896c4).
- Softened: tokens that checked out in the last 24 h skip budgets (hub.js:302 refreshes known on each check), lanes/socket retry on 1013; only self-hosters behind a non-Railway proxy, and clients reach such a hub only via PROTO_ONLINE_HUB or their own build. Mac hubs (no proxy) unaffected.
- Fix: one README sentence is right and minimal.

## hub-signin-3: confirmed, low
- grep finds CLIENT_ID only in src/hub.js:42 and 1213; no test reads githubClientId or CLIENT_ID. CLIENT_ID isn't exported (module.exports at 1205). Mac hubs use config.githubClientId directly (app/teams.js:73), so only the hosted hub can drift.
- Recovery exists (PROTO_CLIENT_ID on Railway) but a drift ships silently. Fix: test that regex-reads src/hub.js (or export CLIENT_ID) and asserts equal to app/config.json githubClientId. Hub must not require config.json (Dockerfile copies only src/).

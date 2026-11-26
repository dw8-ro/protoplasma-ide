# hub-signin review (6912c45, 5e896c4, branch on top)
Progress: read 6912c45, 5e896c4, branch hub.js diff (no sign-in changes on branch), identity tests, config/Dockerfile. Client-id check fails closed (missing/multi header -> null); CLIENT_ID == config.githubClientId; isOwner sync so no race; hubs.json 409/hold logic matches tests.

## F1 (low): addressOf keys the per-address budget on the FIRST X-Real-IP value, the client-controlled end
- src/hub.js addressOf (~line 280): `str(req.headers[addressHeader], 100).split(',')[0].trim()`.
- Node joins a repeated X-Real-IP into "a, b"; a proxy that appends (or adds its own header after the client's) puts its
  trusted value LAST. Taking [0] lets the client choose its address whenever Railway doesn't strip a client-sent X-Real-IP.
- Repro (work/find-hub-signin/xrealip.js, local hub, addressHeader x-real-ip, fake verifyUser): 40 made-up tokens, each
  with `X-Real-IP: 9.9.<i>.1` then `X-Real-IP: 6.6.6.6` (or one header "9.8.<i>.1, 6.6.6.7"): all 40 reach verifyUser (401), none 503.
  Real proxy address constant, so with .pop() only 10 would.
- Consequence: per-address budget void -> one source fills the 300/min hub budget -> everyone's new sign-ins 503/1013
  (the pre-5e896c4 state, but with 5x more bad-token calls to GitHub). Depends on Railway behaviour not verifiable offline.
- Fix: take the last element (`.split(',').pop().trim()`), which is the same when the proxy overwrites, and safer when it appends.
- on_main_too: yes (5e896c4 is live).

## F2 (low): a self-hosted hub behind any non-Railway proxy puts every client under one 10/min address budget; README doesn't mention PROTO_ADDRESS_HEADER
- src/hub.js standalone: `addressHeader: process.env.PROTO_ADDRESS_HEADER ?? (process.env.RAILWAY_ENVIRONMENT ? 'x-real-ip' : undefined)`;
  addressOf falls back to req.socket.remoteAddress = the proxy's address for everyone.
- README.md:231 tells people to deploy the Dockerfile on "Railway or any container host" and lists DATA_DIR, PROTO_OWNERS,
  PROTO_CLIENT_ID, but not PROTO_ADDRESS_HEADER (only AGENTS.md has it).
- Scenario: hub on Fly/Render/Cloud Run/nginx. All new sign-ins share MAX_ADDRESS_LOOKUPS=10 a minute (was 60 hub-wide
  before 5e896c4); 11 teammates signing in within a minute, or one person sending made-up tokens, makes everyone's new sign-in 503/1013.
- Fix: one sentence in README (set PROTO_ADDRESS_HEADER to the header your proxy sets, e.g. fly-client-ip / x-forwarded-for's last hop),
  or log a warning at start when no addressHeader is set and HOST is 0.0.0.0.
- on_main_too: yes.

## F3 (low, test-gap): nothing checks CLIENT_ID (hub.js) == githubClientId (app/config.json)
- AGENTS.md "Keep these in sync": change one without the other and nobody can sign in to the hosted hub. Both are
  'Ov23likRClHQUA3jdHEW' today; no test compares them (grep test/: none). One assert in identity.test.js would.
- on_main_too: yes.

Progress: identify() budgets/caches, isOwner, hubs.json pin/hold/409, passes, client-id plumbing (Docker, Mac hub, lane.js) checked. Sound: fails closed on missing/multiple client-id header; blank PROTO_CLIENT_ID = any (documented); isOwner synchronous (no race); passes only name the caller; 409 hold can't be refreshed by someone who no longer holds the login; askedBy/known/identities pruned at heartbeat; REST 503 / WS 1013 on throttle.

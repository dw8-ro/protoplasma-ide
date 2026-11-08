# Rust instead of Electron, and the known bugs: research, 8 Nov 2026

Measured on David's Mac with the playground (app 0.6.0). The worktree's `node_modules` turned out to hold an old
Electron 44.5.1, so the figures are from 44.5.1, not 44.10.0; that shouldn't change the size of the numbers. Fixes 1–4
in the bug table were made the same day (see HANDOFF.md, "Since 0.6.0").

## Short answer

- **The main function works.** `npm test`: 106 of 106. Live in the playground: create a team, invite, two people's agents
  in one session, the overlap warning, team context in prompts, Needs you, Stop → Idle (customer scenarios 1 and 2,
  all checks passed).
- **A move to Rust (Tauri) would save roughly 100–150 MB per open app, about a third.** It would not touch the agents,
  which use far more: one Claude Code process is 105–300 MB on this Mac, so three agents use 300–900 MB. A full move
  is weeks of work and re-implements the security-sensitive parts.
- **The $5 Railway credit already covers the hub.** The hosted hub uses 28 MB of RAM and almost no CPU (about
  $0.30 a month). This billing period is $3.02 of $5 so far, with RackRadar now gone. A Rust hub would save pennies.
- **Suggested order:** fix the bug list below (mostly small), make the cheap memory savings inside Electron, and
  measure again. Prototype Tauri only if memory still matters after that.

## What the app uses today

`footprint` (the figure Activity Monitor shows), per app copy:

| State | Main (Node) | GPU | Page | Network | Total |
|---|---|---|---|---|---|
| Just opened, team screen | 85 | 235, falling to ~110 | 38 | 7 | 250–365 MB |
| 2 agents on screen | 85 | 110 | 66 | 8 | ~270 MB |
| 6 agents on screen | 85 | 190–290 | 66–75 | 8 | 350–450 MB |
| 6 agents, full scrollback, code view open | 96 | 160–190 | 130 | 8 | ~400 MB |

- The **GPU process is the biggest part and grows with terminals**: each WebGL terminal adds about 20–45 MB of GPU
  memory (110 MB with 2 terminals, 190–290 MB with 6).
- The page (xterm buffers, Monaco, DOM) is 40–130 MB. The main process (Node, lanes, the in-app hub) is about 85 MB.
- The script used is `mem.sh` in the session scratchpad. Worth adding to `scripts/` as a rerunnable check.

## What a switch to Rust would and wouldn't save

Saved:
- Chromium's own browser process and Electron's Node main (85 MB) → a Rust core of roughly 15–30 MB.
- Chromium's network service (8 MB) → WebKit's own (shared, similar).

Not saved:
- The page itself moves into WebKit's WebContent process at a similar size. xterm buffers and Monaco cost the same.
- WebGL terminals cost GPU memory in WebKit's GPU process too.
- Activity Monitor shows WebKit's processes under their own names (`com.apple.WebKit.*`), so a Tauri app looks
  smaller than it is unless they're counted.

Estimate: **150–250 MB for a Tauri build against 270–400 MB today.** Published comparisons agree on "roughly half"
for simple apps (Hopp: 172 MB vs 409 MB for six windows), but none of them run terminals and an editor.

## The options

### A. Stay on Electron and trim memory (done 8 Nov: what it found)
Measured with `scripts/memory.js` (new) on a fresh playground: David runs 6 agents with full scrollback and Max watches
them.
- **Done: teammates' terminals keep 2,000 lines instead of 5,000.** That's about what the hub replays to someone who
  joins late anyway (`SCROLLBACK`, 256K characters). Max's page process went from 132–150 MB to 100–110 MB, and his
  copy from 464–489 MB to 325–347 MB. Your own agents keep 5,000 lines (about 6.5 MB each at 107 columns).
- **Electron updated to 44.10.2.**
- **The GPU process can't be trimmed from the app.** It's mostly two things:
  - Chromium's compositor surfaces for a Retina window (IOSurface, 95–130 MB);
  - Skia's GPU cache, which fills to its 96 MB budget and is emptied after a while when idle.

  That cache is why GPU figures swing by about 100 MB between identical runs, and why switching terminals quickly
  spikes the GPU process to about 350 MB for roughly 20 seconds. Freeing each WebGL context immediately
  (`loseContext()`) was tried and changed nothing. Only one terminal is on screen in the session view, so WebGL isn't
  multiplied by the number of agents.
- **Left as is:**
  - The main process (82–95 MB) is Electron and Node's own baseline.
  - Monaco adds about 15 MB once opened, and AMD modules can't be unloaded.
- So in-app trimming is worth about 8–10% of a copy that watches busy teammates. The rest is Chromium's own
  baseline, which only a different shell (B, C or D below) changes.

### B. Tauri 2 shell, Node kept as a sidecar process (about 2–3 weeks)
- Rust does the window, menu, Keychain, notifications and certificate pinning. A bundled Node process runs today's
  main-process code (lanes, files, GitHub, updates, the This Mac hub) behind a small message channel. Page code stays
  almost the same: `preload.js` becomes a shim over Tauri's `invoke`.
- Saves less than C: the Node process (40–60 MB) remains, and the app grows by Node's binary (~100 MB on disk).
- Must move the hub watch socket out of the page (see "WebKit and the Mac hub" below).

### C. Tauri 2 with everything in Rust (roughly 6–10 weeks, most risk)

| Today (Node) | Rust replacement |
|---|---|
| node-pty | `portable-pty` (WezTerm's), or `tauri-plugin-pty` (built on it, still marked in development) |
| ws (client and hub server) | `tokio-tungstenite` |
| bonjour-service | `mdns-sd` |
| Electron safeStorage | `keyring` (macOS Keychain) |
| `/usr/bin/openssl` for the hub certificate | `rcgen` |
| Certificate pinning (`setCertificateVerifyProc`, `ca`) | a `rustls` custom verifier |
| Ed25519 passes | `ed25519-dalek` |
| git and gh calls | `std::process::Command` (same commands) |
| updates.js | `tauri-plugin-updater` or a port of today's checks (keep `sameSigner`) |
| single-instance lock | `tauri-plugin-single-instance` |
| login-shell environment | `fix-path-env` or the same `$SHELL -ilc` call |

- **The hub has to be ported too** (1,067 lines): the This Mac hub runs inside the app. Two hub implementations
  (Node on Railway, Rust in the app) would drift apart, so port it once and use the Rust binary on Railway as well.
- **Security logic to re-implement with care:** the push guard (`partsOf`, `commandsIn`, `pushRiskOf`), the shell-write
  check, passes, `safeHookReply`, and the `inside()`/`within()` path checks.
- **Tests:** the hub tests talk to the hub over HTTP and WebSockets, so most of them could test a Rust hub if
  `startHub` spawns the binary instead. lane, workspace and files tests call functions directly and would need ports.
- Rough size: ~2,900 lines of Node to port, ~3,900 lines of page code kept.

### D. Electrobun: Bun plus the system WebKit, staying in JavaScript (about 1–2 weeks, young framework)
- Keeps the JavaScript. node-pty is replaced by `Bun.Terminal` (built into Bun since 1.3.5), and `ws` runs on Bun.
- Its own updater (bsdiff patches) and signing. v1 came out in early 2026, so the community is small.
- The same WebKit socket question as B and C. Saves about as much as B.

### WebKit and the Mac hub (applies to B, C and D)
Today the page opens the hub's `/watch` WebSocket itself, and Electron's `setCertificateVerifyProc` lets it accept a
Mac hub's self-signed, pinned certificate. WebKit gives apps no matching hook for a page's WebSocket: an Apple forum
report and an open WebKit bug point that way, though it isn't confirmed for current macOS. Plan on opening that socket
in native code and passing messages to the page. It's a contained change: `watch()` in renderer.js gets its frames from
`proto` instead of a WebSocket.

### Moving existing installs over
The current updater (`app/updates.js`) accepts a new build only if all of these hold:
- it's signed with the same certificate;
- it has the bundle id `com.electron.protoplasma`;
- its signed version matches the release;
- the zip is named `Protoplasma-<ver>-mac-arm64.zip`.

A Tauri or Electrobun build can be given the same bundle id and signed with the same certificate, so 0.6.x copies
could update themselves straight into the new app. Prove it with `scripts/update-check.js` before release. The paused
closed-source plan also changes where updates come from: if both happen, do them in one bridge release.

## Known bugs and loose ends, with fixes

| # | What | Fix | Size |
|---|---|---|---|
| 1 | Electron 44.10.0 is two patch releases behind (44.10.2 has Chromium/V8 security backports) | **Fixed 8 Nov:** `~44.10.2` | Small |
| 2 | C157: after a theme switch, terminal text already on screen keeps the old colours | **Fixed 8 Nov.** Cause: in light mode `forPage` (renderer.js) rewrote pure-black backgrounds to white as output arrived. They now become the default background (`49`) in both themes, so the theme decides at draw time | Small |
| 3 | An escape sequence split across two output chunks isn't recoloured (renderer.js ponytail), and the hub's scrollback trim can start mid-sequence (shared.js TODO) | **Fixed 8 Nov:** an unfinished trailing `ESC[…` waits for the next chunk; scrollback is trimmed at a line end | Small |
| 4 | The flaky e2e step "Comment on this points the next comment at those lines" | **Fixed 8 Nov.** The cause was the test's own race, not window focus: `openFile` marks the file active before it loads it and then focuses the editor, so the step now waits for `openFile` | Small |
| 5 | C151: no retry when Monaco fails to load | **Left:** Monaco loads from the app's own files, so a failure doesn't go away on retry; the message explaining it is enough | None |
| 6 | `allowScripts` in package.json isn't enforced | `.npmrc` with `ignore-scripts=true` plus `@lavamoat/allow-scripts`, in CI too | Small–medium |
| 7 | A Codex question (`request_user_input`) shows as Idle, not Needs you | Detect Codex's question screen in lane.js the way the trust prompt is detected (needs a live Codex run to capture the text) | Medium |
| 8 | During a flood of made-up tokens, new sign-ins wait | Per-address budgets, trusting Railway's `X-Real-IP` only when running on Railway | Medium |
| 9 | A downloaded folder's own `.git/config` can run git filter commands when the app reads it | Read the folder's config first and skip git status for folders with filter or diff drivers, with a notice | Medium |
| 10 | Session-name aliases can be claimed by renames (low; aliases are capped at 50, so an old name can drop off and be reused) | **Left:** the rename check already refuses any current alias, so this needs 50 renames of one session; the cap itself guards against teams.json growing without limit | None |
| 11 | DOMPurify advisories inside Monaco (none reachable) | Take the next Monaco release with a newer DOMPurify | Wait |
| 12 | OpenCode has no hooks | A plugin in `.opencode/plugins/`; nobody uses OpenCode, so last | Medium |
| 13 | Teammates' notes and goals reach agents' prompts | Accepted risk; already labelled as teammate text | None |
| 14 | C44: invite logins with an underscore | Won't fix (only GitHub Enterprise Managed Users) | None |

Not tried yet, so not known to work:
- The README one-liner on a fresh Mac.
- Two physical Macs sharing a Mac-hosted team.
- Codex's `apply_patch` and a push to main, live.

Loose ends:
- Commit `7507d5b` (launch prep: fixed-name release zip, licence notices, SECURITY.md) is on branch
  `claude/protoplasma-status-6783b4`, not on main.
- GitHub settings left for David:
  - delete the branch `main-lsx6e3`;
  - add a ruleset for `v*` tags;
  - put the signing secrets in an environment that needs his approval.
- No open GitHub issues.

## Sources
- [Hopp: Tauri vs Electron, performance and trade-offs](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4)
- [Railway pricing](https://docs.railway.com/reference/pricing)
- [Bun 1.3.5: Bun.Terminal](https://bun.com/blog/bun-v1.3.5)
- [Electrobun docs](https://framework.blackboard.sh/electrobun/) and [architecture](https://blackboard.sh/electrobun/docs/guides/architecture/overview)
- [tauri-plugin-pty](https://docs.rs/crate/tauri-plugin-pty/0.2.1)
- [Apple forum: self-signed certificates and WKWebView WebSockets](https://developer.apple.com/forums/thread/120869), [WebKit bug 158345](https://bugs.webkit.org/show_bug.cgi?id=158345)
- [Electron releases (44.10.1, 44.10.2)](https://github.com/electron/electron/releases)

# Upstream changes, 16-24 Nov 2026 (for 0.7.0)

## 1. Electron
- Latest 44.x: 44.11.6 (24 Nov 2026). 45 is out: 45.0.0 (21 Oct), latest 45.5.0 (24 Nov, Chromium 156.0.8078.109). 46 in alpha (46.0.0-alpha.13). Source: registry.npmjs.org/electron time + dist-tags; https://releases.electronjs.org/releases/stable?version=44
- 44.x after 44.10.2 (3 Nov): 44.11.0 (10 Nov, Chromium 152.0.7977.169, "Backported fixes from upstream ANGLE, Chromium, Dawn, devtools_frontend, FFmpeg, PDFium, Skia, V8" #55585), 44.11.1 (11 Nov), 44.11.2 (12 Nov), 44.11.3 (12 Nov, more upstream backports #55748), 44.11.4 (17 Nov), 44.11.5 (18 Nov, more upstream backports incl. WebRTC), 44.11.6 (24 Nov). Electron's notes list no CVE ids, only "backported fixes from upstream".
- Font bug: Chromium change crrev.com/c/8525429 (crbug 568832157, a UAF fix) made ctx.font reject leading whitespace; follow-up crrev.com/c/8573817 fixed it. Electron tracking issue electron/electron#55616 (closed 13 Nov). Fix "Fixed canvas `font` and `document.fonts.check()` rejecting leading whitespace" (#55776) shipped in **44.11.4 (17 Nov)**; 45.3.2 on the 45 line. https://releases.electronjs.org/release/v44.11.4
- xterm.js: issue #6297 open (opened 5 Nov), PR #6312 "fix(webgl): omit leading whitespace from canvas fonts" open, unreviewed, not merged (9 Nov). No xterm release since 6.0.0 / addon-webgl 0.19.0 (22 Dec 2025); betas 6.1.0-beta.339 / 0.20.0-beta.332.

## 2. Railway: X-Real-IP / X-Forwarded-For
- Official docs (docs.railway.com/networking/public-networking/specs-and-limits, undated): only "X-Real-IP for identifying client's remote IP". Nothing about overwriting.
- Staff/moderator on Help Station: overwritten. Moderator 0x5b62656e5d, 29 Sep 2026: "X-Real-IP, X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Host are all overwritten at Railway's edge" (station.railway.com/questions/which-client-address-headers-does-the-ra-fb9e36d7). Same moderator 8 Sep 2026: X-Real-IP "is written at the edge, so it can't be spoofed".
- Measurement by a user 8-9 Sep 2026 (station.railway.com/questions/does-the-edge-strip-client-x-forwarded-f-613e5cb6): spoofed X-Real-IP and a sentinel X-Forwarded-For did not reach the app. Staff answers conflict on XFF (phin: stripped; sam-a: appends). Reported, unconfirmed: on CDN-routed traffic X-Real-IP was the CDN edge IP (tracked bug, no fix date).
- Verdict: watch. Spoofing X-Real-IP isn't possible per staff and one measurement; the risk is the CDN bug, which would put many clients behind one address (MAX_ADDRESS_LOOKUPS 10/min). Not documented officially.

## 3. Claude Code 2.1.289 (3 Oct) -> 2.1.332 (24 Nov)
Source: raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md; dates from registry.npmjs.org.
- No change to the http hook shape, `ask`, additionalContext, timeout, or --settings merging that Protoplasma relies on. Hooks still fail open by default; `onFailure: "block"` is opt-in (2.1.295, 8 Oct).
- Relevant: 2.1.332 a PreToolUse ask reason now shows on Read/Grep/Glob/Edit/Write prompts (good for the edit-overlap ask). 2.1.327 /hooks now lists --settings hooks. 2.1.326 (16 Nov) `"decision":"block"` holds in more cases; HTTP hooks ignore Content-Length/Transfer-Encoding in `headers`. 2.1.321 (9 Nov) fixed an ask lost when another hook's defer finished first. 2.1.312 timeout under 1 s counts as 1 s. 2.1.300 updatedInput validated. 2.1.299 UserPromptSubmit runs before a skill/slash command expands. 2.1.296 Esc during a UserPromptSubmit hook no longer lets the unchecked prompt through. 2.1.328 Esc no longer lost at a permission prompt when typed straight after.
- Verdict: none (safeHookReply already strips decision/updatedInput). Worth a real-claude status check on 2.1.332 before release.

## 4. Codex 0.169.1 (17 Nov), 0.170.0 (18 Nov), 0.171.0 (20 Nov), 0.172.0 (24 Nov)
Source: api.github.com/repos/openai/codex/releases/tags/rust-v0.17x.0.
- Nothing about -c session-flag hooks, hook hash review, apply_patch, request_user_input, or trust-prompt text. Hook-adjacent only: #62112 bundled Memory hook trusted without saved hashes; #61180 temp trusted-repo cleanup (merged 12 Nov, no prompt change); model-request hook lifecycle changes (#61562, #61587); TUI workspace sidebar on by default in 0.171.0 (may change screen layout the trust/hook-review detection reads).
- Verdict: watch: rerun scripts/codex-hooks.js and a trust-prompt check on 0.172.0.

## 5. Monaco 0.58.0 (23 Nov)
- CHANGELOG (cdn.jsdelivr.net/npm/monaco-editor@0.58.0/CHANGELOG.md): "Updates bundled DOMPurify from 3.4.15 to 3.4.17"; package deps dompurify 3.4.17. 3.4.17 fixes GHSA-cg2g-xh64-v4q7 (SAFE_FOR_TEMPLATES), GHSA-mrv2-3pqr-j5jr (IN_PLACE), GHSA-c6gr-qvv4-5v3f (PARSER_MEDIA_TYPE) per Snyk/Corgea (advisories 22 Oct 2026).
- Breaking: markdown hovers no longer load remote images by default (markdownImages.allowedOrigins). Irrelevant to the app (CSP already).
- Verdict: act (low): bump to 0.58.0 and drop the DOMPurify item from "Known and left".

## 6. GitHub
- No announcement found about X-OAuth-Client-Id or the device flow since Aug 2026. The 14 Aug 2026 changelog (github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps): OAuth apps can opt in to 8-hour tokens + refresh tokens; "Short-lived tokens are enabled by default for all new applications". Existing apps opt in. Header not mentioned. The OAuth label page 404'd.
- Verdict: watch: never tick "short-lived tokens" on Protoplasma's OAuth app (the app has no refresh logic); a new OAuth app would get them by default.

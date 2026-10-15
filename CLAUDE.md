# CLAUDE.md

The project guide lives in AGENTS.md, shared with Codex and OpenCode, so the two never drift apart. The current state
and open work are in HANDOFF.md. Both are loaded here:

@AGENTS.md

@HANDOFF.md

## Notes for Claude Code sessions

- **Earlier memory doesn't carry over.** Earlier work on this project ran in a temporary folder whose auto-memory
  doesn't follow a new checkout. Everything worth keeping from it is in AGENTS.md, HANDOFF.md and `docs/recheck/`.
- **Folder-trust prompts are David's to answer.** A real `claude` started in a new folder stops at its folder-trust
  prompt. Never accept one on his behalf.
  - The playground uses stand-in agents (bash shells).
  - e2e runs real `claude` processes, which are never sent a prompt, and creates and removes
    `~/Protoplasma/protoplasma-e2e`. Its trust-prompt check starts `claude` in a new temp folder and dismisses the
    prompt with Esc, which declines it.
- **Driving the app:**
  - Electron isn't a web page, so the in-app browser can't drive it. Use `scripts/e2e.js` (it runs page code through
    `webContents.executeJavaScript`) or the playground's control API (`x-play-token` header).
  - Computer use can't deliver Escape to the app. Send it with `webContents.sendInputEvent` instead.
  - Launch the installed copy with `open /Applications/Protoplasma.app`. Opening it by name can start the `dist/` copy.
- **e2e and the `claude` CLI:** if e2e suddenly says "the claude command isn't installed", Claude Code was probably
  updating itself mid-run (its binary is briefly missing). Rerun before debugging.
- **Usage limit:** it has been hit many times. Prefer working inline. If you do use subagents, use few, give each a
  narrow scope, and have them write findings to a file as they go so a cut-off loses nothing.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit or push only when David asks.
  Pushing `main` can redeploy the hosted hub (see "Hosted hub" under "Releases, signing and the hosted hub" in AGENTS.md).

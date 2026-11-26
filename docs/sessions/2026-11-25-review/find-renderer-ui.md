# Review: renderer-ui slice (0.7.0 branch, 75aaaf3)
Progress: read the full renderer.js diff (solo space, invites, look/sees, inView terminals, scaleOff, GUESSED_DONE_MS, sessionNameFrom, moveSession, side-panel plan/memory, clash chips). Escaping of new interpolations looks sound so far.

## F1: New session form silently cuts the agent's first message at 300 characters (medium/low)
- app/index.html (#task `<input ... maxlength="300">`), app/renderer.js #agentForm.onsubmit (`first = ... ? task : ''`), src/hub.js:852 (`str(body.task, 300)`).
- The field is now "What should the agent do?" and doubles as the CLI's first message. It is a single-line <input> with maxlength 300 (the hub's goal cap). Pasting a longer or multi-line prompt is truncated (and newlines stripped) with no notice, and the truncated text is what the agent starts on. main.js firstPrompt allows 12,000.
- on_main_too: no (at 5e896c4 #task was only an optional goal; no first prompt from the form).
- Fix: a <textarea> without the 300 cap for the prompt; send the full text as prompt and only str(...,300) of it as the session goal (or say when it was cut).

## F2: Default agent "Other" after the Other command is cleared leaves no agent picked; with one CLI installed the picker is hidden and Start says "No agent to start yet. Try again in a moment." for good (low)
- app/renderer.js isInstalled (`?.installed !== false` is true for a cmd not in the list), defaultAgent, syncAgents (`again` finds nothing), `#agentField.hidden = ... installed.length === 1 && !checked:disabled`, openNewAgent (`preferred` null), onsubmit (`if (!cmd) throw ... Try again in a moment`). main.js agents:status lists 'other' only when the command is set.
- Repro: Settings, Other command "gemini", Default agent = Other; then clear Other command. Mac has only Claude Code. New session: no radio checked, Agent field hidden, every Start fails with the "try again" message.
- on_main_too: no.
- Fix: in defaultAgent use `agents.some(a => a.cmd === prefs.agent && a.installed)`; or in syncAgents check the first enabled radio when none is checked.
Progress: checked code.js md()/showActive focus, index.html diff (danger buttons, panel move, More options), hub sees/replay path (c reset makes stale pending harmless), hooked in views (GUESSED_DONE_MS sound), dropTerminal deferral, scaleOff. Sound so far.

More low:
- sessionNameFrom only avoids names in the open team's records; folders/branches (<clone>@<slug>, session/<slug>) are per repo, not per team, so a prompt-named session can land in the same checkout as a same-named session in another team or "Just me" (pre-existing for typed names; AGENTS.md says a made-up name "never joins another session").
- checkInvites lists every non-solo team not opened on this Mac, including teams you own made on another Mac: "You were added to X, open it to work with <you>".
- e2e unticks #sendTask, so the New session form's first-message path (prompts flag, dataset.from skip) has no automated check.
Progress: budget spent (~28 calls). Terminal lifecycle (inView/dropTerminal/pending/replay with \x1bc), GUESSED_DONE_MS, escaping of new strings, md(), showActive focus, danger buttons, focus outlines, slug/existingSession sync all looked sound.

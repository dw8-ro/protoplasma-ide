# Section 3: agents (src/lane.js, all 225 lines)

## Covered
- Constants and the TRUST_PROMPT / stripAnsi regexes (lines 11-24).
- claudeHookSettings (JSON printed from a real run, matchers, timeout 3, Authorization header + allowedEnvVars, PROTO_HOOK_SECRET in the child env).
- git()/rootsOf/repoFromRemote/githubRepo helpers.
- gitStatus, run against real temp repos with a bare origin and a second clone: clean main, uncommitted and committed renames
  (into, out of, up a folder, nested, 9 shapes), untracked, staged, non-ASCII / space / quote / tab / leading-space names, binary file,
  detached HEAD, session/ branch with no upstream then a teammate push (auto-set upstream, behind/ahead/unpushed), non-session pushed
  branch without -u, main moved on (behind), 250 untracked files (cap of 200, files count), clone-of-empty-repo (no origin/HEAD),
  repo with no commits, not a repo; core.quotePath, GIT_OPTIONAL_LOCKS / GIT_TERMINAL_PROMPT in the child env (via a git shim),
  fetch cadence and the in-flight poll guard (80 s run with a git shim that makes fetch take 7 s).
- installed()/runnable (relative names, PATH search against env.PATH while process.env.PATH differs, a directory with the same name earlier on PATH, unset PATH).
- startLane: checks, PTY spawn + environment, hello contents (printed), connect()/reconnect/close codes (1000, 1013 retry in 3 s with local scrollback in the
  second hello; 4001 stops; 4003 retries every 30 s and calls onRefused each time), rejoin(), exit while connected / while disconnected.
- term.onData flush batching, trust-prompt detection (Claude + Codex wording, false triggers, return to idle), Codex/OpenCode working/idle timers and the echo window.
- write()/resize() guards and behaviour after the agent exits (no throw), resize message to the hub.
- Standalone CLI block at the bottom (read; not run).
- Hub side glanced at: onLane (hello validation, status/size/git handling, close), authenticate (4001/4003/1013), pong/terminate.
- Test harness: scratch/3/lanetest.js (fake hub + fake `codex`/`claude` agents), scratch/3/gittest.js, gittest2.js, cadence.js.

Checked and fine (no finding): installed() with a same-named directory earlier on PATH, env.PATH vs process.env.PATH, missing command (clear error);
claudeHookSettings JSON (matchers, timeout, header + allowedEnvVars); hello fields; 1000/1006/1013 retry in 3 s with scrollback in the second hello;
4001 stops, 4003 retries at 30 s; rejoin(); flush batching; write/resize after exit (no throw); trust-prompt wording for Claude and Codex (including
`\s*` for cursor-move spaces) and Enter/Esc/typed text answering it while arrow keys and terminal replies don't; all nine rename shapes
(`a/{b => }/c`, `{ => x}/f`, `{src/lib => lib}/x`, `a => b`) give the right new path with no leading slash; upstream auto-set for session/ only (feature/x
untouched); behind/ahead/unpushed numbers; 200-path cap with true `files` count; detached HEAD gives the short sha; empty repo and non-repo;
GIT_OPTIONAL_LOCKS=0, GIT_TERMINAL_PROMPT=0 and core.quotePath=false reach every git call; fetch at poll 0 then every 12th poll (~65 s);
the in-flight guard never overlaps two polls.

## [medium] The lane never notices a dead hub connection (laptop sleep, Wi-Fi change)
- Where: src/lane.js:139-158 (connect), no ping/pong or keepalive anywhere; hub side src/hub.js:657-667 (hub pings and terminates sockets that miss a pong)
- What happens: the hub drops a lane whose pongs stop coming and moves it to "stopped" for teammates. If the path was dead at the time (Mac asleep,
  network switched, NAT dropped) the FIN never reaches the Mac, so on wake the lane's socket still reads OPEN. An idle agent writes nothing, so
  nothing errors, close never fires and nothing reconnects. Teammates see the agent as stopped until it next prints something (the first echoed
  key then hits an RST and reconnects). `lanes:rejoin` doesn't help: connect() returns because readyState is OPEN, and main.js has no powerMonitor 'resume' hook.
- Evidence: SUSPECTED (by reading; ws has no built-in keepalive and nothing on the lane side sends or checks pings). Not simulated.
- Suggested fix: on the lane, ws.ping() every ~20 s and ws.terminate() when no pong within a few seconds (the 'close' handler then reconnects);
  optionally call rejoin/terminate from powerMonitor 'resume'.

## [low] Resizing the window makes a Codex/OpenCode agent show "working" for 3 s
- Where: src/lane.js:172 and 199-203 (resize doesn't set lastInput)
- What happens: the activity status treats any output more than 400 ms after a keystroke as work. A resize makes the TUI redraw, which is output
  that isn't a keystroke echo, so every window resize, sidebar toggle or pane switch flips an idle agent to "working" (and bumps lastActive on the
  hub) for QUIET_MS. Dragging the window edge keeps it on "working" throughout.
- Evidence: CONFIRMED (scratch/3/lanetest.js, fake `codex` that prints on SIGWINCH: idle at 3.7 s, lane.resize(100,30) at 5.7 s, status "working" at 5.7 s, idle again at 8.7 s).
- Suggested fix: set `lastInput = Date.now()` in resize() (the redraw is a reply to the terminal, like an echo).

## [low] Ordinary output that mentions "trust this folder" is taken for the trust prompt
- Where: src/lane.js:23 (TRUST_PROMPT), 170-171
- What happens: the regex looks for the phrase anywhere in the last 400 plain-text characters of output, so an agent that writes or quotes that sentence
  (a reply, a `cat` of docs, a diff of this repo's own trust-prompt code or tests, "I don't trust this folder's scripts") reports "needs you" to the whole team.
  While `asking` is true the Codex/OpenCode activity logic is switched off (line 172), so a hands-off agent stays on "needs you" with no way back until
  someone types. For Claude the first keystroke then sends "idle" even if the agent is mid-turn, until the next hook event.
- Evidence: CONFIRMED that ordinary output ("remember the user should trust this folder before editing") reports "needs you" (lanetest.js, 10.2 s).
  The stuck part is SUSPECTED (by reading lines 171-172).
- Suggested fix: require the option line too (`1. Yes` / "Yes, continue" within the same 400 chars), or only watch for the prompt until the first
  Enter has been sent; also drop `asking` after some time or on the first non-prompt output that follows a redraw.

## [low] Final output is lost when the agent exits while the hub is unreachable
- Where: src/lane.js:197 (`flush(); ws.close()` with a closed socket), 141 (no further connect once exited)
- What happens: if the agent exits (or prints its last screen, e.g. an error or a goodbye) while the connection is down, nothing is sent: `exited`
  stops all reconnects and `flush()` has nowhere to go. The hub already moved the lane to "stopped" with the screen from before the disconnect, so
  teammates never see how it ended. (Same for output produced during a short outage right before an exit.)
- Evidence: CONFIRMED (lanetest.js lane `sexit`: hub closes with 1013, agent prints FINAL and exits at 2.5 s; one connection only, hub never saw FINAL).
- Suggested fix: on exit while not OPEN, try one last connect that sends hello (with full history) and then closes, or accept and document it.

## [low] Paths with a quote, tab, backslash or newline come out C-quoted, and first/last paths lose edge spaces
- Where: src/lane.js:62-63 (`core.quotePath=false`, `out.trim()`), 77, 82-88
- What happens: quotePath=false only stops the escaping of non-ASCII bytes. A file named `q"uote.txt` is reported as `"q\"uote.txt"` and `tab\there.txt` as
  `"tab\\there.txt"` (with literal quotes), so the hub's overlap matching against the path Claude reports never matches. `run()` also trims the whole output, so the
  first or last name in a listing loses a leading or trailing space (` lead.txt` becomes `lead.txt` when it is the first untracked file; it stayed intact when it was in the middle of numstat output).
- Evidence: CONFIRMED (scratch/3/gittest.js output: `"\"q\\\"uote.txt\""`, `"\"tab\\there.txt\""`, and `lead.txt` vs ` lead.txt`). Non-ASCII, spaces inside names and binary files are fine.
- Suggested fix: use `-z` for ls-files and diff --name-only (split on \0) and `--numstat -z`; don't trim path listings (trim only the count outputs).

## [low] A branch pushed without -u counts everything since main as unpushed and local
- Where: src/lane.js:70 (upstream auto-set only for `session/`), 78, 90
- What happens: for any other branch with no upstream (`git push origin feature/x`, or `git push origin HEAD`), `unpushed` is computed against main and `local`
  falls back to the whole `changed` list, even though `origin/feature/x` holds those commits. Two checkouts of the same pushed branch then see each other's
  shared files as overlaps, and the badge shows unpushed commits that are pushed.
- Evidence: CONFIRMED (gittest.js `feature/x pushed (no -u)`: unpushed 1, local [f.txt], `@{upstream}` still none, while origin/feature/x exists).
- Suggested fix: when there is no upstream but `refs/remotes/origin/<branch>` exists, use it as the upstream for counting (without writing config for non-session branches).

## [low] No origin/HEAD means committed branch work isn't reported at all
- Where: src/lane.js:65-66, 74, 77, 81
- What happens: `main` comes only from `origin/HEAD`. A clone of an empty repo, or `git init` + `git remote add`, has none until a fetch creates it
  (git 2.48+ does that; older git never). Then `base` is empty, `ahead` is 0, and `changed` is only the uncommitted files: files the agent already committed on its
  branch drop out of the overlap list the moment they're committed.
- Evidence: CONFIRMED (gittest2.js: clone of an empty repo, a committed file on a new branch: `ahead 0`, `changed ["dirty.txt"]` only).
- Suggested fix: fall back to `origin/main`, then `origin/master`, when origin/HEAD is missing (`git rev-parse --verify --quiet`).

## [low] Git stats stall while a fetch runs, and a failed git call looks like "no changes"
- Where: src/lane.js:62-64 (`err ? ''`), 64 (`await run('fetch')` inside the guarded poll), 187-193
- What happens: (1) the once-a-minute `fetch` is awaited inside the single in-flight poll, so no git stats or branch switches are reported while it runs, up to its 20 s
  timeout on a slow or hanging remote. (2) every failure (20 s timeout, 10 MB maxBuffer on a giant diff or untracked list) resolves to '' and is reported as a clean
  checkout; the hub then drops the lane's recorded edited files that aren't in `changed` (hub.js:557), so one bad poll can erase overlap data.
- Evidence: (1) CONFIRMED (cadence.js with a git shim that sleeps 7 s in fetch: no polls between 65 s and 72 s). (2) SUSPECTED (by reading; not forced).
- Suggested fix: start the fetch without awaiting it (its own guard) and let the next poll read the refs; make `run` return null on error and skip the report when `numstat`/`ls-files` failed.

## [low] The hook secret is put in every agent's environment, and a blackholed hub adds 3 s to every hook
- Where: src/lane.js:121 (`PROTO_HOOK_SECRET` always set), 30 (`timeout: 3`)
- What happens: (a) Codex and OpenCode never use the secret but get it anyway, so any command the agent runs (and anything it echoes into a transcript with `env`)
  can read it; it authenticates hook posts for that lane. (b) With the hub unreachable in a way that hangs instead of refusing (captive portal, dropped packets),
  UserPromptSubmit, each PreToolUse (Read/Bash/edits), and every PostToolUse wait up to 3 s: roughly +6 s per tool call, which the "fails open" comment doesn't mention.
- Evidence: SUSPECTED (by reading; (a) is a plain code fact, (b) not simulated).
- Suggested fix: set PROTO_HOOK_SECRET only when `path.basename(cmd) === 'claude'`; consider a 1-2 s timeout for PostToolUse, or skip the hooks after repeated hub failures.

## [low] Standalone CLI rough edges
- Where: src/lane.js:208-225
- What happens: (1) a missing command, folder or malformed hub URL ends in a raw Node stack trace instead of the usage-style message (the first lines of the error are right, the rest is noise).
  (2) onRefused uses console.error, which for a 4003 repeats every 30 s straight into the same terminal that is showing the agent's full-screen UI. (3) stdin chunks are Buffers, so
  `d === '\x1b'` in write() never matches: Esc alone doesn't answer a trust prompt (Enter and typed text do). (4) the background `git fetch` can prompt on the controlling terminal
  for an ssh passphrase or host key (GIT_TERMINAL_PROMPT=0 doesn't cover ssh), which the Electron app never has but a terminal run does.
- Evidence: (1) CONFIRMED (ran with an unknown command and with `notaurl`). (2)-(4) SUSPECTED (by reading).
- Suggested fix: wrap startLane in try/catch and print `e.message`; write refusals to a status line or a log file; `lane.write(String(d))` (or `setEncoding('utf8')`); set GIT_SSH_COMMAND with `-o BatchMode=yes` when unset.

## [low] The JSDoc for startLane is attached to the wrong function
- Where: src/lane.js:94-109
- What happens: the `/** Starts an agent CLI ... */` block (with @param/@returns) sits above the `runnable`/`installed` helpers that were inserted later, so editors show it on `runnable`
  and nothing documents startLane. It also lists only hub/team/token/session/cmd/open (not args, cwd, cols, rows, env, onRefused) and the @returns omits `repo` and `rejoin`.
- Evidence: CONFIRMED (read).
- Suggested fix: move the helpers above the comment and add the missing parameters.

## Outside my scope
- src/hub.js:629: messages that arrive while a lane's token is being verified are queued only up to 100 and the rest are dropped silently, so a lane streaming output while GitHub is slow to answer leaves a gap in the hub's copy of the screen.
- src/hub.js:531: on every lane reconnect the new lane object starts with `files: new Set()` and status 'idle' (Claude), so after a network blip recorded edited files and a "needs you"/"working" status are lost until the next hook event; only `startedAt` is carried over.
- app/main.js:67 and 148: `auth:signOut` doesn't stop running agents, and each lane keeps the token it started with, so after signing in as a different GitHub user the old agents stay connected as the previous user (and a 4001 lane can only recover by restarting the agent).

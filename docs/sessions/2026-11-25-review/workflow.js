export const meta = {
  name: 'review-0-7-0-retry',
  description: 'Retry of the read-only 0.7.0 branch review on a smaller budget: 3 agents at a time, saving findings as they go, one verifier per area',
  phases: [
    { title: 'Batch 1', detail: 'live hub sign-in, hook relay and main process, build and release' },
    { title: 'Batch 2', detail: 'hub changes, lanes and agents, Just me and teams in the window' },
    { title: 'Batch 3', detail: 'terminals and UI, cross-cutting invariants, upstream questions' },
  ],
}

const CLONE = args.clone
const REVIEW = args.review
const WORK = args.work
const PROJ = args.proj
const AUDIT = args.audit

function rules(label) {
  return [
    'HARD RULES (David approves every code change himself, so this work is strictly read-only):',
    '- ' + CLONE + ' is a scratch clone; treat its tracked files as read-only so every reviewer sees the same code. Never edit, create, move or delete anything under "' + PROJ + '" (the main checkout and all its worktrees). Never run git commands that change state there (checkout, switch, commit, stash, reset, merge, rebase, branch, tag, worktree, fetch, pull, push, config, gc). Read-only git (diff, log, show, grep, blame, ls-files) is fine.',
    '- Scratch work only in ' + WORK + '/' + label + '/ (create it). For git experiments make a temporary repo there with GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1. A scratch script may require the clone\'s modules by absolute path (require("' + CLONE + '/src/hub.js")); node_modules is linked into the clone.',
    '- Never install anything. Never start the Electron app, e2e, the playground, scripts/status-check.js, or a real claude, codex or opencode process. Never contact the hosted hub, GitHub or any other network service.',
    '- Don\'t run the full test suite (it passed 127 of 127 on this branch today). One test file narrowed with --test-name-pattern, run from inside the clone, is fine.',
    '- A hub you start must listen on 127.0.0.1 port 0 and be closed when done; use the fake identities the tests use (how test/*.test.js stub verifyUser and githubUser), never real tokens.',
  ].join('\n')
}

const SAVE = function (label) {
  return 'WORK IN SMALL STEPS AND SAVE AS YOU GO. The first run of this review was cut off by a usage limit after 30 minutes and lost everything, because nothing had been written down yet.\n'
    + '- First, create ' + REVIEW + '/find-' + label + '.md with a heading.\n'
    + '- The moment you are reasonably sure of a finding, append it there (title, file:line, severity, failure scenario, evidence, suggested fix) before you continue.\n'
    + '- After every 8 or so tool calls, append one line starting "Progress:" with what you have checked and what looked sound.\n'
    + '- Budget: about 30 tool calls. Start from the diff, read surrounding code only where a change touches it, and never read whole large files end to end. Go after the items most likely to hide a real defect first. When the budget is spent, stop and return what you have.'
}

const KNOWN = 'Known and accepted; don\'t report unless the branch made it worse: teammates\' notes, goals and briefs reaching agents\' prompts (accepted prompt-injection risk); the push guard being a word heuristic rather than a shell parser; --no-verify skipping the pre-push hook (D5); session-alias claims after 50 renames; DOMPurify advisories inside Monaco (unreachable); invite logins with underscores (C44); git filter or diff drivers in a downloaded folder\'s own .git/config; a sign-in flood from many addresses; Electron pinned at 44.10.2 (already known: 44.11.4 fixed the font bug, so the pin can move); the collaborator footfungus2 (trusted); only dw8-ro may create Online teams (PROTO_OWNERS, a product decision); the release job running dependency code where the signing key is (known, 17 Nov; only the build-ci slice proposes its fix).'

function context(label) {
  return 'You are one reviewer in an independent review of Protoplasma\'s unreleased 0.7.0 work. Protoplasma is a macOS Electron app for multiplayer AI coding: agent CLIs (Claude Code, Codex, OpenCode) run in PTYs on each person\'s Mac; a hub (src/hub.js: hosted on Railway, or inside someone\'s app as a "This Mac" hub) relays the terminals to teammates, tracks which files each checkout changed (overlaps), and answers Claude Code and Codex hooks (team context in prompts; "ask" before risky pushes or edits to a file a teammate changed).\n\n'
    + 'WHAT IS UNDER REVIEW\n'
    + '- A clone of branch claude/fable-5-2-redesign-dd3b36 (HEAD 75aaaf3) is at ' + CLONE + '. Read and run code there.\n'
    + '- The released, live code is commit 5e896c4 (origin/main). In the clone, "git diff 5e896c4...HEAD -- <paths>" shows what the branch adds and "git log --oneline 5e896c4..HEAD" lists its 46 commits.\n'
    + '- The clone\'s AGENTS.md and HANDOFF.md describe the current design and supersede older copies you were given at start-up (those describe 0.6.1). Read only the parts relevant to your slice.\n'
    + '- The only earlier review of this branch was by the session that wrote it (commit af8ba6f). Yours is the first independent one.\n\n'
    + rules('find-' + label) + '\n\n'
    + SAVE(label) + '\n\n'
    + 'WHAT TO REPORT\n'
    + '- Real defects: a concrete input, state or sequence that gives a wrong result, a crash, a hang, lost work, something private leaking, or a broken security boundary (AGENTS.md "Security boundaries"). Regressions from 0.6.1. "Keep these in sync" invariants the branch broke. Risky new logic with no test. Docs that contradict the code on something that matters.\n'
    + '- Not style, naming, taste or "could be cleaner". Every finding needs a concrete failure scenario and evidence (file:line and the code path, or a repro you ran). Say whether the same defect already exists at 5e896c4 (on_main_too).\n'
    + '- Severity: high = a teammate, a hub operator or an outsider can take over an agent, read private data or push to main unasked, or work is lost; medium = a real failure people will hit, or a security weakening that needs unusual conditions; low = rare, or minor with a real consequence.\n'
    + '- ' + KNOWN + '\n'
    + '- At most 10 findings. Name any further low ones in one line each under not_covered, starting with "More low:".'
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          symbol: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string', enum: ['correctness', 'security', 'regression', 'sync-invariant', 'test-gap', 'docs', 'design-rule', 'supply-chain', 'performance'] },
          description: { type: 'string' },
          failure_scenario: { type: 'string' },
          evidence: { type: 'string' },
          suggested_fix: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          on_main_too: { type: 'boolean' },
        },
        required: ['title', 'file', 'line', 'severity', 'category', 'description', 'failure_scenario', 'evidence', 'suggested_fix', 'confidence', 'on_main_too'],
      },
    },
    checked_and_sound: { type: 'array', items: { type: 'string' } },
    not_covered: { type: 'array', items: { type: 'string' } },
    extra: { type: 'string' },
  },
  required: ['findings', 'checked_and_sound', 'not_covered'],
}

const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
          reasoning: { type: 'string' },
          evidence: { type: 'string' },
          fix_notes: { type: 'string' },
        },
        required: ['id', 'verdict', 'severity', 'reasoning', 'evidence', 'fix_notes'],
      },
    },
  },
  required: ['verdicts'],
}

function verifyPrompt(key, findings) {
  const label = 'verify-' + key
  return 'You are the skeptic for one area of an independent review of Protoplasma\'s unreleased 0.7.0 branch. A clone of the branch is at ' + CLONE + ' (HEAD 75aaaf3); the live, released code is commit 5e896c4. Protoplasma is a macOS Electron app for multiplayer AI coding: agent CLIs run in PTYs on each person\'s Mac, and a hub (src/hub.js) relays terminals to teammates, tracks overlapping edits and answers agents\' hooks. The clone\'s AGENTS.md describes the design and its security boundaries and supersedes older copies you were given at start-up.\n\n'
    + 'A reviewer reported the findings below. Try to REFUTE each one. For each: is the code really as described at HEAD; is the failure scenario reachable in practice (who can trigger it, what must be true first); is it already handled elsewhere (a caller, a guard, the hub or the app); is it one of the known and accepted items; is the severity right; is the suggested fix right and minimal, and would it break anything? Settle it the cheapest sure way: a small scratch repro against the clone\'s modules when that is quick and read-only, otherwise trace the code path end to end. Answer "refuted" when you cannot establish it with evidence, "uncertain" only when it truly needs the Electron window, a real agent or the network.\n'
    + 'Severity scale: high = a teammate, a hub operator or an outsider can take over an agent, read private data or push to main unasked, or work is lost; medium = a real failure people will hit, or a security weakening needing unusual conditions; low = rare, or minor with a real consequence; none = not a defect.\n'
    + KNOWN + '\n\n'
    + rules(label) + '\n\n'
    + 'SAVE AS YOU GO: create ' + REVIEW + '/' + label + '.md first, and append each verdict (id, verdict, severity, why, evidence) the moment you reach it. Budget: about 6 tool calls per finding.\n\n'
    + 'The findings (JSON):\n' + JSON.stringify(findings, null, 1) + '\n\nReturn one verdict per finding id.'
}

const SLICES = {
  'hub-signin': 'YOUR SLICE (label: hub-signin): the two hub commits that are LIVE on the hosted hub and were never reviewed by anyone but their author: 6912c45 ("only accept sign-ins from Protoplasma\'s own GitHub app") and 5e896c4 ("per-address sign-in budget, and owners and Mac hubs pinned to GitHub ids"). Read them with git show, then check what the branch changed on top (git diff 5e896c4...HEAD -- src/hub.js). Supporting code: the client side that supplies the client id (app/teams.js, app/config.json, src/lane.js) and test/identity.test.js.\nFocus, in order:\n- githubUser(token, clientId): the X-OAuth-Client-Id comparison (case, whitespace, missing header, several values, blank PROTO_CLIENT_ID meaning "any"), and every caller passing the right client id (the standalone hub and Docker, a Mac\'s own hub via teams.js and config.json, lane.js standalone). Anything that fails open, or locks out legitimate users?\n- identify(): the sha256-keyed caches, shared in-flight lookups, the per-address budget (askedBy, MAX_ADDRESS_LOOKUPS) and hub budget (MAX_LOOKUPS), known tokens skipping the budgets (known.json growth, a corrupt file, a token revoked on GitHub staying known), counting before the wait. Can one address still starve others? Do maps keyed by address or hash ever get pruned? Are 503 and 1013 right for REST and WebSocket?\n- addressHeader: X-Real-IP trusted only on Railway (RAILWAY_ENVIRONMENT) or with PROTO_ADDRESS_HEADER; spoofing off Railway; a header holding a list; IPv6 and IPv4-mapped forms; a missing header on Railway.\n- isOwner and owners.json: the id recorded at the first team, refusal under another id, two first requests at once, load and save errors, an owner whose id lookup failed, teams created before this change.\n- hubs.json {id, prints, at}: POST /hubs pinning, the 30-day hold after a rename (LOGIN_HELD_MS), at most 5 per login, old-format entries, POST /passes only for a registered aud, the 409 path. Can someone get a pass naming another person, or lock a person out of registering their own hub?\n- Do the identity tests exercise the failure paths?',
  'relay-main': 'YOUR SLICE (label: relay-main): app/teams.js, app/main.js and app/preload.js (git diff 5e896c4...HEAD -- app/teams.js app/main.js app/preload.js app/config.json).\nFocus, in order:\n- The hook relay (hookRelay, safeHookReply, codexReply, and the new slimHook that sends the hub only what it reads): a hub\'s answer may only add context or ask the person, never allow, deny, block, stop or rewrite a tool call. Every new hook event (Codex question and Interrupt, OpenCode) must be covered. slimHook must not drop a field the hub reads (compare hub.js onHook and what it calls, field by field: edit paths in tool_input, apply_patch text, the Bash command, cwd, session ids), and must not forward what the hub should not get (file contents, tool output, transcript paths).\n- codexReply: refuse once, then allow the same step within 10 minutes. Can a hub make the relay allow something it would otherwise refuse, or make a refusal permanent? Does its map grow without bound?\n- main.js startLane and the Other command: argument coercion, the CLI taken from the agent table, hookBase for every hooked CLI, PROTO_SHARED_TEAM, the not-guarded notice, the first-prompt cap and leading-dash handling; Move to a team (does a moved session keep its folder and branch, and is the folder still checked against the folders allow-list and the team key?).\n- Every new or changed IPC handler: signedIn / inFolder wrappers, coerced arguments, a matching preload method (AGENTS.md "The IPC rule").\n- The Just me (solo) space on the main side, if any: where it is stored, per account, sign-out and account switch.',
  'build-ci': 'YOUR SLICE (label: build-ci): supply chain and release. git diff 5e896c4...HEAD -- .npmrc package.json scripts/allowed-scripts.js .github install.sh Dockerfile; then read .github/workflows/*.yml, scripts/sign.sh, scripts/allowed-scripts.js and the Dockerfile.\nFocus, in order:\n- The Dockerfile and the hosted hub: does the branch\'s hub require any new file or dependency (src/agents.js? anything new in src/shared.js?) that the Dockerfile does not copy? That would crash the hosted hub on its next deploy (pushing main redeploys it). Check every require in hub.js and shared.js against the Dockerfile. Also the Railway watch patterns in AGENTS.md (src/hub.js, src/shared.js, Dockerfile): would a hub dependency change outside those files fail to redeploy?\n- allowScripts enforcement: .npmrc ignore-scripts=true plus npm run setup (scripts/allowed-scripts.js) running only the allowed install scripts at their pinned versions. Does allowed-scripts.js do what it claims (which scripts, how versions are checked, what happens on a mismatch, path handling)? Is every workflow and documented setup path updated, or does something now silently produce a broken app (node-pty without spawn-helper, no Electron binary)? Does npm run dist still package a working node-pty?\n- package.yml\'s asar check list and the dist --ignore prefixes against the new runtime files (src/agents.js, src/opencode-plugin.mjs): would a release miss a file?\n- Workflow permissions, action pinning, persist-credentials, and the tag-on-main and version checks still intact.\n- The release job (known, open): release.yml runs npm ci, npm test and npm run dist in the same job that receives MAC_CERT_P12 and runs scripts/sign.sh. Confirm whether the branch changed this, then put a concrete proposal in the extra field (text only, no file change): a build job with no secrets uploading the unsigned app as an artifact; a sign-and-publish job that installs nothing, checks out only scripts/sign.sh from the tagged commit, verifies the artifact, signs, zips (the zip name and layout in AGENTS.md "Release artifact" must not change) and publishes, in a protected environment. A YAML outline, and what David must set up on GitHub first.',
  'hub-branch': 'YOUR SLICE (label: hub-branch): everything the branch changes in src/hub.js and src/shared.js (git diff 5e896c4...HEAD -- src/hub.js src/shared.js), with test/hub.test.js, test/hub-live.test.js and test/quota.test.js.\nFocus, in order:\n- Status from keys and hooks: a lane\'s key {moving} messages applied to agents with hooks, statusAt / ago (a key older than the last hook\'s change is ignored), hooked surviving reconnects and sent in views, ASK_TOOLS making a question "needs you", interrupts giving idle, an answered permission giving working. States that can stick (needs you or working forever), races between a hook and a key, and anything someone other than the agent\'s owner can send to change that agent\'s status.\n- Output only to windows showing that session (sees), the look budget, the replay budget: can a window miss output it should get, or get output for a session or team it must not see?\n- claimsOn: plan steps naming a file tell a teammate\'s agent before it edits. Path normalisation, subfolder prefixes, cost on every PreToolUse (hook answers must stay well under Claude Code\'s 3 s timeout), and the text reaching additionalContext.\n- PUSH_CONFIG: asks when -c or git config sets remote.*.push, remote.*.pushurl or push.default. Try bypasses within reason: quoting, --config-env, GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n env vars, git config --add or --global, upper-case keys (git config keys are case-insensitive), remote.origin.mirror, branch.<name>.pushRemote, remote.pushDefault. An older uncommitted version of this fix is in "' + AUDIT + '" (read-only: git -C that-folder diff -- src/hub.js test/hub.test.js); check the branch\'s version is at least as strong.\n- Quotas: MAX_OWNED_TEAMS and MAX_TEAMS, their interaction with owners and This Mac hubs, off-by-one, persistence.\n- Branch-conflict and claim data from lanes: size caps (str() / size()), validation of what a (possibly hostile) lane sends, and views() still never including root, roots, hookSecret or history.\n- shared.js: anything changing slug() or a limit (AGENTS.md "Keep these in sync").',
  'lane-agents': 'YOUR SLICE (label: lane-agents): src/lane.js, the new src/agents.js (one table for agent CLIs) and src/opencode-plugin.mjs (git diff 5e896c4...HEAD -- src/lane.js src/agents.js src/opencode-plugin.mjs), with test/agents.test.js, test/conflicts.test.js and test/lan.test.js.\nFocus, in order:\n- Codex hook trust: Codex trusts each hook by its place and text. The branch added a question hook and an Interrupt hook after the four already-trusted ones so that only the two new ones need review. Compare the four old hook entries and their command byte for byte with what 5e896c4 generates (codexHookSettings then vs the agent table now); if anything about them changed, every Codex user must re-trust all of them.\n- Status detection: decided sending key {moving}, interrupts, trust-prompt detection (TRUST_PROMPT and ANSWERS; the installed Claude Code 2.1.289 shows "Yes, I trust this folder" and Codex 0.169 shows "Trust this folder?", "Hooks need review", "Trust and continue", "Trust all and continue"), byActivity for CLIs without hooks, guessed status. Input clears "needs you" but the terminal\'s own escape-sequence replies must not.\n- branchConflicts (git merge-tree against other sessions\' pushed branches and main): the right merge-base, the git version needed (merge-tree --write-tree needs git 2.38+, AGENTS.md promises 2.28) and what happens on an older git, cost (how often, how many branches), SAFE_GIT and GIT_TERMINAL_PROMPT=0 on every new git call, MAX_CHANGED equal to the hub\'s, remote branch names used as arguments (a leading dash, odd bytes).\n- The shared git poll for agents in one folder, SETTLED_MS and SLOW: missed changes, changes attributed to the wrong lane, timers outliving the agent.\n- src/agents.js vs its consumers: the Other command must never get another agent\'s hooks or PROTO_HOOK_SECRET, and its arguments must never pass through a shell.\n- The OpenCode plugin: where it is loaded from, what it sends, whether an unrelated OpenCode run could load it or it could leak the hook secret, behaviour when the hub is down, and that it posts through the loopback relay.',
  'renderer-solo': 'YOUR SLICE (label: renderer-solo): app/renderer.js, the parts about Just me and teams: isSolo, startSolo, moveSession ("Move to a team..."), checkInvites (on focus and every 10 minutes) and the invite alert, per-account solo storage, the team window marking the open team, and cleanAgent (coercing every list a hub sends). Start from git diff 5e896c4...HEAD -- app/renderer.js.\nFocus, in order:\n- Escaping: every new string from a hub or a teammate interpolated into HTML goes through esc(); numbers coerced with |0; no new innerHTML on an element also written with setHTML.\n- cleanAgent and state handling: a hostile or older hub sending odd shapes (missing fields, non-arrays, huge strings, objects where strings are expected) must not throw inside render() (that blanks the window) or reach HTML unescaped.\n- Move to a team: the team offline, the session name taken there, an agent running, a move that half-fails. Is anything lost (folder, branch, unsaved files parked per folder)? Can an agent end up on two teams? Is anything sent that the person did not choose to share?\n- Just me per account: switching GitHub accounts, signing out, a solo session after joining a team, solo sessions never sent to any hub.\n- checkInvites: waking the online hub too often (it sleeps after about 10 minutes idle), duplicate alerts, alerts for teams you left or were removed from.\n- The shared classic-script scope: a new top-level const, let or class whose name exists in code.js or panes.js is a SyntaxError that stops that file loading; a new top-level function with another file\'s function name silently replaces it. Check every new top-level name in renderer.js, code.js and panes.js against the others.',
  'renderer-ui': 'YOUR SLICE (label: renderer-ui): the rest of the window. app/renderer.js parts about terminals and sessions (output only to windows showing that session; teammates\' terminals existing only while their session is on screen and dropped off-screen only when the hub can replay them; redraw for another pixel ratio; scrolling a terminal gone by the next frame; the New session form that asks one thing and names the session from it; GUESSED_DONE_MS and "Your agent finished"; Plan and Memory in the side panel; Open beside; the shorter bar under a terminal; overlap alerts, branch conflicts and plan claims), plus app/panes.js, app/code.js (showActive no longer taking focus; md() escaping a comment\'s author) and app/index.html. Start from git diff 5e896c4...HEAD -- app/renderer.js app/panes.js app/code.js app/index.html.\nFocus, in order:\n- Lifecycle bugs: a terminal disposed while still referenced (the known xterm "reading \'dimensions\'" page-error class), WebGL contexts not released, output buffered for a terminal that no longer exists (bounded?), replays requested over and over, a dropped teammate terminal that never comes back, focus stolen from inputs.\n- The New session form: the name made from the prompt must agree with src/shared.js slug and existingSession; a prompt that slugs to nothing or to an existing session; very long prompts; the 12,000-character first-prompt cap.\n- Status shown to the person: can "Your agent finished" or "Needs you" be wrong or stuck now; notifications for an agent already on screen (D6).\n- Escaping of every new interpolated string (overlap alerts, branch-conflict file names, claims) and the md() hover.\n- index.html: keyboard access and focus outlines, inert while Settings is open, destructive buttons using .btn.danger.\n- render() must stay cheap and idempotent: no new work that grows with history on every hub state.',
  'invariants': 'YOUR SLICE (label: invariants): cross-cutting checks on the whole branch.\n1. AGENTS.md "Keep these in sync", item by item on the branch: slug() vs its renderer copy (byte for byte) and findSession vs existingSession; <clone>@<slug> and session/<slug> in workspace.js and github.js; MAX_CHANGED in hub.js and lane.js; EDIT_TOOLS; MAX_SHARED_FILE and the frame limit vs renderer answerFile; the status strings (needs you, idle, working, plus running) in the lane, the hub\'s allow-list, the renderer\'s STATUS and sessionStatus; PROTECTED_BRANCHES / pushRiskOf vs PUSH_GUARD; the privacy numbers in README.md and index.html vs the constants; the agent lists now that src/agents.js exists; hook events and matchers across lane.js, teams.js\'s relay, hub.js onHook and the OpenCode plugin; the README wire-protocol table vs every message type hub.js, lane.js and the renderer send (new ones such as key, claims, conflicts, look changes).\n2. David\'s design rule ("minimal but sufficient: simplify by choosing what shows first, never by removing a tool"): any user-facing capability reachable in 0.6.1 (5e896c4) that is no longer reachable on the branch. Compare menus, buttons, Settings, shortcuts, the Settings Keyboard list and the README shortcut table against main.js menu items and runMenu. Put the comparison result in the extra field; report real losses as findings with category design-rule.\n3. Tests: risky new logic with no test; new tests that wait a fixed time instead of for a condition; tests using the developer\'s real git config or home folder without GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1; tests that require electron.\n4. Docs vs code where it matters: claims in AGENTS.md, README.md and docs/release-notes/0.7.0.md that the code does not do, especially security and privacy claims.',
}

const UPSTREAM = 'Finish a check of what changed upstream since Protoplasma\'s last work (16 and 17 Nov 2026; today is 25 Nov 2026). An earlier agent answered the Electron question before it was cut off; its notes are in ' + REVIEW + '/upstream.md. Keep that section and append yours below it as you go. Read-only: never edit anything under "' + PROJ + '" or in ' + CLONE + ', install or download nothing, and send no project or personal details to any external service (searching public docs, changelogs and issue trackers is fine). Load WebSearch with ToolSearch (query "select:WebSearch"); use WebFetch too if you have it. Budget: about 25 tool calls. Answer with sources (URL and date), and say plainly when you could not find out:\n'
  + '1. Railway: does Railway\'s edge proxy overwrite or strip a client-supplied X-Real-IP (and X-Forwarded-For) header before it reaches the service? The hub trusts X-Real-IP for per-address sign-in budgets when RAILWAY_ENVIRONMENT is set. Docs, changelog, or staff answers on Railway\'s help station.\n'
  + '2. Claude Code: changelog entries from mid-November to now (installed: 2.1.289) about hooks (PreToolUse permissionDecision "ask", additionalContext, UserPromptSubmit, PermissionRequest, Stop, http hooks, hook timeouts, how --settings merges) or interrupt behaviour that would change what Protoplasma relies on (see ' + CLONE + '/src/agents.js for the hook settings it writes).\n'
  + '3. Codex CLI 0.170 to 0.172 (installed 0.169.0): changes to -c hooks=... session-flag hooks, hook trust and hash review, apply_patch, request_user_input, or the trust prompt text.\n'
  + '4. Monaco 0.58.0 (installed 0.57.0): does it bundle a DOMPurify newer than 3.4.15, per its changelog or release notes?\n'
  + '5. GitHub: anything announced about the X-OAuth-Client-Id response header on GET /user, or about the OAuth device flow, which the hub\'s sign-in check relies on.\n'
  + 'Return the answers as markdown: one short section per question, each ending with "Impact on Protoplasma:" and a one-line verdict (none, watch, or act, and what).'

async function runBatch(title, keys, withUpstream) {
  phase(title)
  const finds = await parallel(keys.map(k => () => agent(context(k) + '\n\n' + SLICES[k], { label: 'find:' + k, phase: title, schema: FINDINGS_SCHEMA, effort: 'high' }))
    .concat(withUpstream ? [() => agent(UPSTREAM, { label: 'upstream', phase: title, effort: 'medium' })] : []))
  const upstream = withUpstream ? finds[keys.length] : null
  const sliceResults = keys.map((k, i) => {
    const r = finds[i]
    if (!r) return { slice: k, failed: true, findings: [] }
    const fs = (r.findings || []).map((f, j) => Object.assign({ id: k + '-' + (j + 1) }, f))
    return { slice: k, failed: false, sound: r.checked_and_sound, notCovered: r.not_covered, extra: r.extra || '', findings: fs }
  })
  for (const s of sliceResults) log(s.slice + ': ' + (s.failed ? 'reviewer failed (partial notes may be in find-' + s.slice + '.md)' : s.findings.length + ' finding(s)'))
  const toVerify = sliceResults.filter(s => s.findings.length)
  const verdicts = await parallel(toVerify.map(s => () => agent(verifyPrompt(s.slice, s.findings), { label: 'verify:' + s.slice, phase: title, schema: VERDICTS_SCHEMA, effort: 'high' })))
  toVerify.forEach((s, i) => {
    const v = verdicts[i]
    const byId = {}
    for (const x of (v && v.verdicts) || []) byId[x.id] = x
    s.findings = s.findings.map(f => Object.assign({}, f, { verdict: byId[f.id] || null }))
    s.verifierFailed = !v
  })
  return { slices: sliceResults, upstream }
}

const b1 = await runBatch('Batch 1', ['hub-signin', 'relay-main', 'build-ci'], false)
const b2 = await runBatch('Batch 2', ['hub-branch', 'lane-agents', 'renderer-solo'], false)
const b3 = await runBatch('Batch 3', ['renderer-ui', 'invariants'], true)

const slices = b1.slices.concat(b2.slices, b3.slices)
const all = slices.flatMap(s => s.findings)
const n = st => all.filter(f => f.verdict && f.verdict.verdict === st).length
log('Done: ' + all.length + ' findings; ' + n('confirmed') + ' confirmed, ' + n('uncertain') + ' uncertain, ' + n('refuted') + ' refuted, ' + all.filter(f => !f.verdict).length + ' without a verdict')
const compact = f => (f.verdict && f.verdict.verdict === 'refuted')
  ? { id: f.id, title: f.title, file: f.file, severity: f.severity, refuted: String(f.verdict.reasoning).slice(0, 300) }
  : f
return { slices: slices.map(s => Object.assign({}, s, { findings: s.findings.map(compact) })), upstream: b3.upstream }

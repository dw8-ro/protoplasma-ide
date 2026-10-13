# Fix log (items from COMPILED.md)

## Batch A: hub — done (commit "Recheck fixes: hub")
Fixed: C1, C2, C3, C4, C10, C11 (token shape checked before asking GitHub), C12, C35, C36, C39, C40, C41, C42, C43, C45 (hub.js part),
C46, C47 (size/look only when changed; ponytail: no coalescing), C49, C50, C51, C52, C53, C54, C55, C56, C57, C117, C118, C119 (hub reads hello.machine), C121.
Moved: C45 README part -> G; C48 sender check -> E (C2 already stops the crash); C119 lane sends `machine` -> B; C120 -> E (the dialog should say so; a 403 would fail agent starts).
Skipped: C44 (underscore logins are Enterprise Managed Users, who can't use the public device-flow sign-in).
Tests: 52 pass (new: dot names, bad JSON, non-member removal, bad frame + reset, write check, more push cases).

## Batch B: agents and worktrees — done (commit "Recheck fixes: agents and session folders")
Fixed: C13, C14, C15 (refuses when non-build ignored files exist; message passed up as `kept`), C29 (lane pings every 20 s),
C58, C59 (question plus both Yes/No answers), C60, C61 (-z everywhere), C62, C63, C64 (fetch beside the poll; null on git failure),
C65, C66, C67, C68, C70, C71, C72, C73, C119 (lane sends a hashed machine id), C122 (no secret for Codex/OpenCode), C123, C124 (and timeout 300 s), C125.
Moved: C69 notice -> C (github.js ignores installPushGuard's result); C15's wording in github.js -> C.
Tests: 56 pass (new: same-time start, odd file names, ignored .env kept, renamed default branch; trust prompt test made realistic).

## Batch C: main process, teams, GitHub, updates — done (commit "Recheck fixes: main process, teams, GitHub, updates")
Fixed: C16, C17, C18 (stopHosting on sign-out; shells killed; folders cleared), C19, C20 (clone into .partial, shared in-flight),
C21, C30 (quit warning counts terminals; shell:kill IPC), C31, C32 (team key = where|id), C69 (startLane returns a notice; renderer alerts it),
C74, C75, C76, C77, C78 (swap.sh logs to ~/Library/Logs and alerts on failure), C79, C80, C81, C82, C83 (verified with real codesign),
C126 (main + renderer button), C127 (renderer shows "Couldn't reach GitHub"), C128, C130, C131 (lock first, top-level return), C132, C133,
C134, C135, C136, C137 (Bonjour made lazily), C138. Also: SIGTERM quits without the dialog (section 14's playground item).
Left: C129 -> "Needs a decision". C137's Info.plist keys -> G.
Tests: 56 unit pass; e2e 117/117.

## Batch D: code view — done (commit "Recheck fixes: code view")
Fixed: C5 (grep -z; --no-index outside git), C6 (codePrefs from applyPrefs), C22, C23 (add/commit -- .), C37, C84 (status prefix; readLane maps
repo-top paths; Explorer/Conflicts/asks use the prefix), C85, C86, C87 (flush at least once a second), C88 (comment: the 3 s poll covers worktrees),
C89 (status notGit; Commit disabled with a note), C90 (read returns {outside}; notes for every case), C91, C92, C93, C94 (all five), C95, C96,
C139, C140, C141, C142, C143, C144 (commit result stays with its folder), C145 (client + server), C146, C147, C148, C149, C150, C151, C152 (forgetFolder).
Not done: C151's "retry Monaco after a failed load" (AMD caches the failed module; showCode now explains the failure instead).
Also: hub lists an agent's own edits first in the same-branch case (the hub test depended on the repo's uncommitted file count).
Tests: 56 unit pass; e2e 117/117.

## Batch E: screens and panes — done (commit "Recheck fixes: screens and panes")
Fixed: C7, C8 (only focused typing, never terminal replies), C9 (followPanes once state has arrived), C24, C25, C38, C97, C98, C99, C100,
C101 (a, b, c: delete confirm reworded), C102, C103, C153 (a deleted team's agents stop), C154, C155, C156, C158, C159 (teamKey checked in main),
C160, C161, C162, C163, C164, C165, C166, C167, C168, C169 (pins refused without a repo), C170, C171 (+ no notification for an agent on screen in
a pane), C172 (a-e), C173, C174, C175, C176, C177, C178, C179, C180, C181 ("Not now"), C182 (option renamed "Active first").
From earlier batches: C48 (answerFile refuses what the hub can't pass), C120 (dialog explains a goal only the creator/owner can change).
Not done: C157 (old terminal output keeps the previous theme's colouring until redrawn: accepted).
Tests: 56 unit pass; e2e 117/117.

## Batch F: markup and CSS — done (commit "Recheck fixes: markup and styles")
Fixed: C26, C27 (--faint #8a8a93 dark / #6b6b74 light), C104, C105, C106 (in-app privacy text), C183 (update bar stays reachable; page behind
Settings inert; focus returns), C184, C185 (<bdi>), C186 (aria-selected on tabs; editor tabs focusable with Enter/Delete; empty alerts kept),
C187, C188, C189, C190. Checked by screenshots (team picker dark, session and Settings light).
Tests: 56 unit pass; e2e 117/117.

## Batch G: tooling, tests and docs — done (commit "Recheck fixes: tooling, tests and docs")
Fixed: C28 (playground stop() waits for both copies to exit), C33 (x-play-token on the control API, printed and saved in <folder>/token; Host
checked), C34 (e2e agent lookup limited to this run's descendants), C107 (two tests renamed; 'hacked' status asserted ignored), C108 (tests run
with GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_NOSYSTEM=1, no PROTO_SHARED_TEAM; asserts main didn't move, not git's wording), C109 (session cut
from origin/main while the main checkout has another branch out; tracked edit blocks removal; names match), C110 (ownBundle positive case),
C111 (sibling-prefix folder and link, dangling link, rename; each checked by breaking files.js on purpose), C112, C113 (IFS newline),
C114, C115, C116, C45/C106 (README privacy and protocol text matches the hub and the in-app text), C191 (15-minute limit, "no unexpected
error alerts" check, temp folders removed, Electron's profile folder too once the process is gone), C192 (release script checks main matches
origin/main; workflow checks the tag is on main), C193 (package.yml: dist plus asar check on pushes and PRs), C194 (install.sh quits a running
copy and swaps via .old), C195 (readiness error, setup failure stops everything), C196 (README Development note). Also C137's Info.plist keys
(build/extend-info.plist via --extend-info).
Not done: the long "add tests for everything untested" lists in C107/C109/C110/C111 beyond the cases above.
Tests: 58 unit pass; e2e 118/118; no protoplasma-* temp folders left after either.

# Section 13: markup and CSS (app/index.html, 1035 lines)

## Covered
- Content-Security-Policy (line 4): every directive against what renderer.js/code.js/panes.js actually load (WebSocket to hubs, avatar images, Monaco workers and fonts, inline style attributes). No script-src, so scripts fall back to default-src 'self'; no inline scripts or on* attributes exist in the markup. Fine as is.
- Script order (1026-1034): xterm, addon-fit, addon-webgl, renderer.js, code.js, panes.js, then Monaco's loader.js last. code.js and panes.js use renderer.js's top-level `const $`, so the order is required and correct. `loadMonaco()` is lazy, so `require` exists by then.
- Element ids: node script (scratch/13/ids.js) compared every `$('#..')`, getElementById and `#id` selector in app/*.js with the markup ids, both ways. No duplicate ids. Only `ghStatus` and `updateStatus` are "missing", and both are written by renderer.js's openSettings (lines 1492, 1512), so they exist when used. Ids nothing looks up: SVG symbols, aria-labelledby targets (inviteTitle, renameTitle, repoLabel, cwdLabel, settingsTitle) and `codeView` (reached through `VIEWS` and `` `#${v}` ``). No orphans.
- Forms: all 7 forms (stepForm, memoryForm, commentForm, createTeam, inviteForm, renameForm, agentForm) have onsubmit + preventDefault. Labels/aria-labels on every input. Button types: every non-submit button inside a form has type="button", including JS-generated ones (`.repo-row`, `.comment-ref .stop`). Maxlengths against src/hub.js (below).
- Dialogs: Esc and button closing for start, inviteDlg, renameDlg, switcher, agent, settings (custom Esc handler, renderer.js:1667); focus targets on open.
- CSS (lines 8-650): all rules read. Dead-selector scan (scratch/13/css.js): every class, id and data attribute in a selector is used somewhere; keyframes all used. Specificity pairs checked: `#createErr:empty` vs `.error:empty` (ID wins, intended), `.foot .error:empty`, `.pane-body .lane` vs `.lane.mine` (same specificity, later wins, intended), `.page-head input` vs the base input rule (later wins), `.step .stop` vs `.comment .stop` (later wins). Dark and light variable sets: light redefines every colour variable the dark set has (complete); `--ui`/`--mono` are shared.
- Grid: body grid with sidebar hidden (`--side:0px`, sidebar `display:none`, settings `inset-left` follows), the code-view grid and the dock clamp `min(var(--dock,36%), calc(100% - 220px))` (consistent with code.js:693's 220px clamp), pane grid, `.lane`/`.lane-bar` container query, dialog max-height and sticky `.foot`.
- z-index/stacking: `.settings` (fixed, z 5, non-modal) vs `.menu` (z 20) vs modal dialogs (top layer) vs the update bar (no z-index).
- Accessibility: contrast ratios computed for `--muted`, `--faint`, `--live`, `--needs`, `--overlap` on canvas/main/surface/raised in both themes, and the teammate palette on light (scratch/13/contrast.js); focus outlines; role/tabindex markup in the static HTML and the JS-generated templates.
- Copy: Settings General, Agents, Notifications, Keyboard (against the menu in app/main.js:212-246 and the ⌘J handler at renderer.js:1660), Data & privacy (against src/hub.js limits, persistence and `views()`, src/shared.js SCROLLBACK, app/github.js scope and safeStorage), About/Account panes (renderer.js:1478-1520), sign-in, teams, invite, rename and new-session text.

CSP verdict: sound. `connect-src ws: wss:` covers the hub socket (renderer only uses `new WebSocket`, no fetch/XHR); `img-src` covers `avatars.githubusercontent.com` plus `github.com` (needed: `https://github.com/<login>.png` redirects to the former, and a hub-supplied `avatar` URL on any other host is blocked, which is good); `worker-src 'self' blob:` and `font-src 'self' data:` cover Monaco; `style-src 'unsafe-inline'` is needed for the many inline style attributes and Monaco. Nothing unnecessary, nothing blocked that the scripts need that I could find. (`base-uri` and `form-action` aren't covered by default-src, but there is no HTML-injection route to use them and will-navigate is blocked in main.js, so not reported.)

## [medium] Keyboard focus is invisible on every checkbox and switch
- Where: app/index.html:87 (`input:focus { outline: none; ... }`) against :62 (`:focus-visible` outline); affects `.switch` (631-634), `.toggle input` (577), `.step input`
- What happens: `input:focus` has specificity (0,1,1) and beats the global `:focus-visible` rule (0,1,0), so every `<input>` that isn't a visually hidden radio loses its focus ring. Text inputs get a border-colour change instead, but checkboxes don't: the six Settings switches (open, sessionBranches, shareFiles, notifyNeeds, notifyDone, badge), "Let teammates type into it", "Look for teams on this network" and the plan-step checkboxes show nothing at all when tabbed to (`.switch` is `appearance:none` with no border, so `border-color` changes nothing). There is also no `.switch:focus-visible` rule. These are the controls that gate "teammates can type on this Mac" and "look for teams on this network", so a keyboard user can't tell which one they are about to flip. Radios are fine (lines 575, 628).
- Evidence: CONFIRMED by cascade: selector specificity (0,1,1) > (0,1,0), and no other rule sets an outline on these elements (read all 650 CSS lines).
- Suggested fix: scope the reset to text-like inputs, `input:not([type=checkbox], [type=radio]):focus { outline: none; ... }`, or add `.switch:focus-visible, .toggle input:focus-visible { outline: 2px solid ... }` after it.

## [medium] `--faint` text fails contrast in both themes, including a security warning
- Where: app/index.html:19 and :39 (the variable), used by `.fine` (90), `.side-label` (148), `.where` (114), `.ago`, `.card-branch`, `.person-meta`, `.panel-label`, placeholders (86) and others
- What happens: computed contrast of `--faint`: dark 2.96 on canvas, 2.82 on main, 2.63 on surface, 2.37 on raised; light 3.09 on canvas, 3.42 on main/surface, 2.95 on raised. WCAG AA for 11.5-12px text needs 4.5. This is informational text people need: the line under "Look for teams on this network" ("Looking shows your GitHub sign-in to every Mac that answers, so turn it on only on networks you trust", `.fine` inside a surface-coloured dialog = 2.63:1 dark), the "signed in" label, branch names, timestamps, section labels, input placeholders, and the tab labels in the code view (`.code-tab`, `.activity button`). `--muted` is fine (dark 4.76-5.93, light 5.63-6.52).
- Evidence: CONFIRMED (computed with WCAG luminance, scratch/13/contrast.js).
- Suggested fix: lift `--faint` to about #8a8a93 in dark (4.6:1 on main) and about #6b6b74 in light (5.1:1), or use `--muted` for the warning/`.fine` copy and keep `--faint` for decoration only.

## [low] Light theme: state colours as small text are just under 4.5:1, and `.lane-label` uses the undarkened teammate colour
- Where: app/index.html:40-42 (`--live`, `--needs`, `--overlap` light), :310 (`.lane-label`), :49 (the only darkening rule)
- What happens: (a) the comment at :48 says teammate colours are "darkened where they're used as text on light", but only `.avatar` is handled. `.lane-label` (the owner's name cut into each terminal's border) uses `color: var(--c)` as is, on a white background: contrast is 1.38 (lime #d9e46a), 1.77 (#6fd6a8), 1.85, 1.95, 2.08, 2.22, 2.49, 2.67. Some labels are nearly invisible in light theme. (b) Light `--live` 4.51, `--needs` 4.43, `--overlap` 4.66 on white, but 3.9-4.2 on canvas/raised, and the 11% tinted `.pill.needs`/`.pill.overlap` backgrounds give 3.88 and 4.01, for 11.5px text.
- Evidence: CONFIRMED (computed).
- Suggested fix: `:root[data-theme=light] .lane-label { color: color-mix(in srgb, var(--c) 62%, black); }`, and darken the three light state colours slightly.

## [low] Settings is a non-modal overlay: it covers the update bar's buttons, and the page behind stays focusable
- Where: app/index.html:594-598 (`.settings`, `position: fixed; inset: 48px 0 0 var(--side)`), :139 (`.update-bar`); renderer.js:1499 (`.show()`, not `.showModal()`)
- What happens: (1) when an update is ready, the bar sits in grid row 2 directly under the 48px title bar, which is exactly where the fixed Settings page starts. Settings covers everything right of the sidebar (all of it when the sidebar is hidden), so "Later" and "Update now", which are at the bar's right edge, are hidden while Settings is open. The About pane's Updates row has only "Check now", so there is no way to install from inside Settings. (2) Because it isn't modal and nothing is `inert`, Tab and Shift+Tab from the Settings controls reach the sessions page, sidebar buttons and terminals hidden behind it, and closing Settings (Done or Esc) doesn't move focus back to anything.
- Evidence: SUSPECTED (by reading; layout and focus order follow from the CSS/DOM and the `.show()` call, not run).
- Suggested fix: set `top` from the bar's height (a `--top` variable updated with the bar) or give `.update-bar` a z-index above 5 and `position: relative`; mark `.sidebar`/`main` `inert` while `#settings` is open and focus the opener on close.

## [low] No maxlength on the pinned-file and invite-username inputs
- Where: app/index.html:794 (`#memoryFile`), :857 (`#inviteLogin`)
- What happens: every other field has the hub's limit (team 60, session 60, rename 60, goal 300, step 200, note 500, comment 500), but `#memoryFile` has none against the hub's 300 (`str(body.file, 300)`, src/hub.js:377) and `#inviteLogin` has none against 39 (hub `str(body.login, 40)` then `GITHUB_LOGIN`, hub.js:488-489). A path pasted over 300 characters is silently cut by the hub, so the note gets pinned to a path that doesn't exist; a username over 39 gets "That isn't a GitHub username" with no hint why.
- Evidence: SUSPECTED (by reading hub.js and the markup; not run).
- Suggested fix: add `maxlength="300"` and `maxlength="39"`.

## [low] Teammates' dotfile paths show reordered in the file lists (`direction: rtl`)
- Where: app/index.html:217 (`.files .path`), renderer.js:1012 (path rendered with no bidi isolation)
- What happens: `direction: rtl` is used so the left end of a long path is clipped and the file name stays visible. For a path that starts with a neutral character (`.github/workflows/ci.yml`, `.gitignore`, `.env.example`, `_private.js`, `@scope/pkg`, `[id]/page.tsx`) the Unicode bidi algorithm places that leading character on the right, so it displays as `github/workflows/ci.yml.`, `gitignore.`, `private.js_`. This is in the overlap list on session cards and in the panel's "files changed" lists.
- Evidence: SUSPECTED (UAX #9 rules N1/N2 for a neutral at the start of an RTL paragraph; not rendered).
- Suggested fix: prefix the path with a left-to-right mark (`‎`) in the template, or wrap it in `<bdi>`.

## [low] Plan-step "remove" button can't be reached from the keyboard
- Where: app/index.html:448-449 (`.step .stop { visibility: hidden }`, `.step:hover .stop { visibility: visible }`)
- What happens: `visibility: hidden` takes the button out of the tab order, and the show rule is `:hover` only (no `:focus-within`), so keyboard-only users can't remove a step. The same pattern as `.ws-row .ws-menu` is correct there (`opacity` plus a `:focus-visible` rule at 154); here it is not. The `.code-tab .x` close control (395-396) is a span inside a div that isn't focusable either (see next finding).
- Evidence: CONFIRMED by CSS semantics (hidden elements aren't focusable; no focus rule exists).
- Suggested fix: `.step:hover .stop, .step:focus-within .stop { visibility: visible }`, or use `opacity` like `.ws-menu`.

## [low] Tab and live-region semantics are incomplete
- Where: app/index.html:741-742 (`role="tablist"`/`role="tab"`, no aria-selected), :804 (`.panel-tabs`), :770 (`.dock-tabs`), :754 (`#codeTabs`, children built at code.js:345 as `<div role="tab">` with no tabindex); `.error:empty` (584) with `role="alert"` at :713, 788, 799, 859, 869, 850
- What happens: (1) the Explorer/Conflicts tabs declare tab roles but nothing ever sets `aria-selected` (grep found it only on the repo and switcher options); the Session/Environment and Agent/Terminal switchers have no roles or pressed state, so the active one is shown only by colour. The editor's tabs are non-focusable divs, so with the keyboard the only way to switch files is ⌘P. (2) Six `role="alert"` paragraphs are `display:none` while empty (`.error:empty`), and many screen readers don't announce text that arrives together with the element becoming visible. `#createErr` and `#agentErr` are not affected (forced `display:block`).
- Evidence: SUSPECTED (by reading; no assistive tech run).
- Suggested fix: add `aria-selected` where `.on` is toggled and `tabindex`/arrow keys for the editor tabs (or drop the tab roles); keep alert paragraphs `display:block` with `min-height:0`, or visually hide instead of `display:none`.

## [low] Long names overflow at narrow window widths (header crumbs, filter chip)
- Where: app/index.html:246-251 (`.room-head`, `.crumbs b`), :179 (`.chip`), :174 (`.page-head`)
- What happens: (1) `.crumbs b` (the session name, up to 60 characters, about 420px) is a flex item with `white-space: nowrap` inherited from `.room-head` and no `overflow:hidden`/ellipsis, so it can't shrink. At the minimum window (900px, sidebar open) the crumbs get about 330px beside the Code, New pane, panel toggle and Share buttons, so a name over roughly 45 characters runs under the buttons; the task crumb and "who" label shrink first, then the name overlaps. (2) `.chip` is a fixed 26px high with no nowrap/ellipsis; the filter chip holds an `owner/repo` name (`#filterChip`, renderer.js:943) next to a 190px search box, a select and the New button, so a long workspace name wraps inside the 26px chip and spills out of it (about 14+ characters at 900px).
- Evidence: SUSPECTED (by reading and arithmetic; not rendered).
- Suggested fix: `.crumbs b { min-width: 0; overflow: hidden; text-overflow: ellipsis; }` and `.chip { max-width: 100%; white-space: nowrap; } .chip > :first-child`/text in a span with ellipsis.

## [low] Settings "Default agent" row doesn't fit between 900 and about 1060px with the sidebar open
- Where: app/index.html:959 (`style="min-width: 330px"`), :612 (`.setting`), :598 (`grid-template-columns: 212px 1fr`)
- What happens: at the 900px minimum window width, the Settings body is 900-248-212 = 440px wide, less 64px padding and 32px row padding = 344px. The 330px segmented control plus the 20px gap leaves no room for the text, whose minimum is its longest word, so the row is wider than its card and the control sticks out past the card's right border (the body scrolls sideways). The Theme row (218px of tiles) is tight but wraps. Hiding the sidebar (⌘B) fixes it.
- Evidence: SUSPECTED (by arithmetic from the CSS; not rendered).
- Suggested fix: let `.setting` wrap (`flex-wrap: wrap`) or drop the 330px min-width in favour of `min-width: 0` with smaller labels.

## [low] Keyboard list: ⌘J is described as "Toggle the session panel", but in the code view it hides the agents dock
- Where: app/index.html:997; renderer.js:1660 (`code.on ? toggleDock() : $('#panelToggle').click()`)
- What happens: with a file open (code view) ⌘J toggles the dock holding the agents, Terminal tab and session panel; the code-view welcome text calls it "Toggle the panel" (line 763) and the menu "Toggle Panel", but Settings says "session panel". ⇧⌘M "Comment on the selected lines" is also listed with no mention that it only works with the editor focused (it is a Monaco keybinding, code.js:92, not in the menu). Everything else in the list matches app/main.js (⌘N, ⌘K, ⇧⌘L, ⌘P, ⌘S, ⌘I, ⇧⌘T, ⌘B, ⇧⌘E, ⌘J, ⌘,).
- Evidence: SUSPECTED (by reading main.js and renderer.js).
- Suggested fix: "Toggle the panel (the agents dock when a file is open)" and "Comment on the selected lines (in the editor)".

## [low] Data & privacy leaves out what the hub relays about each checkout, and the 256 KB figure is a floor
- Where: app/index.html:1013-1015; src/hub.js:143-145 (`views()`), src/shared.js:4,16
- What happens: the three lists name notes, plans, comments, terminal output and hook events, but not the other things the hub holds in memory and shows teammates for every running agent: the names of the files each checkout changed (up to 200), branch name, git summary and the last prompt (`views()` sends `git`, `branch`, `prompt`). "Not kept on the hub: Your repos and their files" is true of contents, but file names are shown on every card's overlap list. The hub also receives each checkout's folder paths (`root`/`roots`, up to 1000 characters, used for hook path checks; only a hash `tree` is broadcast), which no list mentions. Separately, "The last 256 KB of each agent's output is held" is the trim target: `shared.js:16` trims only when the buffer exceeds 512 KB, so up to 512 KB is held. All other claims check out: GitHub token is only hashed (hub.js:105-112, never stored), stored on the Mac with safeStorage (github.js:20), scope read:user (github.js:45), 20 stopped agents per team (MAX_STOPPED), comment snippet 300, shared files relayed and not stored (hub.js:587-595), scrollback and stopped screens in memory only (teams.json holds teams, sessions, notes only).
- Evidence: SUSPECTED (by reading hub.js; not run).
- Suggested fix: add "file names changed, branch and last prompt, while an agent runs" to "Passed through the hub" and say "up to 512 KB".

## [low] Error text and most dialog text can't be selected or copied
- Where: app/index.html:56 (`body { user-select: none }`), :529 (`dialog { user-select: none }`)
- What happens: `.error` paragraphs (sign-in failures, "Only the files ... are shared", hub errors), the GitHub CLI status in Settings > Account (`#ghStatus`, which holds the `gh` error output when it's missing or logged out) and the update error in the bar can't be selected, so a user can't copy them into a bug report; only inputs, comments, notes and the sign-in code are selectable.
- Evidence: SUSPECTED (by reading the CSS).
- Suggested fix: `.error, #ghStatus, #updateText, .settings-body p { user-select: text; }`.

## Outside my scope
- app/code.js:345: the editor tab is a `div role="tab"` with no tabindex, and its close control is a `role="button"` span (line 346) with no tabindex; keyboard users can't close or switch tabs (markup-side noted above).
- app/renderer.js:1537: `$('#updateStatus').textContent = ...` is unguarded while the lookups at 1505 and 1521 guard with `if ($('#...'))`; safe today only because the button exists only in the About pane after `appInfo()` resolves.
- Monaco's default worker creation under the CSP (`worker-src 'self' blob:`, no `MonacoEnvironment`, file:// base) can't be confirmed without running; the e2e would show it if workers fail (Monaco falls back to the main thread with a console warning).

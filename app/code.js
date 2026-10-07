// The code view: a session's files on this Mac in a real editor (Monaco, the one inside VS Code), beside its agents.
// As in Amoeba, opening a file switches the session view to the code, and the agents move to a panel underneath.
// Your agent's edits appear as it makes them. Teammates' code stays on their Macs; the Explorer marks the files
// their agents are changing. Uses renderer.js's state and helpers ($, esc, setHTML, current, local, hubLanes, ...).

const code = {
  on: false,            // the session view shows the code
  root: null,           // the session's folder on this Mac
  files: [],            // its files, as paths from the root
  tree: null,
  changes: new Map(),   // path -> M | A | D | R | U
  changedDirs: new Set(),
  branch: '',
  open: [],             // paths with a tab
  active: null,
  diff: null,           // the open path shown as changes since the last commit (or against a teammate's, below)
  against: null,        // with diff: the teammate's agent whose version it's compared with
  explorer: 'files',    // the Explorer's tab: files | conflicts
  pane: 'explorer',     // explorer | search | changes
  expanded: new Set(),
  unpushed: 0,          // commits on the branch that aren't pushed
  dock: 'agent',        // what the panel underneath shows: agent | terminal
  dockHidden: false,
};
const models = new Map(); // path -> { model, saved, stale, view, note }
let monacoReady, editor, diffEditor;
const base = p => p.slice(p.lastIndexOf('/') + 1);
const dirOf = p => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const isDirty = entry => !!entry?.model && !entry.theirs && entry.model.getAlternativeVersionId() !== entry.saved;

// ---- Monaco ----

function loadMonaco() {
  return monacoReady ||= new Promise((resolve, reject) => {
    require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
    require(['vs/editor/editor.main'], () => {
      // Without the project's config and dependencies, TypeScript would flag imports everywhere; keep syntax errors only.
      for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) defaults.setDiagnosticsOptions({ noSemanticValidation: true });
      resolve(window.monaco);
    }, reject);
  });
}
const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function editorTheme() {
  if (!window.monaco) return;
  const light = effectiveTheme() === 'light';
  monaco.editor.defineTheme('protoplasma', { base: light ? 'vs' : 'vs-dark', inherit: true, rules: [], colors: {
    'editor.background': cssVar('--main'), 'editorGutter.background': cssVar('--main'), 'minimap.background': cssVar('--main'),
    'editor.lineHighlightBackground': cssVar('--surface'), 'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': cssVar('--faint'), 'editorLineNumber.activeForeground': cssVar('--muted'),
    'editorWidget.background': cssVar('--surface'), 'editorWidget.border': cssVar('--line'), 'editorIndentGuide.background1': cssVar('--line'),
    'scrollbarSlider.background': `${cssVar('--line-strong')}99`, 'scrollbarSlider.hoverBackground': cssVar('--line-strong'),
  } });
  monaco.editor.setTheme('protoplasma');
}
new MutationObserver(() => { editorTheme(); for (const s of shells.values()) Object.assign(s.term.options, { theme: terminalTheme(), minimumContrastRatio: contrastFloor() }); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

async function ensureEditor() {
  await loadMonaco();
  if (editor) return;
  editorTheme();
  const host = $('#codeEditor');
  host.innerHTML = '<div class="ed"></div><div class="ed" hidden></div>';
  const options = { automaticLayout: true, theme: 'protoplasma', fontFamily: terminalFont(), fontSize: prefs.fontSize + 0.5, glyphMargin: true,
    minimap: { renderCharacters: false }, scrollBeyondLastLine: false, smoothScrolling: true, padding: { top: 10 }, fixedOverflowWidgets: true };
  editor = monaco.editor.create(host.children[0], options);
  diffEditor = monaco.editor.createDiffEditor(host.children[1], { ...options, originalEditable: false, renderOverviewRuler: false });
  for (const ed of [editor, diffEditor.getModifiedEditor()]) {
    ed.onDidChangeModelContent(() => renderTabs());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveActive);
    ed.addAction({ id: 'protoplasma.comment', label: 'Comment on this for the session', contextMenuGroupId: 'navigation', contextMenuOrder: 0,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM], run: commentOn });
  }
}

// ---- The session's folder ----

/** Shows the code (or hides it, with `on` false). Resolves to whether there's a folder to show. */
async function showCode(on = true) {
  if (!on || view !== 'session') { code.on = false; render(); return false; }
  code.on = true;
  render();
  await Promise.all([openRoot(), ensureEditor()]);
  render();
  return !!code.root;
}
// The session's folder on this Mac: where your agent in it runs, or the checkout the app made for it. Null if neither.
function rootFor(session) {
  const mine = [...local].find(([, l]) => l.teamKey === currentTeam.key && l.session === session);
  const source = sourceFor(session);
  return proto.code.root(mine ? { lane: mine[0] }
    : source?.repo && source.worktree !== false ? { repo: source.repo, name: recordFor(session)?.key || session } : {});
}
/** The open session's files, for checking a path someone typed; null when its code isn't on this Mac. */
async function sessionFiles() {
  const root = await rootFor(current).catch(() => null);
  if (root && root === code.root && code.files.length) return code.files;
  return root ? proto.code.list(root).catch(() => null) : null;
}
async function openRoot() {
  const root = await rootFor(current);
  if (root === code.root) return;
  for (const entry of models.values()) entry.model?.dispose();
  models.clear();
  Object.assign(code, { root, files: [], tree: null, changes: new Map(), changedDirs: new Set(), branch: '', open: [], active: null, diff: null });
  if (!root) return;
  await refreshFiles();
  proto.code.watch(root);
}
async function refreshFiles() {
  const root = code.root;
  const [files, { branch, unpushed, underWay, changes }] = await Promise.all([proto.code.list(root), proto.code.status(root)]);
  if (root !== code.root) return;
  code.files = files;
  code.tree = treeOf(files);
  // New changes since, or a rebase that has ended: the note on screen no longer applies.
  if (changes.length > code.changes.size || (code.underWay && !underWay)) $('#commitNote').textContent = '';
  code.branch = branch;
  code.unpushed = unpushed;
  code.underWay = underWay;
  code.changes = new Map(changes.map(c => [c.path, c.state]));
  code.changedDirs = new Set(changes.flatMap(c => c.path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))));
  render();
}
// Files changed on disk: by your agent, a teammate's pull, or you in another editor.
let refreshTimer;
proto.code.onChanged((root, paths) => {
  if (root !== code.root) return;
  for (const p of paths) if (models.has(p)) reload(p);
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshFiles, 250);
});
async function reload(path, { force = false } = {}) {
  const entry = models.get(path);
  if (!entry?.model) return;
  const file = await proto.code.read(code.root, path);
  if (file.text == null || file.text === entry.model.getValue()) return;
  if (isDirty(entry) && !force) { entry.stale = true; return render(); }
  entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: file.text }], () => null);
  entry.saved = entry.model.getAlternativeVersionId();
}

// ---- Opening, showing and saving files ----

async function modelFor(path) {
  if (models.has(path)) return models.get(path);
  const file = await proto.code.read(code.root, path);
  const entry = { note: file.binary ? 'This file isn\'t text, so it isn\'t shown here.' : file.tooBig ? 'This file is too big to open here.'
    : file.gone ? 'This file has been deleted.' : '' };
  if (file.text != null) {
    entry.model = monaco.editor.createModel(file.text, undefined, monaco.Uri.file(`${code.root}/${path}`));
    entry.saved = entry.model.getAlternativeVersionId();
  }
  models.set(path, entry);
  return entry;
}
/** Opens a file in the code view, at `line`, or as its changes since the last commit with `diff`. */
async function openFile(path, { line, match, diff = false, against = null } = {}) {
  if (!await showCode()) return;
  if (!code.open.includes(path)) code.open.push(path);
  rememberView();
  code.active = path;
  code.diff = diff ? path : null;
  code.against = diff ? against : null;
  for (const dir of path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))) code.expanded.add(dir);
  await modelFor(path);
  render();
  await showActive(line, match);
}
function rememberView() {
  const entry = models.get(code.active);
  if (entry?.model && code.diff !== code.active) entry.view = editor.saveViewState();
}
let committedModel = null; // the last commit's version shown in a diff, ours to dispose
async function showActive(line, match) {
  const entry = code.active && models.get(code.active);
  const [plain, changes] = $('#codeEditor').children;
  if (entry?.model && code.diff === code.active) {
    const theirs = code.against && (await theirModel(code.against, code.active)).model;
    const before = theirs || monaco.editor.createModel(await proto.code.committed(code.root, code.active), entry.model.getLanguageId());
    diffEditor.setModel({ original: before, modified: entry.model });
    committedModel?.dispose();
    committedModel = theirs ? null : before;
    [plain.hidden, changes.hidden] = [true, false];
    diffEditor.getModifiedEditor().focus();
  } else {
    editor.setModel(entry?.model || null);
    editor.updateOptions({ readOnly: !!entry?.theirs });
    marks.last = null;
    if (entry?.view) editor.restoreViewState(entry.view);
    [plain.hidden, changes.hidden] = [false, true];
    if (line) {
      const at = match ? entry.model.getLineContent(line).toLowerCase().indexOf(match.toLowerCase()) : -1;
      editor.setSelection(at < 0 ? new monaco.Selection(line, 1, line, 1) : new monaco.Selection(line, at + 1, line, at + 1 + match.length));
      editor.revealLineInCenter(line);
    }
    if (entry?.model) editor.focus();
  }
  renderBanner();
  marks();
}
function closeFile(path) {
  const entry = models.get(path);
  if (isDirty(entry) && !confirm(`Close ${base(path)} without saving your changes?`)) return;
  if (diffEditor?.getModel()?.modified === entry?.model) diffEditor.setModel(null);
  entry?.model?.dispose();
  models.delete(path);
  const at = code.open.indexOf(path);
  code.open.splice(at, 1);
  if (code.active === path) { code.active = code.open[Math.min(at, code.open.length - 1)] || null; code.diff = null; }
  render();
  showActive();
}
async function saveActive() {
  const path = code.active, entry = models.get(path);
  if (!code.on || !entry?.model || entry.theirs) return;
  if (entry.stale && !confirm(`${base(path)} changed on disk while you were editing it, probably by an agent. Save yours over that change?`)) return;
  try {
    await proto.code.write(code.root, path, entry.model.getValue());
    entry.saved = entry.model.getAlternativeVersionId();
    entry.stale = false;
    render();
  } catch (e) { alert(errorText(e)); }
}

// ---- Drawing it ----

// Called from render(): lays out the session view for the code, or puts it back.
let lookedFor = null;
function renderCode() {
  const on = code.on && view === 'session';
  $('#room').classList.toggle('coding', on);
  $('#room').classList.toggle('dock-hidden', on && code.dockHidden);
  $('#code').hidden = $('#dockGrip').hidden = $('#dockTabs').hidden = !on;
  $('#codeToggle').classList.toggle('on', on);
  const shell = on && code.dock === 'terminal';
  $('#shellPane').hidden = !shell;
  if (shell) for (const id of ['#lanes', '#replayPanel', '#ghPanel', '#memoryPanel', '#backBar']) $(id).hidden = true;
  for (const b of $('#dockTabs').children) b.classList.toggle('on', b.dataset.dock === code.dock);
  if (!on) return;
  // An agent started since the code was opened brings the session's folder with it.
  const agentsHere = [...local].filter(([, l]) => l.session === current).map(([id]) => id).join();
  if (!code.root && agentsHere !== lookedFor) { lookedFor = agentsHere; openRoot().then(() => code.root && render()); }
  teammates = teammatesFiles();
  for (const b of $('.activity').querySelectorAll('[data-code-view]')) b.classList.toggle('on', b.dataset.codeView === code.pane);
  for (const p of $('.code-side').children) p.hidden = p.dataset.codePane !== code.pane;
  $('#changeCount').hidden = !code.changes.size;
  $('#changeCount').textContent = code.changes.size;
  $('#codeBranch').textContent = code.branch;
  $('#codeBranch').title = code.branch;
  const pushOnly = !code.changes.size && code.unpushed > 0;
  $('#commitBtn').textContent = pushOnly ? `Push ${code.unpushed} commit${code.unpushed === 1 ? '' : 's'}` : 'Commit & Push';
  $('#commitMessage').hidden = pushOnly;
  $('#commitBtn').disabled = !!code.underWay;
  if (code.underWay) $('#commitNote').textContent = `A ${code.underWay} is under way${[...code.changes.values()].includes('C') ? ', with conflicts in the files marked C' : ''}. `
    + `Finish it or abort it in the Terminal tab (git ${code.underWay} --continue or --abort), then commit.`;
  $('#codeWelcomeText').textContent = code.root ? 'Start working in this repository'
    : 'This session\'s code isn\'t on this Mac yet. Add an agent and its folder opens here.';
  $('#codeWelcome').hidden = !!code.active;
  for (const b of $('#explorerTabs').children) b.classList.toggle('on', b.dataset.explorer === code.explorer);
  $('#codeTree').hidden = code.explorer !== 'files';
  $('#codeConflicts').hidden = code.explorer !== 'conflicts';
  const conflicts = conflictRows();
  $('#conflictCount').textContent = conflicts.count;
  setHTML($('#codeConflicts'), conflicts.html);
  setHTML($('#codeTree'), code.tree ? treeRows(code.tree) : '');
  marks();
  setHTML($('#codeChanges'), [...code.changes].sort(([a], [b]) => a.localeCompare(b))
    .map(([path]) => fileRow(path, 0, base(path), dirOf(path))).join('') || (code.root ? '<p class="panel-empty">No changes since the last commit.</p>' : ''));
  renderTabs();
  renderBanner();
}
function renderTabs() {
  setHTML($('#codeTabs'), code.open.map(key => {
    const theirs = theirsOf(key), path = theirs?.path || key;
    const note = theirs ? laneName(theirs.lane) : code.diff === key ? (code.against ? `vs ${laneName(code.against)}` : 'changes') : '';
    return `<div class="code-tab ${key === code.active ? 'on' : ''} ${isDirty(models.get(key)) ? 'dirty' : ''}" data-tab-file="${esc(key)}" title="${esc(theirs ? `${laneName(theirs.lane)}'s ${path}` : path)}" role="tab">
      ${esc(base(path))}${note ? `<small>${esc(note)}</small>` : ''}<span class="x" data-close-file="${esc(key)}" role="button" aria-label="Close ${esc(base(path))}"></span></div>`;
  }).join(''));
}
function renderBanner() {
  const entry = code.active && models.get(code.active), theirs = theirsOf(code.active);
  const text = entry?.stale ? 'This file changed on disk while you were editing it.'
    : theirs ? entry?.note || `${laneName(theirs.lane)}'s version, read-only. It updates as their agent works.` : entry?.note || '';
  $('#codeBanner').hidden = !text;
  setHTML($('#codeBanner'), text ? `<span>${esc(text)}</span>${entry.stale
    ? '<span class="spacer"></span><button class="btn small" data-reload>Load theirs</button><button class="btn small" data-keep>Keep mine</button>' : ''}` : '');
}

function treeOf(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    let node = root;
    for (const dir of file.split('/').slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push(file);
  }
  return root;
}
function treeRows(node, prefix = '', depth = 0) {
  let html = '';
  for (const [name, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    const dir = prefix + name, open = code.expanded.has(dir);
    html += `<button class="tree-row ${open ? 'open' : ''}" data-dir="${esc(dir)}" style="--depth:${depth}" role="treeitem" aria-expanded="${open}">
      <svg class="chev"><use href="#chevron"/></svg><span class="name">${esc(name)}</span>${code.changedDirs.has(dir) ? '<span class="dot"></span>' : ''}</button>`;
    if (open) html += treeRows(child, `${dir}/`, depth + 1);
  }
  return html + node.files.sort((a, b) => a.localeCompare(b)).map(file => fileRow(file, depth, base(file))).join('');
}
// Files teammates' agents are changing in this repo (in their own checkouts), with who.
function teammatesFiles() {
  const theirs = new Map();
  for (const l of hubLanes) {
    if (local.has(l.id) || same(l.login, me.login) || !(roomRepo ? l.repo === roomRepo : l.session === current)) continue;
    // On your branch, only what they haven't pushed: the rest is in your checkout too.
    for (const f of l.branch && l.branch === code.branch ? l.local || l.files : l.files) theirs.set(f, [...(theirs.get(f) || []), l]);
  }
  return theirs;
}
let teammates = new Map(); // refreshed on every render
function fileRow(path, depth, label, hint = '') {
  const theirs = teammates.get(path) || [];
  const state = code.changes.get(path) || '';
  const names = [...new Set(theirs.map(l => l.name))].join(' and ');
  const title = theirs.length ? `${path}\n${names} ${theirs.length === 1 ? 'is' : 'are'} changing this${state ? ' too' : ''}` : path;
  return `<button class="tree-row ${state} ${theirs.length && state ? 'overlap' : ''} ${path === code.active ? 'on' : ''}" data-file="${esc(path)}" style="--depth:${depth}" title="${esc(title)}" role="treeitem">
    <span class="leaf"></span><span class="name">${esc(label)}${hint ? ` <span class="dir">${esc(hint)}</span>` : ''}</span>
    ${theirs.length ? `<span class="theirs" style="--c:${colorFor(theirs[0].login)}" data-theirs="${esc(theirs[0].id)}" title="Open ${esc(theirs[0].name)}'s version"></span>` : ''}${state ? `<span class="state ${state}">${state}</span>` : ''}</button>`;
}

// ---- A teammate's version of a file ----
// Asked for through the hub; their app answers if they share files (Settings → Agents). See answerFile in renderer.js.

const theirsKey = (lane, path) => `theirs:${lane}:${path}`;
const theirsOf = key => (key?.startsWith('theirs:') ? { lane: key.split(':')[1], path: key.split(':').slice(2).join(':') } : null);
const laneName = id => hubLanes.find(l => l.id === id)?.name || 'A teammate';
const asks = new Map(); // ask -> resolve
let askCount = 0;
function askFile(lane, path) {
  return new Promise(resolve => {
    if (ws?.readyState !== WebSocket.OPEN) return resolve({ error: 'Not connected to the team right now.' });
    const ask = String(++askCount);
    asks.set(ask, resolve);
    ws.send(JSON.stringify({ t: 'file:get', lane, path, ask }));
    setTimeout(() => { if (asks.delete(ask)) resolve({ error: `${laneName(lane)}'s app didn't answer.` }); }, 12_000);
  });
}
function fileAnswered(m) { const done = asks.get(m.ask); asks.delete(m.ask); done?.(m); }
async function theirModel(lane, path) {
  const key = theirsKey(lane, path);
  const entry = models.get(key) || { theirs: true };
  models.set(key, entry);
  const answer = await askFile(lane, path);
  if (answer.text == null) entry.note = answer.error;
  else {
    entry.note = '';
    if (!entry.model) entry.model = monaco.editor.createModel(answer.text, undefined, monaco.Uri.parse(`theirs://${lane}/${path}`));
    else if (entry.model.getValue() !== answer.text) entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: answer.text }], () => null);
  }
  return entry;
}
async function openTheirs(lane, path) {
  await showCode();
  await ensureEditor();
  const key = theirsKey(lane, path);
  if (!code.open.includes(key)) code.open.push(key);
  rememberView();
  Object.assign(code, { active: key, diff: null, against: null });
  await theirModel(lane, path);
  render();
  showActive();
}
// Kept current while it's on screen.
setInterval(() => {
  if (!code.on || view !== 'session' || document.hidden) return;
  const theirs = theirsOf(code.active);
  if (theirs) theirModel(theirs.lane, theirs.path).then(entry => (entry.model && editor.getModel() !== entry.model && code.active === theirsKey(theirs.lane, theirs.path) ? showActive() : renderBanner()));
  else if (code.against && code.diff === code.active) theirModel(code.against, code.active);
}, 1500);

// ---- Conflicts: what you and a teammate both changed, and merge conflicts here ----

function conflictRows() {
  const merges = [...code.changes].filter(([, state]) => state === 'C').map(([path]) => path);
  const mine = hubLanes.filter(l => local.has(l.id) && l.session === current);
  const both = [...new Set(mine.flatMap(l => l.overlaps))].filter(f => !merges.includes(f));
  const html = merges.map(path => `<div class="conflict" title="A merge conflict in your checkout">${fileRow(path, 0, base(path), dirOf(path))}</div>`).join('')
    + both.map(path => {
      const others = hubLanes.filter(o => !local.has(o.id) && o.overlaps.includes(path));
      return `<div class="conflict">${fileRow(path, 0, base(path), dirOf(path))}
        ${others.map(o => `<button class="btn small" data-compare="${esc(o.id)}" data-path="${esc(path)}">Compare with ${esc(o.name)}'s</button>`).join('')}</div>`;
    }).join('');
  return { count: merges.length + both.length, html: html || '<p class="panel-empty">Nothing here. Files you and a teammate both change, and merge conflicts, show up here.</p>' };
}

// ---- Comments on lines ----

function commentOn(ed) {
  const path = theirsOf(code.active)?.path || code.active, sel = ed.getSelection();
  if (!path || !sel) return;
  const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
  setCommentRef({ file: path, line: sel.startLineNumber, endLine, snippet: ed.getModel().getLineContent(sel.startLineNumber).trim().slice(0, 300) });
  Object.assign(code, { dockHidden: false });
  panelHidden = false;
  panelTab = 'session';
  render();
  $('#commentText').focus();
}
// The session's comments on the open file, beside the lines they're about.
let commentMarks;
function marks() {
  if (!editor || !window.monaco) return;
  const path = theirsOf(code.active)?.path || code.active;
  const list = (recordFor(current)?.comments || []).filter(c => c.file && c.file === path && c.line);
  const key = JSON.stringify(list.map(c => c.id));
  if (key === marks.last) return;
  marks.last = key;
  commentMarks ||= editor.createDecorationsCollection();
  commentMarks.set(list.map(c => ({ range: new monaco.Range(c.line, 1, c.endLine || c.line, 1), options: { isWholeLine: true, className: 'commented-line',
    glyphMarginClassName: 'comment-glyph', glyphMarginHoverMessage: { value: `**${c.author}:** ${c.text.replace(/[\\`*_[\]<>]/g, '\\$&')}` } } })));
}

// ---- Searching ----

let searchTimer;
$('#codeQuery').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const query = $('#codeQuery').value, root = code.root;
    const hits = root && query.trim() ? await proto.code.search(root, query).catch(() => []) : [];
    if (root !== code.root || query !== $('#codeQuery').value) return;
    const byFile = new Map();
    for (const hit of hits) byFile.set(hit.path, [...(byFile.get(hit.path) || []), hit]);
    setHTML($('#codeHits'), [...byFile].map(([path, list]) => `<div class="hit-file" title="${esc(path)}">${esc(path)}</div>`
      + list.map(h => `<button class="hit" data-file="${esc(path)}" data-line="${h.line}"><b>${h.line}</b>${snippet(h.text, query)}</button>`).join('')).join('')
      || (query.trim() ? '<p class="panel-empty">Nothing found.</p>' : ''));
  }, 200);
};
// The line from just before the match, with the match marked.
function snippet(text, query) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return esc(text);
  const from = Math.max(0, at - 16);
  return `${from ? '…' : ''}${esc(text.slice(from, at))}<mark>${esc(text.slice(at, at + query.length))}</mark>${esc(text.slice(at + query.length))}`;
}
// ⌘P: the Go to list, with the folder's files.
function goToFile() {
  if (view !== 'session') return;
  showCode().then(ok => ok && openSwitcher(() => code.files.map(f => ({ text: f, kind: { M: 'Changed', A: 'Added', U: 'New', D: 'Deleted', R: 'Renamed' }[code.changes.get(f)] || '', run: () => openFile(f) })), 'Go to a file'));
}

// ---- Commit & Push ----

async function commit() {
  const pushOnly = !code.changes.size && code.unpushed > 0;
  const message = pushOnly ? '' : $('#commitMessage').value.trim(), note = $('#commitNote');
  if (!pushOnly && !message) return $('#commitMessage').focus();
  if (!pushOnly && !code.changes.size) { note.textContent = 'There\'s nothing to commit.'; return; }
  if ([...models.values()].some(isDirty)) { note.textContent = 'Save your open files first (⌘S).'; return; }
  if (/^(main|master)$/.test(code.branch) && !confirm(`Commit and push straight to ${code.branch}?`)) return;
  $('#commitBtn').disabled = true;
  note.textContent = 'Committing…';
  try {
    note.textContent = await proto.code.commit(code.root, message);
    $('#commitMessage').value = '';
  } catch (e) {
    note.textContent = errorText(e);
  } finally {
    $('#commitBtn').disabled = false;
    await refreshFiles();
    if (code.diff) { code.diff = null; render(); showActive(); } // its changes are committed now
  }
}
$('#commitBtn').onclick = commit;
$('#commitMessage').oninput = () => { if (!code.underWay) $('#commitNote').textContent = ''; };
$('#commitMessage').onkeydown = e => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); commit(); } };

// ---- The Terminal tab: a plain shell in the folder, on this Mac only ----

const shells = new Map(); // root -> { id, term, el }
async function showShell() {
  for (const [root, s] of shells) s.el.hidden = root !== code.root;
  if (!code.root) return;
  let s = shells.get(code.root);
  if (!s) {
    const el = document.createElement('div');
    el.className = 'shell-term';
    el.style.height = '100%';
    $('#shellPane').append(el);
    const term = new Terminal({ fontSize: prefs.fontSize, lineHeight: prefs.lineHeight, fontFamily: terminalFont(), theme: terminalTheme(),
      minimumContrastRatio: contrastFloor(), cursorBlink: true, scrollback: 5000 });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    gpu({ term }, true);
    fit.fit();
    s = { term, el, id: await proto.shell.start(code.root, term.cols, term.rows) };
    shells.set(code.root, s);
    term.onData(d => proto.shell.write(s.id, d));
    new ResizeObserver(() => { if (!el.hidden && el.offsetParent) { fit.fit(); proto.shell.resize(s.id, term.cols, term.rows); } }).observe(el);
  }
  s.term.focus();
}
proto.shell.onData((id, d) => { for (const s of shells.values()) if (s.id === id) s.term.write(d); });
proto.shell.onExit(id => {
  for (const [root, s] of shells) if (s.id === id) { s.term.dispose(); s.el.remove(); shells.delete(root); }
  if (code.dock === 'terminal') { code.dock = 'agent'; render(); }
});

// ---- Clicks and keys ----

const toggleDock = () => { code.dockHidden = !code.dockHidden; render(); };
$('#codeToggle').onclick = () => showCode(!code.on);
$('.activity').onclick = e => {
  const pane = e.target.closest('[data-code-view]')?.dataset.codeView;
  if (!pane) return;
  code.pane = pane;
  render();
  if (pane === 'search') $('#codeQuery').focus();
  if (pane === 'changes') refreshFiles();
};
$('.code-side').onclick = e => {
  const tabbed = e.target.closest('[data-explorer]');
  if (tabbed) { code.explorer = tabbed.dataset.explorer; return render(); }
  if (e.target.dataset.theirs) return openTheirs(e.target.dataset.theirs, e.target.closest('[data-file]').dataset.file);
  if (e.target.dataset.compare) return openFile(e.target.dataset.path, { diff: true, against: e.target.dataset.compare });
  const row = e.target.closest('[data-dir], [data-file]');
  if (!row) return;
  if (row.dataset.dir) {
    const dir = row.dataset.dir;
    code.expanded.has(dir) ? code.expanded.delete(dir) : code.expanded.add(dir);
    return render();
  }
  openFile(row.dataset.file, { line: Number(row.dataset.line) || undefined, match: row.dataset.line && $('#codeQuery').value, diff: code.pane === 'changes' });
};
$('#codeTabs').onclick = e => {
  const close = e.target.closest('[data-close-file]');
  if (close) return closeFile(close.dataset.closeFile);
  const tab = e.target.closest('[data-tab-file]');
  if (tab && tab.dataset.tabFile !== code.active) { rememberView(); code.active = tab.dataset.tabFile; code.diff = code.against = null; render(); showActive(); }
};
$('#codeTabs').onauxclick = e => { const tab = e.target.closest('[data-tab-file]'); if (e.button === 1 && tab) closeFile(tab.dataset.tabFile); };
$('#codeBanner').onclick = async e => {
  const entry = models.get(code.active);
  if ('reload' in e.target.dataset) { entry.stale = false; await reload(code.active, { force: true }); }
  if ('keep' in e.target.dataset) entry.stale = false;
  render();
};
$('.code-keys').onclick = e => {
  const key = e.target.closest('[data-code-key]')?.dataset.codeKey;
  if (key === 'file') goToFile();
  if (key === 'agent') addAgent(prefs.agent);
  if (key === 'panel') toggleDock();
};
$('#dockTabs').onclick = e => {
  const dock = e.target.closest('[data-dock]')?.dataset.dock;
  if (!dock) return;
  code.dock = dock;
  render();
  if (dock === 'terminal') showShell();
};
// Drag the line above the agents to give them more or less room.
$('#dockGrip').onpointerdown = e => {
  const body = $('.room-body'), top = body.getBoundingClientRect().top, height = body.clientHeight;
  e.preventDefault();
  const move = ev => body.style.setProperty('--dock', `${Math.round(Math.min(height - 220, Math.max(220, height - (ev.clientY - top))))}px`);
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); store.set('dock', body.style.getPropertyValue('--dock')); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
};
if (store.get('dock')) $('.room-body').style.setProperty('--dock', store.get('dock'));

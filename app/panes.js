// Amoeba's pane mode: several sessions side by side, each showing its main agent (yours if you have one in it).
// "New pane" in a session opens it with that session and an empty pane to fill. Uses renderer.js's state and helpers.

const MAX_PANES = 3;
let panes = [];            // session names, null for an empty pane
let paneShape = '';        // the panes the columns were built for

const panesKey = () => `panes:${currentTeam.key}`;
function openPanes(list) {
  panes = list.slice(0, MAX_PANES);
  store.set(panesKey(), JSON.stringify(panes));
  closeMenu();
  $('#settings').close();
  view = 'panes';
  current = null;
  render();
}
const savePanes = () => store.set(panesKey(), JSON.stringify(panes));

// The agent a pane shows for a session: yours first, then whoever's.
const paneLane = (lanes, name) => lanes.filter(l => l.session === name).sort((a, b) => local.has(b.id) - local.has(a.id))[0];
// Which terminals are on screen in pane mode (renderRoom keeps the rest hidden).
const paneLaneIds = () => panes.map(name => name && paneLane(board, name)?.id).filter(Boolean);

function renderPanes(lanes) {
  const on = view === 'panes';
  $('#panesView').hidden = !on;
  if (!on) { // terminals go back to the session view
    for (const t of terms.values()) if (t.el.parentElement !== $('#lanes')) $('#lanes').append(t.el);
    return;
  }
  const open = panes.filter(Boolean).length;
  $('#panesTitle').textContent = `${open} session${open === 1 ? '' : 's'}${panes.length < MAX_PANES ? ', room for another' : ''}`;
  $('#addPane').disabled = panes.length >= MAX_PANES;
  // Columns are rebuilt only when the panes change, so terminals inside them aren't torn out on every update.
  const shape = JSON.stringify(panes);
  if (shape !== paneShape) {
    paneShape = shape;
    for (const t of terms.values()) if (t.el.parentElement !== $('#lanes')) $('#lanes').append(t.el);
    $('#paneGrid').innerHTML = panes.map((_, i) => `<section class="pane" data-pane="${i}"><header class="pane-head"></header><div class="pane-body"><div class="pane-empty"></div></div></section>`).join('');
  }
  $('#paneGrid').style.setProperty('--panes', panes.length);
  panes.forEach((name, i) => {
    const pane = $(`#paneGrid [data-pane="${i}"]`);
    const rec = name && recordFor(name), inIt = name ? lanes.filter(l => l.session === name) : [];
    setHTML(pane.querySelector('.pane-head'), name
      ? `<b title="${esc(name)}">${esc(name)}</b>${rec?.task ? `<span class="pane-task" title="${esc(rec.task)}">${esc(rec.task)}</span>` : ''}
         <span class="spacer"></span>${inIt.length ? `<span class="stack">${[...new Map(inIt.map(l => [l.login, l])).values()].map(avatar).join('')}</span>` : ''}
         <button class="icon-btn" data-pane-open="${i}" title="Open the session" aria-label="Open the session">⤢</button>
         <button class="icon-btn" data-pane-close="${i}" title="Close the pane" aria-label="Close the pane">×</button>`
      : `<b>Open a session</b><span class="spacer"></span><button class="icon-btn" data-pane-close="${i}" title="Close the pane" aria-label="Close the pane">×</button>`);
    const lane = name && paneLane(lanes, name), t = lane && terms.get(lane.id);
    if (t && t.el.parentElement !== pane.querySelector('.pane-body')) pane.querySelector('.pane-body').append(t.el);
    const empty = pane.querySelector('.pane-empty');
    empty.hidden = !!t;
    const choices = sessionList(lanes).filter(s => !panes.includes(s.name) && s.status !== 'done');
    setHTML(empty, t ? '' : name
      ? `<p>No agents are running in ${esc(name)}.</p><button class="btn small primary" data-pane-add="${esc(name)}">Add agent</button>`
      : `${choices.length ? `<div class="pane-pick">${choices.map(s => `<button class="panel-row" data-pane-pick="${i}" data-name="${esc(s.name)}"><b>${esc(s.name)}</b>${pill(s.status)}</button>`).join('')}</div>`
        : '<p>Every session is already open in a pane.</p>'}<button class="btn small" data-pane-new>New session</button>`);
  });
  requestAnimationFrame(fitTeammates); // teammates' terminals scale to the pane they're in now
}

$('#addPane').onclick = () => { if (panes.length < MAX_PANES) { panes.push(null); savePanes(); render(); } };
$('#singlePane').onclick = () => { const first = panes.find(Boolean); first ? openSession(first) : go('sessions'); };
$('#paneGrid').onclick = e => {
  const { paneOpen, paneClose, panePick, name, paneAdd } = e.target.closest('[data-pane-open], [data-pane-close], [data-pane-pick], [data-pane-add], [data-pane-new]')?.dataset || {};
  if (paneOpen !== undefined) return openSession(panes[paneOpen], paneLane(board, panes[paneOpen])?.id || null);
  if (paneClose !== undefined) {
    panes.splice(Number(paneClose), 1);
    savePanes();
    return panes.length ? render() : go('sessions');
  }
  if (panePick !== undefined) { panes[Number(panePick)] = name; savePanes(); return render(); }
  if (paneAdd) { current = paneAdd; return addAgent(prefs.agent).then(() => openPanes(panes)); }
  if (e.target.closest('[data-pane-new]')) openNewAgent();
};

// One action against the running playground (npm run playground, or -- --real), for a person or a script driving it
// step by step from a shell. Clicks and typing are real input events, as in drive.js.
//   node scripts/customer/act.js <who> <command> [args]          who: david | max
//     state                       what this person's app shows: team, page, session, agents, alerts, plan, notes, code view
//     shot                        a screenshot of the window; prints the file to open
//     click <css>                 a real click on the first visible match
//     clicktext <css> <text>      a real click on the first visible match containing text
//     type <text>                 real typing into whatever has focus
//     key <key> [mod+mod]         a real key press: Enter, Escape, Tab, Up, Down, Backspace, a letter... (mods: shift, meta, alt, control)
//     menu <action>               a menu command: settings, new-agent, add-agent, switcher, go-to-file, save, code, panel, sidebar, invite, teams, updates
//     js <code>                   page JavaScript (an async function body; return a value)
//     until <expr> [ms]           waits until a page expression is true (default 10000 ms); prints true or false
//     screen <agent> [--all]      an agent's terminal as it is on screen (--all: the last 80 lines, scrollback included)
//     say <agent> <text>          focuses an agent's terminal, types the text and presses Enter
//     press <agent> <key>...      focuses an agent's terminal and presses keys in order, e.g. Down Enter, or shift+Tab
//     wait <agent> [sec] [status,status]  waits until the hub reports the agent in one of the statuses (default idle,needs you)
//     errors                      the last 20 page errors and answered confirm()/alert() questions
//   <agent> is mine (your first agent), mine2, mine3..., or an agent id (or the start of one).
//   node scripts/customer/act.js sync signal <name> [note] | sync wait <name> [sec] | sync list
//   node scripts/customer/act.js logs [new]      the copies' app, console and main-errors logs (new: only lines since the last `logs new`)
const fs = require('fs');
const path = require('path');
const { root, call, js, click, clickText, type, key, menu, shot, until, sleep } = require('./drive');

const [who, command, ...rest] = process.argv.slice(2);
const out = v => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
const fail = message => { console.error(message); process.exit(1); };

// Page code that finds an agent's id from mine / mineN / an id or its start.
const laneOf = ref => `(() => { const ref = ${JSON.stringify(String(ref || 'mine'))};
  const m = /^mine(\\d*)$/.exec(ref); if (m) return [...local.keys()][(m[1] ? +m[1] : 1) - 1] || null;
  return hubLanes.find(l => l.id === ref)?.id || hubLanes.find(l => l.id.startsWith(ref))?.id || (terms.has(ref) ? ref : null); })()`;

const STATE = `const short = l => ({ id: l.id, who: l.login, cmd: l.cmd, session: l.session, status: l.status, open: l.open, branch: l.branch,
    files: (l.files || []).slice(0, 12), overlaps: l.overlaps, git: l.git && { ahead: l.git.ahead, behind: l.git.behind, added: l.git.added, removed: l.git.removed },
    typedBy: l.typedBy || undefined, prompt: (l.prompt || '').slice(0, 100) || undefined });
  return {
    me: me?.login, team: currentTeam ? currentTeam.name + ' (' + currentTeam.where + ', owner ' + currentTeam.owner + ')' : null,
    connection: $('#connText')?.textContent, view, session: current, focus, tab, panelTab,
    openDialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.id + (d.querySelector('.err:not(:empty), [id$=Err]:not(:empty)') ? ' error: ' + d.querySelector('.err:not(:empty), [id$=Err]:not(:empty)').textContent : '')),
    alerts: $('#alerts')?.innerText.replace(/\\s+/g, ' ').trim().slice(0, 600),
    mine: [...local].map(([id, l]) => ({ id, cmd: l.cmd, session: l.session, open: l.open, refused: l.refused })),
    agents: hubLanes.map(short),
    stopped: stoppedAgents.map(s => s.id + ' ' + s.login + ' ' + s.cmd + ' in ' + s.session),
    sessions: sessionRecords.map(r => ({ name: r.name, task: r.task, by: r.createdBy, done: r.done || undefined,
      steps: (r.steps || []).map(s => (s.done ? '[x] ' : '[ ] ') + s.text), comments: (r.comments || []).map(c => c.author + ': ' + String(c.text).slice(0, 80)) })),
    notes: memories.map(m => String(m.text).slice(0, 100)),
    lookingAt: teamWatchers.map(w => w.login + ' @ ' + (w.session || '-')),
    code: $('#code') && !$('#code').hidden ? { root: code.root, active: code.active, changes: [...code.changes], underWay: code.underWay || undefined, note: $('#commitNote')?.textContent || undefined } : null,
    pageErrors: window.__errors?.length || 0,
  };`;

// The terminal as drawn: the rows on screen, or with --all the last 80 lines of scrollback too.
const SCREEN = (ref, all) => `const id = ${laneOf(ref)}; const t = id && terms.get(id);
  if (!t) return { error: 'No such agent here: ' + ${JSON.stringify(String(ref))} + '. Agents: ' + hubLanes.map(l => l.id.slice(0, 10) + ' (' + l.login + ' ' + l.cmd + ')').join(', ') };
  const b = t.term.buffer.active, lines = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  const shown = ${all ? 'lines.slice(-80)' : 'lines.slice(b.baseY, b.baseY + t.term.rows)'};
  while (shown.length && !shown[shown.length - 1].trim()) shown.pop();
  const l = hubLanes.find(x => x.id === id);
  return { id, who: l?.login, cmd: l?.cmd, status: l?.status, onScreen: !t.el.hidden && !!t.el.getClientRects().length, size: t.term.cols + 'x' + t.term.rows, text: shown.join('\\n') };`;

async function focusAgent(ref) {
  const r = await js(who, `const id = ${laneOf(ref)}; const t = id && terms.get(id); if (!t) return { error: 'No such agent: ' + ${JSON.stringify(String(ref))} };
    if (t.el.hidden || !t.el.getClientRects().length) return { error: 'That agent\\'s terminal isn\\'t on screen. Open its session (and the agent) first.' };
    t.term.focus(); return { id, focused: document.activeElement === t.term.textarea };`);
  if (r.error) fail(r.error);
  return r;
}
// "shift+Tab" -> { key: 'Tab', modifiers: ['shift'] }
const parseKey = k => { const parts = String(k).split('+'); return { key: parts.pop(), modifiers: parts.map(m => m.toLowerCase()) }; };

async function persona() {
  switch (command) {
    case 'state': return out(await js(who, STATE));
    case 'shot': return out(await shot(who));
    case 'click': await click(who, rest.join(' ')); return out('clicked');
    case 'clicktext': await clickText(who, rest[0], rest.slice(1).join(' ')); return out('clicked');
    case 'type': await type(who, rest.join(' ')); return out('typed');
    case 'key': { const { key: k, modifiers } = parseKey(rest[0]); await key(who, k, rest[1] ? rest[1].split('+') : modifiers); return out('pressed'); }
    case 'menu': await menu(who, rest[0]); return out('sent');
    case 'js': return out(await js(who, rest.join(' ')));
    case 'until': return out(await until(who, rest[0], Number(rest[1]) || 10000));
    case 'screen': { const r = await js(who, SCREEN(rest[0], rest.includes('--all'))); if (r.error) fail(r.error); const { text, ...about } = r; return out(`${JSON.stringify(about)}\n${text}`); }
    case 'say': {
      const r = await focusAgent(rest[0]);
      await type(who, rest.slice(1).join(' '));
      await sleep(300);
      await key(who, 'enter');
      return out(`typed into ${r.id} and pressed Enter`);
    }
    case 'press': {
      const r = await focusAgent(rest[0]);
      for (const k of rest.slice(1)) { const p = parseKey(k); await key(who, p.key, p.modifiers); await sleep(250); }
      return out(`pressed ${rest.slice(1).join(' ')} in ${r.id}`);
    }
    case 'wait': {
      const ref = rest[0], ms = (Number(rest[1]) || 300) * 1000, want = (rest.slice(2).join(' ') || 'idle,needs you').split(',').map(s => s.trim());
      const id = await js(who, `return ${laneOf(ref)}`);
      if (!id) fail(`No such agent: ${ref}`);
      const began = Date.now();
      let status;
      while (Date.now() - began < ms) {
        status = await js(who, `return hubLanes.find(l => l.id === ${JSON.stringify(id)})?.status ?? 'gone'`);
        if (want.includes(status) || status === 'gone') break;
        await sleep(1000);
      }
      return out(`${id}: ${status} after ${Math.round((Date.now() - began) / 1000)} s`);
    }
    case 'errors': return out(await js(who, `return { errors: window.__errors.slice(-20), dialogs: window.__dialogs.slice(-20) }`));
    default: fail(`Unknown command: ${command}. See the top of ${__filename}.`);
  }
}

async function sync() {
  const dir = path.join(root, 'sync');
  fs.mkdirSync(dir, { recursive: true });
  const file = name => path.join(dir, String(name).replace(/[^\w.-]/g, '_'));
  if (command === 'signal') { fs.writeFileSync(file(rest[0]), `${new Date().toISOString()} ${rest.slice(1).join(' ')}\n`); return out(`signalled ${rest[0]}`); }
  if (command === 'wait') {
    const ms = (Number(rest[1]) || 900) * 1000, began = Date.now();
    while (!fs.existsSync(file(rest[0]))) {
      if (Date.now() - began > ms) return out(`timed out after ${rest[1] || 900} s waiting for ${rest[0]}`);
      await sleep(1000);
    }
    return out(`${rest[0]}: ${fs.readFileSync(file(rest[0]), 'utf8').trim()}`);
  }
  if (command === 'list') return out(fs.readdirSync(dir).filter(f => !f.startsWith('.')).map(f => `${f}: ${fs.readFileSync(path.join(dir, f), 'utf8').trim()}`).join('\n') || '(none)');
  fail('sync signal <name> [note] | sync wait <name> [sec] | sync list');
}

// Each log's lines, or with `new` only those added since the last `logs new` (offsets kept in sync/.logs).
function logs() {
  const offsets = path.join(root, 'sync', '.logs');
  fs.mkdirSync(path.dirname(offsets), { recursive: true });
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(offsets, 'utf8')); } catch {}
  const files = ['david', 'max'].flatMap(p => ['app.log', 'console.log', 'main-errors.log'].map(f => path.join(root, p, f)));
  if (process.env.PLAY_LOG) files.push(process.env.PLAY_LOG);
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const from = command === 'new' ? Math.min(seen[f] || 0, text.length) : Math.max(0, text.length - 4000);
    seen[f] = text.length;
    const part = text.slice(from).trim();
    if (part) out(`==== ${path.relative(root, f)}\n${part}`);
  }
  fs.writeFileSync(offsets, JSON.stringify(seen));
}

(who === 'sync' ? sync() : who === 'logs' ? Promise.resolve(logs()) : ['david', 'max'].includes(who) ? persona() : Promise.resolve(fail('Start with david, max, sync or logs. See the top of this file.')))
  .catch(e => fail(String(e.message || e)));

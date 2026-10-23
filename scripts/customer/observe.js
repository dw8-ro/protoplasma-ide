// Watches the running playground while people (or scripts) use it. Every few seconds it reads both copies' state and
// writes what each one saw change (observer.log, in the playground folder) and anything that looks wrong (anomalies.log):
// page errors, error lines in the logs, a copy's own agent missing from the hub's list, and the two copies disagreeing
// about an agent, a session or the notes for longer than a state broadcast takes to arrive.
//   node scripts/customer/observe.js [seconds between looks, default 3]      (Ctrl+C stops it)
// OBSERVE_DIR puts the two logs somewhere that outlives the playground folder.
const fs = require('fs');
const path = require('path');
const { root, js, sleep } = require('./drive');

const every = (Number(process.argv[2]) || 3) * 1000;
const PATIENCE = 4; // looks in a row two copies may disagree before it counts (state arrives within a second or two)
const dir = process.env.OBSERVE_DIR || root;
const timeline = path.join(dir, 'observer.log'), anomalies = path.join(dir, 'anomalies.log');
const stamp = () => new Date().toTimeString().slice(0, 8); // local time, like `date +%T`
const write = (file, line) => fs.appendFileSync(file, `${stamp()} ${line}\n`);
const saw = line => write(timeline, line);
const flag = line => { write(anomalies, line); write(timeline, `!! ${line}`); };
const people = ['david', 'max'];

const LOOK = `return { team: currentTeam?.id || null, teamName: currentTeam?.name || null, view, session: current, conn: $('#connText')?.textContent || '',
  lanes: hubLanes.map(l => ({ id: l.id, who: l.login, cmd: l.cmd, session: l.session, status: l.status, open: !!l.open,
    files: [...(l.files || [])].sort().join(' '), overlaps: [...(l.overlaps || [])].sort().join(' '), behind: l.git?.behind | 0, ahead: l.git?.ahead | 0, typedBy: l.typedBy || '' })),
  local: [...local].map(([id, l]) => ({ id, refused: l.refused || '' })), stopped: stoppedAgents.map(s => s.id).sort().join(' '),
  sessions: sessionRecords.map(r => r.name + ' ' + (r.steps || []).filter(s => s.done).length + '/' + (r.steps || []).length + ' steps, ' + (r.comments || []).length + ' comments').sort().join(' | '),
  notes: memories.map(m => m.text).sort().join(' | '), members: currentTeam ? (currentTeam.members || []).map(x => x.login || x).join(' ') : '',
  alerts: ($('#alerts')?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
  errors: window.__errors ? window.__errors.slice() : [], dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.id).join(' ') };`;

const before = {}; // who -> last look
const streaks = new Map(); // what disagrees -> looks in a row
const lanes = look => new Map((look?.lanes || []).map(l => [l.id, l]));
const name = l => `${l.who}'s ${l.cmd} ${l.id.slice(0, 10)}`;

function changes(who, now, was) {
  if (!was) return saw(`${who}: first look: team ${now.teamName}, ${now.view}${now.session ? ` "${now.session}"` : ''}, ${now.lanes.length} agents`);
  for (const k of ['teamName', 'view', 'session', 'conn', 'dialogs', 'alerts', 'stopped', 'sessions', 'notes', 'members']) {
    if (now[k] !== was[k]) saw(`${who}: ${k}: ${JSON.stringify(was[k])} -> ${JSON.stringify(now[k])}`);
  }
  const a = lanes(was), b = lanes(now);
  for (const [id, l] of b) {
    const o = a.get(id);
    if (!o) { saw(`${who}: + ${name(l)} in "${l.session}" ${l.status}`); continue; }
    for (const k of ['session', 'status', 'files', 'overlaps', 'behind', 'ahead', 'typedBy', 'open']) if (o[k] !== l[k]) saw(`${who}: ${name(l)} ${k}: ${JSON.stringify(o[k])} -> ${JSON.stringify(l[k])}`);
  }
  for (const [id, l] of a) if (!b.has(id)) saw(`${who}: - ${name(l)}`);
  for (const e of now.errors.slice(was.errors.length)) flag(`${who}: page error: ${e}`);
}

// Something that stays wrong for PATIENCE looks is flagged once, and its end noted.
function expect(key, ok, describe) {
  const n = ok ? 0 : (streaks.get(key) || 0) + 1;
  if (!ok && n === PATIENCE) flag(describe());
  if (ok && (streaks.get(key) || 0) >= PATIENCE) saw(`ok again: ${key}`);
  streaks.set(key, n);
}

function compare(d, m) {
  for (const who of people) {
    const look = who === 'david' ? d : m;
    if (!look?.team) continue;
    const listed = lanes(look);
    for (const l of look.local) expect(`${who}'s own agent ${l.id} listed`, listed.has(l.id) || !!l.refused,
      () => `${who}'s own agent ${l.id.slice(0, 10)} runs but the hub's list in ${who}'s app doesn't have it`);
  }
  if (!d?.team || d.team !== m?.team) return;
  const a = lanes(d), b = lanes(m);
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(id), y = b.get(id);
    expect(`agent ${id} on both`, !!x && !!y, () => `${name(x || y)} shows in ${x ? 'david' : 'max'}'s app but not ${x ? 'max' : 'david'}'s`);
    if (!x || !y) continue;
    for (const k of ['session', 'status', 'files', 'overlaps', 'typedBy']) {
      expect(`agent ${id} ${k}`, x[k] === y[k], () => `the copies disagree about ${name(x)} ${k}: david sees ${JSON.stringify(x[k])}, max sees ${JSON.stringify(y[k])}`);
    }
  }
  for (const k of ['sessions', 'notes', 'stopped']) {
    expect(`team ${k}`, d[k] === m[k], () => `the copies disagree about ${k}: david ${JSON.stringify(d[k])}, max ${JSON.stringify(m[k])}`);
  }
}

// New lines in the copies' logs and the playground's own that look like errors. Known noise of the playground is skipped.
const LOGS = people.flatMap(p => ['app.log', 'console.log', 'main-errors.log'].map(f => path.join(root, p, f)));
if (process.env.PLAY_LOG) LOGS.push(process.env.PLAY_LOG);
const offsets = new Map(LOGS.map(f => [f, fs.existsSync(f) ? fs.statSync(f).size : 0]));
const ERRORISH = /error|exception|uncaught|unhandled|warn|fail|refused|denied|cannot|can't|couldn't|ENOENT|EACCES|TypeError|ReferenceError|SyntaxError|\[gone\]|unresponsive/i;
const NOISE = /sandbox_extension_issue_file|Sign in to the GitHub CLI to see your repos|task queue exceeded allotted deadline|^\s+at /;
const repeats = new Map();
function readLogs() {
  for (const f of LOGS) {
    if (!fs.existsSync(f)) continue;
    const size = fs.statSync(f).size, from = offsets.get(f) || 0;
    if (size <= from) { offsets.set(f, size); continue; }
    const fd = fs.openSync(f, 'r'), buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    offsets.set(f, size);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim() || NOISE.test(line) || !ERRORISH.test(line)) continue;
      const key = `${path.relative(root, f)} ${line.replace(/^\S+Z /, '').replace(/\d+/g, '#').slice(0, 160)}`;
      const n = (repeats.get(key) || 0) + 1;
      repeats.set(key, n);
      if (n === 1 || n === 10 || n === 100) flag(`log ${path.relative(root, f).startsWith('..') ? 'playground' : path.relative(root, f)}${n > 1 ? ` (seen ${n} times)` : ''}: ${line.slice(0, 400)}`);
    }
  }
}

let stop = false;
process.on('SIGINT', () => { stop = true; });
process.on('SIGTERM', () => { stop = true; });
(async () => {
  saw(`observer started, looking every ${every / 1000} s`);
  const unreadable = {};
  while (!stop) {
    const looks = {};
    for (const who of people) {
      try { looks[who] = await js(who, LOOK); if (unreadable[who]) saw(`${who}: readable again`); unreadable[who] = false; } catch (e) {
        if (!unreadable[who]) flag(`${who}'s app couldn't be read: ${String(e.message).slice(0, 200)}`);
        unreadable[who] = true;
      }
      if (looks[who]) { changes(who, looks[who], before[who]); before[who] = looks[who]; }
    }
    compare(looks.david, looks.max);
    readLogs();
    await sleep(every);
  }
  saw('observer stopped');
})();

// How much memory the playground's two copies use, by process type, as Activity Monitor counts it (macOS `footprint`).
// A before-and-after check for memory work. Needs `npm run playground` running, with customer scenarios 1 and 2 done
// (a team, the "Login page" session, an agent each).
//   node scripts/memory.js [--agents N] [--code]
// Starts agents in David's copy until he has N (default 6), fills every terminal's scrollback, has Max watch the session
// (so his copy shows them all as teammates' terminals), lets things settle, then prints the median of 3 samples.
// With --code, David also opens the code view, and it measures again.
const { execFileSync } = require('child_process');
const path = require('path');
const { root, js, until, sleep } = require('./customer/drive');

const arg = name => process.argv.includes(name);
const agents = +(process.argv[process.argv.indexOf('--agents') + 1] || 0) || 6;
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

// A copy's processes: its helpers name their user-data folder, and its main process has PLAY_DIR in its environment.
function processes(who) {
  const dir = path.join(root, who);
  return sh('ps', ['-Ao', 'pid=,command=']).split('\n').map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).flatMap(([, pid, command]) => {
    if (!command.includes('Electron')) return [];
    if (command.includes(`--user-data-dir=${dir}/userData`)) {
      const type = /--type=([\w-]+)/.exec(command)?.[1];
      return [{ pid, type: type === 'utility' ? /--utility-sub-type=[\w.]*?(\w+)\.mojom/.exec(command)?.[1] || 'utility' : type }];
    }
    if (/--type=/.test(command)) return [];
    try { return sh('ps', ['eww', '-o', 'command=', '-p', pid]).includes(`PLAY_DIR=${dir} `) ? [{ pid, type: 'main' }] : []; } catch { return []; }
  });
}
function footprintMB(pid) {
  try {
    const [, n, unit] = /Footprint: ([\d.]+) ([KMG]B)/.exec(sh('footprint', ['-p', pid])) || [];
    return n ? +n * { KB: 1 / 1024, MB: 1, GB: 1024 }[unit] : 0;
  } catch { return 0; }
}
const median = xs => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function measure(label) {
  await sleep(25000); // let output finish drawing (both copies) and painting settle
  const samples = [];
  for (let i = 0; i < 3; i++) {
    for (const who of ['david', 'max']) await js(who, 'window.gc?.(); return 1'); // the playground exposes it
    await sleep(1000);
    const row = {};
    for (const who of ['david', 'max']) for (const p of processes(who)) row[`${who} ${p.type}`] = (row[`${who} ${p.type}`] || 0) + footprintMB(p.pid);
    samples.push(row);
    await sleep(3000);
  }
  console.log(`\n${label}`);
  for (const who of ['david', 'max']) {
    const types = [...new Set(samples.flatMap(s => Object.keys(s)).filter(k => k.startsWith(who + ' ')))].sort();
    const parts = types.map(k => [k.slice(who.length + 1), median(samples.map(s => s[k] || 0))]);
    const total = parts.reduce((sum, [, mb]) => sum + mb, 0);
    console.log(`  ${who.padEnd(6)} total ${Math.round(total)} MB  (${parts.map(([t, mb]) => `${t} ${Math.round(mb)}`).join(', ')})`);
  }
}

(async () => {
  const session = 'Login page';
  await js('david', `if (current !== ${JSON.stringify(session)}) openSession(${JSON.stringify(session)}); return 1`);
  while (await js('david', 'return local.size') < agents) {
    const have = await js('david', 'return local.size');
    await js('david', `openNewAgent(${JSON.stringify(session)}); return 1`);
    await until('david', `$('#agent').open`, 4000);
    await js('david', `$('#startAgent').click(); return 1`);
    if (!await until('david', `local.size > ${have}`, 20000)) throw new Error('An agent didn\'t start: ' + await js('david', `return $('#agentErr').textContent`));
  }
  await js('david', `for (const id of local.keys()) proto.write(id, "seq 1 20000 | sed 's/$/ some build output, as an agent would print it/'\\r"); return 1`);
  await js('max', `openSession(${JSON.stringify(session)}); return 1`);
  await measure(`${agents} agents of David's in "${session}", scrollback full; Max watching`);
  if (arg('--code')) {
    await js('david', `showCode(); return 1`);
    await until('david', `!!window.editor`, 15000);
    await measure('…and David opens the code view');
  }
})().catch(e => { console.error(e.message); process.exit(1); });

// What the installed Codex makes of the hooks Protoplasma starts it with: `node scripts/codex-hooks.js`.
// Starts `codex app-server` with the same `-c hooks=…` the app passes (lane.js codexHookSettings) and asks it to list
// them. Sends no prompt and trusts nothing. Run it after changing the settings, and after a Codex update:
// - every hook should be listed, from "sessionFlags", with no errors;
// - one whose trust is "modified" means its matcher, timeout or command changed, so everyone reviews it again;
// - a new one is "untrusted" until its person picks "Trust all and continue" once.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { codexHookSettings } = require('../src/lane');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-codex-hooks-'));
const codex = spawn('codex', ['-c', codexHookSettings(), 'app-server'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
const send = msg => codex.stdin.write(`${JSON.stringify(msg)}\n`);
const done = code => { clearTimeout(limit); codex.kill(); fs.rmSync(dir, { recursive: true, force: true }); process.exitCode = code; };
let out = '', err = '';
const limit = setTimeout(() => { console.error(`Codex didn't answer in 20 s.\n${err.slice(0, 800)}`); done(1); }, 20_000);
codex.on('error', e => { console.error(`Couldn't start codex: ${e.message}`); done(1); });
codex.stderr.on('data', d => { err += d; });
codex.stdout.on('data', d => {
  out += d;
  for (let at; (at = out.indexOf('\n')) >= 0;) {
    let m;
    try { m = JSON.parse(out.slice(0, at)); } catch {}
    out = out.slice(at + 1);
    if (m?.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'hooks/list', params: { cwds: [dir] } }); }
    if (m?.id !== 2) continue;
    if (m.error) { console.error(`hooks/list failed: ${JSON.stringify(m.error)}`); return done(1); }
    console.log(execFileSync('codex', ['--version']).toString().trim());
    let ok = true;
    for (const entry of m.result.data) {
      for (const problem of [...entry.warnings || [], ...entry.errors || []]) { ok = false; console.log(`problem: ${typeof problem === 'string' ? problem : JSON.stringify(problem)}`); }
      for (const h of entry.hooks) {
        if (h.source !== 'sessionFlags') continue; // the person's own hooks aren't ours to list
        console.log([h.eventName, h.matcher || '(any)', h.key.split(':').slice(-3).join(':'), h.trustStatus, `${h.timeoutSec}s`].join('  '));
      }
    }
    done(ok ? 0 : 1);
  }
});
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'protoplasma-hooks-check', version: '0' } } });

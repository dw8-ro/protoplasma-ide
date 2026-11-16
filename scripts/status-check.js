// The "Status tells the truth" checks (docs/first-install.md) with a real Claude Code, through the app's own lane and
// hub code: an interrupt goes Idle, a question is Needs you, and an approved permission is Working at once.
// Usage: node scripts/status-check.js [folder]. The folder (this checkout by default) must be one Claude already
// trusts: if its folder-trust question shows, this stops without answering it. Uses your Claude sign-in, with haiku,
// for three short prompts. The only answer it gives is Yes to running a 20-second `node -e` timer, and the first option of its own
// question; any other permission is declined with Esc.
const path = require('path');
const { startHub } = require('../src/hub');
const { startLane } = require('../src/lane');
const WebSocket = require('ws');

const cwd = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const TOKEN = 'tok-check';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

(async () => {
  const hub = await startHub({ port: 0, host: '127.0.0.1', verifyUser: async t => (t === TOKEN ? { login: 'checker', name: 'Checker', avatar: '' } : null) });
  const url = `http://127.0.0.1:${hub.port}`;
  const team = await (await fetch(`${url}/teams`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ name: 'Status check' }) })).json();

  // What the team sees: the agent's status, with when each change came.
  let status = null, since = Date.now();
  const changes = [];
  const watcher = new WebSocket(`${url.replace('http', 'ws')}/watch`);
  watcher.on('open', () => watcher.send(JSON.stringify({ t: 'watch', token: TOKEN, team: team.id })));
  watcher.on('message', raw => {
    const m = JSON.parse(raw);
    const now = m.t === 'state' && m.lanes[0]?.status;
    if (now && now !== status) { status = now; changes.push(`${((Date.now() - since) / 1000).toFixed(1)}s ${now}`); }
  });

  // STATUS_DEBUG=1: every hook Claude sends, through a small logging relay in front of the hub.
  let hookBase;
  if (process.env.STATUS_DEBUG) {
    const http = require('http');
    const relay = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c)).on('end', async () => {
        const body = Buffer.concat(chunks).toString();
        try { const ev = JSON.parse(body); console.log(`  hook ${((Date.now() - since) / 1000).toFixed(1)}s ${ev.hook_event_name}${ev.tool_name ? ` ${ev.tool_name}` : ''}${ev.notification_type ? ` ${ev.notification_type}` : ''}`); } catch {}
        const out = await fetch(`${url}${req.url}`, { method: 'POST', headers: { authorization: req.headers.authorization }, body });
        res.writeHead(out.status, { 'content-type': 'application/json' }).end(await out.text());
      });
    });
    await new Promise(r => relay.listen(0, '127.0.0.1', r));
    hookBase = `http://127.0.0.1:${relay.address().port}`;
  }
  let screen = '';
  const lane = startLane({ hub: url, hookBase, team: team.id, token: TOKEN, session: 'status-check', cmd: 'claude', args: ['--model', 'haiku'], cwd, cols: 120, rows: 40 });
  lane.term.onData(d => { screen = (screen + d.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '')).slice(-6000); });
  const until = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(100); } return pred(); };
  const say = async text => { lane.write(text); await sleep(300); lane.write('\r'); };
  const finish = code => { try { lane.term.kill(); } catch {} watcher.close(); hub.close(); process.exit(code); };

  try {
    await until(() => status, 15000);
    await sleep(5000); // Claude Code drawing its prompt
    if (/trust\s*(this\s*folder|the\s*files)/i.test(screen)) {
      lane.write('\x1b'); // declines: answering it is the person's
      console.log(`Claude asks whether to trust ${cwd}. That's yours to answer: open it with claude there once, then run this again.`);
      return finish(2);
    }

    // 1. Interrupted means Idle.
    since = Date.now(); changes.length = 0;
    await say('Write a 400-word story about a lighthouse keeper. Do not use any tools.');
    const working = await until(() => status === 'working', 30000);
    await sleep(3000);
    const pressed = Date.now();
    lane.write('\x1b');
    const idle = await until(() => status === 'idle', 10000);
    check('Esc while it works: Idle within a few seconds', working && idle, `${changes.join(', ')}; idle ${((Date.now() - pressed) / 1000).toFixed(1)}s after Esc`);
    await sleep(2000);

    // 2. A question is Needs you.
    since = Date.now(); changes.length = 0;
    await say('Use the AskUserQuestion tool right now to ask me which name I prefer, Alpha or Beta. Do nothing else, and use no other tool.');
    const asked = await until(() => status === 'needs you', 45000);
    check('a question for you: Needs you while it\'s up', asked, changes.join(', '));
    if (asked) { await sleep(1500); lane.write('\r'); } // the first option
    await until(() => status === 'idle', 45000);
    await sleep(2000);

    // 3. Approved means Working at once.
    since = Date.now(); changes.length = 0;
    // Claude Code runs `sleep` without asking, so a timer in node stands in: harmless, and it's asked about.
    await say('Run exactly this shell command with the Bash tool: node -e "setTimeout(() => {}, 20000)" Then say done. Do nothing else.');
    const permission = await until(() => status === 'needs you', 45000);
    if (!permission) {
      check('a permission: Needs you until approved', false, `no permission was asked (node may be allowed in your settings): ${changes.join(', ')}`);
    } else {
      await sleep(1500);
      if (!/setTimeout/.test(screen.slice(-3000))) { lane.write('\x1b'); check('a permission for the timer', false, 'it asked about something else, declined'); }
      else {
        const held = status === 'needs you'; // still asking when the person gets to it
        const approved = Date.now();
        lane.write('1');
        const back = await until(() => status === 'working', 15000);
        const took = (Date.now() - approved) / 1000;
        check('Needs you until approved, then Working at once, not when the command ends', held && back && took < 8, `${changes.join(', ')}; Working ${took.toFixed(1)}s after approving a 20 s command`);
        await until(() => status === 'idle', 60000);
      }
    }
  } catch (e) { console.error(e); results.push(false); }
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  finish(results.every(Boolean) ? 0 : 1);
})();

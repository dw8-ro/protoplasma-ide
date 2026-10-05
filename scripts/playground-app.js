// One copy of the app for the playground (see playground.js), signed in as PROTO_GITHUB_TOKEN's made-up person, with a
// small HTTP API on 127.0.0.1:PLAY_PORT for driving it:
//   POST /js     the body is page JavaScript (an async function body; `return` a value)  -> { ok, value | error }
//   POST /click  { x, y }               a real mouse click at window coordinates (as in /shot images)
//   POST /key    { key, modifiers }     a real key press, e.g. { "key": "Escape" } or { "key": "k", "modifiers": ["meta"] }
//   POST /type   { text }               real typing into whatever has focus
//   POST /menu   { action }             a menu command: settings, new-agent, add-agent, switcher, go-to-file, save, code,
//                                       panel, sidebar, invite, teams, updates
//   POST /hook   { lane, ...event }     a Claude Code hook event for one of this copy's agents, e.g.
//                                       { "lane": "<id>", "hook_event_name": "PermissionRequest" }
//   GET  /shot                          saves a screenshot (1440 wide, same coordinates as /click)  -> { file }
// Agents are bash shells standing in for the CLI picked, so what you type into them really changes files.
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const hubModule = require('../src/hub');
const laneModule = require('../src/lane');

const { PLAY_PORT, PLAY_DIR, PROTO_ONLINE_HUB: hub } = process.env;
const people = { 'tok-david': { login: 'david', name: 'David', avatar: '' }, 'tok-max': { login: 'max', name: 'Max', avatar: '' } };
hubModule.githubUser = async token => people[token] || null;
app.setPath('userData', path.join(PLAY_DIR, 'userData'));

// ---- Agents: bash in a terminal, named after the CLI ----
const NAMES = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const bin = path.join(PLAY_DIR, 'bin'), secrets = path.join(PLAY_DIR, 'secrets');
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(secrets, { recursive: true });
for (const [cmd, name] of Object.entries(NAMES)) {
  fs.writeFileSync(path.join(bin, cmd), `#!/bin/bash
echo "$PROTO_HOOK_SECRET" > ${JSON.stringify(secrets)}/$$
printf '\\033[1m%s\\033[0m \\033[2m(a bash shell standing in for the agent)\\033[0m\\r\\n' ${JSON.stringify(name)}
export PS1='\\[\\033[2m\\]\\W \\$\\[\\033[0m\\] ' BASH_SILENCE_DEPRECATION_WARNING=1
exec /bin/bash --norc --noprofile -i
`, { mode: 0o755 });
}
const lanes = new Map();
const { startLane } = laneModule;
laneModule.startLane = o => {
  const lane = startLane({ ...o, cmd: path.join(bin, path.basename(o.cmd)) });
  lanes.set(lane.id, lane);
  return lane;
};

// ---- The control API ----
const wrap = code => `(async () => {
  try {
    const value = await (async () => { ${code}
    })();
    try { return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) }; } catch { return { ok: true, value: String(value) }; }
  } catch (e) { return { ok: false, error: String(e && e.stack || e) }; }
})()`;
const KEYS = { enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'Backspace', up: 'Up', down: 'Down', left: 'Left', right: 'Right' };
let shots = 0;

http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const raw = await new Promise(resolve => { let s = ''; req.on('data', d => { s += d; }); req.on('end', () => resolve(s)); });
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return send(503, { error: 'The window isn\'t open yet.' });
  const wc = win.webContents;
  try {
    const route = new URL(req.url, 'http://x').pathname;
    const body = route === '/js' ? raw : (raw ? JSON.parse(raw) : {});
    if (route === '/js') return send(200, await wc.executeJavaScript(wrap(body)));
    if (route === '/shot') {
      fs.mkdirSync(path.join(PLAY_DIR, 'shots'), { recursive: true });
      const file = path.join(PLAY_DIR, 'shots', `${String(++shots).padStart(3, '0')}.png`);
      fs.writeFileSync(file, (await wc.capturePage()).resize({ width: win.getContentSize()[0] }).toPNG());
      return send(200, { file });
    }
    if (route === '/click') {
      for (const type of ['mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: Math.round(body.x), y: Math.round(body.y), button: body.button || 'left', clickCount: 1 });
      return send(200, { ok: true });
    }
    if (route === '/key') {
      const keyCode = KEYS[String(body.key).toLowerCase()] || body.key;
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: body.modifiers || [] });
      if (String(keyCode).length === 1 && !(body.modifiers || []).some(m => /meta|cmd|control|ctrl/.test(m))) wc.sendInputEvent({ type: 'char', keyCode, modifiers: body.modifiers || [] });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: body.modifiers || [] });
      return send(200, { ok: true });
    }
    if (route === '/type') { for (const ch of String(body.text)) wc.sendInputEvent({ type: 'char', keyCode: ch }); return send(200, { ok: true }); }
    if (route === '/menu') { wc.send('menu', body.action); return send(200, { ok: true }); }
    if (route === '/hook') {
      const { lane, ...event } = body;
      const term = lanes.get(lane)?.term;
      if (!term) return send(404, { error: 'No agent with that id runs in this copy.' });
      const secret = fs.readFileSync(path.join(secrets, String(term.pid)), 'utf8').trim();
      const reply = await fetch(`${hub}/hooks/${lane}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` },
        body: JSON.stringify({ cwd: lanes.get(lane).cwd || '/', ...event }) });
      return send(reply.status, await reply.json().catch(() => null));
    }
    send(404, { error: 'Try /js, /click, /key, /type, /menu, /hook or /shot.' });
  } catch (e) {
    send(500, { error: e.message });
  }
}).listen(Number(PLAY_PORT), '127.0.0.1');

require('../app/main');

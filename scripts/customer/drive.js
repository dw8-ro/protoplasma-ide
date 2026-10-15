// Customer simulation: drives the playground's two copies (npm run playground) like a person, finding an element and
// sending a real mouse click to its centre, or real typing. Run the scenarios in order against one fresh playground:
//   for s in 1 2 3 4 4b 5 6 7 8; do node scripts/customer/s$s.js; done
// Results go to results.log beside this file (not committed). See docs/usage-test/REPORT.md.
const fs = require('fs');
const path = require('path');
// The running playground: PLAY_ROOT, or the newest protoplasma-playground-* folder in the temp folder.
const newest = () => fs.readdirSync(require('os').tmpdir()).filter(d => d.startsWith('protoplasma-playground-'))
  .map(d => path.join(require('os').tmpdir(), d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const root = process.env.PLAY_ROOT || newest();
const token = fs.readFileSync(path.join(root, 'token'), 'utf8').trim();
const port = { david: 7801, max: 7802 };
const log = path.join(__dirname, 'results.log');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(who, route, body, method = 'POST') {
  const res = await fetch(`http://127.0.0.1:${port[who]}${route}`, { method, headers: { 'x-play-token': token },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body ?? {})) : undefined });
  return res.json();
}
async function js(who, code) {
  const r = await call(who, '/js', code);
  if (!r.ok) throw new Error(`${who} js: ${r.error}`);
  return r.value;
}
// Where an element is on screen (null if missing or hidden), after scrolling it into view.
const where = (who, sel) => js(who, `const el = typeof ${JSON.stringify(sel)} === 'string' ? document.querySelector(${JSON.stringify(sel)}) : null;
  if (!el || !el.getClientRects().length) return null;
  el.scrollIntoView({ block: 'nearest' });
  const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };`);
async function click(who, sel) {
  const at = await where(who, sel);
  if (!at) throw new Error(`${who}: nothing visible at ${sel}`);
  await call(who, '/click', at);
  await sleep(120);
}
// Clicks the first visible element matching `sel` whose text contains `text`.
async function clickText(who, sel, text) {
  const at = await js(who, `const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.getClientRects().length && e.textContent.includes(${JSON.stringify(text)}));
    if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };`);
  if (!at) throw new Error(`${who}: no visible ${sel} with "${text}"`);
  await call(who, '/click', at);
  await sleep(120);
}
const type = async (who, text) => { await call(who, '/type', { text }); await sleep(60); };
const key = async (who, k, modifiers) => { await call(who, '/key', { key: k, modifiers }); await sleep(80); };
const menu = async (who, action) => { await call(who, '/menu', { action }); await sleep(150); };
const hook = (who, body) => call(who, '/hook', body);
const shot = async who => (await call(who, '/shot', null, 'GET')).file;
async function until(who, expr, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await js(who, `return !!(${expr})`).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}
let section = '';
const results = [];
function check(name, ok, detail = '') {
  const line = `${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${detail ? `  (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : ''}`;
  results.push(!!ok);
  console.log(line);
  fs.appendFileSync(log, `${line}\n`);
  return ok;
}
const begin = name => { section = name; fs.appendFileSync(log, `\n== ${name}\n`); console.log(`\n== ${name}`); };
// Runs a scenario, logging (not throwing) an unexpected error as a failure.
async function run(name, fn) {
  begin(name);
  try { await fn(); } catch (e) { check('ran without an unexpected error', false, e.message.slice(0, 300)); }
  const dialogs = await Promise.all(['david', 'max'].map(w => js(w, 'const d = window.__dialogs.splice(0); return d;').catch(() => [])));
  if (dialogs.flat().length) fs.appendFileSync(log, `   dialogs: ${JSON.stringify({ david: dialogs[0], max: dialogs[1] })}\n`);
}
module.exports = { root, call, js, where, click, clickText, type, key, menu, hook, shot, until, check, run, sleep };

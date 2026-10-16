// The "How it works" diagram for the README, as SVG in GitHub's dark or light colours: two Macs, each running the app and
// an agent CLI in a terminal, and the hub between them. Text is live SVG text, so it stays sharp at any size.
const COLORS = {
  dark: { text: '#e6edf3', muted: '#8b949e', card: '#161b22', box: '#0d1117', line: '#30363d', arrow: '#6e7681', me: '#a78bfa', mate: '#5eead4', hub: '#e6edf3' },
  light: { text: '#1f2328', muted: '#59636e', card: '#f6f8fa', box: '#ffffff', line: '#d1d9e0', arrow: '#818b98', me: '#7c3aed', mate: '#0d9488', hub: '#1f2328' },
};

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

module.exports = function diagram(theme) {
  const c = COLORS[theme];
  const sans = 'font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Inter, Helvetica, Arial, sans-serif"';
  const mono = 'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"';
  const text = (x, y, s, { size = 18, fill = c.text, weight = 400, anchor = 'start', font = sans } = {}) =>
    `<text x="${x}" y="${y}" ${font} font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

  // A Mac: the app on top, the agent's terminal below it.
  const mac = (x, title, color, cli, who) => `
  <rect x="${x}" y="40" width="300" height="420" rx="20" fill="${c.card}" stroke="${color}" stroke-opacity=".55" stroke-width="1.5"/>
  ${text(x + 24, 80, title, { size: 15, fill: color, weight: 600 })}
  <rect x="${x + 24}" y="104" width="252" height="104" rx="14" fill="${c.box}" stroke="${c.line}"/>
  ${text(x + 46, 146, 'Protoplasma', { size: 20, weight: 600 })}
  ${text(x + 46, 176, 'sessions, code, team', { size: 15, fill: c.muted })}
  <line x1="${x + 150}" y1="208" x2="${x + 150}" y2="292" stroke="${c.line}" stroke-width="1.5"/>
  ${text(x + 162, 256, 'starts', { size: 14, fill: c.muted })}
  <rect x="${x + 24}" y="292" width="252" height="132" rx="14" fill="${c.box}" stroke="${color}" stroke-opacity=".7"/>
  <circle cx="${x + 46}" cy="320" r="5" fill="${color}"/>
  ${text(x + 60, 326, who, { size: 14, fill: c.muted })}
  ${text(x + 46, 366, cli, { size: 22, weight: 600, font: mono })}
  ${text(x + 46, 398, 'the real CLI, in a terminal', { size: 15, fill: c.muted })}`;

  // An arrow from (x1, y) to (x2, y), with its label centred above it at labelX (the gap between a Mac and the hub).
  const arrow = (x1, x2, y, label, labelX, { dashed = false } = {}) => `
  <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${c.arrow}" stroke-width="1.75"${dashed ? ' stroke-dasharray="6 6"' : ''} marker-end="url(#head)"/>
  ${text(labelX, y - 12, label, { size: 14, fill: c.muted, anchor: 'middle' })}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="500" viewBox="0 0 1280 500">
  <title>How Protoplasma works: each Mac runs the app and its agents; the hub relays terminals and team state between them</title>
  <defs>
    <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10z" fill="${c.arrow}"/>
    </marker>
  </defs>
  ${mac(40, 'YOUR MAC', c.me, 'claude', 'you')}
  ${mac(940, "TEAMMATE'S MAC", c.mate, 'codex', 'a teammate')}

  <rect x="520" y="132" width="240" height="236" rx="22" fill="${c.card}" stroke="${c.hub}" stroke-opacity=".35" stroke-width="1.5"/>
  ${text(640, 182, 'Hub', { size: 24, weight: 700, anchor: 'middle' })}
  ${text(640, 210, 'online, or on a teammate\'s Mac', { size: 14, fill: c.muted, anchor: 'middle' })}
  ${text(640, 258, 'relays terminals', { size: 15, anchor: 'middle' })}
  ${text(640, 288, 'flags overlapping files', { size: 15, anchor: 'middle' })}
  ${text(640, 318, 'answers Claude Code hooks', { size: 15, anchor: 'middle' })}
  ${text(640, 348, 'keeps sessions, plans, notes', { size: 15, anchor: 'middle' })}

  ${arrow(520, 316, 156, 'live team state', 430)}
  ${arrow(760, 964, 156, 'live team state', 850)}
  ${arrow(316, 520, 316, 'terminal, git status', 430)}
  ${arrow(964, 760, 316, 'terminal, git status', 850)}
  ${arrow(316, 520, 356, 'Claude Code hooks', 430, { dashed: true })}
</svg>
`;
};

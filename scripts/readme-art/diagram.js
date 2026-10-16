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

  // A Mac: the app on top, the agent's terminal below it. Sizes are for a 1280-wide picture shown about 830 px wide.
  const mac = (x, title, color, cli, who) => `
  <rect x="${x}" y="40" width="290" height="420" rx="20" fill="${c.card}" stroke="${color}" stroke-opacity=".55" stroke-width="1.5"/>
  ${text(x + 20, 80, title, { size: 17, fill: color, weight: 600 })}
  <rect x="${x + 20}" y="104" width="250" height="104" rx="14" fill="${c.box}" stroke="${c.line}"/>
  ${text(x + 42, 146, 'Protoplasma', { size: 21, weight: 600 })}
  ${text(x + 42, 178, 'sessions, code, team', { size: 17, fill: c.muted })}
  <line x1="${x + 145}" y1="208" x2="${x + 145}" y2="292" stroke="${c.line}" stroke-width="1.5"/>
  ${text(x + 157, 256, 'starts', { size: 16, fill: c.muted })}
  <rect x="${x + 20}" y="292" width="250" height="132" rx="14" fill="${c.box}" stroke="${color}" stroke-opacity=".7"/>
  <circle cx="${x + 42}" cy="321" r="5" fill="${color}"/>
  ${text(x + 56, 327, who, { size: 16, fill: c.muted })}
  ${text(x + 42, 368, cli, { size: 23, weight: 600, font: mono })}
  ${text(x + 42, 400, 'the real CLI, in a terminal', { size: 16, fill: c.muted })}`;

  // An arrow from (x1, y) to (x2, y), with its label centred above it at labelX (the gap between a Mac and the hub).
  const arrow = (x1, x2, y, label, labelX, { dashed = false } = {}) => `
  <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${c.arrow}" stroke-width="1.75"${dashed ? ' stroke-dasharray="6 6"' : ''} marker-end="url(#head)"/>
  ${text(labelX, y - 12, label, { size: 17, fill: c.muted, anchor: 'middle' })}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="500" viewBox="0 0 1280 500">
  <title>How Protoplasma works: each Mac runs the app and its agents; the hub relays terminals and team state between them</title>
  <defs>
    <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 10 5 0 10z" fill="${c.arrow}"/>
    </marker>
  </defs>
  ${mac(40, 'YOUR MAC', c.me, 'claude', 'you')}
  ${mac(950, "TEAMMATE'S MAC", c.mate, 'codex', 'a teammate')}

  <rect x="500" y="118" width="280" height="264" rx="22" fill="${c.card}" stroke="${c.hub}" stroke-opacity=".35" stroke-width="1.5"/>
  ${text(640, 170, 'Hub', { size: 26, weight: 700, anchor: 'middle' })}
  ${text(640, 200, 'online, or on one of the Macs', { size: 16, fill: c.muted, anchor: 'middle' })}
  ${text(640, 252, 'relays terminals', { size: 17, anchor: 'middle' })}
  ${text(640, 284, 'flags overlapping files', { size: 17, anchor: 'middle' })}
  ${text(640, 316, 'answers Claude Code hooks', { size: 17, anchor: 'middle' })}
  ${text(640, 348, 'keeps sessions, plans, notes', { size: 17, anchor: 'middle' })}

  ${arrow(500, 310, 156, 'live team state', 415)}
  ${arrow(780, 970, 156, 'live team state', 865)}
  ${arrow(310, 500, 318, 'terminal, git status', 415)}
  ${arrow(970, 780, 318, 'terminal, git status', 865)}
  ${arrow(310, 500, 362, 'Claude Code hooks', 415, { dashed: true })}
</svg>
`;
};

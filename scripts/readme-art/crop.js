// Shared by the README image pages. ?theme=dark|light picks the colours; ?zoom= renders the 1280-wide layout larger.
const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') === 'light' ? 'light' : 'dark';
document.documentElement.style.zoom = query.get('zoom') || 1;

// <div class="crop" data-src="session" data-x data-y data-w data-h data-s data-r style="left; top">: shows the region
// (x, y, w, h) of the app window in docs/<src>.png at scale s, where 1 is the window at its 1x size (1440x900).
// Region and radius are in the window's own 2x pixels; npm run screenshot puts the 2880x1800 window at (128, 128).
// A child <i class="mark" data-x data-y data-w data-h> rings a region given in the same window pixels.
const EDGE = 128;
for (const el of document.querySelectorAll('.crop')) {
  const d = el.dataset, s = +d.s / 2, r = +(d.r || 21);
  Object.assign(el.style, { width: `${d.w * s}px`, height: `${d.h * s}px`, borderRadius: `${r * s}px` });
  const img = new Image();
  img.src = `../../docs/${d.src}.png`;
  Object.assign(img.style, { width: `${3136 * s}px`, left: `${-(+d.x + EDGE) * s}px`, top: `${-(+d.y + EDGE) * s}px` });
  el.prepend(img);
  for (const m of el.querySelectorAll('.mark')) {
    const q = m.dataset;
    Object.assign(m.style, { left: `${(q.x - d.x) * s}px`, top: `${(q.y - d.y) * s}px`, width: `${q.w * s}px`, height: `${q.h * s}px` });
  }
}

// Writes the demo GIF (scripts/demo.js), plain and framed for the README: the recording with rounded corners and a hairline
// ring, on a margin of GitHub's dark or light page colour, like the images npm run readme-art makes.
const fs = require('fs');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

const PAD = 24, RADIUS = 14;
const PAGES = { dark: { page: [13, 17, 23], ring: [255, 255, 255, 0.14] }, light: { page: [255, 255, 255], ring: [0, 0, 0, 0.16] } };

/** An RGBA frame (width x height) inside its frame: returns { rgba, width, height }. */
function framed(rgba, width, height, theme) {
  const { page, ring } = PAGES[theme];
  const W = width + 2 * PAD, H = height + 2 * PAD, out = new Uint8Array(W * H * 4);
  // How far inside the rounded rectangle a pixel centre is (negative: outside), so its edge can be antialiased.
  const inside = (x, y) => {
    const dx = Math.max(RADIUS - x - 0.5, x + 0.5 - (width - RADIUS), 0), dy = Math.max(RADIUS - y - 0.5, y + 0.5 - (height - RADIUS), 0);
    return dx > 0 && dy > 0 ? RADIUS - Math.hypot(dx, dy) : Math.min(x + 0.5, y + 0.5, width - x - 0.5, height - y - 0.5);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4, sx = x - PAD, sy = y - PAD;
      let px = page;
      if (sx >= 0 && sy >= 0 && sx < width && sy < height) {
        const d = inside(sx, sy), cover = Math.min(1, Math.max(0, d + 0.5));
        const i = (sy * width + sx) * 4, src = [rgba[i], rgba[i + 1], rgba[i + 2]];
        px = src.map((v, k) => v * cover + page[k] * (1 - cover));
        const edge = Math.max(0, 1 - Math.abs(d - 0.5)) * ring[3]; // the 1px ring along the edge
        px = px.map((v, k) => v * (1 - edge) + ring[k] * edge);
      }
      out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = 255;
    }
  }
  return { rgba: out, width: W, height: H };
}

// One shared palette, and pixels that didn't change since the previous frame left transparent, so the GIF stays small.
function writeGif(file, rgba, width, height, delay) {
  const pick = [0, rgba.length >> 2, rgba.length >> 1, (rgba.length * 3) >> 2, rgba.length - 1].map(i => rgba[i]);
  const sample = new Uint8Array(pick.reduce((n, f) => n + f.length, 0));
  pick.reduce((offset, f) => { sample.set(f, offset); return offset + f.length; }, 0);
  const colours = quantize(sample, 255);
  const palette = [...colours, [0, 0, 0]]; // index 255: transparent
  const gif = GIFEncoder();
  let previous = null;
  for (const frame of rgba) {
    const index = applyPalette(frame, colours);
    const drawn = index.slice();
    if (previous) for (let i = 0; i < index.length; i++) if (index[i] === previous[i]) index[i] = 255;
    gif.writeFrame(index, width, height, { palette: previous ? undefined : palette, delay, transparent: !!previous, transparentIndex: 255, dispose: 1 });
    previous = drawn;
  }
  gif.finish();
  fs.writeFileSync(file, gif.bytes());
}

module.exports = { framed, writeGif };

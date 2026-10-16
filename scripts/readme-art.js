// Renders the README images in docs/readme/ from the screenshots in docs/ (npm run screenshot makes those): each page
// in scripts/readme-art/ in GitHub's dark and light themes, at 1.3x its 1280x720 layout, and the diagram as SVG.
// Usage: npm run readme-art
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const diagram = require('./readme-art/diagram');

const PAGES = ['hero', 'agents', 'code', 'sessions', 'overlap', 'start'];
const ZOOM = 1.3;
const out = path.join(__dirname, '..', 'docs', 'readme');

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  for (const theme of ['dark', 'light']) fs.writeFileSync(path.join(out, `how-it-works-${theme}.svg`), diagram(theme));
  // Offscreen, so a page larger than the screen is painted although no window is shown. The page scales itself (?zoom).
  const win = new BrowserWindow({ show: false, useContentSize: true, width: 1280 * ZOOM, height: 720 * ZOOM,
    webPreferences: { offscreen: true, zoomFactor: 1 } });
  // The next whole frame the page paints.
  const frame = () => new Promise(resolve => {
    win.webContents.once('paint', (event, dirty, image) => resolve(image));
    win.webContents.invalidate();
  });
  for (const page of PAGES) {
    for (const theme of ['dark', 'light']) {
      await win.loadFile(path.join(__dirname, 'readme-art', `${page}.html`), { query: { theme, zoom: String(ZOOM) } });
      // Every crop's screenshot decoded and the font in place, then painted, before the picture is taken.
      await win.webContents.executeJavaScript('document.fonts.ready.then(() => Promise.all([...document.images].map(i => i.decode())))');
      await frame();
      await new Promise(resolve => setTimeout(resolve, 500));
      const file = path.join(out, `${page}-${theme}.png`);
      fs.writeFileSync(file, (await frame()).toPNG());
      console.log(`saved docs/readme/${page}-${theme}.png (${Math.round(fs.statSync(file).size / 1024)} KB)`);
    }
  }
  app.quit();
});

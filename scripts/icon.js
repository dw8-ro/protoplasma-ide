// Renders app/icon.svg to build/icon.png (1024px) and build/icon.icns using sips and iconutil.
// Usage: npm run icon
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'build');
const png = path.join(out, 'icon.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.join(root, 'app/icon.svg')).toString('base64');
  await win.loadURL(`data:text/html,<style>html,body{margin:0;background:transparent}</style><img src="data:image/svg+xml;base64,${svg}">`);
  await new Promise(r => setTimeout(r, 500));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(png, (await win.webContents.capturePage()).resize({ width: 1024, height: 1024 }).toPNG());

  const iconset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'protoplasma-icon-')), 'icon.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', size, size, png, '--out', path.join(iconset, `icon_${size}x${size}.png`)], { stdio: 'ignore' });
    execFileSync('sips', ['-z', size * 2, size * 2, png, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(out, 'icon.icns')]);
  console.log('saved build/icon.png and build/icon.icns');
  app.quit();
});

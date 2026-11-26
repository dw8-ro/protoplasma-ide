// Runs the install scripts of the dependencies that package.json's allowScripts names, at the versions it pins, and
// no others. .npmrc sets ignore-scripts=true, so npm install and npm ci run none at all.
// Usage: npm run setup, after npm install or npm ci (it also runs the project's own postinstall).
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const { allowScripts = {} } = require(path.join(root, 'package.json'));
for (const [spec, allowed] of Object.entries(allowScripts)) {
  if (!allowed) continue;
  const at = spec.lastIndexOf('@'), name = spec.slice(0, at), version = spec.slice(at + 1);
  const dir = path.join(root, 'node_modules', name);
  let pkg;
  try { pkg = require(path.join(dir, 'package.json')); } catch { continue; } // not installed here
  // The package's own name too: an npm alias ("node-pty": "npm:other@1.0.0") puts another package in that folder.
  if (pkg.name !== name || pkg.version !== version) {
    console.error(`node_modules/${name} holds ${pkg.name}@${pkg.version}, but allowScripts in package.json allows ${spec}. Read what its install scripts do, then update allowScripts.`);
    process.exit(1);
  }
  // By path: "npm rebuild <name>" would also run the scripts of every nested or aliased copy with that folder name.
  execFileSync('npm', ['rebuild', dir, '--ignore-scripts=false'], { cwd: root, stdio: 'inherit' });
}

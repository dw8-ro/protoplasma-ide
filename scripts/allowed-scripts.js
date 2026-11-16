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
  let installed;
  try { installed = require(path.join(root, 'node_modules', name, 'package.json')).version; } catch { continue; } // not installed here
  if (installed !== version) {
    console.error(`${name} is ${installed} here, but allowScripts in package.json allows ${spec}. Read what its install scripts do in ${installed}, then update allowScripts.`);
    process.exit(1);
  }
  execFileSync('npm', ['rebuild', name, '--ignore-scripts=false'], { cwd: root, stdio: 'inherit' });
}

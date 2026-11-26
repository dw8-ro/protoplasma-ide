# verify-build-ci

## build-ci-1: confirmed, medium
Why: allowed-scripts.js checks only the top-level node_modules/<name>/package.json version, then runs `npm rebuild <name>`. npm's rebuild isNode matches by folder name with an empty rawSpec, so every non-bundled node of that name at any version is rebuilt, aliases included. npm 11.20's allowScripts gate only skips packages explicitly set to false.
Evidence: work/verify-build-ci/t (offline, the clone's .npmrc and an unchanged allowed-scripts.js): `npm run setup` wrote TOP, ALIASED_EVIL (other -> "node-pty": "npm:evil-pkg@6.6.6") and NESTED_UNVETTED (third -> node-pty@0.9.0). `npm rebuild <abs>/node_modules/node-pty --ignore-scripts=false` wrote only TOP. Today's lockfile has one copy of each name, so it can't be exploited yet. Main ran every install script anyway, so this isn't a regression against main, but it defeats the branch's new control.
Fix: rebuild by path (path.join(root,'node_modules',name)) and refuse when the installed package.json name differs from name. Verified that the path form runs only the top-level copy (npm then warns about unlisted packages, which is harmless).

## build-ci-2: confirmed, low
Why: README.md:186-191 says npm install then npm start, with no setup step. README.md:219 says "isn't enforced yet ... no .npmrc". The branch's README diff doesn't touch either. .npmrc:3 ignore-scripts=true; package.json:23 setup; AGENTS.md:21 and :585-593 describe the new flow. Without setup, Electron still fetches its binary on first run (electron/index.js), so the window opens, but node-pty's post-install and the root chmod of spawn-helper never run.
Fix: as suggested (`npm install && npm run setup`, and rewrite the paragraph to match AGENTS.md).

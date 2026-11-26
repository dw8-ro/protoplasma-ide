# fixes-ci-docs findings

## 1. medium: release.yml sign job extracts the build job's tar over its own checkout, so build-job code can replace scripts/sign.sh and read the signing key
- `sign` runs `actions/checkout` (sparse: scripts/sign.sh), then `tar -xzf app.tgz` in the same folder, then `scripts/sign.sh` with MAC_CERT_P12/MAC_CERT_PASSWORD in env.
- app.tgz is made by the `build` job, where every dependency's code runs. A compromised dependency (or allowed install script) adds `scripts/sign.sh` to app.tgz; bsdtar overwrites the checked-out file by default.
- Verified in scratch (work2/fixes-ci-docs/tartest): checked-out `scripts/sign.sh` = good, archive with `scripts/sign.sh` = evil, after `tar -xzf` it reads `evil`.
- So the split's stated guarantee ("dependency code never runs where the signing key is", AGENTS.md, release notes) doesn't hold. Also a planted extra `Protoplasma-*-mac-arm64.zip` would be uploaded by the glob.
- Fix: extract into its own dir and refuse anything but Protoplasma.app: `tar -tzf app.tgz | grep -qv '^Protoplasma.app\(/\|$\)' && exit 1; mkdir out && tar -xzf app.tgz -C out`, then sign `out/Protoplasma.app` (or checkout sign.sh into `path: src`).

## 2. low: unsigned-app artifact kept 1 day, but the sign job waits for a reviewer
- `retention-days: 1` on upload; `sign` runs in the `release` environment that HANDOFF/plan tell David to give required reviewers. A wait can last up to 30 days.
- Tag pushed in the evening, approved the next evening: download-artifact fails (artifact expired). Re-running only `sign` can't help; plan.md says a failed release "needs a new commit and a new version (0.7.1)", which would push David into an unneeded version bump (a "Re-run all jobs" rebuilds it, since nothing was published).
- Fix: `retention-days: 7` (or more), and say in plan/HANDOFF that a failed `sign` before publishing just needs "Re-run all jobs".

## 3. low: AGENTS.md test counts now wrong
- AGENTS.md Commands: "123 integration tests"; repo map: hub-live 18, identity 7, conflicts 1, no quota.test.js. Actual (test( count): hub-live 20, identity 8, conflicts 3, quota 2; total 130 (HANDOFF says 130 of 130).

## 4. low: docs still pin Electron to 44.10.2 and describe Monaco 0.57's DOMPurify as current
- package.json now `electron ~44.11.6`, `monaco-editor ^0.58.0` (min/vs bundles DOMPurify 3.4.17).
- docs/plan.md:46 (phase 1): "Electron stays at `~44.10.2`." HANDOFF.md:166: "Electron stays at 44.10.2. Don't take 44.11.x as it is". HANDOFF.md:354 ("Known and left"): "Monaco 0.57.0 bundles DOMPurify 3.4.15 ... Take a Monaco release with a newer DOMPurify when one comes out".
- A later session reading plan.md or the Known-and-left list could revert Electron or re-chase the DOMPurify item. Fix: mark them done/superseded with the 25 Nov versions.

## Checked and sound
- npm rebuild <absolute dir>: npm 11.20 rebuild.js accepts `directory` specs and matches `node.path === spec.fetchSpec`; scratch script with npm's own arborist selects exactly node_modules/node-pty and node_modules/electron.
- allowScripts pin electron@44.11.6 = installed 44.11.6 = lockfile; electron has no install scripts; node-pty 1.1.0 unchanged.
- TAG passes via job output; upload/download names match (unsigned-app, app.tgz in cwd); sign.sh is 100755 in git; sparse non-cone patterns cover sign.sh and release notes; gh with --repo needs no git; job permissions OK; download-artifact needs no actions:read.
- e2e: `app` is imported (line 5); check() takes a third detail arg. package.json version 0.6.1, so `npm version minor` gives 0.7.0.

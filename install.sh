#!/bin/sh
# Installs the latest Protoplasma into /Applications.
# Anything downloaded this way isn't quarantined, so macOS opens the app without the "can't be verified" warning.
set -e
REPO=dw8-ro/protoplasma-ide
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh release download -R "$REPO" -p 'Protoplasma-*-mac-arm64.zip' -D "$TMP" # works for a private repo you can see
else
  URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*mac-arm64\.zip"' | cut -d'"' -f4)
  [ -n "$URL" ] || { echo "Couldn't find a release. If the repo is private, sign in first: gh auth login" >&2; exit 1; }
  curl -fsSL -o "$TMP/Protoplasma.zip" "$URL"
fi

ditto -x -k "$TMP"/*.zip "$TMP/app"
rm -rf /Applications/Protoplasma.app
mv "$TMP/app/Protoplasma.app" /Applications/
xattr -dr com.apple.quarantine /Applications/Protoplasma.app 2>/dev/null || true
echo "Installed Protoplasma. It keeps itself up to date from now on."
open /Applications/Protoplasma.app

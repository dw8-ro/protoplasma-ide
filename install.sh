#!/bin/sh
# Installs the latest Protoplasma into /Applications.
# Anything downloaded this way isn't quarantined, so macOS opens the app without the "can't be verified" warning.
set -e
REPO=dw8-ro/protoplasma-ide
# (uname -m says x86_64 in a Rosetta shell, so ask the hardware)
[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] || { echo "Protoplasma runs on Macs with Apple silicon." >&2; exit 1; }
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
# The new copy goes in beside the old one first, so a failed move never leaves you with neither.
rm -rf /Applications/Protoplasma.app.new
mv "$TMP/app/Protoplasma.app" /Applications/Protoplasma.app.new
rm -rf /Applications/Protoplasma.app
mv /Applications/Protoplasma.app.new /Applications/Protoplasma.app
xattr -dr com.apple.quarantine /Applications/Protoplasma.app 2>/dev/null || true
echo "Installed Protoplasma. It keeps itself up to date from now on."
open /Applications/Protoplasma.app

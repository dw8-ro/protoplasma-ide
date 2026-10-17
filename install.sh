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
  gh release download -R "$REPO" -p 'Protoplasma-*-mac-arm64.zip' -D "$TMP" # a signed-in gh isn't held to GitHub's hourly limit for anonymous requests
else
  URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"browser_download_url": *"[^"]*mac-arm64\.zip"' | cut -d'"' -f4)
  [ -n "$URL" ] || { echo "Couldn't get the latest release from GitHub. Check your connection and try again in a few minutes, or download it from https://github.com/$REPO/releases" >&2; exit 1; }
  curl -fsSL -o "$TMP/Protoplasma.zip" "$URL"
fi

ditto -x -k "$TMP"/*.zip "$TMP/app"
# A running copy would keep running the old version: it's asked to quit first (it asks about running agents).
if pgrep -x Protoplasma >/dev/null 2>&1; then
  echo "Quitting Protoplasma to replace it..."
  osascript -e 'tell application "Protoplasma" to quit' 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Protoplasma >/dev/null 2>&1 || break; sleep 1; done
  pgrep -x Protoplasma >/dev/null 2>&1 && { echo "Protoplasma is still open. Quit it, then run this again." >&2; exit 1; }
fi
# The old copy is moved aside, not deleted, until the new one is in place: a failed move never leaves you with neither.
rm -rf /Applications/Protoplasma.app.old
[ -d /Applications/Protoplasma.app ] && mv /Applications/Protoplasma.app /Applications/Protoplasma.app.old
if mv "$TMP/app/Protoplasma.app" /Applications/Protoplasma.app; then
  rm -rf /Applications/Protoplasma.app.old
else
  [ -d /Applications/Protoplasma.app.old ] && mv /Applications/Protoplasma.app.old /Applications/Protoplasma.app
  echo "Couldn't put the new version in /Applications." >&2; exit 1
fi
xattr -dr com.apple.quarantine /Applications/Protoplasma.app 2>/dev/null || true
echo "Installed Protoplasma. It keeps itself up to date from now on."
open /Applications/Protoplasma.app

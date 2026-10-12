#!/bin/sh
# Signs the built app, without an Apple developer account.
# With MAC_CERT_P12 (a base64 .p12) and MAC_CERT_PASSWORD set, it uses that self-signed certificate, the same one for
# every release, so macOS treats each version as the same app: Keychain access ("Always Allow") and privacy
# permissions carry over when the app updates itself. Without them it signs ad hoc, which runs fine but makes every
# build look like a new app to macOS.
# Usage: scripts/sign.sh path/to/Protoplasma.app
set -e
APP=$1
if [ -z "$MAC_CERT_P12" ]; then
  # A release signed ad hoc would be refused by every copy already installed, so CI never makes one.
  [ -z "$CI" ] || { echo "The signing certificate (MAC_CERT_P12, MAC_CERT_PASSWORD) isn't set in this repo's secrets." >&2; exit 1; }
  codesign --force --deep --sign - "$APP"
  exit
fi
DIR=$(mktemp -d)
KC="$DIR/signing.keychain-db"
trap 'security delete-keychain "$KC" 2>/dev/null; rm -rf "$DIR"' EXIT
printf '%s' "$MAC_CERT_P12" | base64 --decode > "$DIR/cert.p12"
security create-keychain -p "$MAC_CERT_PASSWORD" "$KC"
security unlock-keychain -p "$MAC_CERT_PASSWORD" "$KC"
security import "$DIR/cert.p12" -k "$KC" -P "$MAC_CERT_PASSWORD" -T /usr/bin/codesign > /dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$MAC_CERT_PASSWORD" "$KC" > /dev/null
# codesign finds identities through the keychain search list, so the build keychain joins it until we're done.
# The list is split on line ends only, so a home folder with a space in its name stays whole.
SEARCH=$(security list-keychains -d user | sed -e 's/^ *"//' -e 's/" *$//')
OLDIFS=$IFS; IFS='
'
# shellcheck disable=SC2086
security list-keychains -d user -s "$KC" $SEARCH
IFS=$OLDIFS
trap 'IFS="
"; security list-keychains -d user -s $SEARCH; security delete-keychain "$KC" 2>/dev/null; rm -rf "$DIR"' EXIT
security find-identity -p codesigning "$KC" | sed -n '1,3p'
# By fingerprint: a self-signed certificate isn't trusted, and codesign won't match an untrusted identity by name.
ID=$(security find-certificate -c "Protoplasma Release Signing" -Z "$KC" | awk '/SHA-1/ { print $NF; exit }')
codesign --force --deep --keychain "$KC" --sign "$ID" "$APP"
codesign --verify --deep --strict "$APP"

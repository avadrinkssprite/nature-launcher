#!/usr/bin/env bash
# Nature Launcher for Linux (x64 / arm64).
# Installs the app straight from the GitHub repo's main branch plus the Electron runtime it pins,
# so there are no per-version builds. Re-running it updates the launcher.
#
#   curl -fsSL https://raw.githubusercontent.com/avadrinkssprite/nature-launcher/main/install.sh | bash
#
# Options: --update (used by the launcher: waits for it to exit, then reopens it)  --uninstall
# Instances and settings live in ~/.config/nature-launcher and are never touched.
set -euo pipefail

REPO=avadrinkssprite/nature-launcher
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
DIR="$DATA/nature-launcher"
BIN="$HOME/.local/bin/nature-launcher"
DESKTOP="$DATA/applications/nature-launcher.desktop"
MODE="${1:-install}"

say() { printf '\033[1;36m::\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [ "$MODE" = "--uninstall" ]; then
  [ ! -e "$DIR" ] || [ -f "$DIR/nature-launcher" ] || die "$DIR doesn't look like a Nature Launcher install, not touching it"
  rm -rf "$DIR" "$BIN" "$DESKTOP"
  say "Removed Nature Launcher. Your instances are still in ~/.config/nature-launcher"
  exit 0
fi

case "${NL_ARCH:-$(uname -m)}" in
  x86_64 | amd64) EARCH=x64 ;;
  aarch64 | arm64) EARCH=arm64 ;;
  *) die "Unsupported CPU: $(uname -m) (needs x86_64 or arm64)" ;;
esac

fetch() {
  if command -v curl >/dev/null; then curl -fL --progress-bar "$1" -o "$2"
  elif command -v wget >/dev/null; then wget -q --show-progress -O "$2" "$1"
  else die "Needs curl or wget"; fi
}
unpack() {
  if command -v unzip >/dev/null; then unzip -qo "$1" -d "$2"
  elif command -v python3 >/dev/null; then python3 -m zipfile -e "$1" "$2"
  else die "Needs unzip or python3"; fi
}
wait_for_exit() { # the launcher quits itself before running an update; give it a moment
  command -v pgrep >/dev/null || return 0
  for _ in $(seq 1 40); do pgrep -f "$DIR/nature-launcher" >/dev/null || return 0; sleep 0.5; done
  die "Nature Launcher is still running. Close it and run this again."
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

say "Downloading Nature Launcher"
fetch "https://github.com/$REPO/archive/refs/heads/main.zip" "$tmp/repo.zip"
mkdir "$tmp/repo" && unpack "$tmp/repo.zip" "$tmp/repo"
app="$(find "$tmp/repo" -mindepth 1 -maxdepth 1 -type d | head -n 1)" # GitHub wraps it in <repo>-main/
[ -f "$app/main.js" ] || die "The download did not contain the launcher"

ver="$(grep -A1 '"node_modules/electron"' "$app/package-lock.json" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p')"
[ -n "$ver" ] || die "Could not find the Electron version in package-lock.json"

# the whole install folder is replaced, so never touch a folder that holds something else
if [ -e "$DIR" ] && [ ! -f "$DIR/nature-launcher" ] && [ -n "$(ls -A "$DIR")" ]; then
  die "$DIR already has other files in it"
fi

if [ ! -f "$DIR/nature-launcher" ] || [ "$(cat "$DIR/version" 2>/dev/null)" != "$ver" ]; then
  say "Downloading runtime (Electron $ver)"
  fetch "https://github.com/electron/electron/releases/download/v$ver/electron-v$ver-linux-$EARCH.zip" "$tmp/electron.zip"
  mkdir "$tmp/rt" && unpack "$tmp/electron.zip" "$tmp/rt"
  mv "$tmp/rt/electron" "$tmp/rt/nature-launcher"
  rm -f "$tmp/rt/resources/default_app.asar"
  chmod +x "$tmp/rt/nature-launcher" "$tmp/rt/chrome_crashpad_handler" 2>/dev/null || true # python's unzip drops modes
  wait_for_exit
  rm -rf "$DIR"
  mkdir -p "$(dirname "$DIR")"
  mv "$tmp/rt" "$DIR"
else
  wait_for_exit
fi

say "Installing to $DIR"
rm -rf "$DIR/resources/app"
cp -r "$app" "$DIR/resources/app"

# Chromium's sandbox needs unprivileged user namespaces; some distros (e.g. Ubuntu 24.04) block them
mkdir -p "$(dirname "$BIN")" "$(dirname "$DESKTOP")"
cat > "$BIN" <<EOF
#!/bin/sh
if unshare --user true 2>/dev/null; then exec "$DIR/nature-launcher" "\$@"; fi
exec "$DIR/nature-launcher" --no-sandbox "\$@"
EOF
chmod +x "$BIN"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Nature Launcher
Comment=Minecraft launcher with Modrinth built in
Exec=$BIN %U
Icon=$DIR/resources/app/build/icon.png
Terminal=false
Categories=Game;
StartupWMClass=nature-launcher
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$DESKTOP")" 2>/dev/null || true

if [ "$MODE" = "--update" ]; then
  nohup "$BIN" >/dev/null 2>&1 &
  say "Updated"
else
  say "Done. Open Nature Launcher from your app menu, or run: $BIN"
fi

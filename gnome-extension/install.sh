#!/usr/bin/env bash
# Install the GNOME top-bar extension and a systemd user service that keeps the server running.
#
#   gnome-extension/install.sh               # extension + service on port 3140
#   USAGE_TRACKER_PORT=3170 gnome-extension/install.sh
#   gnome-extension/install.sh --no-service  # extension only; run the server yourself
#   gnome-extension/install.sh --uninstall
#
# Run it from a shell where `node` (20+) resolves, or pass NODE=/path/to/node. The service records that
# absolute path, so re-run this script after switching Node installs.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UUID=usage-tracker@joshuamaiorino.github.io
SOURCE="$ROOT/gnome-extension/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/usage-tracker.service"
PORT=${USAGE_TRACKER_PORT:-3140}
SCHEMA=org.gnome.shell.extensions.usage-tracker

service=1
case "${1:-}" in
  '') ;;
  --no-service) service=0 ;;
  --uninstall)
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST"
    if [ -f "$UNIT" ]; then
      systemctl --user disable --now usage-tracker.service || true
      rm -f "$UNIT"
      systemctl --user daemon-reload
    fi
    echo "Removed the extension and service. Log out and back in to clear the top bar."
    exit 0
    ;;
  *) echo "Usage: $0 [--no-service | --uninstall]" >&2; exit 2 ;;
esac

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
  echo "USAGE_TRACKER_PORT must be an integer between 1 and 65535." >&2
  exit 2
fi

rm -rf "$DEST"
mkdir -p "$DEST/schemas"
cp "$SOURCE/metadata.json" "$SOURCE/extension.js" "$SOURCE/stylesheet.css" "$DEST/"
cp "$ROOT/public/usage-view.js" "$DEST/"
cp "$SOURCE/schemas/"*.gschema.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"
gsettings --schemadir "$DEST/schemas" set "$SCHEMA" server-url "http://127.0.0.1:$PORT"
echo "Installed extension to $DEST (server http://127.0.0.1:$PORT)"

if [ "$service" = 1 ]; then
  NODE=${NODE:-$(command -v node || true)}
  if [ -z "$NODE" ] || ! "$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    echo "Node.js 20+ not found. Put it on PATH or pass NODE=/path/to/node." >&2
    exit 1
  fi
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<EOF
[Unit]
Description=Usage Tracker local server
After=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/server.js --port $PORT
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable usage-tracker.service
  systemctl --user restart usage-tracker.service
  echo "Service usage-tracker.service running $NODE on port $PORT"
fi

# A running Wayland session only loads new extensions at login, so `gnome-extensions enable` can fail
# here; add the UUID to the enabled list directly instead.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
  current=$(gsettings get org.gnome.shell enabled-extensions)
  if [[ "$current" != *"'$UUID'"* ]]; then
    if [ "$current" = "@as []" ] || [ "$current" = "[]" ]; then next="['$UUID']"; else next="${current%]}, '$UUID']"; fi
    gsettings set org.gnome.shell enabled-extensions "$next"
  fi
  echo "Enabled. Log out and back in to load it (Wayland cannot reload GNOME Shell in place)."
fi

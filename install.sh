#!/bin/bash
# Install the current checkout into the user extension directory and enable it.
set -eu
cd "$(dirname "$0")"

UUID="$(python3 -c "import json;print(json.load(open('metadata.json'))['uuid'])")"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

./build.sh

echo "Installing $UUID..."
gnome-extensions install --force "${UUID}.shell-extension.zip"

# GNOME Shell rescans the extension directory on change, but a shell that was
# already running when this uuid first appeared may not notice. Enabling over
# D-Bus reports whether it picked it up.
gnome-extensions enable "$UUID" 2>&1 || true

echo
echo "Installed to $EXT_DIR"
echo "On Wayland, log out and back in if the panel icon does not appear."
echo "Test without touching your session: ./ui-test.sh"

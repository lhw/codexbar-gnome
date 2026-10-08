# UI smoke test.
#
# Loads the extension into a headless GNOME Shell, waits for it to poll the
# CLI, then has a test-only companion extension print the popup menu's label
# tree to the shell log. That catches layout and null-property errors that unit
# tests cannot, and lets us assert on the exact strings the user sees.
#
# Usage: ./ui-test.sh [timeout-seconds]
# Set CODEXBAR_TEST_PRIMARY=<provider id> to exercise the primary-provider
# setting.

set -u
cd "$(dirname "$0")"

SECS="${1:-60}"
UUID="$(python3 -c "import json;print(json.load(open('metadata.json'))['uuid'])")"
DUMPER_UUID="codexbar-dumper@test"

EXT_ROOT="$HOME/.local/share/gnome-shell/extensions"

install_ext() {
  local src="$1" uuid="$2"
  rm -rf "$EXT_ROOT/$uuid"
  mkdir -p "$EXT_ROOT/$uuid"
  tar -C "$src" --exclude=.git --exclude='*.zip' --exclude=test -cf - . | tar -C "$EXT_ROOT/$uuid" -xf -
  if [ -d "$src/schemas" ]; then
    glib-compile-schemas "$EXT_ROOT/$uuid/schemas/" 2>/dev/null || true
  fi
}

install_ext . "$UUID"
install_ext test/dumper "$DUMPER_UUID"

# Enable the dumper first so its timer is already running when the target
# finishes its first poll.
ENABLE_DUMPER="gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.EnableExtension '$DUMPER_UUID' >/dev/null 2>&1"
ENABLE_TARGET="gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.EnableExtension '$UUID' >/dev/null 2>&1"
GET_ERRORS="gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.GetExtensionErrors '$UUID' 2>&1"

echo "Running $UUID in a headless shell (timeout ${SECS}s)..."

export CODEXBAR_DUMP_TARGET="$UUID"
export GSETTINGS_SCHEMA_DIR="$EXT_ROOT/$UUID/schemas"

# dconf is per-session, so a setting written outside the shell's session never
# reaches it. The keyfile backend is a plain file both processes can see.
#
# XDG_CONFIG_HOME must stay the real one: codexbar resolves its own config from
# it, and pointing it elsewhere silently reduces the fixture to one provider.
export GSETTINGS_BACKEND=keyfile
export GSETTINGS_BACKEND_KEYFILE="${GSETTINGS_BACKEND_KEYFILE:-/tmp/opencode/ui-test-settings}"

timeout "$SECS" dbus-run-session -- bash -c "
  gnome-shell --headless --wayland >/tmp/opencode/ui-shell.log 2>&1 &
  SHELL_PID=\$!
  sleep 9
  if [ -n \"\${CODEXBAR_TEST_PRIMARY:-}\" ]; then
    gsettings --schemadir '$GSETTINGS_SCHEMA_DIR' set org.gnome.shell.extensions.codexbar primary-provider \"\$CODEXBAR_TEST_PRIMARY\" 2>&1
  fi
  $ENABLE_DUMPER
  $ENABLE_TARGET
  sleep 22
  $GET_ERRORS
  kill \$SHELL_PID 2>/dev/null
" 2>&1 | grep -E "^\(" > /tmp/opencode/ui-errors.txt

echo "=== menu tree ==="
sed -n '/CODEXBAR-DUMP-START/,/CODEXBAR-DUMP-END/p' /tmp/opencode/ui-shell.log 2>/dev/null \
  | sed 's/^.*CODEXBAR-DUMP-START.*/CODEXBAR-DUMP-START/; s/^.*CODEXBAR-DUMP-END.*/CODEXBAR-DUMP-END/; s/^.*CODEXBAR-DUMP //' \
  | grep -vE "^$|libmutter|meta_monitor|meta_workspace"

if grep -q "CODEXBAR-DUMP-START" /tmp/opencode/ui-shell.log 2>/dev/null; then
  echo "dump captured"
else
  echo "NO DUMP CAPTURED"
  grep -iE "$UUID|CODEXBAR|CRITICAL|WARNING.*[Ee]xtension" /tmp/opencode/ui-shell.log 2>/dev/null | head -20
fi

echo "=== extension errors ==="
# An empty array means the shell loaded and enabled it cleanly.
ERRORS="$(grep -F '(@as [],)' /tmp/opencode/ui-errors.txt 2>/dev/null)"
if [ -n "$ERRORS" ]; then
  echo "clean"
else
  cat /tmp/opencode/ui-errors.txt 2>/dev/null || echo "(shell did not report)"
fi

# Shell log lines naming the extension, minus the mutter warnings that every
# headless run emits regardless of the extension.
echo "=== extension log lines ==="
grep -iE "$UUID" /tmp/opencode/ui-shell.log 2>/dev/null \
  | grep -viE "libmutter|meta_monitor|meta_workspace" | head -20

rm -rf "$EXT_ROOT/$DUMPER_UUID"
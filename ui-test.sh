# UI smoke test.
#
# Loads the extension into a headless GNOME Shell, waits for it to poll the
# CLI, then has a test-only companion extension print the popup menu's label
# tree to the shell log. That catches layout and null-property errors that unit
# tests cannot, and lets us assert on the exact strings the user sees.
#
# Usage: ./ui-test.sh [timeout-seconds]

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

# The test enables a throwaway companion extension over D-Bus and sets the
# primary-provider knob. Both write to the real dconf database: dbus-run-session
# gives a new bus but not a new dconf, and GSETTINGS_BACKEND=keyfile is not
# honoured by this GLib build. Snapshot both and restore them afterwards so a
# test run cannot leave anything behind.
SAVED_EXTENSIONS="$(gsettings get org.gnome.shell enabled-extensions)"

restore_state() {
  gsettings set org.gnome.shell enabled-extensions "$SAVED_EXTENSIONS" 2>/dev/null || true
}
trap restore_state EXIT INT TERM

timeout "$SECS" dbus-run-session -- bash -c "
  gnome-shell --headless --wayland >"${TMPDIR:-/tmp}/codexbar-ui-shell.log" 2>&1 &
  SHELL_PID=\$!
  sleep 9
  $ENABLE_DUMPER
  $ENABLE_TARGET
  sleep 22
  $GET_ERRORS
  # Must be a graceful TERM, and must happen well inside the timeout below. A
  # shell killed by SIGKILL writes \$XDG_RUNTIME_DIR/gnome-shell-disable-extensions,
  # which makes Ubuntu's org.gnome.Shell-disable-extensions.service turn off
  # every user extension at the next login.
  kill -TERM \$SHELL_PID 2>/dev/null
  wait \$SHELL_PID 2>/dev/null
" 2>&1 | grep -E "^\(" > "${TMPDIR:-/tmp}/codexbar-ui-errors.txt"

# Belt and braces: if the run was cut short by the timeout above, clear the flag
# GNOME Shell leaves behind so the user's next login is not affected.
DISABLE_FLAG="$XDG_RUNTIME_DIR/gnome-shell-disable-extensions"
if [ -e "$DISABLE_FLAG" ]; then
  echo "WARNING: cleared $DISABLE_FLAG left by an unclean shutdown" >&2
  rm -f "$DISABLE_FLAG"
  gsettings set org.gnome.shell disable-user-extensions false
fi

echo "=== menu tree ==="
sed -n '/CODEXBAR-DUMP-START/,/CODEXBAR-DUMP-END/p' "${TMPDIR:-/tmp}/codexbar-ui-shell.log" 2>/dev/null \
  | sed 's/^.*CODEXBAR-DUMP-START.*/CODEXBAR-DUMP-START/; s/^.*CODEXBAR-DUMP-END.*/CODEXBAR-DUMP-END/; s/^.*CODEXBAR-DUMP //' \
  | grep -vE "^$|libmutter|meta_monitor|meta_workspace"

if grep -q "CODEXBAR-DUMP-START" "${TMPDIR:-/tmp}/codexbar-ui-shell.log" 2>/dev/null; then
  echo "dump captured"
else
  echo "NO DUMP CAPTURED"
  grep -iE "$UUID|CODEXBAR|CRITICAL|WARNING.*[Ee]xtension" "${TMPDIR:-/tmp}/codexbar-ui-shell.log" 2>/dev/null | head -20
fi

echo "=== extension errors ==="
# dbus-run-session only relays its own diagnostics, so a JS error inside the shell
# process appears in the shell log and nowhere else. Scan both, or a thrown
# exception reads as a clean run.
ERRORS="$(cat "${TMPDIR:-/tmp}/codexbar-ui-errors.txt" "${TMPDIR:-/tmp}/codexbar-ui-shell.log" 2>/dev/null \
  | grep -E "JS ERROR|Extension ($UUID|$DUMPER_UUID):" \
  | grep -viE "libmutter|meta_monitor|meta_workspace" | head -20)"
if [ -z "$ERRORS" ] && grep -qF '(@as [],)' "${TMPDIR:-/tmp}/codexbar-ui-errors.txt"; then
  echo "clean"
else
  echo "$ERRORS"
fi

# Shell log lines naming the extension, minus the mutter warnings that every
# headless run emits regardless of the extension.
echo "=== extension log lines ==="
grep -iE "$UUID" "${TMPDIR:-/tmp}/codexbar-ui-shell.log" 2>/dev/null \
  | grep -viE "libmutter|meta_monitor|meta_workspace" | head -20

rm -rf "$EXT_ROOT/$DUMPER_UUID"

if [ -n "$ERRORS" ] || ! grep -q "ABOUT-CHECKS-PASSED" "${TMPDIR:-/tmp}/codexbar-ui-shell.log"; then
  echo "UI checks failed" >&2
  exit 1
fi

#!/bin/bash
# Package the extension.

set -e
cd "$(dirname "$0")"

UUID="$(python3 -c "import json;print(json.load(open('metadata.json'))['uuid'])")"

echo "Compiling schemas..."
glib-compile-schemas schemas/

echo "Running tests..."
for t in test-parse test-cost test-display test-links test-prefs test-cli; do
  result="$(gjs -m "test/$t.js" 2>&1 | sed 's/^Gjs-Console-Message: [0-9:.]* //' | tail -1)"
  echo "  $t: $result"
  case "$result" in
    *"0 failed") ;;
    *) echo "FAILED: $t"; exit 1 ;;
  esac
done

uv run --locked --directory browser-session python -m unittest discover -p 'test_*.py'

# Keep the helper runnable as a directory, without shipping its environment or tests.
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/codexbar-helper.XXXXXX")"
trap 'rm -r -- "$STAGING"' EXIT
mkdir "$STAGING/browser-session"
for source in browser-session/*.py; do
    case "$(basename "$source")" in test_*) continue ;; esac
    cp "$source" "$STAGING/browser-session/"
done
cp browser-session/pyproject.toml browser-session/uv.lock "$STAGING/browser-session/"

echo "Packing $UUID..."
gnome-extensions pack \
    --extra-source=extension.js \
    --extra-source=prefs.js \
    --extra-source=cli.js \
    --extra-source=parse.js \
    --extra-source=cost.js \
    --extra-source=links.js \
    --extra-source="$STAGING/browser-session/" \
    --extra-source=stylesheet.css \
    --extra-source=media/ \
    --force

echo "Packed ${UUID}.shell-extension.zip"

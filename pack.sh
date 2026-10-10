#!/bin/sh
# Builds the zip to upload at https://extensions.gnome.org (or to install with
# `gnome-extensions install --force <zip>`). Output: dist/<uuid>.shell-extension.zip
#
# Only what the extension needs at run time goes in: no tests, tools, docs, icons, notes,
# patches, git data or compiled schemas (GNOME Shell 45+ compiles the schema itself, and
# extensions.gnome.org rejects a bundled gschemas.compiled).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"

command -v zip >/dev/null 2>&1 || { echo "pack.sh: 'zip' is required" >&2; exit 1; }
uuid=$(python3 -c "import json;print(json.load(open('metadata.json'))['uuid'])")
out="dist/$uuid.shell-extension.zip"

# The schema must be valid before anything is shipped.
if command -v glib-compile-schemas >/dev/null 2>&1; then
    glib-compile-schemas --strict --dry-run schemas
else
    echo "pack.sh: glib-compile-schemas not found, schema not validated" >&2
fi

for f in extension.js prefs.js metadata.json; do
    [ -f "$f" ] || { echo "pack.sh: missing $f" >&2; exit 1; }
done

mkdir -p dist
rm -f "$out"

# Every top-level file and folder except the development ones listed here.
set --
for entry in * ; do
    case "$entry" in
        dist|tests|tools|icons|pack.sh|install.sh|*.md|*.zip|*.tar.*|*.patch|log.txt|node_modules) continue ;;
    esac
    set -- "$@" "$entry"
done
zip -q -r -X "$out" "$@" -x '*/.*' '*.patch' '*/gschemas.compiled' 'gschemas.compiled'

# EGO accepts at most 5 MB.
bytes=$(wc -c < "$out")
if [ "$bytes" -gt 5242880 ]; then
    echo "pack.sh: $out is $bytes bytes, extensions.gnome.org accepts at most 5 MB" >&2
    exit 1
fi

echo "Created $out ($bytes bytes)"
unzip -l "$out" 2>/dev/null | tail -n 1 || true

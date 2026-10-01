#!/bin/sh
# Installs this folder as ~/.local/share/gnome-shell/extensions/<uuid>
set -e
here=$(cd "$(dirname "$0")" && pwd)
uuid=$(python3 -c "import json,sys;print(json.load(open('$here/metadata.json'))['uuid'])")
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"
mkdir -p "$dest"
cp -r "$here"/. "$dest"/
rm -rf "$dest/tests" "$dest/tools" "$dest/install.sh" "$dest/gschemas.compiled"
glib-compile-schemas "$dest/schemas"
echo "Installed to $dest. Log out/in (Wayland), then: gnome-extensions enable $uuid"

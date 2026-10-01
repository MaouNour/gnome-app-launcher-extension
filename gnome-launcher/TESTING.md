# Testing

## Automated (no GNOME needed)

```sh
node tests/run.mjs          # 35 tests: search, frecency, themes, validation, sanitizers
node tools/bench.mjs 20000  # search latency (use `gjs -m tools/bench.mjs` for SpiderMonkey numbers)
glib-compile-schemas --strict --dry-run schemas
```

## On-device checklist (requires GNOME Shell)

Watch logs while testing: `journalctl -f -o cat /usr/bin/gnome-shell` (enable *Advanced > Verbose logging*).
Nested session for safe iteration: `dbus-run-session gnome-shell --nested --wayland` (older) or `--devkit` (newer).

| Area | Steps | Expected |
|---|---|---|
| Enable/disable | `gnome-extensions disable/enable` 10x | No errors, no leftover overlay, shortcut works after each enable |
| Re-login | Log out/in | Launcher opens instantly, results present on first open |
| Shortcut | Change in prefs, test; set a conflicting one | New shortcut works immediately; conflict flagged in prefs and notified |
| App launch | Launch several apps, one already running | Focus or launch; failures notify and re-sync the index |
| Custom commands | Add valid, missing-binary, bad-quote, disabled entries | Valid runs; broken show a notification; disabled hidden; nothing crashes |
| Actions | One of each type incl. `gnome` actions | Each behaves; bad URL scheme rejected |
| Search | Prefix, initials (`vsc`), fuzzy (`ffx`), accents, two tokens, keyword | Ranked sensibly |
| Cache rebuild | Delete `~/.cache/gnome-launcher/apps.json`; write garbage into it; install/remove an app | Rebuilds silently; list updates within ~1 s |
| Themes | Switch built-ins; create/export/import custom; toggle GNOME dark mode with *Follow GNOME* | Applies live; dark/light switches live |
| Prefs changes | Change every Appearance control while the launcher is closed and open | Applied without reload |
| Missing icons | Entry with a bogus icon name/path | Falls back to a generic icon |
| Many entries | Import ~2000 generated commands | Typing stays instant; scrolling smooth |
| Transparency/blur | Opacity 0.5; blur 30 on a busy wallpaper | Translucent; blur applied or one logged warning |
| Rapid toggling | Hold the shortcut / spam it | No stuck overlay, input always returns to the desktop |
| Idle cost | `top`/`gnome-shell` CPU with launcher closed | No wakeups attributable to the extension |

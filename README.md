# GNOME Launcher

Owner/maintainer: **maou-nournar** (extension UUID `gnome-launcher@maou-nournar`).

A fast, lightweight, highly customizable launcher for GNOME Shell, inspired by Lightbar and Vicinae.
Fuzzy search over applications, your own commands and actions, with themes, transparency and optional blur.

**Status: 0.1.0, not yet verified inside a live GNOME Shell.** The pure modules (search, themes, validation) are
unit-tested under node; the Shell/GTK-facing code was only syntax-checked. See `TESTING.md` for the on-device checklist.

## Install

```sh
mkdir -p ~/.local/share/gnome-shell/extensions/gnome-launcher@maou-nournar
tar xzf gnome-launcher.tar.gz --strip-components=1 -C ~/.local/share/gnome-shell/extensions/gnome-launcher@maou-nournar
glib-compile-schemas ~/.local/share/gnome-shell/extensions/gnome-launcher@maou-nournar/schemas   # harmless on newer GNOME
# Log out and back in (Wayland), then:
gnome-extensions enable gnome-launcher@maou-nournar
gnome-extensions prefs gnome-launcher@maou-nournar
```

The directory name must equal the UUID (`gnome-launcher@maou-nournar`). Default shortcut: **Ctrl+Alt+Space**
(change it in *Keyboard Shortcuts*; known GNOME conflicts are flagged there).

## Compatibility

| | |
|---|---|
| Target | GNOME Shell 46-50 (ESM extensions, `metadata.json` declares 46-50; versions beyond what you run are unverified) |
| GJS | The version shipped with those Shell releases (ES modules, `Gio._promisify`) |
| Required | Nothing beyond GNOME Shell, GLib/Gio, Clutter, St, libadwaita (prefs) |
| Optional | `gnome-session-quit`, `systemctl`, `gnome-control-center` for the matching built-in GNOME actions |
| Mutter/Shell dependent | Blur (`Shell.BlurEffect`), bare-Super activation (`overlay-key`), per-entry shortcuts (`grab_accelerator`) |

Version-specific code is isolated: blur in `ui/launcher.js#_applyBlur`, key handling in `shortcuts/keybindings.js`,
Shell-only APIs in `commands/runner.js` (`GNOME` table).

## Architecture

```
extension.js          wiring, lifecycle, config-change dispatch (no heavy work in enable())
prefs.js, prefs/      Adw preferences (widgets.js: rows, shortcut capture, list editor; pages.js: pages)
config/config.js      typed GSettings wrapper + parsed-JSON cache
ui/launcher.js        modal overlay, entry, pooled rows, animation, blur
ui/style.js           layout + theme -> St CSS strings (computed on change only)
themes/themes.js      pure: theme schema, sanitizer, built-ins, resolver
search/engine.js      pure: ranking, fuzzy, narrowing, frecency
applications/         appIndex.js (cache + incremental diff + monitor), launch.js
commands/             schema.js (pure validation), userEntries.js (pure), runner.js (execution)
cache/                store.js (atomic versioned JSON), stats.js (usage counts)
shortcuts/            keybindings.js
utils/                log.js, timing.js (cancellable debounce/idle)
tools/bench.mjs, tests/run.mjs   node-runnable benchmark and unit tests
```

Key decisions:

- **Event-driven only.** No polling. App changes come from `Gio.AppInfoMonitor` (debounced); theme changes from `org.gnome.desktop.interface`; everything else from GSettings signals.
- **Cache flow.** Login: cached app list loads asynchronously, then a low-priority diff against installed apps updates only changed records and rewrites the cache only if something changed. Corrupt/outdated cache files are discarded and rebuilt; invalid records are dropped individually.
- **Search runs on in-memory, pre-folded strings.** Appending characters rescans only the previous matches. Benchmarks (node/V8, 20,000 synthetic entries): about 10 ms cold worst case, about 3 ms per keystroke while typing. A real install has a few hundred entries.
- **UI objects are reused.** One window, one entry, a pool of rows created on demand; hidden when closed (no painting, no timers).
- **Settings are JSON strings in GSettings** for commands, actions, themes and overrides, validated and sanitized on every load. Imports go through the same sanitizers.

## Features and where to configure them

Everything is under the extension's preferences: General, Appearance (size, position, search bar placement, typography,
colours, radius, border, shadow, blur, opacity, animation, overall scale), Themes (light/dark auto-switching, custom
themes, JSON import/export), Keyboard Shortcuts, Applications (default icons by category), Commands, Custom Actions,
Search, Performance (cache tools), Advanced.

Keys while open: Up/Down, Ctrl+N/P/J/K, Tab/Shift+Tab, PageUp/PageDown, Enter, Alt+1..9, Esc (leaves a sub-view first, then closes), Backspace on an empty sub-view search goes back.

### Built-in entries (Preferences > Built-in Entries)

Shut Down, Restart, Log Out (these use GNOME's own confirmation dialog), Suspend, Lock Screen, Take Screenshot, Show Overview,
Show All Apps, Toggle Dark Mode, Toggle Do Not Disturb, **Clipboard History** and **Clear Clipboard History**. Each can be disabled and given
a *global shortcut* (works anywhere) and/or a *window shortcut* (only while the launcher is open, never grabbed globally, must include Ctrl/Alt/Super).
Commands and custom actions have the same two shortcut fields. A global shortcut on *Clipboard History* opens the launcher directly in that view.

- **Clipboard history** is text only, kept in memory (never written to disk), updated by Mutter's selection-changed signal (no polling). Disable it or clear it from the prefs or the launcher.
- **Quick calculator**: type `12*(3+4)`; Enter copies the result. Uses a small parser, never `eval`.

### Pointer outside the window

General > *Pointer outside the window*: close on click (default), close when the pointer leaves the window (arms after the pointer has entered once), or never (keyboard only).

## Security model

- Entries are labelled **App / Command / Action** in the list so user-defined items are distinguishable from installed apps.
- **Commands** run as an argument vector (shell-style quoting is parsed, but no shell is started), so search text and
  arguments cannot inject shell syntax. Executables and paths are checked before launch.
- Only an explicit **shell** action uses `/bin/sh -c`, exactly as the user wrote it.
- URL actions are limited to `http(s)`, `ftp` and `mailto`. Theme values are validated before reaching any CSS string.
- Nothing needs root; the launcher never executes search results, only entries from the index.

## Known limitations

- **Blur** uses `Shell.BlurEffect` (background blur). If unavailable or constructed differently on your version, the
  launcher logs once and keeps working with transparency only. The blurred region is rectangular, so a large window
  corner radius shows square blur corners; use a small radius with blur.
- **Bare Super**: turning the option on runs the equivalent of `gsettings set org.gnome.mutter overlay-key ''` and the launcher detects the Super press itself; turning it off or disabling the extension runs `gsettings reset org.gnome.mutter overlay-key`. If the shell crashes while it is on, run that reset command yourself (a custom overlay-key you had set is not preserved).
- Shortcut conflict detection in prefs covers GNOME's own keybinding schemas only, not other extensions or apps.
- The theme drop-downs list themes at the time the preferences window opens.
- Fonts: only family and weight (no italics); custom icons are theme names or file paths (no embedded images).
- Per-entry shortcuts use `grab_accelerator`; a rejected accelerator is reported once as a notification.
- Ranking uses launch counts with time decay, not per-query learning.

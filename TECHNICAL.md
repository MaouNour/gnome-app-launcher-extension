# Technical notes

## 0.4.4: clipboard on disk, linked files, `!command`

Not touched: `_place()`, overlay/box layout, blur, animations.

### New files
| File | Purpose |
|---|---|
| `clipboard/persist.js` (pure JS) | Rules and validation: `serializeItems`/`reviveItems` (index format, rejects malformed or hostile entries: copies must match `img-<sha256>.<ext>`, links must be absolute, only `video` files), `linkCandidates` (same-size images saved within 20 s), `watchedSelections(source)`, `isSecret`, name helpers, `fileLabels`. |
| `commands/exec.js` (pure JS) | `parseExec(query, prefix)` for the run-a-command prefix. |

### `clipboard/history.js` (rewritten)
- **Source:** `clipboard-source` = `clipboard | primary | both | own`. One `owner-changed` handler is connected only when something is watched; CLIPBOARD (120 ms debounce) and PRIMARY (500 ms, text of 2+ characters only). `own` connects nothing; `captureNow()` (built-in "Save Clipboard to History") and `noteCopied(text)` (calculator/entry copies) feed it.
- **Disk:** index `history.json` (`{v:1, items}`) plus image copies `img-<sha256>.<ext>` in the history folder (default `$XDG_DATA_HOME/gnome-launcher/clipboard`). Dir created 0700, files written with `FileCreateFlags.PRIVATE` (0600), replace-destination (atomic). Saves are debounced (1.2 s) and async; a synchronous flush runs in `stop()`/`destroy()`. Loaded asynchronously at start and merged with anything already captured (deduplicated). Orphaned `img-*` copies are removed on load. Missing files drop their entries. Turning persistence off reads copies back into memory and deletes `history.json` and `img-*`; changing the folder copies image files over.
- **Linking:** a new image is kept in memory first, then `_resolveImage` looks for its source file at 0 s, 1.5 s and 4 s (the file may be written after the clipboard is set): list the folder (async, batched), pick candidates by size and mtime, confirm with a SHA-256 of the file contents. A match stores `{path, linked: true}` and drops the bytes; otherwise a copy is written (if saving is on and the size limit allows). `_discard` deletes only our own copies (`!linked` and `isCopyName`).
- **Recordings:** `Gio.File.monitor_directory` on the recordings folder; `CHANGES_DONE_HINT`/`MOVED_IN`/`RENAMED` for video extensions add a `file` item (size from `query_info`). If the folder does not exist yet it is retried when the launcher opens (`ensureWatching`).
- **Using an item:** `useItem(id, how)`: images go back as their image mime (read from the file when linked), videos as `text/uri-list`; `ctrl` opens via the default app, `alt` opens the folder. A missing file removes the entry and notifies.
- Secrets: items with `x-kde-passwordManagerHint` are skipped.

### Other files
| File | Change |
|---|---|
| `schemas/...gschema.xml` | New keys: `clipboard-source`, `clipboard-persist`, `clipboard-dir`, `clipboard-link-files`, `clipboard-screenshot-dir`, `clipboard-videos`, `clipboard-video-dir`, `exec-prefix` (`!`), `exec-shell` (true). |
| `extension.js` | Passes `{openUri, notify}` to the history; `_syncClipboardOptions()` on enable and when those keys change; `clipimage`/`clipfile` activation passes the modifier; `clip`/`calc` copies call `noteCopied`; `onOpen` calls `ensureWatching`; `!command` handled in `_search` (before the launcher's own keyword) and `exec` kind in `_activate` (no frecency); runner hook `saveClipboard`. |
| `commands/runner.js` | `exec` kind: `/bin/sh -c` or a shell-split argv, cwd = home, no pipes captured (nothing can block on output), one notification on non-zero exit. `spawn` now uses `wait_async` and reports the status. `save-clipboard` target. |
| `commands/builtins.js` | New entry "Save Clipboard to History". |
| `ui/launcher.js` | Tag labels for `clipfile` and `exec`. |
| `prefs/pages.js` | Built-in Entries page: "Clipboard history" group with all options; Search page: "Run commands" group. |
| `tests/run.mjs`, `TESTING.md` | 9 new tests (index round trip and rejection, copy names, link candidates, recordings, source selection, secrets, `!` parsing, linked files are never deleted). 108 pass. |

### Not verified
Only the pure logic is covered by tests; the GNOME-side code (selection signals, file monitor, async file I/O, GJS signatures) was syntax-checked but not run in a live Shell. Check: copy text, restart the shell (log out/in on Wayland) and reopen history; take a screenshot with Print and look for "linked: <file name>"; record a screencast; try `!echo hi > /tmp/x`, `!nonexistent` and a failing command; switch the source to primary and select some text.

### Not included
Running a command in a terminal, command output in the launcher, copying a file from the file manager as a file entry (it stays a text entry), and a screenshots-folder monitor (screenshots are linked through the clipboard only).

## 0.4.3: Escape, Launcher Settings, more animation styles

Nothing here touches `_place()`, the overlay/box layout or blur; `_place()` is byte-identical to 0.4.1.

| File | Change |
|---|---|
| `ui/launcher.js` `_onKey` | Escape: `if (!this.exitMode()) this.close();` -> `this.close();`. Backspace on an empty field still calls `exitMode()`. |
| `commands/builtins.js` | New system entry `launcher-settings` (target `launcher-settings`, default window shortcut `<Control>i`). `windowShortcut: ''` is kept in the overrides only where the entry ships a default, meaning "cleared"; the default is used when no override exists. |
| `commands/runner.js` | `target === 'launcher-settings'` calls the `openPrefs` hook. |
| `extension.js` | Runner hook `openPrefs: () => this.openPreferences()`. |
| `prefs/pages.js` | Built-in store keeps `''` for entries with a shipped window-shortcut default; the shortcut row falls back to that default. |
| `ui/launcher.js` `ANIMS` + `_animate` | Table of animations (scale, vertical offset, easing for open/close) replaces the inline `fade-scale`/`slide` conditions; adds `pop`, `drop`, `rise`. The offset is a transform (`translation_y`), the layout position is not changed. Unknown values fall back to `fade-scale`. |
| `prefs/pages.js` | Animation Style combo lists the three new styles. Schema default unchanged (`fade-scale`). |
| `tests/run.mjs` | Window-shortcut assertions filtered by id (the new entry adds one); new tests for Launcher Settings, offered animation styles, and Escape. 99 pass. |
| `metadata.json`, `TESTING.md` | 0.4.3, test count 99. |

Not ported: theme `anim`/`animMs` ("Follow the theme" animation), divider, brightness, blur and shadow layering.
Not run in GNOME Shell: check Escape from the emoji view, Ctrl+I, typing "settings" and Enter, and each animation.

## 0.4.2: selective port onto 0.4.1

Base: the uploaded 0.4.1 tree. Ported from the 0.5.x tree only the items below. `ui/launcher.js` positioning,
blur, animation and the overlay/box layout are exactly as in 0.4.1.

### Highlight fix: `ui/launcher.js`
Cause: `_render()` did `this._sel = -1` and then `_select(0)`. That forgot the index but never cleared the
painted state of the old row/cell, so it stayed highlighted (also when switching between list and grid).

| Where | Change |
|---|---|
| constructor | new `this._selItem = null` (the item currently painted as selected) |
| `_clearSel()` (new) | `this._selItem?.setSelected(false); this._selItem = null; this._sel = -1;` |
| `_render()` | `this._sel = -1` -> `this._clearSel()` |
| `_select(i)` | un-highlights `this._selItem` (not `_item(this._sel)`, which could point at another actor after a view change); stores `this._selItem = row` after `setSelected(true)` |
| close `done()` in `_animate` | calls `_clearSel()` before `_trimPool()` |
| `_trimPool()` | calls `_clearSel()` first, so no `setSelected` runs on an actor that is about to be destroyed; the old trailing `this._sel = -1` is removed |
| `destroy()` | `this._selItem = null` |

### Blocklist (apps + fullscreen)
- `shortcuts/blocklist.js` (new, pure JS): `compileBlocklist(list)` -> `{size, test(names)}`, case-insensitive,
  `.desktop` suffix ignored, `*`/`?` wildcards, dots literal; `normalizeBlockEntry()`.
- `shortcuts/keybindings.js`: `setBlocked(bool)`. The main binding and the per-entry grabs remember their
  arguments (`_mainArgs`, `_customArgs`) so they can be removed when blocked and put back afterwards;
  `clearMain()` / `clearCustom()` also forget them. Window-level handlers return early while blocked.
- `extension.js`: `_syncBlocklist()` compiles the list, and connects `global.display` `notify::focus-window`
  only while the feature is configured; `_checkFocus()` watches the focused window's `notify::fullscreen` only
  when the fullscreen switch is on; `_isBlocked(win)` compares wm class, instance, GTK app id, sandboxed app id,
  and the Shell app's id/name. Handled in `_onSetting` for keys `blocklist` and `block-fullscreen`; focus
  watching is removed in `disable()` via `_unwatchFocus()`. Added `import Shell`. The `openPrefs` hook of 0.5.x
  was left out.
- `schemas/...gschema.xml`: new keys `blocklist` (`as`, `[]`) and `block-fullscreen` (`b`, `false`), inside the
  `<schema>` element. Validated with `glib-compile-schemas --strict --dry-run`.
- `prefs/pages.js`: new `blocklistGroup(window, settings)` (text entry, installed-app picker, removable rows,
  fullscreen switch) added to `shortcuts(window, settings)`. Added `import GLib` and the blocklist import.
  The call passes both arguments (the 0.5.0 "settings is undefined" crash was a one-argument call).

### Regex help
- `prefs/widgets.js`: `REGEX_HELP` text and `regexHelpButton()` (info button with a scrollable popover). The
  generic text-field builder adds it as a suffix when a field has `help: 'regex'`.
- `commands/schema.js`: both `keywords` fields get the new label and `help: 'regex'`.
- `prefs/pages.js` Search page: description mentions per-entry regex keywords; `rx.set_header_suffix(regexHelpButton())`.

### Themes (colours only): `themes/themes.js`
Added colour-scheme entries `nord-light`, `solarized-dark`, `catppuccin-latte`, `catppuccin-mocha`, `tokyo-day`,
`tokyo-night`, `gruvbox-light`, `gruvbox-dark`, `rose-pine-dawn`, `rose-pine` (existing `nord` and
`solarized-light` untouched) and quick-preset families Nord, Solarized, Catppuccin, Tokyo Night, Gruvbox,
Rosé Pine. No new theme fields (no divider, brightness or animation keys); the preferences still show a
single "Quick preset" row.

### Tests / housekeeping
- `tests/run.mjs`: built-in theme count 9 -> 19; new tests for preset families, blocklist matching and the
  argument-count check of `prefs/pages.js` functions. 96 pass.
- `metadata.json` 0.4.1 -> 0.4.2; `TESTING.md` count 92 -> 96; `CHANGELOG.md`, `TECHNICAL.md` added.

### Not run
Nothing here was run inside GNOME Shell. Check on device: open prefs and the Keyboard Shortcuts page; add a
blocklist entry for an app, focus it and confirm the shortcut reaches the app; type searches and arrow through
results to confirm only one row is highlighted; apply Tokyo Night.

# Technical notes

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

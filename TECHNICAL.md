# Technical notes

## 0.5.0: blur rebuilt on Blur my Shell

Window position/layout code is unchanged. Only how the blur is attached changed.

### Why the old blur glitched
`_attachBlur` added `Shell.BlurEffect` to the window box itself and removed it before/after every animation. An effect on an actor makes Clutter paint that actor and all its children into a separate buffer; combined with sampling the backdrop while the window was scaling or fading, it produced flicker.

### New structure (as in Blur my Shell's application blur)
- `blur/blur.js` `LauncherBlur`: creates an empty `St.Widget` ("blur actor") inserted **below** the window box in the overlay (`insert_child_below`). The window keeps its own translucent background on top.
  - **dynamic:** the actor gets `NativeDynamicBlurEffect` (`BlurEffect` in `BACKGROUND` mode; radius = 2 x sigma x display scale; brightness; corner radius). Its alignment and margins copy the window's, and its size follows the window's allocation (`notify::allocation`, applied in an idle callback so no actor is resized during an allocation). With "keep repainting" on, a `PaintSignals` effect re-queues the blur repaint when the actor is painted (BMS hacks level 1).
  - **static:** a monitor-sized actor with a `Background.BackgroundManager` (wallpaper, `controlPosition: false`), the pipeline's effects, `set_clip()` to the window rectangle, and a pivot at the window's centre so scaling matches.
  - Animation: `set/ease/removeTransitions` mirror the window's opacity, scale and translation, so the blur is never "off" while the window animates. A blur created while the window is showing copies the window's current look first.
  - A failed build is remembered for that configuration and not retried on every style update (warns once).
  - `destroy()` runs before the overlay is destroyed.
- `blur/pipeline.js`: builds a pipeline's effects on an actor from an `EffectsManager` (recycling, reverse order, `corner` radius optionally taken from the theme).
- `blur/effects_manager.js`, `connections.js`, `paint_signals.js`, `utils.js`: from BMS (log prefix / import paths changed).
- `blur/effects/*.js, *.glsl`: all BMS effects (native static/dynamic, gaussian, Monte Carlo, color, luminosity, noise, pixelize, derivative, downscale, upscale, rgb_to_hsl, hsl_to_rgb, corner). `native_dynamic_gaussian_blur.js` additionally stores the unscaled corner radius (BMS leaves it undefined, so a scale change would give NaN). `registry.js` maps type -> class.
- `blur/defs.js` (pure): effect names, descriptions, editable parameters and defaults for the preferences (extracted from BMS `effects.js`), groups, default pipelines, `cleanParams`/`sanitizePipelines` (clamping, unknown keys and types dropped, duplicate ids renamed, defaults always present), `resolveBlur` (settings -> which blur to build).
- `ui/launcher.js`: `_applyBlur(st, mon)` computes the spec with `resolveBlur` and loads `blur/blur.js` with a dynamic `import()` the first time it is needed (a failure only logs). `_attachBlur/_detachBlur` and the `gl-blur` effect on the box are gone. `_animate` drives the blur with the window. `_place` tells the blur which monitor. New `_monitor()` helper.
- `ui/style.js`: exposes `radius` (the theme's window radius) for the blur's corners.
- `schemas`: `blur-mode` (theme|dynamic|static|off, default theme), `blur-sigma`, `blur-brightness`, `blur-corner-auto`, `blur-corner-radius`, `blur-repaint`, `blur-pipeline`, `blur-pipelines` (JSON). `extension.js`: these keys restyle the launcher.
- `prefs/blur.js` (new Blur page) registered in `prefs/pages.js`.
- Default behaviour is unchanged: mode "theme" uses each theme's own blur strength like before.

### Tests (115)
Effects/registry/shaders/defaults consistent; parameter cleaning; pipeline validation; blur mode resolution; schema default pipelines match the code; `blur/blur.js` only loaded dynamically and no effect on the window box; license notice present.

### Not verified
No GNOME Shell was available: GJS/Shell-side code (`blur/blur.js`, effects, shaders, the page) is syntax-checked only. Check: blur with a window behind the launcher while opening/closing; each mode; change strength live; a static pipeline with a Corner effect; a display-scale change; disabling blur.

### Known limits
- Static mode shows the wallpaper only (it does not blur windows behind). Dynamic mode does.
- Rounded dynamic blur depends on the Shell's blur supporting `corner_radius`; otherwise it stays rectangular.
- The effect parameter set is BMS's; shader compile errors are logged by the Shell.

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

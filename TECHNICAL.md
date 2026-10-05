# Technical notes

## 0.6.0: click fix, blur removed, running marker, action menu, file search

### Click regression from 0.5.3
`ui/launcher.js` computed `HAS_RELEASE`/`HAS_MOTION` with `GObject.signal_lookup(name, Clutter.Actor)`; it returned 0 (the second argument is a GType, not a class), so `onPrimaryClick` connected no `button-release-event` handler and no row reacted. Now `tryConnect(actor, signal, fn)` wraps `actor.connect` in try/catch and every path is attempted on its own: `Clutter.ClickGesture` (when the class exists, in its own try/catch) and `button-release-event`; `_clicked` still ignores a repeat within 400 ms and clicks while the window is closing. The overlay press/motion handlers use `tryConnect` too. The `ClickGesture(recognize_on_press)` on the overlay was removed (it sat above every row and was a risk with no benefit; the press handler already closes on an outside click). If clicks still fail, `dbg('click on result N')` shows whether any arrive.

### Blur removed
Deleted `blur/` (effects, shaders, manager, pipeline, license and notice), `prefs/blur.js`, the `blur-*` schema keys, the theme `blur` field, `style.js` `blur`/`radius` outputs, `Launcher._applyBlur` and every blur call in `_animate`, `_place`, `destroy`, the blur tests and docs. `_animate` is back to a single `box.ease(...)`. Shadow remains (`shadow-enabled`, default false; `buildStyles` only emits `box-shadow` when `layout.shadow` is true and the theme has opacity).

### Identity (`ui/identity.js`)
`WM_CLASS = 'gnome-launcher'`, `APP_ID`/`SCHEMA_ID = 'org.gnome.shell.extensions.gnome-launcher'`, `UUID`. The overlay has name `gnome-launcher-overlay`, style class `gnome-launcher-overlay`; the window box has `name: 'gnome-launcher'`, style classes `gnome-launcher gnome-launcher-window gnome-launcher org-gnome-shell-extensions-gnome-launcher` and accessible name "GNOME Launcher". **Limit:** Blur my Shell's Applications component (`components/applications.js`) only handles `Meta.WindowActor`s and matches `meta_window.get_wm_class()`; a Shell actor never appears there and has no window class, so no value set on this actor can make it selectable in Blur my Shell today. A Blur my Shell component that finds an actor in `Main.uiGroup` by name (like its `dash_to_dock.js`) would be needed.

### Running marker
`ui/accent.js` (pure): `activeColor({mode, custom, system, theme})` with the GNOME accent names mapped to libadwaita colours and fallbacks. `extension._activeColor` reads `org.gnome.desktop.interface accent-color` only if the key exists and restyles on `changed::accent-color`. `style.js` outputs `active`/`activeSel` (dot 6x6 or dash 14x3, scaled), `activeOn`, `activeAfter`. `Row` has a `mark` widget moved before the icon or before the tag; `Row.set(entry, fav, running)`; `Launcher._isRunning` compares `entry.payload.appId` with `Shell.AppSystem.get_running()` ids (callback `running`, read on each `_refresh`).

### Action menu
Launcher: setting `action-menu` (false). Ctrl+B / right click -> `_openMenu(i)` (main search only) -> `onMenu(entry)` returns `{placeholder}` and the launcher enters mode `actions`; `leaveMenu()` restores the earlier text and selection; Escape and Backspace-on-empty call it. Ctrl+H, Ctrl+F and Ctrl+D return PROPAGATE while the menu is on, Ctrl+B while it is off. Extension: `_menuInfo/_menuItems/_menuSearch/_runMenu`; item kinds `menu` (not recorded as searches). `applications/launch.js` gained `launchApp(id, {newWindow})`, `launchAppAction`, `describeApp` (desktop file, command line, actions, running state), `quitApp`, `editFile`; runner kinds `appaction` and `file`; `Stats.forget(id)`. New workspace: `global.workspace_manager.append_new_workspace(true, time)` then a new window of the app.

### File search
`files/results.js` (pure): terms, backend choice, `locate` arguments (`-i -b -A -e -l N --`), URI parsing, path filtering (home only, no hidden, no pseudo file systems unless allowed), labels. `files/search.js`: `FileSearch` finds GNOME's provider from `org.gnome.Nautilus.search-provider.ini` (BusName/ObjectPath), calls `org.gnome.Shell.SearchProvider2.GetInitialResultSet` over D-Bus (4 s timeout, cancellable), or runs `plocate/locate/mlocate` with `Gio.Subprocess` (cancellable, output bounded by `-l 400`). Nothing is written to disk. Extension: `_wantFiles(query)` (debounced 250 ms, once per query via `_filesFor`), `_runFiles`, `_fileEntry`, `_openFile`; `Launcher.addAsyncResults(query, entries)` merges the late results before a web fallback and ignores them if the text changed. Keys: `files-enabled` (false), `files-backend` (auto), `files-min-chars` (3), `files-max` (8), `files-hidden` (false), `files-outside-home` (false). Prefs show which backends exist (same lookups).

### Tests (130)
Click wiring without up-front signal guesses; blur really gone; identity names and schema id; file-result helpers; file search off by default and write-free; action menu key rules and operations; shadow off by default and marker styles; accent colour fallbacks.

### Not verified
No GNOME Shell was available; Shell/Clutter/D-Bus code is syntax-checked only. Check: clicks and taps on rows and emoji cells; Ctrl+B menu items (new workspace especially); a file search with GNOME and with locate; the dot colour with different accents; the shadow switch.

## 0.5.3: click/tap fix and favorites

### Click / tap / touch (`ui/launcher.js`)
Reported: with a mouse or touchpad (tap to click; the physical touchpad button worked) choosing an entry hides the
launcher and then shows it as if it were opening again. **Not reproduced** (no Shell here), so this is a fix for the most
likely cause, not a confirmed one.
- Finding: rows and cells connected only `button-release-event` and `motion-event`; the overlay used
  `button-press-event`. The current GNOME Shell (`popupMenu.js`, `search.js` in the main branch) uses
  `Clutter.ClickGesture`, `Clutter.KeyController` and `Clutter.MotionController` instead of those signals, so on
  Shells with the gesture-based input a tap can be consumed by a gesture and never reach the button handlers.
- Now: `onPrimaryClick(actor, fn)` adds a `Clutter.ClickGesture` (`recognize`, primary button) when the class exists
  and also the `button-release-event` handler when that signal exists (`GObject.signal_lookup`). Both call
  `Launcher._clicked(i)`, which ignores clicks unless the state is `open`/`opening`, ignores a second click within
  400 ms (the same tap reported twice) and logs `click on result N` in debug mode. `onPointerOver` uses
  `motion-event` where present, else `notify::hover` (ignored for 300 ms after a key press, so keyboard scrolling does
  not move the selection). The overlay also has a `ClickGesture(recognize_on_press)` whose `may-recognize` accepts only
  presses outside the window (same pattern as `PopupMenuManager`), closing it when "outside click" is selected.
- If it still happens: turn on *Advanced > Verbose logging*, reproduce, and send
  `journalctl -f -o cat /usr/bin/gnome-shell`; also the GNOME Shell version (`gnome-shell --version`), Wayland or X11,
  and whether the click was a button press or a tap. The log shows whether a click was received, how many times, and
  whether the window was opened again.

### Favorites
| Where | Change |
|---|---|
| schema | `favorites-enabled` (true), `favorites` (JSON `[{id, name}]`) |
| `search/engine.js` `_initial(..., favorites)` | favorites (ids in order, skipping unknown/hidden ones) first and always all shown; the rest of `count` is recent/frequent/alphabetical without duplicates; `count` smaller than the number of favorites returns only favorites |
| `extension.js` | `_favoriteList/_favoriteIds/_toggleFavorite` (same eligible kinds as hiding), start list gets `favorites`, `favorites*` keys call `launcher.refreshResults()` |
| `ui/launcher.js` | Ctrl+D -> `_favoriteSelected`; `refreshResults()` re-runs the search and keeps the selection on the same entry; list rows show a star (`Row.set(entry, fav)`) |
| `prefs/pages.js` | `entryListGroup` shared by *Hidden entries* and *Favorites* (Remove / Remove all); switch in *When the launcher opens* |

### Tests
129 pass: favorites ordering, favorites wiring, click/tap wiring (both paths, once, not while closing, outside press).

## 0.5.2: emoji sections, grid fix, recent start list, search history

### Grid fix (`ui/launcher.js`)
Cause: `_render()` created `_chunk()` = 6 lines of cells and nothing more, while the list height is
`min(content, maxListH)`. A window taller than 6 lines showed empty space until the selection moved (which calls
`_grow`) or the list scrolled. Now the height is computed first and `_grow(max(chunk, _fillCount(h)))` creates enough
lines to fill it plus 3 lines (list view: rows, same rule).

### Grid layout in lines (`ui/launcher.js`, `ui/style.js`)
- `_layoutGrid()` turns the results into `_lines` `[{base, count, header}]`, `_tops` (top of each line in CSS px, header
  included), and `_secs` (section bounds). `_sections` comes from the search result array (`results._sections =
  [{title, count}]`); without it the grid is one block. A section starts on a new line with its title above.
- `GridRow` is now a vertical box: a header (`St.Bin` with a label, fixed height `sectionH`) and the line of cells;
  `set(results, line)` fills cells up to `line.count` and hides the others.
- `_gridPos(i)` -> `{line, col}`; `_item`, `_grow`, `_scrollToSelected` (from the top of the line incl. its title to the
  bottom of its cells), `_onScrolled` and the new `_moveLines(d)` (Up/Down/Page keys) use it. Replaces the fixed
  `floor(i / cols)` arithmetic. `style.js` adds `sectionTitle` and `sectionH`.

### Emoji sections (`extension.js`)
`_emojiMode(query)`: only for an empty query in the grid layout with `emoji-recent` on and at least one emoji used:
recent = stats entries that exist in the emoji engine, newest `stat[1]` first, `emoji-recent-count` of them; all = natural
order, no frecency. Result `[...recent, ...all]` with `_sections = [Recent, All emoji]`. Anything else is the old
`_emojiSearch`. `_pickEmoji` records a hit when `emoji-remember` or `emoji-recent` is on.

### Recent start list (`search/engine.js`, `extension.js`)
`search('', {recent: {fill}})` -> `_initial(..., recent)`: entries from usage stats sorted by last use; `fill` false stops
there, true fills with the usual list. New `SearchEngine.get(id)`. `_remember(id)` records usage when `frecency` or
`start-recent` is on (previously only `frecency`).

### Search history (`search/history.js`, `extension.js`, `ui/launcher.js`, `cache/store.js`)
- `QueryHistory` (pure): newest first, de-duplicated (a repeat moves to the front), max length (0 = unlimited),
  200-character cap, `step(cursor, dir)` for the arrows, `load`/`merge` validate stored data.
- `extension.js`: `_recordSearch(entry)` at the top of `_activate` (skipped for accounts, when the launcher is closed or
  not in the main search, and for `!commands` if `history-commands` is off). Stored with `JsonStore(..., {private: true})`
  in the state folder, saved debounced (1.5 s), synchronously on disable. `history-max`, `history-persist` (off deletes
  the file) and `history-generation` (clear) are handled in `_onConfigChanged`.
- `JsonStore` gains `{private}`: folder 0700, files created with `FileCreateFlags.PRIVATE` (0600).
- Launcher: Up with `_sel <= 0` (or already walking) calls `_historyStep(-1)`; Down while walking steps forward and finally
  restores the draft (`_draft`). `_hCursor`/`_histSet` keep typing and recalling apart (text-changed resets the walk
  unless the launcher set the text itself, and auto-launch is skipped for recalled text). Reset on open and when a mode
  is left.

### Schema
`start-recent`, `start-fill`, `history-enabled`, `history-persist`, `history-max`, `history-commands`,
`history-generation`, `emoji-recent`, `emoji-recent-count`. Prefs: *Search* page groups "When the launcher opens" and
"Search history"; emoji group gets the Recent switch and count.

### Tests (126)
History list, arrows, validation and merge; wiring checks; recent-first start list; grid fill/sections wiring.

### Not verified
No GNOME Shell was available. Check: open the emoji grid in a tall window (no empty lower half), pick a few emoji and
reopen (Recent above All emoji, a gap between them, arrow keys cross the gap), open the launcher with nothing typed
(recent first), run a few searches and press Up/Down, restart the shell and press Up again.

## 0.5.1: paste, Super key, auto-launch, unlimited history, hiding

| Area | Change |
|---|---|
| Super key (`shortcuts/keybindings.js`) | **Cause:** the 0.4.x code set Mutter's `overlay-key` to `''` and watched Super on `global.stage` `captured-event`. In Mutter's `events.c` a key event is passed to the focused Wayland client and returns STOP, so the stage never sees it while an application has focus; only the overview was disabled. **Now:** `overlay-key` is left alone; `GObject.signal_handlers_block_matched(global.display, {signalId: 'overlay-key'})` blocks the Shell's handler (`overviewControls.js` connects it and calls `Main.overview.toggle()`), then our own `overlay-key` handler is connected (after the block, so it still runs). `_stopSuper` disconnects ours and unblocks. If blocking throws, the handler hides the overview that just opened (old fallback). If an empty `overlay-key` is found it is reset once when the option is turned on. Removed: stage handler, press/release tracking. Any other extension's `overlay-key` handlers that existed at that moment are blocked too while the option is on. |
| Paste (`extension.js`, `clipboard/history.js`) | `_pasteClip`: `mute(1500)`, `copyText`, then `Paster.paste(text, {keys:'auto', borrow:false})` (auto = Ctrl+Shift+V in terminals). `_useClipImage`: `useItem(id, how, onSet)`; `onSet` runs after the image is on the clipboard (linked files are read asynchronously) and sends the paste keys. `_wantsPaste(how)` = `clipboard-paste !== (how === 'shift')`. `clip` and `calc` no longer share a case: calc only copies. Files keep copy / Ctrl open / Alt folder. |
| Auto-launch (`ui/launcher.js`) | `_autoLaunch(grew)` after each text change: needs the option, no sub-mode, 2+ characters, text longer than before, exactly one non-`web` result of kind `app`/`command`/`action`. Fires after `auto-launch-delay` ms and re-checks (still open, same single result, same text). Timer cancelled on close/destroy and on every keystroke. Keys: `auto-launch-single` (false), `auto-launch-delay` (350). |
| Unlimited history (`clipboard/history.js`, schema) | `clipboard-max` range 0..1,000,000 and `clipboard-image-count` 0..100,000, 0 = `Infinity` internally (`_trim`, `imagesToDrop`, `reviveItems`). Disk: the index is still one JSON file rewritten (debounced) on change, so a huge history makes saves and the in-memory entry list larger. |
| Hiding (`extension.js`, `ui/launcher.js`, `prefs/pages.js`, schema) | Ctrl+H in `_onKey` -> `onHide(entry)` -> `_hideEntry`: only `app`, `command`, `action`, `system`, `mode` kinds; stores `{id, name}` in `hidden-entries` (JSON), then rebuilds the engine list immediately without hidden ids (`_rebuildEntries`). The highlight stays at the same position. Prefs: *Hidden entries* group on the Search page (live list, Unhide, Unhide all). Shortcuts of hidden entries are unaffected (they are registered separately). |
| Tests | 5 new (Super implementation, paste rules, unlimited limits, auto-launch rules, hiding). 120 pass. |

### Not verified
No GNOME Shell was available. Check: tap Super (with an app focused and on the desktop): launcher opens, overview does not; turn the option off: overview works again; choose a clipboard text entry with a text editor and a terminal focused; choose an image entry; Shift+Enter; type two letters of a unique app with auto-launch on; Ctrl+H on an app, then Unhide in preferences.

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

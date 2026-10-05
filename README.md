# GNOME Launcher

Owner/maintainer: **maou-nournar** (extension UUID `gnome-launcher@maou-nournar`).

A fast, lightweight, highly customizable launcher for GNOME Shell, inspired by Lightbar and Vicinae.
Fuzzy search over applications, your own commands and actions, with themes, transparency, an action menu and optional file search.

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
| Mutter/Shell dependent | Bare-Super activation (`overlay-key`), per-entry shortcuts (`grab_accelerator`) |

Version-specific code is isolated: key handling in `shortcuts/keybindings.js`,
Shell-only APIs in `commands/runner.js` (`GNOME` table).

## Architecture

```
extension.js          wiring, lifecycle, config-change dispatch (no heavy work in enable())
prefs.js, prefs/      Adw preferences (widgets.js: rows, shortcut capture, list editor; pages.js: pages)
config/config.js      typed GSettings wrapper + parsed-JSON cache
ui/launcher.js        modal overlay, entry, lazily created pooled rows, animation
ui/style.js           layout + theme -> St CSS strings (computed on change only)
themes/themes.js      pure: theme schema, sanitizer, built-ins, resolver
search/engine.js      pure: ranking, fuzzy, narrowing, frecency, regex search
search/regex.js       pure: regex query parsing with a slow-pattern guard
search/web.js         pure: web / AI fallback providers and urls
accounts/             accounts.js (pure records, URL checks, password generator), vault.js (GNOME Keyring via libsecret)
emoji/                data.js (generated dataset, loaded lazily), emoji.js (pure logic), paste.js (virtual-keyboard paste)
applications/         appIndex.js (cache + incremental diff + monitor), launch.js
commands/             schema.js (pure validation), userEntries.js (pure), runner.js (execution)
cache/                store.js (atomic versioned JSON), stats.js (usage counts)
shortcuts/            keybindings.js
utils/                log.js, timing.js (cancellable debounce/idle)
tools/                bench.mjs (search benchmark), gen-emoji.mjs (regenerates emoji/data.js; dev only)
tests/run.mjs         node-runnable unit tests
```

Key decisions:

- **Event-driven only.** No polling. App changes come from `Gio.AppInfoMonitor` (debounced); theme changes from `org.gnome.desktop.interface`; everything else from GSettings signals.
- **Cache flow.** Login: cached app list loads asynchronously, then a low-priority diff against installed apps updates only changed records and rewrites the cache only if something changed. Corrupt/outdated cache files are discarded and rebuilt; invalid records are dropped individually.
- **Search runs on in-memory, pre-folded strings.** Appending characters rescans only the previous matches. Benchmarks (node/V8, 20,000 synthetic entries): about 10 ms cold worst case, about 3 ms per keystroke while typing. A real install has a few hundred entries.
- **UI objects are reused.** One window, one entry, a pool of rows created on demand in batches of 40 as you scroll (so "scroll through every result" and the emoji list never build thousands of actors); pools above 60 rows are trimmed when the window closes. Hidden when closed (no painting, no timers).
- **Settings are JSON strings in GSettings** for commands, actions, themes and overrides, validated and sanitized on every load. Imports go through the same sanitizers.

## Features and where to configure them

Everything is under the extension's preferences: General, Appearance (size, position, search bar placement, typography,
colours, radius, border, shadow, opacity, animation, overall scale), Themes (light/dark auto-switching, custom
themes, JSON import/export), Keyboard Shortcuts, Applications (default icons by category), Commands, Custom Actions,
Search, Performance (cache tools), Advanced.

Keys while open: Up/Down, Ctrl+N/P/J/K, Tab/Shift+Tab, PageUp/PageDown, Enter, Alt+1..9, Esc (leaves a sub-view first, then closes), Backspace on an empty sub-view search goes back.

### Built-in entries (Preferences > Built-in Entries)

Shut Down, Restart, Log Out (these use GNOME's own confirmation dialog), Suspend, Lock Screen, Take Screenshot, Show Overview,
Show All Apps, Toggle Dark Mode, Toggle Do Not Disturb, **Clipboard History** and **Clear Clipboard History**. Each can be disabled and given
a *global shortcut* (works anywhere) and/or a *window shortcut* (only while the launcher is open, never grabbed globally, must include Ctrl/Alt/Super).
Commands and custom actions have the same two shortcut fields. A global shortcut on *Clipboard History* opens the launcher directly in that view.

- **Clipboard history** holds text and, optionally, images. It is kept in memory (never written to disk) and updated by Mutter's selection-changed signal (no polling). Disable it or clear it from the prefs or the launcher.
  Images (screenshots, copied pictures) are on by default and bounded by *Images to keep* (default 8) and *Largest image to keep* (default 4 MB), so the worst case is about 32 MB. They show a thumbnail and their size read from the file header, and Enter puts the image back on the clipboard. Text always wins: an image is only recorded when the clipboard offers no text with it (a spreadsheet selection is kept as text, not as its picture).
- **Quick calculator**: type `12*(3+4)`; Enter copies the result. Uses a small parser, never `eval`.

### Emoji picker (Preferences > Emoji)

Built in, no external libraries or frameworks. Open it by typing `emoji` in the launcher, with its own global/window
shortcut, or type `:heart` in the main search for inline results (also `:thumbsup` style shortcodes).
The dataset (about 130 KB of plain text, 1,900+ emoji) is imported the first time you use it and released a minute after
the launcher closes, so it costs nothing while unused. Recently/frequently used emoji come first.

Choosing an emoji can: copy it to the **clipboard**, copy it to the **private buffer**, both, or neither; and/or **paste it in
place** and close. The private buffer lives in memory only (never on the clipboard, in clipboard history or on disk). A separate
global shortcut, **Paste from the private buffer**, types its content into the focused window.

Pasting works the way clipboard managers do: the text goes on the clipboard, the paste keys are sent from a virtual keyboard
created by the compositor, and, when the emoji is not supposed to stay on the clipboard, your own clipboard text is put back afterwards.
Keys are Ctrl+V, or Ctrl+Shift+V in terminals (auto-detected by window class), or fixed to a choice of your own.
Only a *text* clipboard is restored; an image on the clipboard is not.

### Regular expressions in search

Start a search with a slash to use a pattern over names, keywords and descriptions, ignoring case: `/^(chrom|fire)`, `/term.*emu`, `/\bgimp\b`.
A closing slash is optional. Name matches rank above keyword matches above description matches. *Preferences > Search > Use regular expressions*
can change this to "always when the text looks like a pattern" (invalid or unsafe text silently falls back to normal search) or turn it off.

A pattern runs on every keystroke against every entry, and JavaScript's engine backtracks, so a hostile pattern such as `(a+)+$` could freeze the
shell. Defences: patterns over 120 characters, more than two open-ended repeats, repeated groups that contain repeats or alternatives,
back-references and look-behind are refused with a message; only short slices of each entry's text are tested; and the whole scan has a 60 ms budget
(partial results beat a frozen shell). Custom commands and actions can also put `/regex/` tokens in their **search keywords**; such a pattern is
matched against the whole query and puts the command first, for example `terminal /^open term(inal)?$/`.

### Web and AI fallback

When nothing matches (or always, or never; *Preferences > Web & AI*) the list ends with entries that open your browser: "Search Google for ..." and
"Ask Claude: ...". Starting a search with `? ` forces them whatever the setting, for example `? how to rename a git branch`. The providers are an
editable list (name, address containing `{query}`, icon, AI or not, enabled); defaults are Google, Claude and ChatGPT enabled and DuckDuckGo and
Perplexity available. Only http(s) addresses are accepted and the text is percent-encoded. Whether an assistant pre-fills the question from the address
is up to that site; the defaults use the parameters those sites document.

### Fonts

*Preferences > Appearance > Fonts* has three independent slots: the **search bar** font, the **main** font (result titles) and the **details** font
(descriptions and type labels). Each has a family (chosen with the system font dialog; empty means the theme's font), a size and a weight. Sizes of 0
are automatic (relative to the main size). Names are sanitised before they go into a style, so a font name can never inject other style properties.
Row height is a separate setting, so a very large font can be clipped until the row height is raised.

### Emoji grid

*Preferences > Emoji > Emoji list style* switches the picker from a list to a grid of square cells. The number of columns follows the
window width and the cell size is configurable. Arrow keys move in two dimensions (Left/Right therefore move the selection, not the
text cursor, while the grid is open), PageUp/PageDown jump four lines, and the name of the highlighted emoji is shown under the grid.
Like the list, the grid creates its cells in batches while you scroll.

### Shared keyword for the launcher's own entries

*Preferences > Search > Shared keyword* (default `app`) is added to every built-in entry (Emoji Picker, Clipboard History, Passwords &
Accounts, the power actions, ...). Typing exactly that word lists all of them together; as a normal search term it also ranks them.
Set it to something rarer, or empty to turn it off, if "app" collides with applications you search for.

### Passwords and accounts (Preferences > Accounts)

A small vault, deliberately simple: an account has a name, username, password and optional website.

- **Where things live.** The password is stored **only in the GNOME Keyring** through libsecret (encrypted, unlocked with your login). The launcher keeps the name, username and website in the `accounts` setting so it can search them; those are not secrets. Nothing is ever written to a plain file. If libsecret or a keyring is missing the vault is unavailable and says so; there is no weaker fallback.
- **Using it.** Type `passwords` (or set a shortcut) to open the vault, which is a view of its own: accounts never show up in normal search results. Enter copies the password, Shift+Enter types it into the previous window, Ctrl+Enter copies the username, Alt+Enter opens the website.
- **Clipboard hygiene.** A copied password is removed from the clipboard after *Clear a copied password after* seconds (default 20; only if the clipboard still holds it) and is never added to the clipboard history. Typing it in uses the same borrow-and-restore mechanism as the emoji paste, so it does not stay on the clipboard at all.
- **Editing.** Passwords are write-only in the preferences: they are never read back from the keyring into the window. Leave the field empty to keep the stored one. A generator (random bytes from `/dev/urandom`, unbiased sampling) is built in.
- **Limits.** This is a convenience vault, not a replacement for a full password manager: no sharing, no sync, no browser integration, no TOTP. A password is held in a JavaScript string for the moment it is used, which the runtime cannot wipe. Other clipboard managers you run may still record a copied password; Shift+Enter avoids the clipboard.

### Appearance additions

- **Search icon**: icon-theme name or an image path (a file chooser is provided) and its size; empty hides it.
- **Scrollbar**: never drawn by default, the list still scrolls (wheel, touchpad, keys). A switch brings it back.
- **Scroll through every result** (Search): lifts both result limits so the whole index can be scrolled.
- **Theme presets**: `raycast-dark/light` and `vicinae-dark/light`, plus a *Quick preset* row on the Themes page that sets both modes at once.

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

- **No blur.** The extension does not blur anything itself. The launcher window carries the names `gnome-launcher`
  (actor name), the style classes `gnome-launcher gnome-launcher-window org-gnome-shell-extensions-gnome-launcher`, the
  accessible name "GNOME Launcher" and the schema id `org.gnome.shell.extensions.gnome-launcher` (see `ui/identity.js`),
  so other tools can find it. It is a Shell actor, not a window, so it has no window class. Blur my Shell's application
  blur works on windows by their class and cannot select it without a change in Blur my Shell.
- **Bare Super**: turning the option on runs the equivalent of `gsettings set org.gnome.mutter overlay-key ''` and the launcher detects the Super press itself; turning it off or disabling the extension runs `gsettings reset org.gnome.mutter overlay-key`. If the shell crashes while it is on, run that reset command yourself (a custom overlay-key you had set is not preserved).
- Shortcut conflict detection in prefs covers GNOME's own keybinding schemas only, not other extensions or apps.
- The theme drop-downs list themes at the time the preferences window opens.
- Fonts: only family and weight (no italics); custom icons are theme names or file paths (no embedded images).
- Per-entry shortcuts use `grab_accelerator`; a rejected accelerator is reported once as a notification.
- **Raycast/Vicinae presets** are look-alikes: Raycast's red and dark surface colour come from its brand page, the remaining values (and all of Vicinae's) are approximations.
- **Emoji**: skin-tone variants are not offered; the list shows one glyph per emoji. Newly added Unicode emoji only render if your emoji font has them.
- **Accounts** need libsecret (typelib `Secret-1`) and a Secret Service such as GNOME Keyring; the preferences use Adw.Dialog and Adw.AlertDialog, which need libadwaita 1.5 (GNOME 46+, matching the supported range).
- **Pasting in place** needs the compositor to accept a virtual keyboard (Wayland and X11 both do on GNOME 46-50) and applications that paste with Ctrl+V / Ctrl+Shift+V / Shift+Insert. If sending the keys fails, the emoji is left on the clipboard and a notification says so.
- Ranking uses launch counts with time decay, not per-query learning.

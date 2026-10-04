# Changelog

All notable changes to GNOME Launcher (`gnome-launcher@maou-nournar`). Newest first.

## 0.5.3

### Bug fixes
- **Clicking or tapping an entry could close the launcher and then show it again instead of opening the entry**
  (reported with a mouse and with a touchpad, tap to click). The launcher only listened for a raw
  mouse-button release on each row. Newer GNOME Shell versions recognise clicks, taps and touches with
  gestures (the way the Shell's own menus do), and a plain button-release listener is not reliable there.
  Rows, grid cells and "click outside to close" now use the Shell's click gesture where it exists
  **and** the button events, and a click that arrives through both counts once. Also: clicks are ignored
  once the window is closing, and rows that scroll under a resting pointer no longer steal the selection.
  I could not reproduce this without a Shell, so see TECHNICAL.md for what to send if it still happens.

### New features
- **Favorites.** Press **Ctrl+D** on a result (application, your command or action, built-in entry) to make it a
  favorite, and again to take it off. Favorites are listed first, marked with a star, when the launcher opens,
  before the recently used entries, and all of them are shown even if there are more than "Entries shown
  before typing". They are managed in *Search > Favorites* (remove one or all), and *Search > When the launcher
  opens > Show favorites first* turns the feature off without losing the list.

### Housekeeping
- A statistical password test was made less random. Version 0.5.3, tests 126 -> 129.

## 0.5.2

### Bug fixes
- **Emoji grid showed only about half of its height** until you moved the selection down. The first batch of
  cells was a fixed number of lines, which is less than a tall window can show. The first batch now always
  fills the visible height (plus a few lines ahead); the rest is still created while you scroll.

### New features
- **Emoji: Recent, then All emoji.** In the grid layout with nothing typed, the emoji you picked last (by
  last use, newest first) are shown under a small "Recent" title, then every emoji under "All emoji", a little
  apart, on the same grid. Typing a search shows one plain list as before, and so does the list layout.
  Settings (*Built-in Entries > Emoji picker*): show the Recent section (on), how many recent emoji (16).
  The old "recent and frequent first" switch is now "Rank often-used emoji higher when searching".
- **Recently used entries when the launcher opens.** Before typing, the list shows what you used most recently,
  newest first (before: most frequently used). Settings (*Search > When the launcher opens*): on/off, and whether
  the rest of the list is filled with other entries or left short. The number of entries is the existing
  "Entries shown before typing".
- **Search history.** Press **Up** on the first result (or with nothing listed) to recall earlier searches,
  Up again for older ones, **Down** to come back to what you had typed; typing ends the walk, and a recalled
  search is never opened by itself. Saved when you open an entry from the main search (not from the clipboard,
  emoji or password views). Settings (*Search > Search history*): remember searches (on), keep them on disk
  (on; `~/.local/state/gnome-launcher/history.json`, folder 0700 and file 0600; turning it off deletes the file),
  how many to keep (50, 0 = no limit), also remember `!commands` (on), and a Clear button.

### Housekeeping
- Version 0.5.2. Tests 120 -> 126.

## 0.5.1

### Bug fixes
- **Choosing a clipboard entry now pastes it** into the window you came from (Ctrl+Shift+V is used in
  terminals), for text and images. Shift+Enter only copies. A new switch (*Built-in Entries > Clipboard history >
  Paste the entry when you choose it*) reverses this: Enter copies and Shift+Enter pastes. Ctrl+Enter on an
  image or video opens it and Alt+Enter shows its folder, as before. Calculator results still only copy.
- **Super key opens the launcher.** Before, the overview was disabled but nothing opened, because Mutter never
  shows the Super key to the shell's stage while an application has focus. The launcher now listens to Mutter's
  `overlay-key` signal (a clean Super tap) and blocks the overview's own handler while the option is on.
  The `overlay-key` GSettings value is no longer changed; if an older version left it empty it is reset when
  the option is turned on.

### New features
- **Open the only match** (*Search > Open the only match*, off by default): when exactly one application,
  command or action matches, it is opened after you stop typing (delay adjustable, 350 ms by default).
  Needs two characters and only reacts to typing more. Web searches, `!commands`, calculator results,
  clipboard items, emoji, accounts and power actions are never opened this way, and a web-search fallback row
  does not count as a second match.
- **Unlimited clipboard history:** *Clipboard items to keep* accepts 0 = no limit (up to 1,000,000 otherwise;
  the old limit was 200), and so does *Images to keep*.
- **Hide entries with Ctrl+H** on the highlighted result (applications, your commands and actions, built-in
  entries). Hidden entries are listed under *Search > Hidden entries*, each with an *Unhide* button, plus
  *Unhide all*. Hiding only removes an entry from the search; its shortcuts still work.

### Housekeeping
- Version 0.5.1. Tests 115 -> 120.

## 0.5.0

### Blur rebuilt on Blur my Shell
- **The blur now works like Blur my Shell's application blur.** It is an empty widget placed right behind the
  launcher window that carries the blur effect, and it follows the window's size, position and open/close
  animation. Before, the effect was attached to the window itself and removed during animations, which is what
  caused the glitches. The blur now stays on while the window fades in and out.
- **New Blur page** in preferences:
  - Mode: follow the theme, dynamic, static, or off.
  - Dynamic: strength (sigma), brightness, corner radius (or follow the theme's), and "keep the blur repainting".
  - Static: blur the wallpaper through a **pipeline of effects**, with the full Blur my Shell effect set:
    native gaussian blur, gaussian blur, Monte Carlo blur, color (18 blend modes), luminosity, noise, pixelize,
    derivative, corner, plus advanced effects (downscale, upscale, RGB<->HSL). Create, duplicate, rename, delete and
    reset pipelines; add, remove, reorder effects and edit every parameter.
- The blur code is loaded only when blur is used.

### Licensing
- The code taken from Blur my Shell (GPL-3.0) is in `blur/` with its license and a `NOTICE.md`. The extension
  is distributed under GPL-3.0 terms because of it.

### Housekeeping
- Tests 108 -> 115. Version 0.5.0 (a new feature set, so the minor number goes up).

## 0.4.4

Window layout, positioning and blur code are unchanged (0.4.1 behaviour).

### New features
- **Clipboard history is kept on disk** (on by default). It survives logging out and restarting the shell.
  Stored in `~/.local/share/gnome-launcher/clipboard/` (folder configurable), readable only by you
  (folder mode 0700, files 0600), as plain text. Turning the option off deletes the saved history, and
  *Clear Clipboard History* clears the disk too.
- **Choose what is recorded** (*Built-in Entries > Clipboard history*): the GNOME clipboard (default), the
  Wayland primary selection (selected text), both, or nothing automatically ("this launcher only": the
  history then holds only what the launcher copies itself plus entries added with the new
  **Save Clipboard to History** built-in).
- **Screenshots are linked, not copied** (on by default). A copied image that is identical to a file saved
  just before in the screenshot folder (Pictures/Screenshots, then Pictures; configurable) is stored as a link
  to that file, with its thumbnail, instead of a second copy. If the file is moved or deleted its entry is
  removed. Images with no matching file are copied into the history folder.
- **Screen recordings** made with GNOME (Videos/Screencasts, configurable) are added to the history when the
  recording finishes, as links. Enter puts the file on the clipboard, Ctrl+Enter plays it, Alt+Enter shows
  the folder.
- **Run a command:** start the search with `!` (the symbol is configurable, empty turns it off), for example
  `!ls -la ~`. Enter runs it from your home folder, through a shell by default (pipes, `&&`, variables) or
  directly without a shell (option). A command that fails shows a notification (exit 127: "Command not found").

### Behaviour notes
- Clipboard copies marked as secret by a password manager (`x-kde-passwordManagerHint`) are not recorded.
- Linked files are never deleted by the launcher; only its own image copies are.
- Images are no longer held in memory once they are on disk or linked; thumbnails come from the file.

### Housekeeping
- Tests 99 -> 108.

## 0.4.3

Still built on 0.4.1. Adds more items from 0.5.x that cannot affect where the window is placed
(window layout, positioning and blur code are unchanged).

### New features
- **Launcher Settings** built-in entry: type "settings", "preferences" or "prefs" in the launcher to open
  this extension's preferences. **Ctrl+I** does the same while the launcher is open. The shortcut can be
  changed or cleared on the *Built-in Entries* page (a cleared default stays cleared).
- **More opening animations:** Pop (springy), Drop in and Rise, in *Appearance > Animation > Style*.
  The default is still Fade and scale.

### Behaviour changes
- **Escape always closes the launcher**, also from clipboard history, emoji and accounts. Before, the first
  Escape only went back to the main search. Backspace on an empty field still steps back.

### Housekeeping
- Tests 96 -> 99 (Launcher Settings entry, animation styles offered are defined, Escape behaviour).

## 0.4.2

Built on the stable 0.4.1 code. The 0.5.x line (blur/shadow layering, launcher-style themes, window
positioning changes) was dropped because it introduced a window that jumped to the top of the screen.
Only the low-risk items below were carried over.

### Bug fixes
- **Highlight issue:** after the results changed, the previously selected row or grid cell could stay
  highlighted next to the new selection. The launcher now remembers which item is painted as selected and
  un-highlights it before any new selection, when results are re-rendered, when the window closes, and when
  spare rows are trimmed.

### New features
- **Block the launcher in some applications** (*Keyboard Shortcuts* page). While a listed application has
  focus, every launcher shortcut (main shortcut, Super key, per-entry shortcuts) is released and goes to that
  application. Add entries by typing a window class / app id (wildcards `*` and `?`), or pick an installed app.
- **Also block in any fullscreen window** switch (useful for games; also affects fullscreen video/browsers).
- **Regular-expression help:** an "i" button on the Search page and on the *Search keywords* field of custom
  commands and actions explains how to write `/regex/` keywords, with a cheat sheet, examples and safety notes.
- **More colour themes** (plain palettes, no blur): Nord (light and dark), Solarized (light and dark),
  Catppuccin (Latte / Mocha), Tokyo Night (Day / Night), Gruvbox (light / dark), Rosé Pine (Dawn / default).
  Each is available from the *Quick preset* row, which sets the light and dark theme together.

### Not included (on purpose)
- Blur/shadow layering, rounded blur, blur brightness, theme dividers and per-theme animations.
- The new Raycast / Vicinae / Spotlight / Glass styles (the 0.4.1 Raycast and Vicinae themes are unchanged).
- The "Launcher Settings" built-in entry and the animation styles beyond fade-scale / fade / slide / none.

### Housekeeping
- Version 0.4.2; tests 92 -> 96 (blocklist matching, preset families, and a check that preferences page
  builders are called with the arguments they declare).

## 0.4.1
Baseline: font crash fix (last commit of the supplied repository).

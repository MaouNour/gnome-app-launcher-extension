# Changelog

All notable changes to GNOME Launcher (`gnome-launcher@maou-nournar`). Newest first.

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

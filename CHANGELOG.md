# Changelog

All notable changes to GNOME Launcher (`gnome-launcher@maou-nournar`).
Newest version first.

## 0.5.2

### Bug fixes
- **Launcher window jumped to the top of the screen when you started typing and stayed there until the
  extension was restarted.** The window is now placed with explicit coordinates that are recalculated every
  time the results change, so it keeps its configured position (*Appearance > Position*) while it grows
  and shrinks, with the search box on top or on the bottom.

> Not verified in a live GNOME Shell (see TECHNICAL.md, "Verification"). If it still moves, send the
> output of `journalctl -f -o cat /usr/bin/gnome-shell` with *Advanced > Verbose logging* on.

## 0.5.1

### Bug fixes
- **Preferences window failed to open.** Opening the extension settings threw
  `TypeError: can't access property "bind", settings is undefined` and the window never appeared.
  The *Keyboard Shortcuts* page now builds correctly, so the whole preferences window loads again.
  Cause: the "Block the launcher in some applications" section was being created with the wrong arguments.

### Improvements
- Added an automated check that fails if any preferences page builder is called with a different number of
  arguments than it declares, so this kind of mistake is caught by `node tests/run.mjs` before release.

### Housekeeping
- Version bumped to 0.5.1 in `metadata.json`.
- `TESTING.md` updated with the current test count (101).

## 0.5.0

### Bug fixes
- Fixed the background blur.

### New features
- Several small additions, including the "Block the launcher in some applications" section on the
  *Keyboard Shortcuts* page (release the launcher's shortcuts while chosen apps or fullscreen windows have focus).

> Note: 0.5.0 notes are summarised from the maintainer's description; see `TECHNICAL.md` for the exact code
> involved in 0.5.1.

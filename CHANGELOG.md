# Changelog

All notable changes to GNOME Launcher (`gnome-launcher@maou-nournar`).
Newest version first.

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

# Testing

## Automated (no GNOME needed)

```sh
node tests/run.mjs          # 79 tests: search, frecency, themes and presets, emoji, clipboard images, accounts, validation, calculator, built-ins, static lint
node tools/bench.mjs 20000  # search latency (use `gjs -m tools/bench.mjs` for SpiderMonkey numbers)
glib-compile-schemas --strict --dry-run schemas
```

## On-device checklist (requires GNOME Shell)

Watch logs while testing: `journalctl -f -o cat /usr/bin/gnome-shell` (enable *Advanced > Verbose logging*).
Nested session for safe iteration: `dbus-run-session gnome-shell --nested --wayland` (older) or `--devkit` (newer).

| Area | Steps | Expected |
|---|---|---|
| Enable/disable | `gnome-extensions disable/enable` 10x | No errors, no leftover overlay, shortcut works after each enable |
| Re-login | Log out/in | Launcher opens instantly, results present on first open |
| Shortcut | Change in prefs, test; set a conflicting one | New shortcut works immediately; conflict flagged in prefs and notified |
| App launch | Launch several apps, one already running | Focus or launch; failures notify and re-sync the index |
| Custom commands | Add valid, missing-binary, bad-quote, disabled entries | Valid runs; broken show a notification; disabled hidden; nothing crashes |
| Actions | One of each type incl. `gnome` actions | Each behaves; bad URL scheme rejected |
| Search | Prefix, initials (`vsc`), fuzzy (`ffx`), accents, two tokens, keyword | Ranked sensibly |
| Cache rebuild | Delete `~/.cache/gnome-launcher/apps.json`; write garbage into it; install/remove an app | Rebuilds silently; list updates within ~1 s |
| Themes | Switch built-ins; create/export/import custom; toggle GNOME dark mode with *Follow GNOME* | Applies live; dark/light switches live |
| Prefs changes | Change every Appearance control while the launcher is closed and open | Applied without reload |
| Missing icons | Entry with a bogus icon name/path | Falls back to a generic icon |
| Many entries | Import ~2000 generated commands | Typing stays instant; scrolling smooth |
| Transparency/blur | Opacity 0.5; blur 30 on a busy wallpaper | Translucent; blur applied or one logged warning |
| Rapid toggling | Hold the shortcut / spam it | No stuck overlay, input always returns to the desktop |
| Pointer outside | Try each *Pointer outside the window* mode: click outside, move the pointer out, "never" | Closes only as configured; hover mode does not close at open if the pointer starts outside |
| Window shortcuts | Give a command a window shortcut (e.g. Ctrl+1) and a built-in one; try with the launcher open and closed | Fires only while open; no effect when closed; Ctrl-less shortcuts are ignored with a log line |
| Super key | Turn on *Also open with the Super key*, press Super alone, Super+key, Super+click; then turn it off | Launcher toggles on a bare press; Super+key unaffected; `gsettings get org.gnome.mutter overlay-key` is `''` while on and the default after turning off |
| Built-ins | Run Lock Screen, Toggle Dark Mode, Toggle DND, Take Screenshot; Shut Down/Restart/Log Out and cancel the GNOME dialog | Each works; power actions show GNOME's confirmation |
| Clipboard | Copy several texts, open *Clipboard History*, search, Enter on one, then *Clear Clipboard History* | Newest first; Enter re-copies and closes; Esc leaves the view first; clear empties it |
| Calculator | Type `12*(3+4)`, `2^10`, `1/0`, `firefox` | Result row for valid math, Enter copies it; nothing for the others |
| Idle cost | `top`/`gnome-shell` CPU with launcher closed | No wakeups attributable to the extension |
| Emoji picker | Type `emoji`, pick one; type `:heart`; set a global shortcut for the picker | Opens the picker; list scrolls through all emoji; `:heart` lists hearts inline; shortcut opens the launcher in the picker |
| Emoji copy modes | For each *Copy it to* value, pick an emoji and check the clipboard (`wl-paste`) and clipboard history | Clipboard gets it only for clipboard/both; private buffer never shows in clipboard history |
| Emoji paste in place | Enable *Paste in place*; pick an emoji with a text editor, a browser field and a terminal focused beforehand | Typed into the previously focused window (Ctrl+Shift+V used in the terminal); with *Copy it to: private buffer* your own clipboard text is back afterwards |
| Private buffer key | Pick with *private buffer* selected, set *Paste from the private buffer*, press it in another app; try with an empty buffer | Pastes the last emoji; empty buffer shows a notification |
| Search icon | Change the icon name, choose an image file, change the size, clear it | Updates live; invalid name falls back to the search icon; empty hides it |
| Scrollbar | Type until the list exceeds the maximum height; wheel, touchpad and arrows | Scrolls everywhere, no scrollbar drawn; the switch brings it back |
| Scroll all results | Turn on *Scroll through every result*, open with an empty search and scroll to the bottom | Every entry reachable; no hitch; Up on the first row of a long list stays put |
| Shadow flicker | Use a theme with a shadow and a small window; type so the result count changes quickly, with a non-maximised window behind | Border and shadow stay steady while typing and during open/close |
| Blur with apps behind | Blur 30, open over a non-maximised application, repeat 20x | No garbage or flicker around the window; blur appears right after it settles. If something is still wrong set blur to 0 to confirm the cause |
| Presets | Pick Raycast and Vicinae in *Quick preset*; toggle GNOME dark mode | Light/dark variants switch live |
| Emoji grid | Set *Emoji list style* to grid, open the picker; arrows, PageDown, hover, click, mouse wheel; resize the window width and the cell size | Cells fill the width; selection and the name line follow arrows and mouse; scrolls to the end of the list; no hitch while scrolling |
| Shared keyword | Type `app` in the main search; change the keyword in Search; empty it | Lists Emoji Picker, Clipboard History, Passwords & Accounts and the power actions; changes live; empty disables it |
| Clipboard images | Take a screenshot to the clipboard, copy an image from a browser, copy a spreadsheet range, open Clipboard History | Images show a thumbnail and size; Enter re-copies and pastes into an image editor; the spreadsheet selection is kept as text; images above the size limit are ignored; extra images beyond the count drop the oldest |
| Accounts | Add an account (use Generate), then open `passwords`: Enter, Shift+Enter, Ctrl+Enter, Alt+Enter; edit with an empty password; delete | Password in Passwords/Keys (Seahorse) and not in `dconf dump`; copied password is cleared after the delay and absent from clipboard history; Shift+Enter types it; delete removes the keyring item |
| Accounts without a keyring | Remove the Secret typelib or stop the keyring | Accounts page explains the problem, Add is disabled, the launcher notifies instead of failing silently |

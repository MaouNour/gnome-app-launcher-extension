# Technical notes

## 0.5.1: fix for "settings is undefined" in preferences

### Symptom
```
TypeError: can't access property "bind", settings is undefined
  switchRow@prefs/widgets.js:11:5
  blocklistGroup@prefs/pages.js:196:11
  shortcuts@prefs/pages.js:178:11
  buildPages@prefs/pages.js:595:84
  fillPreferencesWindow@prefs.js:10:38
```
The preferences window did not open.

### Root cause
`blocklistGroup` is declared with two parameters:

```js
function blocklistGroup(window, settings) { ... }
```

but `shortcuts()` called it with one:

```js
p.add(blocklistGroup(settings));   // settings landed in `window`; `settings` was undefined
```

So inside the function `settings` was `undefined`. Its first use, `switchRow(settings, 'block-fullscreen', ...)`,
passed that `undefined` on to `widgets.js`, where `settings.bind(...)` threw. Because `buildPages()` builds every page
before adding any to the window, one failing page prevented the entire window from opening.

### Changes

| File | Change |
|---|---|
| `prefs/pages.js` (line 178, in `shortcuts()`) | `blocklistGroup(settings)` → `blocklistGroup(window, settings)` |
| `tests/run.mjs` | New test `prefs page builders are called with the arguments they declare` (added just before the `metadata uuid matches the owner` test) |
| `metadata.json` | `version-name` `0.5.0` → `0.5.1` |
| `TESTING.md` | Test count in the automated-tests comment: 92 → 101 |
| `CHANGELOG.md` | New file |
| `TECHNICAL.md` | New file (this one) |

No schema, `extension.js` or runtime (Shell-side) code changed.

### The new regression test
Static check over `prefs/pages.js`:
1. Finds every top-level `function name(params) {` and counts its parameters
   (declarations with default values or destructuring are skipped).
2. Finds every call `name(...)` in the file (ignoring method calls like `obj.name(...)`), counting top-level
   arguments with a small scanner that respects nested brackets and string literals.
3. Fails when the counts differ, reporting the call and the expected parameters.

Verified: with the old call restored, the test fails with
`blocklistGroup(settings) passes 1 argument(s), expected 2 (window, settings)`; with the fix it passes.
Full suite: 101 passed.

### Known limits
- The check is textual, not a real parser. It covers plain top-level functions in `prefs/pages.js` only.
- It checks argument count, not order or type.
- Not run inside a live GNOME Shell: verify by opening the preferences (`gnome-extensions prefs gnome-launcher@maou-nournar`)
  and visiting *Keyboard Shortcuts*.

## 0.5.0 (previous release)
Blur fix plus small features, as described by the maintainer. This archive contained no prior changelog, so
file-level details for this version are not listed.

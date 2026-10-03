# Blur: origin and license

The files in this folder are taken from, or adapted from, **Blur my Shell** by aunetx
(https://github.com/aunetx/blur-my-shell, version 72), which is licensed under the **GNU General Public License
version 3** (full text in `LICENSE-blur-my-shell`).

| Here | From Blur my Shell | Change |
|---|---|---|
| `effects/*.js`, `effects/*.glsl` | `effects/` | Imports of `utils.js` now point to `../utils.js`. `native_dynamic_gaussian_blur.js` also stores the unscaled corner radius. |
| `effects/registry.js` | `effects/effects.js` | Only the type -> class table (shell side). |
| `defs.js` | `effects/effects.js` | Names, descriptions, parameters and defaults for the preferences; pipeline validation; blur mode rules (new). |
| `effects_manager.js` | `conveniences/effects_manager.js` | Registry import path. |
| `connections.js`, `paint_signals.js`, `utils.js` | `conveniences/` | Log prefix only. |
| `pipeline.js` | `conveniences/pipeline.js` | Reduced to building the effects on one actor (no settings manager). |
| `blur.js` | `components/applications.js`, `conveniences/dummy_pipeline.js` | The way application windows are blurred (blur actor behind the window, dynamic or static), applied to the launcher. |

Because of this code, the combined work is distributed under the GPL-3.0 terms as well.

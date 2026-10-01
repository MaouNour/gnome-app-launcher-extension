import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {dbg, warn} from '../utils/log.js';

const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
const NONE = Meta.KeyBindingAction.NONE;

export class Keybindings {
    constructor() {
        this._mainKey = null;
        this._overlaySig = 0;
        this._custom = new Map(); // action id -> {id, accel, name}
        this._customSig = 0;
    }

    // Main activation shortcut: bound through a GSettings key ('as'), so Mutter tracks it
    // and the prefs UI edits the very same key. Returns false on conflict/failure.
    setMain(settings, key, callback) {
        this.clearMain();
        const accels = settings.get_strv(key);
        if (accels.length === 0 || accels.every(a => !a))
            return true;
        let action = NONE;
        try {
            action = Main.wm.addKeybinding(key, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES, callback);
        } catch (e) {
            warn('addKeybinding failed:', e.message);
        }
        if (action === NONE) {
            warn('could not bind launcher shortcut', accels.join(','));
            return false;
        }
        this._mainKey = key;
        dbg('main shortcut bound', accels.join(','));
        return true;
    }

    clearMain() {
        if (this._mainKey) {
            Main.wm.removeKeybinding(this._mainKey);
            this._mainKey = null;
        }
    }

    // Optional: open on a bare Super press. Shell's overview also reacts to this key, so the
    // overview is dismissed right after; a brief flash is possible. Documented limitation.
    setSuperKey(enabled, callback) {
        if (this._overlaySig) {
            global.display.disconnect(this._overlaySig);
            this._overlaySig = 0;
        }
        if (!enabled)
            return;
        this._overlaySig = global.display.connect('overlay-key', () => {
            callback();
            if (Main.overview.visible || Main.overview.animationInProgress)
                Main.overview.hide();
        });
    }

    // Per-entry shortcuts. `items` = [{id, accel}]. Returns accelerators that could not be
    // grabbed (conflicts/invalid) so the caller can tell the user. Duplicates: first wins.
    setCustom(items, callback) {
        this.clearCustom();
        const failed = [];
        const seen = new Set();
        for (const {id, accel} of items) {
            const key = accel.trim().toLowerCase();
            if (!key || seen.has(key)) {
                if (key)
                    failed.push(accel);
                continue;
            }
            seen.add(key);
            let action = NONE;
            try {
                action = global.display.grab_accelerator(accel, Meta.KeyBindingFlags.NONE);
            } catch (_e) { /* invalid accelerator string */ }
            if (action === NONE) {
                failed.push(accel);
                continue;
            }
            const name = Meta.external_binding_name_for_action(action);
            Main.wm.allowKeybinding(name, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
            this._custom.set(action, {id, accel, name});
        }
        if (this._custom.size > 0 && !this._customSig) {
            this._customSig = global.display.connect('accelerator-activated', (_d, action) => {
                const c = this._custom.get(action);
                if (c)
                    callback(c.id);
            });
        }
        return failed;
    }

    clearCustom() {
        for (const [action, c] of this._custom) {
            try {
                global.display.ungrab_accelerator(action);
                Main.wm.allowKeybinding(c.name, Shell.ActionMode.NONE);
            } catch (_e) { /* already gone */ }
        }
        this._custom.clear();
        if (this._customSig) {
            global.display.disconnect(this._customSig);
            this._customSig = 0;
        }
    }

    destroy() {
        this.clearMain();
        this.setSuperKey(false);
        this.clearCustom();
    }
}

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {dbg, warn} from '../utils/log.js';

const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
const NONE = Meta.KeyBindingAction.NONE;

export class Keybindings {
    constructor() {
        this._mainKey = null;
        this._custom = new Map(); // action id -> {id, accel, name}
        this._customSig = 0;

        this._mutter = null;
        this._ownSettings = null;
        this._stageSig = 0;
        this._overlaySig = 0;
        this._trigger = new Set();
        this._down = false;
        this._clean = false;
        this._superCb = null;
    }

    // Main activation shortcut. `key` is the name of an 'as' GSettings key. Mutter keeps ONE
    // global list of binding names (shared with every extension), so the key name must be
    // unique, and it is registered once: Mutter itself follows later changes to the setting.
    setMain(settings, key, callback) {
        if (this._mainKey)
            return true;
        let action = NONE;
        for (let attempt = 0; attempt < 2 && action === NONE; attempt++) {
            try {
                action = Main.wm.addKeybinding(key, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES, callback);
            } catch (e) {
                warn('addKeybinding threw:', e.message);
            }
            if (action === NONE) {
                warn(`addKeybinding("${key}") failed (attempt ${attempt + 1}); removing a possibly stale registration`);
                try {
                    Main.wm.removeKeybinding(key);
                } catch (_e) { /* nothing registered under that name */ }
            }
        }
        if (action === NONE)
            return false;
        this._mainKey = key;
        dbg('main shortcut registered:', settings.get_strv(key).join(','));
        return true;
    }

    clearMain() {
        if (this._mainKey) {
            Main.wm.removeKeybinding(this._mainKey);
            this._mainKey = null;
        }
    }

    // Open on a bare Super (or whatever Mutter's overlay-key is) press. Shell's overview owns
    // that key, so while this is enabled Mutter's documented `overlay-key` setting is set to
    // the empty string (which disables it) and the press/release is detected here instead.
    // The original value is kept in our own settings (surviving a crash) and restored when
    // turned off, on disable(), and on the next start if a crash left it empty.
    setSuperKey(enabled, callback, settings) {
        this._stopSuper(settings);
        if (!enabled)
            return;
        this._superCb = callback;
        this._ownSettings = settings;
        try {
            this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
            const current = this._mutter.get_string('overlay-key');
            if (current)
                settings.set_string('saved-overlay-key', current);
            const name = settings.get_string('saved-overlay-key') || 'Super_L';
            this._trigger = new Set([Clutter.keyval_from_name(name)]);
            if (name.startsWith('Super'))
                this._trigger.add(Clutter.keyval_from_name('Super_R')).add(Clutter.keyval_from_name('Super_L'));
            this._mutter.set_string('overlay-key', '');
            this._stageSig = global.stage.connect('captured-event', (_s, ev) => this._onStageEvent(ev));
            dbg('super key handled by the launcher; saved overlay-key =', name);
        } catch (e) {
            // Could not take over the key: fall back to reacting after Shell (overview may flash).
            warn('could not take over overlay-key, using fallback:', e.message);
            this._overlaySig = global.display.connect('overlay-key', () => {
                callback();
                if (Main.overview.visible || Main.overview.animationInProgress)
                    Main.overview.hide();
            });
        }
    }

    _onStageEvent(ev) {
        switch (ev.type()) {
        case Clutter.EventType.KEY_PRESS:
            if (this._trigger.has(ev.get_key_symbol())) {
                if (!this._down) {
                    this._down = true;
                    this._clean = true;
                }
            } else if (this._down) {
                this._clean = false; // Super+<key> is a different shortcut
            }
            break;
        case Clutter.EventType.KEY_RELEASE:
            if (this._down && this._trigger.has(ev.get_key_symbol())) {
                const fire = this._clean;
                this._down = false;
                this._clean = false;
                if (fire)
                    this._superCb?.();
            }
            break;
        case Clutter.EventType.BUTTON_PRESS:
        case Clutter.EventType.SCROLL:
            this._clean = false; // Super+click / Super+scroll
            break;
        default:
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _stopSuper(settings) {
        if (this._stageSig) {
            global.stage.disconnect(this._stageSig);
            this._stageSig = 0;
        }
        if (this._overlaySig) {
            global.display.disconnect(this._overlaySig);
            this._overlaySig = 0;
        }
        this._down = this._clean = false;
        this._superCb = null;

        const s = settings ?? this._ownSettings;
        const saved = s?.get_string('saved-overlay-key');
        if (saved) {
            try {
                const m = this._mutter ?? new Gio.Settings({schema_id: 'org.gnome.mutter'});
                m.set_string('overlay-key', saved);
                s.set_string('saved-overlay-key', '');
                dbg('overlay-key restored to', saved);
            } catch (e) {
                warn('could not restore overlay-key:', e.message);
            }
        }
        this._mutter = null;
        this._ownSettings = null;
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
        this._stopSuper(this._ownSettings);
        this.clearCustom();
    }
}

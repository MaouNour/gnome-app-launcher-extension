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
        this._tookOver = false;
        this._stageSig = 0;
        this._overlaySig = 0;
        this._trigger = new Set();
        this._down = false;
        this._clean = false;
        this._superCb = null;
        this._mainArgs = null;   // {settings, key, callback}: kept so the binding can be put back
        this._customArgs = null; // {items, callback}
        this._blocked = false;
    }

    // While true (a blocked application has focus) every launcher shortcut is released, so the keys
    // reach that application untouched. Event driven: called on focus changes only.
    setBlocked(blocked) {
        if (blocked === this._blocked)
            return;
        this._blocked = blocked;
        if (blocked) {
            this._removeMain();
            this._ungrabCustom();
        } else {
            if (this._mainArgs)
                this._addMain();
            if (this._customArgs)
                this._grabCustom();
        }
    }

    // Main activation shortcut. `key` is the name of an 'as' GSettings key. Mutter keeps ONE
    // global list of binding names (shared with every extension), so the key name must be
    // unique, and it is registered once: Mutter itself follows later changes to the setting.
    setMain(settings, key, callback) {
        if (this._mainArgs)
            return true;
        this._mainArgs = {settings, key, callback};
        return this._blocked ? true : this._addMain();
    }

    _addMain() {
        if (this._mainKey)
            return true;
        const {settings, key, callback} = this._mainArgs;
        let action = NONE;
        for (let attempt = 0; attempt < 2 && action === NONE; attempt++) {
            try {
                action = Main.wm.addKeybinding(key, settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES, callback);
            } catch (e) {
                warn('addKeybinding threw:', e.message);
            }
            if (action === NONE) {
                warn(`addKeybinding(\"${key}\") failed (attempt ${attempt + 1}); removing a possibly stale registration`);
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

    _removeMain() {
        if (this._mainKey) {
            try {
                Main.wm.removeKeybinding(this._mainKey);
            } catch (_e) { /* already removed */ }
            this._mainKey = null;
        }
    }

    clearMain() {
        this._removeMain();
        this._mainArgs = null;
    }

    // Open on a bare Super press. Shell's overview owns that key, so while this is on Mutter's
    // `overlay-key` is set to '' (what `gsettings set org.gnome.mutter overlay-key ''` does) and
    // the press/release is detected here. Turning it off (or disabling the extension) runs the
    // equivalent of `gsettings reset org.gnome.mutter overlay-key`.
    setSuperKey(enabled, callback) {
        this._stopSuper();
        if (!enabled)
            return;
        this._superCb = callback;
        this._trigger = new Set([Clutter.KEY_Super_L, Clutter.KEY_Super_R]);
        try {
            this._stageSig = global.stage.connect('captured-event', (_s, ev) => this._onStageEvent(ev));
            this._mutter = new Gio.Settings({schema_id: 'org.gnome.mutter'});
            this._mutter.set_string('overlay-key', '');
            Gio.Settings.sync();
            this._tookOver = true;
            dbg("overlay-key set to ''; Super handled by the launcher");
        } catch (e) {
            // Could not take over the key: fall back to reacting after Shell (overview may flash).
            warn('could not take over overlay-key, using fallback:', e.message);
            this._stopSuper();
            this._superCb = callback;
            this._overlaySig = global.display.connect('overlay-key', () => {
                if (this._blocked)
                    return;
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
                if (fire && !this._blocked)
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

    _stopSuper() {
        if (this._stageSig) {
            global.stage.disconnect(this._stageSig);
            this._stageSig = 0;
        }
        if (this._overlaySig) {
            global.display.disconnect(this._overlaySig);
            this._overlaySig = 0;
        }
        if (this._tookOver) {
            try {
                (this._mutter ?? new Gio.Settings({schema_id: 'org.gnome.mutter'})).reset('overlay-key');
                Gio.Settings.sync();
                dbg('overlay-key reset');
            } catch (e) {
                warn('could not reset overlay-key:', e.message);
            }
            this._tookOver = false;
        }
        this._down = this._clean = false;
        this._superCb = null;
        this._mutter = null;
    }

    // Per-entry shortcuts. `items` = [{id, accel}]. Returns accelerators that could not be
    // grabbed (conflicts/invalid) so the caller can tell the user. Duplicates: first wins.
    setCustom(items, callback) {
        this._ungrabCustom();
        this._customArgs = {items, callback};
        return this._blocked ? [] : this._grabCustom();
    }

    _grabCustom() {
        const {items, callback} = this._customArgs;
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

    _ungrabCustom() {
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

    clearCustom() {
        this._ungrabCustom();
        this._customArgs = null;
    }

    destroy() {
        this.clearMain();
        this._stopSuper();
        this.clearCustom();
    }
}

import GObject from 'gi://GObject';
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

        this._overlaySig = 0;
        this._shellBlocked = 0;
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

    // Open on a bare Super press (and release, with no other key or click in between: Mutter decides that
    // and emits `overlay-key`). Shell's overview listens to the same signal, so while this is on its
    // handlers are blocked and ours is connected after the block. Nothing in GSettings is changed.
    //
    // Why not watch key events on the stage: Mutter hands key events straight to the focused
    // application and the stage never sees them, so that only worked with nothing focused.
    setSuperKey(enabled, callback) {
        this._stopSuper();
        if (!enabled)
            return;
        this._superCb = callback;
        // An earlier version emptied Mutter's `overlay-key`. If that was left behind (a crash), give it back.
        try {
            const m = new Gio.Settings({schema_id: 'org.gnome.mutter'});
            if (m.get_string('overlay-key') === '') {
                m.reset('overlay-key');
                Gio.Settings.sync();
                dbg('overlay-key restored to its default');
            }
        } catch (e) {
            warn('could not check overlay-key:', e.message);
        }
        try {
            this._shellBlocked = GObject.signal_handlers_block_matched(global.display, {signalId: 'overlay-key'});
        } catch (e) {
            this._shellBlocked = 0;
            warn('could not block the overview\'s Super handler, hiding the overview instead:', e.message);
        }
        this._overlaySig = global.display.connect('overlay-key', () => {
            if (this._blocked)
                return;
            // Fallback when the handler could not be blocked: close the overview that just opened.
            if (!this._shellBlocked && (Main.overview.visible || Main.overview.animationInProgress))
                Main.overview.hide();
            this._superCb?.();
        });
        dbg(`Super key handled by the launcher (overview handlers blocked: ${this._shellBlocked})`);
    }

    _stopSuper() {
        if (this._overlaySig) {
            global.display.disconnect(this._overlaySig);
            this._overlaySig = 0;
        }
        if (this._shellBlocked) {
            try {
                GObject.signal_handlers_unblock_matched(global.display, {signalId: 'overlay-key'});
            } catch (e) {
                warn('could not give the Super key back to the overview:', e.message);
            }
            this._shellBlocked = 0;
        }
        this._superCb = null;
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

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {resolvePasteKeys} from './emoji.js';
import {dbg, warn} from '../utils/log.js';

const FOCUS_DELAY_MS = 140;
const RESTORE_DELAY_MS = 450;
const MUTE_MS = FOCUS_DELAY_MS + RESTORE_DELAY_MS + 400;

const CHORDS = () => ({
    'ctrl-v': [Clutter.KEY_Control_L, Clutter.KEY_v],
    'ctrl-shift-v': [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v],
    'shift-insert': [Clutter.KEY_Shift_L, Clutter.KEY_Insert],
});

export class Paster {
    constructor(opts = {}) {
        this._mute = opts.mute ?? (() => {});
        this._wmClass = opts.wmClass ?? (() => null);
        this._dev = null;
        this._timers = new Set();
        this._gen = 0;
        this._restore = null;
    }

    paste(text, {keys = 'auto', borrow = false} = {}, onFail = null) {
        this._cancel();
        const gen = ++this._gen;
        const cb = St.Clipboard.get_default();

        const send = previous => {
            if (gen !== this._gen)
                return;
            if (borrow) {
                this._mute(MUTE_MS);
                this._restore = () => cb.set_text(St.ClipboardType.CLIPBOARD, previous ?? '');
                cb.set_text(St.ClipboardType.CLIPBOARD, text);
            }
            this._later(FOCUS_DELAY_MS, () => {
                const chord = resolvePasteKeys(keys, this._wmClass());
                if (!this._press(chord)) {
                    this._restore = null;
                    cb.set_text(St.ClipboardType.CLIPBOARD, text);
                    onFail?.();
                    return;
                }
                if (borrow)
                    this._later(RESTORE_DELAY_MS, () => this._runRestore());
            });
        };

        if (borrow)
            cb.get_text(St.ClipboardType.CLIPBOARD, (_c, previous) => send(previous));
        else
            send(null);
    }

    _press(chord) {
        const seq = CHORDS()[chord];
        if (!seq)
            return false;
        try {
            if (!this._dev) {
                const seat = Clutter.get_default_backend().get_default_seat();
                this._dev = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
            }
            for (const key of seq)
                this._dev.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.PRESSED);
            for (const key of [...seq].reverse())
                this._dev.notify_keyval(GLib.get_monotonic_time(), key, Clutter.KeyState.RELEASED);
            dbg(`paste keys sent: ${chord}`);
            return true;
        } catch (e) {
            warn(`could not send paste keys: ${e.message}`);
            this._dropDevice();
            return false;
        }
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    _runRestore() {
        const r = this._restore;
        this._restore = null;
        r?.();
    }

    _cancel() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        this._runRestore();
    }

    _dropDevice() {
        try {
            this._dev?.run_dispose?.();
        } catch (_e) {
            // already gone
        }
        this._dev = null;
    }

    destroy() {
        this._gen++;
        this._cancel();
        this._dropDevice();
    }
}

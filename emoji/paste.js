import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {resolvePasteKeys} from './emoji.js';
import {dbg, warn} from '../utils/log.js';

// Time for the launcher to release its keyboard grab and for the previously focused window to
// get focus back before the paste keys are sent.
const FOCUS_DELAY_MS = 140;
// Applications read the clipboard asynchronously after receiving the paste keys, so a borrowed
// clipboard must stay in place for a moment before the user's own text is put back.
const RESTORE_DELAY_MS = 450;
// Clipboard history is told to ignore changes for the whole borrow window plus its own debounce.
const MUTE_MS = FOCUS_DELAY_MS + RESTORE_DELAY_MS + 400;

const CHORDS = () => ({
    'ctrl-v': [Clutter.KEY_Control_L, Clutter.KEY_v],
    'ctrl-shift-v': [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v],
    'shift-insert': [Clutter.KEY_Shift_L, Clutter.KEY_Insert],
});

// Types text into the previously focused window. GNOME Shell has no "insert text" API for other
// clients, so this does what every clipboard manager does: put the text on the clipboard and
// send the paste shortcut from a virtual keyboard owned by the compositor (works on Wayland and
// X11, needs no extra permissions or processes). The virtual keyboard is created on first use.
export class Paster {
    // opts: {mute(ms): tells clipboard history to ignore changes, wmClass(): class of the focus window}
    constructor(opts = {}) {
        this._mute = opts.mute ?? (() => {});
        this._wmClass = opts.wmClass ?? (() => null);
        this._dev = null;
        this._timers = new Set();
        this._gen = 0;
        this._restore = null; // puts the user's own clipboard text back; set while it is borrowed
    }

    // borrow: the emoji must NOT stay on the clipboard, so the current text is saved first and
    // put back after pasting. Only text clipboards are preserved (an image on the clipboard is
    // replaced by an empty text selection).
    // onFail(): called when keys could not be sent; the text is then left on the clipboard so the
    // user can paste it by hand.
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
                    this._restore = null; // keep the text on the clipboard for a manual paste
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

    // Cancelling while the clipboard is borrowed puts the user's text back right away, so a
    // second quick paste (or disabling the extension) never leaves an emoji behind as "the original".
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

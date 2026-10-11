import Shell from 'gi://Shell';

import {compileBlocklist} from './blocklist.js';

// Releases the launcher shortcuts while a blocked app (or any fullscreen window) has focus.
export class FocusBlock {
    constructor(keys) {
        this._keys = keys;
        this._block = null;
        this._fullscreen = false;
        this._focusSig = 0;
        this._fsSig = 0;
        this._win = null;
    }

    configure(list, blockFullscreen) {
        this._block = compileBlocklist(list);
        this._fullscreen = blockFullscreen;
        if (this._block.size === 0 && !blockFullscreen) {
            this.destroy();
            this._keys.setBlocked(false);
            return;
        }
        this._focusSig ||= global.display.connect('notify::focus-window', () => this._check());
        this._check(true);
    }

    destroy() {
        if (this._focusSig)
            global.display.disconnect(this._focusSig);
        this._focusSig = 0;
        this._dropFsWatch();
        this._win = null;
    }

    _dropFsWatch() {
        if (this._fsSig && this._win) {
            try {
                this._win.disconnect(this._fsSig);
            } catch (_e) { /* window already destroyed */ }
        }
        this._fsSig = 0;
    }

    _check(force = false) {
        const win = global.display.focus_window ?? null;
        if (force || win !== this._win) {
            this._dropFsWatch();
            this._win = win;
            if (win && this._fullscreen)
                this._fsSig = win.connect('notify::fullscreen', () => this._check());
        }
        this._keys.setBlocked(this._isBlocked(win));
    }

    _isBlocked(win) {
        if (!win)
            return false;
        if (this._fullscreen && win.is_fullscreen())
            return true;
        if (this._block.size === 0)
            return false;
        const names = [win.get_wm_class?.(), win.get_wm_class_instance?.(), win.get_gtk_application_id?.(), win.get_sandboxed_app_id?.()];
        try {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            if (app)
                names.push(app.get_id(), app.get_name());
        } catch (_e) { /* no app for this window */ }
        return this._block.test(names);
    }
}

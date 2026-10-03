import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {dbg, warn} from '../utils/log.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

const enc = new TextEncoder();
const dec = new TextDecoder();

// Versioned JSON file. Reads/writes are async (never block the compositor), writes are
// atomic (replace), and anything unreadable/mismatched is treated as "no cache" and
// deleted so the next write starts clean.
export class JsonStore {
    // opts.private: the folder is created 0700 and files 0600 (for data that is nobody else's business).
    constructor(path, version, opts = {}) {
        this._private = !!opts.private;
        this._flags = Gio.FileCreateFlags.REPLACE_DESTINATION | (this._private ? Gio.FileCreateFlags.PRIVATE : 0);
        this._path = path;
        this._file = Gio.File.new_for_path(path);
        this._version = version;
        this._cancellable = new Gio.Cancellable();
        this._dirReady = false;
    }

    // Resolves to the stored data, or null if missing/corrupt/outdated. Never rejects.
    async load() {
        try {
            const [bytes] = await this._file.load_contents_async(this._cancellable);
            const obj = JSON.parse(dec.decode(bytes));
            if (obj?.v !== this._version || obj.data === undefined)
                throw new Error('version mismatch');
            return obj.data;
        } catch (e) {
            if (this._cancellable.is_cancelled())
                return null;
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                warn(`discarding unreadable cache ${this._path}: ${e.message}`);
                this.remove();
            }
            return null;
        }
    }

    async save(data) {
        try {
            this._ensureDir();
            const bytes = enc.encode(JSON.stringify({v: this._version, data}));
            await this._file.replace_contents_async(bytes, null, false, this._flags, this._cancellable);
            dbg('saved', this._path, bytes.length, 'bytes');
            return true;
        } catch (e) {
            if (!this._cancellable.is_cancelled())
                warn(`could not write ${this._path}: ${e.message}`);
            return false;
        }
    }

    // Used on disable(), where an async write might not finish.
    saveSync(data) {
        try {
            this._ensureDir();
            const bytes = enc.encode(JSON.stringify({v: this._version, data}));
            this._file.replace_contents(bytes, null, false, this._flags, null);
            return true;
        } catch (e) {
            warn(`could not write ${this._path}: ${e.message}`);
            return false;
        }
    }

    remove() {
        try {
            this._file.delete(null);
        } catch (_e) { /* already gone */ }
    }

    _ensureDir() {
        if (this._dirReady)
            return;
        GLib.mkdir_with_parents(GLib.path_get_dirname(this._path), this._private ? 0o700 : 0o755);
        this._dirReady = true;
    }

    // Cancels pending async I/O (call in disable()).
    cancel() {
        this._cancellable.cancel();
    }
}

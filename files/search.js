import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {dbg, warn} from '../utils/log.js';
import {locateArgs, parseLines, pathFromUri} from './results.js';

const TIMEOUT_MS = 4000;
const LOCATE_FETCH = 400; // asked for before the filters (home folder, hidden files) are applied

// Where GNOME's file search provider says it lives. The Files app (Nautilus) registers one with the Shell; it is
// answered from the LocalSearch (Tracker) index that GNOME already keeps, so this extension keeps no index.
export function findGnomeProvider() {
    const dirs = [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()];
    for (const d of dirs) {
        const path = GLib.build_filenamev([d, 'gnome-shell', 'search-providers', 'org.gnome.Nautilus.search-provider.ini']);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            continue;
        try {
            const kf = new GLib.KeyFile();
            kf.load_from_file(path, GLib.KeyFileFlags.NONE);
            const bus = kf.get_string('Shell Search Provider', 'BusName');
            const obj = kf.get_string('Shell Search Provider', 'ObjectPath');
            if (bus && obj)
                return {bus, path: obj};
        } catch (e) {
            warn(`could not read ${path}: ${e.message}`);
        }
    }
    return null;
}

export function findLocate() {
    for (const tool of ['plocate', 'locate', 'mlocate']) {
        const p = GLib.find_program_in_path(tool);
        if (p)
            return p;
    }
    return null;
}

// One backend query at a time: a new search cancels the one still running.
export class FileSearch {
    constructor() {
        this._cancel = null;
        this._proc = null;
        this._gnome = undefined;
        this._locate = undefined;
    }

    // {gnome: boolean, locate: string|null}. Looked up once; the answers do not change while the Shell runs.
    available() {
        this._gnome ??= findGnomeProvider();
        this._locate ??= findLocate() ?? null;
        return {gnome: !!this._gnome, locate: this._locate};
    }

    cancel() {
        if (this._cancel) {
            this._cancel.cancel();
            this._cancel = null;
        }
        if (this._proc) {
            try {
                this._proc.force_exit();
            } catch (_e) { /* already gone */ }
            this._proc = null;
        }
    }

    // Resolves to a list of absolute paths (possibly empty); rejects on a backend error. A search that was
    // replaced by a newer one resolves to null.
    async search(backend, terms) {
        this.cancel();
        const cancel = this._cancel = new Gio.Cancellable();
        let paths;
        try {
            paths = backend === 'gnome' ? await this._viaGnome(terms, cancel) : await this._viaLocate(terms, cancel);
        } catch (e) {
            if (cancel.is_cancelled())
                return null;
            throw e;
        }
        if (cancel.is_cancelled())
            return null;
        return paths;
    }

    _viaGnome(terms, cancel) {
        this.available();
        if (!this._gnome)
            return Promise.reject(new Error('GNOME file search is not installed'));
        return new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                this._gnome.bus, this._gnome.path, 'org.gnome.Shell.SearchProvider2', 'GetInitialResultSet',
                new GLib.Variant('(as)', [terms]), new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, TIMEOUT_MS, cancel, (conn, res) => {
                    try {
                        const [ids] = conn.call_finish(res).deepUnpack();
                        resolve(ids.map(pathFromUri).filter(Boolean));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _viaLocate(terms, cancel) {
        this.available();
        if (!this._locate)
            return Promise.reject(new Error('locate is not installed'));
        const argv = locateArgs(this._locate, terms, LOCATE_FETCH);
        dbg(`files: ${argv.join(' ')}`);
        const proc = this._proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, cancel, (p, res) => {
                if (this._proc === p)
                    this._proc = null;
                try {
                    const [, out] = p.communicate_utf8_finish(res);
                    resolve(parseLines(out));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    destroy() {
        this.cancel();
    }
}

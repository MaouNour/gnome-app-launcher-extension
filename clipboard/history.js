import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {prepare} from '../search/engine.js';
import {Debounce} from '../utils/timing.js';
import {dbg, warn} from '../utils/log.js';
import {clipboardKind, imageInfo, imageLabels, imagesToDrop} from './image.js';
import {
    MAX_CHARS, baseName, copyName, fileLabels, isCopyName, isSecret, isTempName, isVideoName, linkCandidates,
    reviveItems, serializeItems, watchedSelections,
} from './persist.js';

const INDEX = 'history.json';
const LINK_MAX = 48 * 1024 * 1024; // the largest copied image held in memory while its original file is looked for
const enc = new TextEncoder();
const dec = new TextDecoder();

function firstLine(text) {
    const line = text.split('\n').find(l => l.trim()) ?? '';
    const t = line.trim().replace(/\s+/g, ' ');
    return t.length > 100 ? `${t.slice(0, 100)}…` : t;
}

const join = (...p) => GLib.build_filenamev(p);

function expandHome(p) {
    if (p === '~')
        return GLib.get_home_dir();
    return p.startsWith('~/') ? join(GLib.get_home_dir(), p.slice(2)) : p;
}

// --- small async file helpers (callback style, so nothing depends on Gio._promisify) ------------------

function loadBytes(file) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (f, res) => {
            try {
                resolve(f.load_contents_finish(res)[1]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function writeBytes(file, bytes) {
    const flags = Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE; // private: mode 0600
    return new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false, flags, null, (f, res) => {
            try {
                f.replace_contents_finish(res);
                resolve(true);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function copyFile(src, dst) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(src).copy_async(Gio.File.new_for_path(dst), Gio.FileCopyFlags.OVERWRITE,
            GLib.PRIORITY_LOW, null, null, (f, res) => {
                try {
                    f.copy_finish(res);
                    resolve(true);
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function deleteFile(path) {
    Gio.File.new_for_path(path).delete_async(GLib.PRIORITY_LOW, null, (f, res) => {
        try {
            f.delete_finish(res);
        } catch (_e) { /* already gone */ }
    });
}

function queryInfo(file, attrs) {
    return new Promise((resolve, reject) => {
        file.query_info_async(attrs, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (f, res) => {
            try {
                resolve(f.query_info_finish(res));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// [{name, size, mtime(seconds)}] of the regular files in a folder, read in batches so a folder with
// thousands of screenshots never blocks the shell.
async function listDir(path) {
    const dir = Gio.File.new_for_path(path);
    const en = await new Promise((resolve, reject) => {
        dir.enumerate_children_async('standard::name,standard::size,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, (f, res) => {
                try {
                    resolve(f.enumerate_children_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
    const out = [];
    try {
        for (;;) {
            const infos = await new Promise((resolve, reject) => {
                en.next_files_async(256, GLib.PRIORITY_LOW, null, (f, res) => {
                    try {
                        resolve(f.next_files_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
            });
            if (infos.length === 0 || out.length > 50000)
                break;
            for (const i of infos) {
                if (i.get_file_type() === Gio.FileType.REGULAR)
                    out.push({name: i.get_name(), size: i.get_size(), mtime: Number(i.get_attribute_uint64('time::modified'))});
            }
        }
    } finally {
        try {
            en.close(null);
        } catch (_e) { /* closed */ }
    }
    return out;
}

// Names in a folder (synchronous, only used on the small history folder itself).
function namesIn(path) {
    const out = [];
    try {
        const d = GLib.Dir.open(path, 0);
        let n;
        while ((n = d.read_name()) !== null)
            out.push(n);
        d.close();
    } catch (_e) { /* no such folder */ }
    return out;
}

function defaultDir(kind) {
    const which = kind === 'shot' ? GLib.UserDirectory.DIRECTORY_PICTURES : GLib.UserDirectory.DIRECTORY_VIDEOS;
    const base = GLib.get_user_special_dir(which) ?? join(GLib.get_home_dir(), kind === 'shot' ? 'Pictures' : 'Videos');
    return join(base, kind === 'shot' ? 'Screenshots' : 'Screencasts');
}

// Clipboard history: text, images and screen recordings.
//  - Event-driven (Mutter's selection `owner-changed` signal and a file monitor); there is no polling.
//  - Which selection is followed is a setting: the normal clipboard, the primary selection, both, or none
//    ("own": the history then only holds what is added through the launcher).
//  - Optionally kept on disk (private folder, mode 0700/0600, plain text) and read back at start-up.
//  - A copied image is linked to the file it came from (a screenshot saved by GNOME) when there is one,
//    instead of being copied again. Screen recordings are only ever linked.
export class ClipboardHistory {
    // host: {openUri(uri), notify(text)}
    constructor(onChange, host = {}) {
        this._items = [];
        this._max = 25;
        this._seq = 0;
        this._entries = null;
        this._onChange = onChange;
        this._host = host;
        this._sels = null;
        this._sigs = [];
        this._watch = {clipboard: false, primary: false};
        this._running = false;
        this._dead = false;
        this._muteUntil = 0;
        this._images = false;
        this._maxImages = 8;
        this._maxImageBytes = 4 * 1024 * 1024;
        this._o = {source: 'clipboard', persist: false, dir: '', link: true, shotDir: '', videos: true, videoDir: ''};
        this._loaded = false;
        this._timers = new Set();
        this._monitor = null;
        this._readClip = new Debounce(120, () => this._fetch('clipboard'));
        this._readPrimary = new Debounce(500, () => this._fetch('primary'));
        this._saver = new Debounce(1200, () => this._flush());
    }

    get active() {
        return this._running;
    }

    // Ignore clipboard changes for the next `ms` milliseconds. Used while the emoji picker briefly
    // borrows the clipboard to paste, so the emoji and the restored text do not land in history.
    mute(ms) {
        this._muteUntil = Math.max(this._muteUntil, GLib.get_monotonic_time() + ms * 1000);
    }

    // --- configuration -------------------------------------------------------------------------

    // Image support on/off, how many images to keep and the largest copied image (in MB) worth keeping.
    setImages(enabled, count, mb) {
        this._images = enabled;
        this._maxImages = count > 0 ? count : Infinity; // 0 = no limit
        this._maxImageBytes = mb * 1024 * 1024;
        let changed = false;
        if (!enabled) {
            changed = this._removeWhere(it => !!it.image);
        } else {
            for (const i of imagesToDrop(this._items, count).reverse()) {
                this._discard(this._items.splice(i, 1)[0]);
                changed = true;
            }
            if (this._running && this._watch.clipboard)
                this._readClip.call(); // an image may already be sitting on the clipboard
        }
        if (changed)
            this._changed();
    }

    // 0 = keep everything.
    setMax(n) {
        this._max = n > 0 ? n : Infinity;
        if (this._trim())
            this._changed();
    }

    // {source, persist, dir, link, shotDir, videos, videoDir}: any subset.
    configure(o) {
        const prev = this._o;
        const prevDir = this._dir();
        this._o = {...prev, ...o};
        if (!this._running)
            return;
        this._rewire();
        if (this._o.persist && !prev.persist)
            this._enablePersist().catch(e => warn(`clipboard history: ${e.message}`));
        else if (!this._o.persist && prev.persist)
            this._disablePersist(prevDir).catch(e => warn(`clipboard history: ${e.message}`));
        else if (this._o.persist && this._dir() !== prevDir)
            this._relocate(prevDir).catch(e => warn(`clipboard history: ${e.message}`));
        if (prev.videos !== this._o.videos || prev.videoDir !== this._o.videoDir)
            this._syncVideos();
    }

    _dir() {
        const d = (this._o.dir ?? '').trim();
        return d ? expandHome(d) : join(GLib.get_user_data_dir(), 'gnome-launcher', 'clipboard');
    }

    _shotDirs() {
        const d = (this._o.shotDir ?? '').trim();
        if (d)
            return [expandHome(d)];
        const pics = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) ?? join(GLib.get_home_dir(), 'Pictures');
        return [defaultDir('shot'), pics];
    }

    _videoDir() {
        const d = (this._o.videoDir ?? '').trim();
        return d ? expandHome(d) : defaultDir('video');
    }

    // --- start / stop --------------------------------------------------------------------------

    start() {
        if (this._running)
            return;
        this._running = true;
        this._sels = global.display.get_selection();
        this._rewire();
        this._syncVideos();
        if (this._o.persist)
            this._loadFromDisk().catch(e => warn(`clipboard history: ${e.message}`));
        if (this._watch.clipboard)
            this._readClip.call();
        dbg('clipboard history started');
    }

    stop() {
        this._readClip.cancel();
        this._readPrimary.cancel();
        this._saver.cancel();
        this._flush(true);
        this._unwatchVideos();
        for (const id of this._sigs)
            this._sels?.disconnect(id);
        this._sigs = [];
        this._running = false;
        this._sels = null;
    }

    // Follow only the selections the source setting asks for; with none, no signal is connected at all.
    _rewire() {
        this._watch = watchedSelections(this._o.source);
        const want = this._watch.clipboard || this._watch.primary;
        if (!want) {
            for (const id of this._sigs)
                this._sels?.disconnect(id);
            this._sigs = [];
            return;
        }
        if (this._sigs.length)
            return;
        this._sigs.push(this._sels.connect('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD && this._watch.clipboard)
                this._readClip.call();
            else if (type === Meta.SelectionType.SELECTION_PRIMARY && this._watch.primary)
                this._readPrimary.call();
        }));
    }

    // --- reading the clipboard -----------------------------------------------------------------

    // Add what is on the clipboard right now, whatever the source setting says (the "Save clipboard" entry).
    captureNow() {
        this._fetch('clipboard', true);
    }

    // In "own" mode the launcher does not watch anything; text it copies itself (calculator results,
    // re-copied entries) is added here.
    noteCopied(text) {
        if (this._running && this._o.source === 'own')
            this._add(text);
    }

    _fetch(which, force = false) {
        if (!force && GLib.get_monotonic_time() < this._muteUntil)
            return;
        const primary = which === 'primary';
        const type = primary ? St.ClipboardType.PRIMARY : St.ClipboardType.CLIPBOARD;
        const cb = St.Clipboard.get_default();
        let mimes = [];
        try {
            mimes = cb.get_mimetypes(type);
        } catch (_e) { /* no mimetype list: fall back to text */ }
        if (isSecret(mimes))
            return; // a password manager asked not to be recorded
        let kind = {kind: 'text'};
        if (!primary) {
            try {
                kind = clipboardKind(mimes, this._images);
            } catch (_e) { /* fall back to text */ }
        }
        if (!kind)
            return;
        if (kind.kind === 'image') {
            cb.get_content(type, kind.mime, (_c, bytes) => {
                if (this._running && bytes)
                    this._addImage(kind.mime, bytes);
            });
            return;
        }
        cb.get_text(type, (_c, text) => {
            if (this._running && (!primary || (text && text.trim().length >= 2)))
                this._add(text);
        });
    }

    // --- adding items --------------------------------------------------------------------------

    _add(text) {
        if (!text || !text.trim() || text.length > MAX_CHARS)
            return;
        const i = this._items.findIndex(x => x.text === text);
        if (i === 0)
            return;
        if (i > 0)
            this._items.splice(i, 1);
        this._items.unshift({text, id: ++this._seq, ts: Date.now()});
        this._trim();
        this._changed();
    }

    _addImage(mime, bytes) {
        const size = bytes.get_size();
        if (size === 0 || size > (this._o.link ? LINK_MAX : this._maxImageBytes)) {
            dbg(`image skipped (${size} bytes)`);
            return;
        }
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        const i = this._items.findIndex(x => x.image?.hash === hash);
        if (i === 0)
            return;
        if (i > 0) {
            const [it] = this._items.splice(i, 1);
            it.ts = Date.now();
            this._items.unshift(it);
            this._changed();
            return;
        }
        const item = {
            id: ++this._seq, ts: Date.now(),
            image: {mime, hash, size, info: imageInfo(bytes.get_data()), bytes, path: null, linked: false},
        };
        this._items.unshift(item);
        for (const j of imagesToDrop(this._items, this._maxImages).reverse())
            this._discard(this._items.splice(j, 1)[0]);
        this._trim();
        this._changed();
        this._resolveImage(item).catch(e => warn(`clipboard image: ${e.message}`));
    }

    // Decide what to keep of a new image: link the file it came from, or store a copy.
    // The file may be written a moment after the clipboard is set, so the search is repeated twice.
    async _resolveImage(item) {
        const img = item.image;
        let found = null;
        if (this._o.link) {
            for (const delay of [0, 1500, 4000]) {
                if (delay && !(await this._wait(delay)))
                    return;
                if (!this._items.includes(item))
                    return;
                found = await this._findOriginal(img).catch(() => null);
                if (found)
                    break;
            }
        }
        if (this._dead || !this._items.includes(item))
            return;
        if (found) {
            dbg(`image linked to ${found}`);
            img.path = found;
            img.linked = true;
            img.bytes = null; // the file is the data; nothing stays in memory
            this._changed();
            return;
        }
        if (img.size > this._maxImageBytes) {
            this._removeWhere(it => it === item);
            this._changed();
            return;
        }
        if (this._o.persist && this._loaded)
            await this._writeCopy(item);
    }

    async _findOriginal(img) {
        const now = Date.now() / 1000;
        for (const dir of this._shotDirs()) {
            let files;
            try {
                files = await listDir(dir);
            } catch (_e) {
                continue; // folder does not exist
            }
            for (const c of linkCandidates(files, img.size, now)) {
                const path = join(dir, c.name);
                try {
                    const data = await loadBytes(Gio.File.new_for_path(path));
                    if (GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, data) === img.hash)
                        return path;
                } catch (_e) { /* unreadable candidate */ }
            }
        }
        return null;
    }

    async _writeCopy(item) {
        const img = item.image;
        if (!img.bytes)
            return;
        const dir = this._dir();
        GLib.mkdir_with_parents(dir, 0o700);
        const name = copyName(img.hash, img.mime);
        await writeBytes(Gio.File.new_for_path(join(dir, name)), img.bytes);
        if (this._dead)
            return;
        if (!this._items.includes(item)) {
            deleteFile(join(dir, name));
            return;
        }
        img.path = name;
        img.bytes = null;
        this._changed();
    }

    // --- screen recordings ---------------------------------------------------------------------

    _syncVideos() {
        this._unwatchVideos();
        if (!this._running || !this._o.videos)
            return;
        const dir = this._videoDir();
        try {
            const f = Gio.File.new_for_path(dir);
            if (!f.query_exists(null))
                return; // nothing recorded yet; tried again when the launcher opens
            this._monitor = f.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connect('changed', (_m, file, other, ev) => this._onFileEvent(file, other, ev));
        } catch (e) {
            warn(`could not watch ${dir}: ${e.message}`);
        }
    }

    _unwatchVideos() {
        if (this._monitor) {
            try {
                this._monitor.cancel();
            } catch (_e) { /* already cancelled */ }
            this._monitor = null;
        }
    }

    // Called when the launcher opens: the recordings folder may have been created since.
    ensureWatching() {
        if (this._running && this._o.videos && !this._monitor)
            this._syncVideos();
    }

    _onFileEvent(file, other, ev) {
        const E = Gio.FileMonitorEvent;
        const target = ev === E.CHANGES_DONE_HINT || ev === E.MOVED_IN ? file : ev === E.RENAMED ? other : null;
        if (target)
            this._addFile(target).catch(e => dbg(`recording not added: ${e.message}`));
    }

    async _addFile(file) {
        const path = file.get_path();
        const name = baseName(path);
        if (!path || !isVideoName(name) || isTempName(name))
            return;
        const info = await queryInfo(file, 'standard::size,standard::type');
        const size = info.get_size();
        if (info.get_file_type() !== Gio.FileType.REGULAR || size <= 0 || !this._running)
            return;
        const i = this._items.findIndex(x => x.file?.path === path);
        if (i >= 0) {
            const [it] = this._items.splice(i, 1);
            it.file.size = size;
            it.ts = Date.now();
            this._items.unshift(it);
        } else {
            this._items.unshift({id: ++this._seq, ts: Date.now(), file: {path, kind: 'video', size, name}});
            this._trim();
        }
        this._changed();
    }

    // --- disk ----------------------------------------------------------------------------------

    _saveSoon() {
        if (this._o.persist && this._loaded && this._running)
            this._saver.call();
    }

    _flush(sync = false) {
        if (!this._o.persist || !this._loaded)
            return;
        this._saver.cancel();
        const dir = this._dir();
        try {
            GLib.mkdir_with_parents(dir, 0o700);
            const file = Gio.File.new_for_path(join(dir, INDEX));
            const text = JSON.stringify({v: 1, items: serializeItems(this._items)});
            if (sync) {
                file.replace_contents(enc.encode(text), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE, null);
            } else {
                writeBytes(file, new GLib.Bytes(enc.encode(text))).catch(e => warn(`could not save clipboard history: ${e.message}`));
            }
        } catch (e) {
            warn(`could not save clipboard history: ${e.message}`);
        }
    }

    _absPath(it) {
        if (it.image?.path)
            return it.image.linked ? it.image.path : join(this._dir(), it.image.path);
        return it.file?.path ?? null;
    }

    async _loadFromDisk() {
        const dir = this._dir();
        this._loaded = false;
        let raw = null;
        try {
            raw = JSON.parse(dec.decode(await loadBytes(Gio.File.new_for_path(join(dir, INDEX)))));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                warn(`clipboard history on disk ignored: ${e.message}`);
        }
        if (this._dead || !this._running)
            return;
        const have = new Set(this._items.map(x => x.text ?? x.image?.hash ?? x.file?.path));
        for (const r of reviveItems(raw?.v === 1 ? raw.items : [], this._max)) {
            const key = r.t === 'text' ? r.text : r.t === 'image' ? r.hash : r.path;
            if (have.has(key))
                continue;
            if (r.t === 'text') {
                this._items.push({id: ++this._seq, ts: r.ts, text: r.text});
            } else {
                const abs = r.t === 'image' && !r.linked ? join(dir, r.path) : r.path;
                if (!GLib.file_test(abs, GLib.FileTest.EXISTS))
                    continue; // the file was moved or deleted: forget the entry
                if (r.t === 'image')
                    this._items.push({id: ++this._seq, ts: r.ts, image: {mime: r.mime, hash: r.hash, size: r.size, info: r.info, bytes: null, path: r.path, linked: r.linked}});
                else
                    this._items.push({id: ++this._seq, ts: r.ts, file: {path: r.path, kind: 'video', size: r.size, name: r.name}});
            }
            have.add(key);
        }
        for (const j of imagesToDrop(this._items, this._maxImages).reverse())
            this._discard(this._items.splice(j, 1)[0]);
        this._trim();
        this._loaded = true;
        this._sweep(dir);
        // Copies that only exist in memory (made before saving was switched on) get written now.
        for (const it of this._items.filter(x => x.image?.bytes && !x.image.path && !x.image.linked))
            await this._writeCopy(it).catch(e => warn(`could not store image: ${e.message}`));
        this._changed();
    }

    // Image copies in the history folder that no item refers to any more (e.g. after a crash).
    _sweep(dir) {
        const used = new Set(this._items.filter(x => x.image && !x.image.linked && x.image.path).map(x => x.image.path));
        for (const n of namesIn(dir)) {
            if (isCopyName(n) && !used.has(n))
                deleteFile(join(dir, n));
        }
    }

    async _enablePersist() {
        await this._loadFromDisk();
    }

    // Saving switched off: the history on disk is deleted. Copied images are read back into memory first
    // so they stay usable for the rest of the session.
    async _disablePersist(dir) {
        this._loaded = false;
        this._saver.cancel();
        const copies = this._items.filter(x => x.image?.path && !x.image.linked);
        await Promise.allSettled(copies.map(async it => {
            it.image.bytes = new GLib.Bytes(await loadBytes(Gio.File.new_for_path(join(dir, it.image.path))));
            it.image.path = null;
        }));
        for (const n of namesIn(dir)) {
            if (n === INDEX || isCopyName(n))
                deleteFile(join(dir, n));
        }
        this._changed();
    }

    // The folder setting changed: copies move to the new folder, the old folder is left as it is.
    async _relocate(oldDir) {
        this._loaded = false;
        const nd = this._dir();
        GLib.mkdir_with_parents(nd, 0o700);
        const copies = this._items.filter(x => x.image?.path && !x.image.linked);
        await Promise.allSettled(copies.map(it => copyFile(join(oldDir, it.image.path), join(nd, it.image.path))));
        this._loaded = true;
        this._saveSoon();
    }

    // --- bookkeeping ---------------------------------------------------------------------------

    _removeWhere(pred) {
        const keep = [];
        let removed = false;
        for (const it of this._items) {
            if (pred(it)) {
                this._discard(it);
                removed = true;
            } else {
                keep.push(it);
            }
        }
        this._items = keep;
        return removed;
    }

    // A dropped image copy is deleted from disk. A linked file is never touched: it is not ours.
    _discard(it) {
        if (it?.image?.path && !it.image.linked && isCopyName(it.image.path))
            deleteFile(join(this._dir(), it.image.path));
    }

    _trim() {
        if (this._items.length <= this._max)
            return false;
        for (const it of this._items.splice(this._max))
            this._discard(it);
        return true;
    }

    _changed() {
        this._entries = null;
        this._onChange();
        this._saveSoon();
    }

    _wait(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timers.delete(id);
                resolve(!this._dead);
                return GLib.SOURCE_REMOVE;
            });
            this._timers.add(id);
        });
    }

    // --- entries -------------------------------------------------------------------------------

    // Newest first, as search entries (kinds 'clip', 'clipimage', 'clipfile').
    entries() {
        if (!this._entries) {
            this._entries = this._items.map(it => {
                if (it.image)
                    return this._imageEntry(it);
                if (it.file)
                    return this._fileEntry(it);
                return prepare({
                    id: `clip:${it.id}`, kind: 'clip', name: firstLine(it.text) || '(whitespace)',
                    desc: `${it.text.length} character${it.text.length === 1 ? '' : 's'}`,
                    category: 'Clipboard', icon: 'edit-paste-symbolic',
                    keywords: it.text.slice(0, 1000), payload: {text: it.text},
                });
            });
        }
        return this._entries;
    }

    _imageEntry(it) {
        const m = it.image;
        const l = imageLabels(m.info, m.size);
        const linked = m.linked ? baseName(m.path) : '';
        const e = prepare({
            id: `clip:${it.id}`, kind: 'clipimage', name: l.name,
            desc: linked ? `${l.desc} · linked: ${linked}` : l.desc, keywords: `${l.keywords} ${linked}`.trim(),
            category: 'Clipboard', icon: 'image-x-generic-symbolic', payload: {imageId: it.id},
        });
        if (m.path)
            e._gi = Gio.FileIcon.new(Gio.File.new_for_path(this._absPath(it))); // thumbnail from the file
        else if (m.bytes)
            e._gi = Gio.BytesIcon.new(m.bytes);
        return e;
    }

    _fileEntry(it) {
        return prepare({
            id: `clip:${it.id}`, kind: 'clipfile', ...fileLabels(it.file),
            category: 'Clipboard', icon: 'video-x-generic-symbolic', payload: {fileId: it.id},
        });
    }

    // --- using an item -------------------------------------------------------------------------

    // Enter: put it back on the clipboard (a file goes as a file reference). Ctrl+Enter opens it,
    // Alt+Enter shows its folder. Both only apply to items that are backed by a file.
    useItem(id, how = '', onSet = null) {
        const it = this._items.find(x => x.id === id && (x.image || x.file));
        if (!it)
            return;
        const path = this._absPath(it);
        if (path && !GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this._missing(it);
            return;
        }
        if (path && how === 'ctrl') {
            this._host.openUri?.(Gio.File.new_for_path(path).get_uri());
            return;
        }
        if (path && how === 'alt') {
            this._host.openUri?.(Gio.File.new_for_path(GLib.path_get_dirname(path)).get_uri());
            return;
        }
        const cb = St.Clipboard.get_default();
        if (it.file) {
            const uri = `${Gio.File.new_for_path(path).get_uri()}\r\n`;
            cb.set_content(St.ClipboardType.CLIPBOARD, 'text/uri-list', new GLib.Bytes(enc.encode(uri)));
            onSet?.();
        } else if (it.image.bytes) {
            cb.set_content(St.ClipboardType.CLIPBOARD, it.image.mime, it.image.bytes);
            onSet?.();
        } else if (path) {
            loadBytes(Gio.File.new_for_path(path)).then(data => {
                if (this._dead)
                    return;
                cb.set_content(St.ClipboardType.CLIPBOARD, it.image.mime, new GLib.Bytes(data));
                onSet?.(); // only now is the image on the clipboard, so this is when it can be pasted
            }).catch(e => this._host.notify?.(`Could not read ${baseName(path)}: ${e.message}`));
        }
    }

    _missing(it) {
        const name = it.file?.name ?? baseName(it.image?.path);
        this._removeWhere(x => x === it);
        this._changed();
        this._host.notify?.(`${name} is no longer there, so it was removed from the clipboard history.`);
    }

    clear() {
        this._removeWhere(() => true);
        this._changed();
    }

    destroy() {
        this._dead = true;
        this.stop();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers.clear();
        this._items = [];
        this._entries = null;
    }
}

// Empties the clipboard, but only if it still holds `text` (the user may have copied something
// else since). Used to take a copied password off the clipboard again.
export function clearClipboardIf(text, done = () => {}) {
    const cb = St.Clipboard.get_default();
    cb.get_text(St.ClipboardType.CLIPBOARD, (_c, current) => {
        if (current === text) {
            cb.set_text(St.ClipboardType.CLIPBOARD, '');
            done(true);
        } else {
            done(false);
        }
    });
}

export function copyText(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

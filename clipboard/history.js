import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {prepare} from '../search/engine.js';
import {Debounce} from '../utils/timing.js';
import {dbg} from '../utils/log.js';
import {clipboardKind, imageInfo, imageLabels, imagesToDrop} from './image.js';

const MAX_CHARS = 20000;

function firstLine(text) {
    const line = text.split('\n').find(l => l.trim()) ?? '';
    const t = line.trim().replace(/\s+/g, ' ');
    return t.length > 100 ? `${t.slice(0, 100)}…` : t;
}

// Clipboard history (text and, optionally, images), kept in memory only (never written to disk).
// Event-driven: it reacts to Mutter's selection `owner-changed` signal, there is no polling.
// Images are bounded by count and by size per image, and are only read when the clipboard offers
// no text.
export class ClipboardHistory {
    constructor(onChange) {
        this._items = [];
        this._max = 25;
        this._seq = 0;
        this._entries = null;
        this._onChange = onChange;
        this._sel = null;
        this._sig = 0;
        this._muteUntil = 0;
        this._images = false;
        this._maxImages = 8;
        this._maxImageBytes = 4 * 1024 * 1024;
        this._read = new Debounce(120, () => this._fetch());
    }

    get active() {
        return this._sig !== 0;
    }

    // Ignore clipboard changes for the next `ms` milliseconds. Used while the emoji picker briefly
    // borrows the clipboard to paste, so the emoji and the restored text do not land in history.
    mute(ms) {
        this._muteUntil = Math.max(this._muteUntil, GLib.get_monotonic_time() + ms * 1000);
    }

    // Image support on/off, how many images to keep and the largest image (in MB) worth keeping.
    setImages(enabled, count, mb) {
        this._images = enabled;
        this._maxImages = count;
        this._maxImageBytes = mb * 1024 * 1024;
        let changed = false;
        if (!enabled) {
            const before = this._items.length;
            this._items = this._items.filter(it => !it.image);
            changed = this._items.length !== before;
        } else {
            for (const i of imagesToDrop(this._items, count).reverse()) {
                this._items.splice(i, 1);
                changed = true;
            }
            this._read.call(); // an image may already be sitting on the clipboard
        }
        if (changed)
            this._changed();
    }

    setMax(n) {
        this._max = n;
        if (this._trim())
            this._changed();
    }

    start() {
        if (this._sig)
            return;
        this._sel = global.display.get_selection();
        this._sig = this._sel.connect('owner-changed', (_s, type) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD)
                this._read.call();
        });
        this._read.call();
        dbg('clipboard history started');
    }

    stop() {
        this._read.cancel();
        if (this._sig)
            this._sel.disconnect(this._sig);
        this._sig = 0;
        this._sel = null;
    }

    _fetch() {
        if (GLib.get_monotonic_time() < this._muteUntil)
            return;
        const cb = St.Clipboard.get_default();
        let kind = {kind: 'text'};
        try {
            kind = clipboardKind(cb.get_mimetypes(St.ClipboardType.CLIPBOARD), this._images);
        } catch (_e) { /* no mimetype list: fall back to text */ }
        if (!kind)
            return;
        if (kind.kind === 'image') {
            cb.get_content(St.ClipboardType.CLIPBOARD, kind.mime, (_c, bytes) => {
                if (this._sig && bytes)
                    this._addImage(kind.mime, bytes);
            });
            return;
        }
        cb.get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (this._sig)
                this._add(text);
        });
    }

    _addImage(mime, bytes) {
        const size = bytes.get_size();
        if (size === 0 || size > this._maxImageBytes) {
            dbg(`image skipped (${size} bytes)`);
            return;
        }
        const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
        const i = this._items.findIndex(x => x.image?.hash === hash);
        if (i === 0)
            return;
        if (i > 0)
            this._items.splice(i, 1);
        this._items.unshift({id: ++this._seq, image: {mime, bytes, hash, size, info: imageInfo(bytes.get_data())}});
        for (const j of imagesToDrop(this._items, this._maxImages).reverse())
            this._items.splice(j, 1);
        this._trim();
        this._changed();
    }

    _add(text) {
        if (!text || !text.trim() || text.length > MAX_CHARS)
            return;
        const i = this._items.findIndex(x => x.text === text);
        if (i === 0)
            return;
        if (i > 0)
            this._items.splice(i, 1);
        this._items.unshift({text, id: ++this._seq});
        this._trim();
        this._changed();
    }

    _trim() {
        if (this._items.length <= this._max)
            return false;
        this._items.length = this._max;
        return true;
    }

    _changed() {
        this._entries = null;
        this._onChange();
    }

    // Newest first, as search entries (kind 'clip').
    entries() {
        if (!this._entries) {
            this._entries = this._items.map(it => it.image ? this._imageEntry(it) : prepare({
                id: `clip:${it.id}`, kind: 'clip', name: firstLine(it.text) || '(whitespace)',
                desc: `${it.text.length} character${it.text.length === 1 ? '' : 's'}`,
                category: 'Clipboard', icon: 'edit-paste-symbolic',
                keywords: it.text.slice(0, 1000), payload: {text: it.text},
            }));
        }
        return this._entries;
    }

    _imageEntry(it) {
        const e = prepare({
            id: `clip:${it.id}`, kind: 'clipimage', ...imageLabels(it.image.info, it.image.size),
            category: 'Clipboard', icon: 'image-x-generic-symbolic', payload: {imageId: it.id},
        });
        e._gi = Gio.BytesIcon.new(it.image.bytes); // shown as the row's thumbnail
        return e;
    }

    // Put a remembered image back on the clipboard.
    copyImage(id) {
        const it = this._items.find(x => x.id === id && x.image);
        if (it)
            St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, it.image.mime, it.image.bytes);
    }

    clear() {
        this._items = [];
        this._changed();
    }

    destroy() {
        this.stop();
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

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {prepare} from '../search/engine.js';
import {Debounce} from '../utils/timing.js';
import {dbg} from '../utils/log.js';

const MAX_CHARS = 20000;

function firstLine(text) {
    const line = text.split('\n').find(l => l.trim()) ?? '';
    const t = line.trim().replace(/\s+/g, ' ');
    return t.length > 100 ? `${t.slice(0, 100)}…` : t;
}

// Text-only clipboard history, kept in memory only (never written to disk). Event-driven:
// it reacts to Mutter's selection `owner-changed` signal, there is no polling.
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
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_c, text) => {
            if (this._sig)
                this._add(text);
        });
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
            this._entries = this._items.map(it => prepare({
                id: `clip:${it.id}`, kind: 'clip', name: firstLine(it.text) || '(whitespace)',
                desc: `${it.text.length} character${it.text.length === 1 ? '' : 's'}`,
                category: 'Clipboard', icon: 'edit-paste-symbolic',
                keywords: it.text.slice(0, 1000), payload: {text: it.text},
            }));
        }
        return this._entries;
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

export function copyText(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
}

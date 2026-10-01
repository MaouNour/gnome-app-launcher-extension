import Gio from 'gi://Gio';

import {prepare} from '../search/engine.js';
import {Debounce, Idle} from '../utils/timing.js';
import {dbg, warn} from '../utils/log.js';

const CHANGE_DEBOUNCE_MS = 600;
const SAVE_DEBOUNCE_MS = 2000;

const sigOf = r => [r.n, r.d, r.ic, r.k, r.f].join('\u0000');

// Compact, JSON-friendly record (this is exactly what is persisted).
function recordOf(info) {
    const id = info.get_id();
    if (!id)
        return null;
    const generic = info.get_generic_name?.() ?? '';
    const keywords = info.get_keywords?.() ?? [];
    return {
        i: id,
        n: info.get_name() ?? '',
        d: info.get_description() || generic || '',
        k: [generic, ...keywords].filter(Boolean).join(' '),
        ic: info.get_icon()?.to_string() ?? '',
        f: info.get_filename?.() ?? '',
    };
}

function validRecord(r) {
    return r && typeof r.i === 'string' && r.i && typeof r.n === 'string' &&
        ['d', 'k', 'ic', 'f'].every(k => typeof r[k] === 'string');
}

function entryOf(r) {
    return prepare({
        id: `app:${r.i}`,
        kind: 'app',
        name: r.n,
        desc: r.d,
        category: 'Applications',
        icon: r.ic,
        keywords: r.k,
        payload: {appId: r.i, file: r.f},
    });
}

// Flow: persisted cache is loaded asynchronously and shown immediately; a low-priority
// refresh then diffs it against the installed apps and updates only what changed. After
// that, refreshes happen only when Gio's AppInfoMonitor reports a change (no polling).
export class AppIndex {
    constructor(store, onChanged) {
        this._store = store;
        this._onChanged = onChanged;
        this._map = new Map(); // appId -> {rec, sig, entry}
        this._entries = null;
        this._ready = false;
        this._destroyed = false;
        this._persist = true;
        this._monitor = null;
        this._monitorId = 0;
        this._changed = new Debounce(CHANGE_DEBOUNCE_MS, () => this.refresh());
        this._verify = new Idle(() => this.refresh());
        this._saver = new Debounce(SAVE_DEBOUNCE_MS, () => this._save(), 300);
    }

    setPersist(value) {
        this._persist = value;
    }

    start() {
        this._monitor = Gio.AppInfoMonitor.get();
        this._monitorId = this._monitor.connect('changed', () => this._changed.call());
        if (this._persist)
            this._loadCache();
        else
            this._verify.schedule();
    }

    async _loadCache() {
        const data = await this._store.load();
        if (this._destroyed)
            return;
        if (!this._ready && Array.isArray(data)) {
            let bad = 0;
            for (const rec of data) {
                if (!validRecord(rec)) {
                    bad++;
                    continue;
                }
                this._map.set(rec.i, {rec, sig: sigOf(rec), entry: entryOf(rec)});
            }
            if (bad)
                warn(`dropped ${bad} invalid cached app records`);
            this._ready = this._map.size > 0;
            if (this._ready) {
                this._entries = null;
                this._onChanged();
            }
            dbg('app cache loaded:', this._map.size);
        }
        this._verify.schedule(); // reconcile with reality at low priority
    }

    // Called when the launcher opens. If nothing is loaded yet, does a synchronous scan
    // (only ever the first time, before the cache arrived). Returns true if it did work.
    ensureReady() {
        if (this._ready)
            return false;
        this.refresh();
        return true;
    }

    entries() {
        if (!this._entries)
            this._entries = [...this._map.values()].map(v => v.entry);
        return this._entries;
    }

    // Diff installed applications against the index; touch only what changed.
    refresh() {
        if (this._destroyed)
            return;
        let changed = false;
        const seen = new Set();
        for (const info of Gio.AppInfo.get_all()) {
            try {
                if (!info.should_show())
                    continue;
                const rec = recordOf(info);
                if (!rec)
                    continue;
                seen.add(rec.i);
                const sig = sigOf(rec);
                const old = this._map.get(rec.i);
                if (!old || old.sig !== sig) {
                    this._map.set(rec.i, {rec, sig, entry: entryOf(rec)});
                    changed = true;
                }
            } catch (e) {
                warn('skipping application:', e.message);
            }
        }
        for (const id of [...this._map.keys()]) {
            if (!seen.has(id)) {
                this._map.delete(id);
                changed = true;
            }
        }
        const firstTime = !this._ready;
        this._ready = true;
        if (changed || firstTime) {
            this._entries = null;
            this._saver.call();
            this._onChanged();
        }
        dbg('app refresh done; changed =', changed, 'count =', this._map.size);
    }

    // Drop the cache and rescan (used by the "clear cache" button and recovery paths).
    rebuild() {
        this._map.clear();
        this._entries = null;
        this._ready = false;
        this._store.remove();
        this.refresh();
    }

    _save() {
        if (!this._persist || this._destroyed)
            return;
        this._store.save([...this._map.values()].map(v => v.rec));
    }

    destroy() {
        this._destroyed = true;
        this._changed.cancel();
        this._verify.cancel();
        // Only write on disable if a save was still pending (avoids disk I/O on every
        // disable/enable cycle such as screen lock).
        const pending = this._saver.pending && this._persist && this._map.size > 0;
        this._saver.cancel();
        if (pending)
            this._store.saveSync([...this._map.values()].map(v => v.rec));
        if (this._monitorId)
            this._monitor.disconnect(this._monitorId);
        this._monitor = null;
        this._monitorId = 0;
        this._store.cancel();
        this._map.clear();
        this._entries = null;
    }
}

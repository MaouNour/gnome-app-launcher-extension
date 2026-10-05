import {Debounce} from '../utils/timing.js';

const MAX_ENTRIES = 1500;
const SAVE_DELAY_MS = 8000;

// Launch counts + last-used time per entry id: {id: [count, lastUsedUnixSeconds]}.
// In memory while running; written debounced (and once more on disable).
export class Stats {
    constructor(store) {
        this._store = store;
        this._map = new Map();
        this._dirty = false;
        this._save = new Debounce(SAVE_DELAY_MS, () => this.flush(), 300 /* G_PRIORITY_LOW */);
    }

    async load() {
        const data = await this._store.load();
        if (data && typeof data === 'object') {
            for (const [id, v] of Object.entries(data)) {
                if (Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]))
                    this._map.set(id, [v[0], v[1]]);
            }
        }
    }

    get(id) {
        return this._map.get(id);
    }

    entries() {
        return this._map.entries();
    }

    // Forgets how often and when an entry was used.
    forget(id) {
        if (this._map.delete(id)) {
            this._dirty = true;
            this._save.call();
        }
    }

    hit(id) {
        const s = this._map.get(id) ?? [0, 0];
        s[0] += 1;
        s[1] = Math.floor(Date.now() / 1000);
        this._map.set(id, s);
        this._dirty = true;
        this._save.call();
    }

    _snapshot() {
        let items = [...this._map.entries()];
        if (items.length > MAX_ENTRIES) {
            items.sort((a, b) => b[1][1] - a[1][1]);
            items = items.slice(0, MAX_ENTRIES);
            this._map = new Map(items);
        }
        return Object.fromEntries(items);
    }

    flush() {
        if (!this._dirty)
            return;
        this._dirty = false;
        this._store.save(this._snapshot());
    }

    destroy() {
        this._save.cancel();
        if (this._dirty) {
            this._store.saveSync(this._snapshot());
            this._dirty = false;
        }
        this._store.cancel();
    }

    reset() {
        this._map.clear();
        this._dirty = false;
        this._save.cancel();
        this._store.remove();
    }
}

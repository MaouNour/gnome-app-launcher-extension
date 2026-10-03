// Pure JS (no GI imports): the list of searches you ran, newest first, and how the Up/Down arrows walk it.

export const MAX_QUERY_LEN = 200;

export class QueryHistory {
    // max: how many searches to keep; 0 = no limit.
    constructor(max = 50) {
        this._items = [];
        this._max = QueryHistory.limit(max);
    }

    static limit(n) {
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
    }

    get size() {
        return this._items.length;
    }

    list() {
        return this._items.slice();
    }

    at(i) {
        return this._items[i];
    }

    setMax(n) {
        this._max = QueryHistory.limit(n);
        return this._trim();
    }

    // Remembers a search. Returns true when the list changed. A search that is already in the list moves to
    // the front instead of appearing twice; blank or very long text is ignored.
    add(query) {
        if (typeof query !== 'string')
            return false;
        const q = query.replace(/\s+/g, ' ').trim();
        if (!q || q.length > MAX_QUERY_LEN)
            return false;
        if (this._items[0] === q)
            return false;
        const i = this._items.indexOf(q);
        if (i > 0)
            this._items.splice(i, 1);
        this._items.unshift(q);
        this._trim();
        return true;
    }

    _trim() {
        if (this._items.length <= this._max)
            return false;
        this._items.length = this._max;
        return true;
    }

    clear() {
        this._items = [];
    }

    // Walks the list. `cursor` is -1 while the text field holds what you typed (nothing recalled yet),
    // otherwise the position of the recalled search (0 = newest). dir -1 = older (Up), +1 = newer (Down).
    // Returns the new cursor, or null when there is nowhere to go.
    step(cursor, dir) {
        if (dir < 0) {
            const next = cursor + 1;
            return next < this._items.length ? next : null;
        }
        return cursor >= 0 ? cursor - 1 : null;
    }

    // Replaces the list with stored data (validated), keeping at most the current limit.
    load(raw) {
        const seen = new Set();
        const out = [];
        if (Array.isArray(raw)) {
            for (const q of raw) {
                if (typeof q !== 'string')
                    continue;
                const t = q.replace(/\s+/g, ' ').trim();
                if (!t || t.length > MAX_QUERY_LEN || seen.has(t))
                    continue;
                seen.add(t);
                out.push(t);
            }
        }
        this._items = out;
        this._trim();
    }

    // Merges stored data that arrived after some searches were already made: what is in memory stays in front.
    merge(raw) {
        const mine = this._items.slice();
        this.load(raw);
        for (const q of mine.reverse())
            this.add(q);
    }

    toJSON() {
        return this._items.slice();
    }
}

// Pure JS (no GI imports): unit-testable and benchmarkable under plain node.
//
import {extractRegexKeywords} from './regex.js';
//
// Entries are "prepared" once (lowercased/diacritic-folded copies of their text fields),
// so a keystroke only does cheap string comparisons against in-memory data. Extending the
// previous query (typing another character) re-scans only the previous matches.

const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /[\u0300-\u036f]/g;
const SEP = /[\s\-_.()/:,]+/g;

export function fold(s) {
    s = s.toLowerCase();
    return NON_ASCII.test(s) ? s.normalize('NFD').replace(MARKS, '') : s;
}

// Adds search metadata to an entry ({name, desc, keywords, category}). Idempotent.
export function prepare(e) {
    // Custom commands/actions may carry /regex/ keywords: split them from the plain words.
    if (e.rxKeywords) {
        const {plain, patterns} = extractRegexKeywords(e.keywords);
        e.keywords = plain;
        e._rx = patterns;
    }
    const n = fold(e.name || '');
    e._n = n;
    e._nw = ` ${n.replace(SEP, ' ').trim()}`;
    e._i = e._nw.split(' ').filter(Boolean).map(w => w[0]).join('');
    const k = fold(e.keywords || '');
    e._k = k;
    e._kw = ` ${k.replace(SEP, ' ')}`;
    e._c = ` ${fold(e.category || '').replace(SEP, ' ')}`;
    e._d = fold(e.desc || '');
    return e;
}

// Frecency: log-scaled use count, decaying with time since last use. Range ~0..200.
export function frecency(stat, nowSec) {
    if (!stat)
        return 0;
    const ageDays = Math.max(0, (nowSec - stat[1]) / 86400);
    return Math.min(200, 45 * Math.log2(1 + stat[0])) / (1 + ageDays / 30);
}

function fuzzyScore(t, s) {
    let ti = 0;
    let score = 0;
    let last = -2;
    let first = -1;
    for (let i = 0; i < s.length && ti < t.length; i++) {
        if (s.charCodeAt(i) !== t.charCodeAt(ti))
            continue;
        if (first < 0)
            first = i;
        let b = 10;
        if (i === last + 1)
            b += 15;
        if (i === 0 || s.charCodeAt(i - 1) === 32)
            b += 12;
        score += b;
        last = i;
        ti++;
    }
    if (ti < t.length)
        return 0;
    const gaps = last - first + 1 - t.length;
    return Math.min(340, Math.max(1, 60 + score - Math.min(first, 20) - gaps * 0.5));
}

function scoreToken(t, e, fuzzy, descs) {
    const n = e._n;
    if (n === t)
        return 1000;
    if (n.startsWith(t))
        return 800 - Math.min(n.length - t.length, 60) * 0.5;
    const wp = e._nw.indexOf(` ${t}`);
    if (wp >= 0)
        return 650 - Math.min(wp, 100) * 0.3;
    if (t.length > 1 && e._i.startsWith(t))
        return 600;
    const sub = n.indexOf(t);
    if (sub >= 0)
        return 450 - Math.min(sub, 100) * 0.5;
    let best = 0;
    // Short tokens only match names, so one-letter queries are not flooded by
    // keyword/description/category noise.
    if (t.length >= 2 && e._kw.indexOf(` ${t}`) >= 0)
        best = 300;
    else if (t.length >= 3 && e._k.includes(t))
        best = 200;
    if (best < 250 && t.length >= 3 && e._c.indexOf(` ${t}`) >= 0)
        best = 250;
    if (fuzzy && t.length > 1) {
        const f = fuzzyScore(t, n);
        if (f > best)
            best = f;
    }
    if (best === 0 && descs && t.length >= 3 && e._d && e._d.includes(t))
        best = 80;
    return best;
}

export class SearchEngine {
    constructor() {
        this._entries = [];
        this._byId = new Map();
        this._alpha = null;
        this._rxEntries = [];
        this._prevQ = '';
        this._prevIdx = null;
        this._prevKey = '';
        this.stats = null; // object with get(id) and entries(), or null
    }

    setEntries(list) {
        this._entries = list;
        this._byId = new Map(list.map(e => [e.id, e]));
        this._rxEntries = list.filter(e => e._rx?.length);
        this._alpha = null;
        this._prevIdx = null;
        this._prevQ = '';
    }

    get size() {
        return this._entries.length;
    }

    // Normal search, plus entries whose /regex/ keywords match the whole query (those come first).
    search(query, opts = {}) {
        const out = this._search(query, opts);
        const q = String(query ?? '').trim();
        if (!q || this._rxEntries.length === 0)
            return out;
        const hits = this._rxEntries.filter(e => e._rx.some(r => r.test(q)));
        if (hits.length === 0)
            return out;
        const seen = new Set(hits.map(e => e.id));
        return [...hits, ...out.filter(e => !seen.has(e.id))].slice(0, opts.limit ?? 30);
    }

    // Regular-expression search over names, keywords and (optionally) descriptions. `re` comes from
    // parseRegexQuery(), so it is already known to be safe; only short slices of text are tested.
    // Name matches rank above keyword matches above description matches; earlier and fuller
    // matches rank higher.
    searchRegex(re, opts = {}) {
        const limit = opts.limit ?? 30;
        const descs = opts.descriptions ?? true;
        const useFrec = (opts.frecency ?? true) && this.stats;
        const now = Math.floor(Date.now() / 1000);
        const hits = [];
        // Only short slices are tested and the whole scan has a time budget: a pattern that is merely
        // polynomial can still be slow over thousands of entries, so partial results beat a frozen shell.
        const deadline = Date.now() + (opts.budgetMs ?? 60);
        let n = 0;
        for (const e of this._entries) {
            if ((++n & 31) === 0 && Date.now() > deadline)
                break;
            const name = (e.name || '').slice(0, 120);
            let score = 0;
            let m = re.exec(name);
            if (m)
                score = 1000 - Math.min(m.index, 100) * 3 + (m[0].length === name.length ? 100 : 0);
            else if (re.test((e.keywords || '').slice(0, 200)))
                score = 300;
            else if (descs && re.test((e.desc || '').slice(0, 150)))
                score = 100;
            if (!score)
                continue;
            if (useFrec)
                score += frecency(this.stats.get(e.id), now);
            hits.push([score, e]);
        }
        hits.sort((a, b) => b[0] - a[0] || a[1]._n.length - b[1]._n.length || (a[1]._n < b[1]._n ? -1 : 1));
        return hits.slice(0, limit).map(h => h[1]);
    }

    // opts: {limit, initial, fuzzy, descriptions, frecency, natural}
    // limit/initial may be Infinity; `natural` fills an empty query in entry order, not A-Z.
    _search(query, opts = {}) {
        const limit = opts.limit ?? 30;
        const fuzzy = opts.fuzzy ?? true;
        const descs = opts.descriptions ?? true;
        const useFrec = (opts.frecency ?? true) && this.stats;
        const now = Math.floor(Date.now() / 1000);

        const q = fold(query).replace(/\s+/g, ' ').trimStart();
        if (!q.trim())
            return this._initial(opts.initial ?? 8, useFrec, now, opts.natural ?? false, opts.recent ?? null, opts.favorites ?? null);

        const tokens = q.split(' ').filter(Boolean);
        const list = this._entries;
        const key = `${fuzzy}${descs}`;

        // Appending characters can only remove matches, so re-scan the previous matches only.
        const narrow = this._prevIdx && this._prevKey === key && q.startsWith(this._prevQ);
        const candidates = narrow ? this._prevIdx : null;
        const count = candidates ? candidates.length : list.length;

        const idx = [];
        const scores = [];
        for (let c = 0; c < count; c++) {
            const i = candidates ? candidates[c] : c;
            const e = list[i];
            let total = 0;
            let ok = true;
            for (let k = 0; k < tokens.length; k++) {
                const s = scoreToken(tokens[k], e, fuzzy, descs);
                if (s === 0) {
                    ok = false;
                    break;
                }
                total += s;
            }
            if (!ok)
                continue;
            if (useFrec)
                total += frecency(this.stats.get(e.id), now);
            idx.push(i);
            scores.push(total);
        }
        this._prevIdx = idx;
        this._prevQ = q;
        this._prevKey = key;

        const order = idx.map((_, j) => j);
        order.sort((a, b) => scores[b] - scores[a] ||
            list[idx[a]]._n.length - list[idx[b]]._n.length ||
            (list[idx[a]]._n < list[idx[b]]._n ? -1 : 1));
        const n = Math.min(limit, order.length);
        const out = new Array(n);
        for (let j = 0; j < n; j++)
            out[j] = list[idx[order[j]]];
        return out;
    }

    get(id) {
        return this._byId.get(id) ?? null;
    }

    // Empty query. Favorites (ids, in the order given) come first and always all show; the rest of `count`
    // is the entries used most recently (recent: {fill}) or most often, then an alphabetical (or natural) fill.
    // `fill` false leaves out entries that were never used.
    _initial(count, useFrec, now, natural, recent = null, favorites = null) {
        this._prevIdx = null;
        this._prevQ = '';
        const out = [];
        const seen = new Set();
        for (const id of favorites ?? []) {
            const e = this._byId.get(id);
            if (e && !seen.has(id)) {
                out.push(e);
                seen.add(id);
            }
        }
        if (count <= out.length)
            return out;
        const take = scored => {
            for (const [, e] of scored) {
                if (out.length >= count)
                    break;
                if (!seen.has(e.id)) {
                    out.push(e);
                    seen.add(e.id);
                }
            }
        };
        let usedAny = false;
        if (recent && this.stats) {
            const used = [];
            for (const [id, stat] of this.stats.entries()) {
                const e = this._byId.get(id);
                if (e)
                    used.push([stat[1], e]);
            }
            used.sort((a, b) => b[0] - a[0]);
            take(used);
            usedAny = used.length > 0;
            if (!recent.fill)
                return out;
        }
        if (useFrec && this.stats && !usedAny) {
            const scored = [];
            for (const [id, stat] of this.stats.entries()) {
                const e = this._byId.get(id);
                if (e)
                    scored.push([frecency(stat, now), e]);
            }
            scored.sort((a, b) => b[0] - a[0]);
            take(scored);
        }
        if (out.length < count) {
            if (!natural && !this._alpha)
                this._alpha = [...this._entries].sort((a, b) => (a._n < b._n ? -1 : a._n > b._n ? 1 : 0));
            for (const e of natural ? this._entries : this._alpha) {
                if (out.length >= count)
                    break;
                if (!seen.has(e.id))
                    out.push(e);
            }
        }
        return out;
    }
}

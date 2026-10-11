import {compileKeywordPattern, extractRegexKeywords} from './regex.js';
import {parseKeywordList} from './keywords.js';

const NON_ASCII = /[^\x00-\x7f]/;
const MARKS = /[\u0300-\u036f]/g;
const SEP = /[\s\-_.()/:,]+/g;

export function fold(s) {
    s = s.toLowerCase();
    return NON_ASCII.test(s) ? s.normalize('NFD').replace(MARKS, '') : s;
}

export function prepare(e) {
    if (e.rxKeywords && !e._rxDone) {
        e._rxDone = true;
        if (e.kwSep) {
            const {phrases, patterns} = parseKeywordList(e.keywords, e.kwSep, !!e.rxWhole);
            e.keywords = phrases.join(' ');
            e._rx = patterns;
            e._kp = phrases.map(p => fold(p).replace(/\s+/g, ' ').trim()).filter(Boolean);
        } else if (e.rxWhole) {
            const re = compileKeywordPattern(e.keywords);
            e.keywords = '';
            e._rx = re ? [re] : [];
        } else {
            const {plain, patterns} = extractRegexKeywords(e.keywords);
            e.keywords = plain;
            e._rx = patterns;
        }
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

function phraseScore(q, phrases) {
    let best = 0;
    for (const p of phrases) {
        let s = 0;
        if (p === q)
            s = 900;
        else if (q.length >= 2 && p.startsWith(q))
            s = 520 - Math.min(p.length - q.length, 40) * 0.5;
        else if (q.length >= 3 && p.includes(q))
            s = 300;
        if (s > best)
            best = s;
    }
    return best;
}

export class SearchEngine {
    constructor() {
        this._entries = [];
        this._byId = new Map();
        this._alpha = null;
        this._rxEntries = [];
        this._phraseIdx = [];
        this._prevQ = '';
        this._prevIdx = null;
        this._prevKey = '';
        this.stats = null;
    }

    setEntries(list) {
        this._entries = list;
        this._byId = new Map(list.map(e => [e.id, e]));
        this._rxEntries = list.filter(e => e._rx?.length);
        this._phraseIdx = [];
        list.forEach((e, i) => {
            if (e._kp?.length)
                this._phraseIdx.push(i);
        });
        this._alpha = null;
        this._prevIdx = null;
        this._prevQ = '';
    }

    get size() {
        return this._entries.length;
    }

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

    searchRegex(re, opts = {}) {
        const limit = opts.limit ?? 30;
        const descs = opts.descriptions ?? true;
        const useFrec = (opts.frecency ?? true) && this.stats;
        const now = Math.floor(Date.now() / 1000);
        const hits = [];
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

        const narrow = this._prevIdx && this._prevKey === key && q.startsWith(this._prevQ);
        let candidates = narrow ? this._prevIdx : null;
        if (candidates && this._phraseIdx.length) {
            const seen = new Set(candidates);
            const extra = this._phraseIdx.filter(i => !seen.has(i));
            if (extra.length)
                candidates = candidates.concat(extra);
        }
        const phraseQ = q.trimEnd();
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
            if (e._kp) {
                const ps = phraseScore(phraseQ, e._kp);
                if (ps > 0 && (!ok || ps > total)) {
                    total = ps;
                    ok = true;
                }
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

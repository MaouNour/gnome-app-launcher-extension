// Pure JS (no GI imports). Converts text typed with another keyboard layout into what the same keys
// produce on the layout the entries are named in (Arabic "لىةث" -> Latin "gnme"), so a search typed
// with the wrong layout still finds things.
//
// A map is plain text, one pair per line: what was typed, whitespace, what it stands for.
//     ض q
//     ص w
//     لا b        (the typed side may be more than one character; the longest match wins)
// Empty lines and lines starting with # are ignored. Characters that are not in the map stay as they are.

const MAX_MAPS = 16;
const MAX_PAIRS = 400;
const MAX_TEXT = 20000;
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Standard Arabic (101) layout, unshifted keys plus the shifted letters that stand for a Latin letter.
export const ARABIC_TEXT = [
    'ض q', 'ص w', 'ث e', 'ق r', 'ف t', 'غ y', 'ع u', 'ه i', 'خ o', 'ح p', 'ج [', 'د ]',
    'ش a', 'س s', 'ي d', 'ب f', 'ل g', 'ا h', 'ت j', 'ن k', 'م l', 'ك ;', "ط '",
    'ئ z', 'ء x', 'ؤ c', 'ر v', 'لا b', 'ى n', 'ة m', 'و ,', 'ز .', 'ظ /', 'ذ `',
    'لأ G', 'لإ T', 'لآ B', 'أ H', 'إ Y', 'آ N',
    '١ 1', '٢ 2', '٣ 3', '٤ 4', '٥ 5', '٦ 6', '٧ 7', '٨ 8', '٩ 9', '٠ 0',
].join('\n');

export const newMap = () => ({id: `map${Date.now().toString(36)}`, name: 'New layout', enabled: true, text: ''});
export const arabicMap = () => ({id: 'arabic', name: 'Arabic (standard)', enabled: true, text: ARABIC_TEXT});
export const DEFAULT_MAPS = [arabicMap()];

export function sanitizeMap(raw, index = 0) {
    if (!raw || typeof raw !== 'object')
        return null;
    const text = typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : '';
    const id = clean(raw.id, 40).replace(/[^A-Za-z0-9_-]/g, '') || `m${index}`;
    return {id, name: clean(raw.name, 60) || 'Layout', enabled: raw.enabled !== false, text};
}

export function sanitizeMaps(list) {
    if (!Array.isArray(list))
        return [];
    const seen = new Set();
    const out = [];
    list.forEach((raw, i) => {
        const m = sanitizeMap(raw, i);
        if (!m || seen.has(m.id) || out.length >= MAX_MAPS)
            return;
        seen.add(m.id);
        out.push(m);
    });
    return out;
}

// Map text -> {pairs: Map(typed -> result), maxLen}. Never throws; bad lines are skipped.
export function parseMapText(text) {
    const pairs = new Map();
    let maxLen = 1;
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#'))
            continue;
        const [from, to] = t.split(/\s+/);
        if (!from || to === undefined || pairs.has(from))
            continue;
        if (pairs.size >= MAX_PAIRS)
            break;
        pairs.set(from, to);
        maxLen = Math.max(maxLen, Array.from(from).length);
    }
    return {pairs, maxLen};
}

// Enabled maps, parsed once; the extension keeps the result until the setting changes.
export function compileMaps(list) {
    return sanitizeMaps(list).filter(m => m.enabled).map(m => ({id: m.id, name: m.name, ...parseMapText(m.text)}))
        .filter(m => m.pairs.size > 0);
}

function applyMap(chars, map) {
    let out = '';
    let hits = 0;
    for (let i = 0; i < chars.length;) {
        let step = 0;
        for (let len = Math.min(map.maxLen, chars.length - i); len >= 1; len--) {
            const to = map.pairs.get(len === 1 ? chars[i] : chars.slice(i, i + len).join(''));
            if (to !== undefined) {
                out += to;
                step = len;
                hits++;
                break;
            }
        }
        if (step === 0) {
            out += chars[i];
            step = 1;
        }
        i += step;
    }
    return {text: out, hits};
}

// The map that recognises most of the typed characters wins (the first one on a tie), so several maps
// (Arabic, Russian, ...) can be on at once. Returns {text, id, name, hits} or null when none applies.
export function translateQuery(query, maps) {
    if (typeof query !== 'string' || !query || !maps?.length)
        return null;
    const chars = Array.from(query);
    let best = null;
    for (const map of maps) {
        const r = applyMap(chars, map);
        if (r.hits > 0 && (!best || r.hits > best.hits))
            best = {text: r.text, id: map.id, name: map.name, hits: r.hits};
    }
    return best;
}

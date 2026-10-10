// Pure JS (no GI imports): the "Search keywords" of custom commands and actions.
//
// Without a separator the field is plain words separated by spaces (with optional /regex/ or <regex> tokens,
// see regex.js). With a separator (";" or "|" or ";;" ...) the field is a LIST: every piece is one keyword that
// may contain spaces and symbols, and is matched as a whole phrase. With "all regular expressions" every piece
// is a pattern and needs no slashes.
//
// A backslash in front of the separator keeps it inside a keyword ("a\;b" is the keyword a;b). Other
// backslashes are left alone so that regular expressions such as \d or \\ work as written.

import {checkPattern, extractRegexKeywords} from './regex.js';

export const MAX_SEPARATOR = 8;
const MAX_PATTERNS = 16;

const WRAPPED_TAG = /^<(regex|re)>([\s\S]*)<\/\1>$/i;
const WRAPPED_SLASH = /^\/([\s\S]+)\/$/;

// Separators are short, never contain a backslash (that is the escape) or control characters.
export function sanitizeSeparator(v) {
    return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\\]/g, '').trim().slice(0, MAX_SEPARATOR) : '';
}

// The pieces of `text` between unescaped separators, trimmed, empty ones dropped.
export function splitKeywords(text, sep) {
    const s = String(text ?? '');
    if (!sep)
        return s.trim() ? [s.trim()] : [];
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length;) {
        if (s[i] === '\\') {
            if (s.startsWith(sep, i + 1)) {
                cur += sep; // escaped separator: a literal one inside the keyword
                i += 1 + sep.length;
            } else if (s[i + 1] === '\\') {
                cur += '\\\\'; // a pair stays a pair, so "\\" before a real separator still splits
                i += 2;
            } else {
                cur += s[i++];
            }
        } else if (s.startsWith(sep, i)) {
            out.push(cur);
            cur = '';
            i += sep.length;
        } else {
            cur += s[i++];
        }
    }
    out.push(cur);
    return out.map(x => x.trim()).filter(x => x !== '');
}

// A list with a separator. Returns {phrases, patterns, items}:
//   phrases   keywords to match as text
//   patterns  compiled regular expressions (tested against the whole typed text)
//   items     one {type: 'phrase'|'regex'|'bad', text, problem?} per piece, for the preferences
export function parseKeywordList(text, sep, allRegex = false) {
    const phrases = [];
    const patterns = [];
    const items = [];
    for (const piece of splitKeywords(text, sep)) {
        let src = null;
        const tag = WRAPPED_TAG.exec(piece);
        const slash = WRAPPED_SLASH.exec(piece);
        if (tag)
            src = tag[2];
        else if (allRegex)
            src = piece;
        else if (slash)
            src = slash[1];
        if (src === null) {
            const p = piece.replace(/\\\\/g, '\\');
            phrases.push(p);
            items.push({type: 'phrase', text: p});
            continue;
        }
        const c = checkPattern(src);
        if (c.re && patterns.length < MAX_PATTERNS) {
            patterns.push(c.re);
            items.push({type: 'regex', text: src});
        } else {
            items.push({type: 'bad', text: piece, problem: c.error ?? `more than ${MAX_PATTERNS} patterns`});
        }
    }
    return {phrases, patterns, items};
}

// What the preferences' "try it" box shows for any combination of the three settings.
export function describeKeywords(text, sep, allRegex = false) {
    if (sep)
        return parseKeywordList(text, sep, allRegex).items;
    if (allRegex) {
        let src = String(text ?? '').trim();
        const tag = WRAPPED_TAG.exec(src);
        if (tag)
            src = tag[2].trim();
        if (!src)
            return [];
        const c = checkPattern(src);
        return [c.re ? {type: 'regex', text: src} : {type: 'bad', text: src, problem: c.error}];
    }
    const bad = [];
    const {plain, patterns} = extractRegexKeywords(text, bad);
    return [
        ...plain.split(' ').filter(Boolean).map(w => ({type: 'phrase', text: w})),
        ...patterns.map(re => ({type: 'regex', text: re.source})),
        ...bad.map(b => ({type: 'bad', text: b.text, problem: b.problem})),
    ];
}

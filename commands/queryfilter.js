// Pure JS (no GI imports): shared by the shell process, the prefs process and tests.
//
// Edits of the text typed in the launcher ("$q") inside a command's arguments, a script's arguments, an
// environment value or a URL. The syntax follows bash's parameter expansion where bash has an equivalent, so
//   ${q:1}  ${q:2:3}  ${q: -3}  ${q:-fallback}  ${#q}  ${q^^}  ${q,,}  ${q#prefix}  ${q%suffix}
// work as people expect, plus a few launcher additions that use regular expressions:
//   ${q/regex/replacement}  ${q//regex/replacement}  ${q~regex}  ${q[0]}  ${q[-1]}  ${q[@]:1}
//
// Nothing here runs a shell or any program. The result is substituted into ONE argument after the command
// line has been split, so an edit can never add or change arguments. An expression that is not understood is
// left exactly as written. Patterns go through the same slow-pattern guard as the search box.

import {isRiskyPattern} from '../search/regex.js';

const MAX_TEXT = 1000; // longest text that regex/glob edits will look at
const MAX_GLOB = 120;

// Index of the "}" that closes a "${" whose body starts at `from`; braces nest and "\" escapes. -1 if none.
function findClose(text, from) {
    let depth = 1;
    for (let i = from; i < text.length; i++) {
        const c = text[i];
        if (c === '\\') {
            i++;
        } else if (c === '{') {
            depth++;
        } else if (c === '}' && --depth === 0) {
            return i;
        }
    }
    return -1;
}

// bash substring: offset < 0 counts from the end, length < 0 stops that many from the end.
function slice(list, off, len) {
    const n = list.length;
    const start = off < 0 ? Math.max(0, n + off) : Math.min(off, n);
    let end = len === undefined ? n : len < 0 ? n + len : start + len;
    end = Math.max(start, Math.min(end, n));
    return list.slice(start, end);
}

const words = q => q.trim().split(/\s+/).filter(Boolean);

// Splits "pattern/replacement" at the first unescaped "/" ("\/" is a literal slash).
function splitReplace(s) {
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '\\') {
            i++;
        } else if (s[i] === '/') {
            return [s.slice(0, i).replace(/\\\//g, '/'), s.slice(i + 1).replace(/\\\//g, '/')];
        }
    }
    return [s.replace(/\\\//g, '/'), ''];
}

function compile(src, flags = '') {
    if (!src)
        return {error: 'the pattern is empty'};
    if (isRiskyPattern(src))
        return {error: 'that pattern is too complex or could be very slow'};
    try {
        return {re: new RegExp(src, flags)};
    } catch (_e) {
        return {error: 'not a valid regular expression'};
    }
}

// "*" and "?" like a shell pattern ("g *" matches "g " followed by anything).
function globRegex(pat) {
    if (pat.length > MAX_GLOB || (pat.match(/\*/g) ?? []).length > 2)
        return {error: 'use at most two * in a prefix or suffix pattern'};
    const src = Array.from(pat, c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$.+()[\]{}|]/g, '\\$&'))).join('');
    return {re: new RegExp(`^(?:${src})$`, 's')};
}

const tooLong = {error: `this edit works on at most ${MAX_TEXT} characters`};

// Parses what stands between "${" and "}". null: not ours (leave the text alone). {error}: ours but wrong.
// {run(q)}: the edit.
function parse(body) {
    let m;
    if (body === '#q')
        return {run: q => String(Array.from(q).length)};
    if (!body.startsWith('q'))
        return null;
    const r = body.slice(1);
    if (r === '')
        return {run: q => q};
    if (!/^[:^,#%/~[]/.test(r))
        return null; // ${qux}, ${q1}: some other variable

    if ((m = /^:-([\s\S]*)$/.exec(r)))
        return {run: q => (q.trim() === '' ? m[1] : q)};
    if ((m = /^:\s*\(?\s*(-?\d+)\s*\)?(?::\s*\(?\s*(-?\d+)\s*\)?)?$/.exec(r))) {
        const off = Number(m[1]);
        const len = m[2] === undefined ? undefined : Number(m[2]);
        return {run: q => slice(Array.from(q), off, len).join('')};
    }
    if ((m = /^\[(-?\d+)\]$/.exec(r))) {
        const i = Number(m[1]);
        return {run: q => {
            const w = words(q);
            return w[i < 0 ? w.length + i : i] ?? '';
        }};
    }
    if ((m = /^\[@\](?::\s*\(?\s*(-?\d+)\s*\)?)?(?::\s*\(?\s*(-?\d+)\s*\)?)?$/.exec(r))) {
        const off = m[1] === undefined ? 0 : Number(m[1]);
        const len = m[2] === undefined ? undefined : Number(m[2]);
        return {run: q => slice(words(q), off, len).join(' ')};
    }
    if (r === '^^')
        return {run: q => q.toUpperCase()};
    if (r === ',,')
        return {run: q => q.toLowerCase()};
    if (r === '^')
        return {run: q => (q ? Array.from(q)[0].toUpperCase() + Array.from(q).slice(1).join('') : q)};
    if (r === ',')
        return {run: q => (q ? Array.from(q)[0].toLowerCase() + Array.from(q).slice(1).join('') : q)};

    if ((m = /^(##|#|%%|%)([\s\S]*)$/.exec(r))) {
        const [, op, pat] = m;
        if (pat === '')
            return {run: q => q};
        const g = globRegex(pat);
        if (g.error)
            return g;
        const prefix = op[0] === '#';
        const longest = op.length === 2;
        return {run: q => {
            if (q.length > MAX_TEXT)
                return tooLong;
            const n = q.length;
            // try the cut points from the short end (or the long end) until the pattern fits exactly
            for (let k = longest ? n : 0; longest ? k >= 0 : k <= n; k += longest ? -1 : 1) {
                const part = prefix ? q.slice(0, k) : q.slice(n - k);
                if (g.re.test(part))
                    return prefix ? q.slice(k) : q.slice(0, n - k);
            }
            return q;
        }};
    }

    if ((m = /^(\/\/|\/)([\s\S]*)$/.exec(r))) {
        const all = m[1] === '//';
        const [src, rep] = splitReplace(m[2]);
        const c = compile(src, all ? 'g' : '');
        if (c.error)
            return c;
        return {run: q => (q.length > MAX_TEXT ? tooLong : q.replace(c.re, rep))};
    }
    if ((m = /^~([\s\S]*)$/.exec(r))) {
        const c = compile(m[1]);
        if (c.error)
            return c;
        return {run: q => {
            if (q.length > MAX_TEXT)
                return tooLong;
            const hit = c.re.exec(q);
            return hit ? (hit[1] ?? hit[0]) : '';
        }};
    }
    return {error: 'unknown edit'};
}

// Walks `text`, replacing $q and ${q...}. `encode` (optional) is applied to each inserted value (URLs).
// `problems` (optional array) collects {expr, problem} for expressions that are ours but unusable.
function expand(text, q, encode, problems) {
    const enc = encode ?? (s => s);
    const src = String(text);
    let out = '';
    let i = 0;
    while (i < src.length) {
        const d = src.indexOf('$', i);
        if (d < 0) {
            out += src.slice(i);
            break;
        }
        out += src.slice(i, d);
        const next = src[d + 1];
        if (next === '{') {
            const close = findClose(src, d + 2);
            const body = close < 0 ? null : src.slice(d + 2, close);
            const p = body === null ? null : parse(body);
            if (p) {
                const value = p.error ? p : p.run(q);
                if (typeof value === 'string') {
                    out += enc(value);
                    i = close + 1;
                    continue;
                }
                problems?.push({expr: `\${${body}}`, problem: value.error});
            }
        } else if (next === 'q' && !/[A-Za-z0-9_]/.test(src[d + 2] ?? '')) {
            out += enc(q);
            i = d + 2;
            continue;
        }
        out += '$';
        i = d + 1;
    }
    return out;
}

export function substituteQuery(text, q, encode = null) {
    return expand(text, String(q ?? ''), encode, null);
}

// For the preferences "try it" box: what the text becomes, and what was wrong with any expression.
export function previewQueryTemplate(text, q) {
    const problems = [];
    const result = expand(text, String(q ?? ''), null, problems);
    return {result, problems};
}

// Ready-made edits for people who do not want to learn the syntax. `expr` is a complete template.
export const QUERY_RECIPES = [
    {label: 'Everything after the first character', expr: '${q:1}'},
    {label: 'The first 3 characters', expr: '${q:0:3}'},
    {label: 'The last 3 characters', expr: '${q: -3}'},
    {label: 'Without the last character', expr: '${q:0:-1}'},
    {label: 'The first word', expr: '${q[0]}'},
    {label: 'The last word', expr: '${q[-1]}'},
    {label: 'Everything after the first word', expr: '${q[@]:1}'},
    {label: 'UPPERCASE', expr: '${q^^}'},
    {label: 'lowercase', expr: '${q,,}'},
    {label: 'Capital first letter', expr: '${q^}'},
    {label: 'Replace spaces with +', expr: '${q// /+}'},
    {label: 'Remove all spaces', expr: '${q// /}'},
    {label: 'Remove "g " from the start', expr: '${q#g }'},
    {label: 'Only the digits', expr: '${q//[^0-9]/}'},
    {label: 'The first number', expr: '${q~[0-9]+}'},
    {label: 'Swap the first two words', expr: '${q/^(\\S+) (\\S+)/$2 $1}'},
    {label: 'A fallback when nothing is typed', expr: '${q:-hello}'},
    {label: 'How many characters', expr: '${#q}'},
];

// Wraps an expression in single quotes when the arguments field would otherwise split or reinterpret it
// (spaces, #, |, ;, quotes, backslashes...).
export function quoteArgument(expr) {
    const s = String(expr);
    if (/^[A-Za-z0-9_${}:.,^@[\]\-+=~%/]*$/.test(s) && !s.includes('#'))
        return s;
    return `'${s.replace(/'/g, "'\\''")}'`;
}

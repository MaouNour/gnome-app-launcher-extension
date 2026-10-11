
export const REGEX_MODES = ['off', 'prefix', 'always'];

const TAG_OPEN = /^<(regex|re)>/i;
const WORD_PREFIX = /^regex:[ \t]?/i;

const MAX_PATTERN = 120;
const META = /[\\^$.*+?()[\]{}|]/;
const UNBOUNDED = /[+*]|\{\d+,\}/g;
const MAX_UNBOUNDED = 2;

export function isRiskyPattern(src) {
    if (src.length > MAX_PATTERN)
        return true;
    if (/\\[1-9]/.test(src))
        return true;
    if (/\(\?<[=!]/.test(src))
        return true;
    const flat = src.replace(/\(\?:/g, '(');
    if (/\((?:[^()\\]|\\.)*(?:[+*?|]|\{\d*,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/.test(flat))
        return true;
    return (src.match(UNBOUNDED) ?? []).length > MAX_UNBOUNDED;
}

export function parseRegexQuery(query, mode) {
    if (mode !== 'prefix' && mode !== 'always')
        return null;
    const t = String(query ?? '').trimStart();
    let body;
    let explicit = false;
    const tag = TAG_OPEN.exec(t);
    if (tag) {
        explicit = true;
        body = t.slice(tag[0].length).replace(new RegExp(`</${tag[1]}>\\s*$`, 'i'), '');
    } else if (WORD_PREFIX.test(t)) {
        explicit = true;
        body = t.replace(WORD_PREFIX, '');
    } else if (t.startsWith('/')) {
        explicit = true;
        body = t.slice(1);
        if (body.endsWith('/') && !body.endsWith('\\/'))
            body = body.slice(0, -1);
    } else if (mode === 'always' && META.test(t)) {
        body = t;
    } else {
        return null;
    }
    if (body.trim() === '')
        return explicit ? {error: tag || WORD_PREFIX.test(t) ? 'Type a regular expression after the tag' : 'Type a regular expression after the slash'} : null;
    if (isRiskyPattern(body))
        return explicit ? {error: 'That pattern is too complex or could be very slow'} : null;
    try {
        return {re: new RegExp(body, 'i'), source: body};
    } catch (_e) {
        return explicit ? {error: 'Not a valid regular expression yet'} : null;
    }
}

export function checkPattern(src) {
    if (!src)
        return {error: 'the pattern is empty'};
    if (isRiskyPattern(src))
        return {error: 'too complex or could be very slow'};
    try {
        return {re: new RegExp(src, 'i')};
    } catch (_e) {
        return {error: 'not a valid regular expression'};
    }
}

export function compileKeywordPattern(text) {
    let src = String(text ?? '').trim();
    const wrapped = /^<(regex|re)>([\s\S]*)<\/\1>$/i.exec(src);
    if (wrapped)
        src = wrapped[2].trim();
    return checkPattern(src).re ?? null;
}

export function extractRegexKeywords(text, bad = null) {
    const patterns = [];
    const add = src => {
        const c = checkPattern(src);
        if (c.re && patterns.length < 8)
            patterns.push(c.re);
        else
            bad?.push({text: src, problem: c.error ?? 'more than 8 patterns'});
    };
    const untagged = String(text ?? '').replace(/<(regex|re)>([\s\S]*?)<\/\1>/gi, (_m, _t, src) => {
        add(src);
        return ' ';
    });
    const plain = untagged.replace(/(^|\s)\/((?:\\.|[^/\\])+)\/(?=\s|$)/g, (_m, lead, src) => {
        add(src);
        return lead;
    }).replace(/\s+/g, ' ').trim();
    return {plain, patterns};
}

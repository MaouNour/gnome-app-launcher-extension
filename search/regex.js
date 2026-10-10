// Pure JS (no GI imports). Regular-expression support for the launcher search.
//
// A pattern typed into a search box runs on every keystroke against every entry, and JavaScript's
// engine backtracks, so a pattern such as (a+)+$ can freeze the shell. Three defences: patterns are
// length-limited, shapes known to blow up are refused, and callers only ever test short slices of
// an entry's text.

export const REGEX_MODES = ['off', 'prefix', 'always'];

// Besides /slashes/, a pattern can be wrapped in tags, which never get confused with a path or with a slash
// inside the pattern: <regex>/home/*</regex>, <re>^a/b$</re>, and in the search box also the prefix
// "regex:" (regex:/home/*). The text between the tags is taken exactly as written.
const TAG_OPEN = /^<(regex|re)>/i;
const WORD_PREFIX = /^regex:[ \t]?/i;

const MAX_PATTERN = 120;
const META = /[\\^$.*+?()[\]{}|]/;
const UNBOUNDED = /[+*]|\{\d+,\}/g;
const MAX_UNBOUNDED = 2; // a.*b.*c.*d on a long string is already quartic

export function isRiskyPattern(src) {
    if (src.length > MAX_PATTERN)
        return true;
    if (/\\[1-9]/.test(src))
        return true; // back-references can be exponential
    if (/\(\?<[=!]/.test(src))
        return true; // look-behind
    // A repeated group that contains a quantifier or an alternation: (a+)+  (.*)*  (a|aa)+  (a?){0,20}
    const flat = src.replace(/\(\?:/g, '(');
    if (/\((?:[^()\\]|\\.)*(?:[+*?|]|\{\d*,\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,\d*\})/.test(flat))
        return true;
    return (src.match(UNBOUNDED) ?? []).length > MAX_UNBOUNDED;
}

// What a search box text means as a regular expression:
//   null                      -> not a regex query, search normally
//   {re, source}              -> run this
//   {error}                   -> explicit regex that cannot be used (say why)
// mode 'prefix': only text starting with "/" ("/chrom|fire" or "/chrom|fire/"), or one of the explicit
//                forms "<regex>...</regex>" (closing tag optional), "<re>...</re>" and "regex:...".
//                The explicit forms are used whenever the mode is not 'off'.
// mode 'always': also plain text that contains regex characters, but only when it compiles
//                and is safe; otherwise it silently falls back to the normal search.
export function parseRegexQuery(query, mode) {
    if (mode !== 'prefix' && mode !== 'always')
        return null;
    const t = String(query ?? '').trimStart();
    let body;
    let explicit = false;
    const tag = TAG_OPEN.exec(t);
    if (tag) {
        // The body is taken as typed (slashes and all); only the closing tag is removed.
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

// {re} when the pattern can be used as a keyword, otherwise {error} with the reason (shown by the preferences).
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

// Search keywords of an entry marked "keywords are a regular expression": the whole field is ONE pattern,
// written without slashes ("^(open )?term(inal)?$"). Returns the compiled pattern, or null when the field is
// empty, not valid yet or unsafe (the entry then simply has no pattern, like an ignored /regex/ token).
export function compileKeywordPattern(text) {
    let src = String(text ?? '').trim();
    const wrapped = /^<(regex|re)>([\s\S]*)<\/\1>$/i.exec(src); // a pasted <regex>...</regex> is fine too
    if (wrapped)
        src = wrapped[2].trim();
    return checkPattern(src).re ?? null;
}

// Search keywords of custom commands/actions may contain /patterns/ next to ordinary words:
//   "terminal /^(open )?term(inal)?$/"
// Returns the ordinary words and the compiled patterns (unsafe or invalid ones are ignored).
// A pattern is tested against the whole query.
//   "terminal <regex>^/usr/bin/.*term$</regex>"   (tags: the pattern may hold slashes and spaces freely)
// `bad` (optional array) collects {text, problem} for the patterns that were ignored.
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

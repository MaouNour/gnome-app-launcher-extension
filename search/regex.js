// Pure JS (no GI imports). Regular-expression support for the launcher search.
//
// A pattern typed into a search box runs on every keystroke against every entry, and JavaScript's
// engine backtracks, so a pattern such as (a+)+$ can freeze the shell. Three defences: patterns are
// length-limited, shapes known to blow up are refused, and callers only ever test short slices of
// an entry's text.

export const REGEX_MODES = ['off', 'prefix', 'always'];

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
// mode 'prefix': only text starting with "/" ("/chrom|fire" or "/chrom|fire/").
// mode 'always': also plain text that contains regex characters, but only when it compiles
//                and is safe; otherwise it silently falls back to the normal search.
export function parseRegexQuery(query, mode) {
    if (mode !== 'prefix' && mode !== 'always')
        return null;
    const t = String(query ?? '').trimStart();
    let body;
    let explicit = false;
    if (t.startsWith('/')) {
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
        return explicit ? {error: 'Type a regular expression after the slash'} : null;
    if (isRiskyPattern(body))
        return explicit ? {error: 'That pattern is too complex or could be very slow'} : null;
    try {
        return {re: new RegExp(body, 'i'), source: body};
    } catch (_e) {
        return explicit ? {error: 'Not a valid regular expression yet'} : null;
    }
}

// Search keywords of custom commands/actions may contain /patterns/ next to ordinary words:
//   "terminal /^(open )?term(inal)?$/"
// Returns the ordinary words and the compiled patterns (unsafe or invalid ones are ignored).
// A pattern is tested against the whole query.
export function extractRegexKeywords(text) {
    const patterns = [];
    const plain = String(text ?? '').replace(/(^|\s)\/((?:\\.|[^/\\])+)\/(?=\s|$)/g, (_m, lead, src) => {
        if (patterns.length < 8 && !isRiskyPattern(src)) {
            try {
                patterns.push(new RegExp(src, 'i'));
            } catch (_e) { /* ignored */ }
        }
        return lead;
    }).replace(/\s+/g, ' ').trim();
    return {plain, patterns};
}


export const MAX_TERMS = 6;
export const MAX_TERM_LEN = 64;

export function toTerms(query) {
    if (typeof query !== 'string')
        return [];
    return query.replace(/[\u0000-\u001f\u007f]/g, ' ').split(/\s+/).filter(Boolean)
        .map(t => t.slice(0, MAX_TERM_LEN)).slice(0, MAX_TERMS);
}

export function pickBackend(pref, avail) {
    const gnome = !!avail?.gnome;
    const locate = !!avail?.locate;
    if (pref === 'gnome')
        return gnome ? 'gnome' : null;
    if (pref === 'locate')
        return locate ? 'locate' : null;
    if (gnome)
        return 'gnome';
    return locate ? 'locate' : null;
}

export function locateArgs(tool, terms, limit) {
    return [tool, '-i', '-b', '-A', '-e', '-l', String(Math.max(1, Math.floor(limit))), '--', ...terms];
}

export const parseLines = text => (typeof text === 'string' ? text.split('\n').filter(Boolean) : []);

export function pathFromUri(uri) {
    if (typeof uri !== 'string' || !uri.startsWith('file://'))
        return null;
    let rest = uri.slice('file://'.length);
    if (!rest.startsWith('/')) {
        const slash = rest.indexOf('/');
        if (slash < 0)
            return null;
        rest = rest.slice(slash);
    }
    try {
        return decodeURIComponent(rest);
    } catch (_e) {
        return null;
    }
}

const SYSTEM_PREFIXES = ['/proc/', '/sys/', '/dev/', '/run/', '/tmp/.'];

export function filterPaths(paths, o) {
    const home = (o.home ?? '').replace(/\/+$/, '');
    const out = [];
    const seen = new Set();
    for (const p of paths ?? []) {
        if (typeof p !== 'string' || !p.startsWith('/') || /[\u0000-\u001f\u007f]/.test(p) || seen.has(p))
            continue;
        if (SYSTEM_PREFIXES.some(s => p.startsWith(s)))
            continue;
        const inHome = !!home && (p === home || p.startsWith(`${home}/`));
        if (!o.outsideHome && !inHome)
            continue;
        const rel = inHome ? p.slice(home.length) : p;
        if (!o.hidden && rel.split('/').some(c => c.startsWith('.') && c.length > 0))
            continue;
        seen.add(p);
        out.push(p);
        if (out.length >= o.max)
            break;
    }
    return out;
}

export const baseName = p => p.slice(p.lastIndexOf('/') + 1) || p;

export function dirName(p) {
    const i = p.lastIndexOf('/');
    return i <= 0 ? '/' : p.slice(0, i);
}

// "/home/me/Documents" -> "~/Documents"
export function shortPath(p, home) {
    const h = (home ?? '').replace(/\/+$/, '');
    if (h && p === h)
        return '~';
    return h && p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

// What a result row shows.
export function describeFile(path, home) {
    const name = baseName(path);
    return {name, desc: shortPath(dirName(path), home), keywords: path};
}

// Pure JS (no GI imports): matching of window/app names against the user's blocklist.
// Entries are compared case-insensitively against the window class, the application id and the
// desktop-file id (".desktop" is ignored). "*" matches any run of characters and "?" one character,
// so "steam_app_*" covers every Steam game.

const norm = s => String(s ?? '').trim().toLowerCase().replace(/\.desktop$/, '');

function globToRegExp(glob) {
    const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${src}$`);
}

// list: string[] from settings. Returns {size, test(names[])}; compiled once per settings change,
// so a focus change only runs a handful of cheap comparisons.
export function compileBlocklist(list) {
    const exact = new Set();
    const globs = [];
    for (const raw of Array.isArray(list) ? list : []) {
        const e = norm(raw).slice(0, 120);
        if (!e)
            continue;
        if (/[*?]/.test(e))
            globs.push(globToRegExp(e));
        else
            exact.add(e);
    }
    return {
        size: exact.size + globs.length,
        test(names) {
            for (const n of names) {
                const k = norm(n);
                if (!k)
                    continue;
                if (exact.has(k) || globs.some(g => g.test(k)))
                    return true;
            }
            return false;
        },
    };
}

export const normalizeBlockEntry = norm;

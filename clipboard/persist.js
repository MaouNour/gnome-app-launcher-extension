// Pure JS (no GI imports): unit-testable under plain node. Rules for the clipboard history that is
// kept on disk: what is stored, how a stored list is validated when it is read back, how a copied image
// is matched to a file that already exists (so it can be linked instead of copied), and the labels of
// file entries (screen recordings).

export const MAX_CHARS = 20000;
export const SOURCES = ['clipboard', 'primary', 'both', 'own'];

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'];
export const VIDEO_EXTS = ['webm', 'mp4', 'mkv', 'mov', 'avi', 'ogv', 'm4v'];

const HASH_RE = /^[0-9a-f]{64}$/;
// Name of an image copy kept in the history folder. Anything else read from the index is rejected, so a
// damaged or edited index can never point outside that folder.
const COPY_RE = /^img-[0-9a-f]{64}\.(png|jpg|gif|bmp|webp)$/;

export function extOf(name) {
    const i = typeof name === 'string' ? name.lastIndexOf('.') : -1;
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export const isVideoName = name => VIDEO_EXTS.includes(extOf(name));
export const isImageName = name => IMAGE_EXTS.includes(extOf(name));

// Files a recorder or an editor is still working on.
export function isTempName(name) {
    return typeof name !== 'string' || name === '' || name.startsWith('.') || name.endsWith('~') ||
        /\.(part|tmp|temp|crdownload)$/i.test(name);
}

export function baseName(path) {
    return typeof path === 'string' ? path.slice(path.lastIndexOf('/') + 1) : '';
}

export function imageExt(mime) {
    switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/bmp': return 'bmp';
    case 'image/webp': return 'webp';
    default: return 'png';
    }
}

export const copyName = (hash, mime) => `img-${hash}.${imageExt(mime)}`;
export const isCopyName = name => COPY_RE.test(name ?? '');

// Applications that mark a copied secret (password managers) say so with an extra clipboard format.
export function isSecret(mimes) {
    return Array.isArray(mimes) && mimes.includes('x-kde-passwordManagerHint');
}

// Which selections are watched for a source setting. 'own' watches nothing: the history then only holds
// what is added through the launcher itself.
export function watchedSelections(source) {
    switch (source) {
    case 'primary': return {clipboard: false, primary: true};
    case 'both': return {clipboard: true, primary: true};
    case 'own': return {clipboard: false, primary: false};
    default: return {clipboard: true, primary: false};
    }
}

// Which of the files in a folder could be the file a copied image came from: an image of exactly the
// same size, written shortly before (or after) it was copied. `files` is [{name, size, mtime}] with
// mtime in seconds. At most `limit` candidates, the closest in time first.
export function linkCandidates(files, size, nowSec, windowSec = 20, limit = 3) {
    return files
        .filter(f => f && f.size === size && isImageName(f.name) && !isTempName(f.name) &&
            Math.abs(nowSec - f.mtime) <= windowSec)
        .sort((a, b) => Math.abs(nowSec - a.mtime) - Math.abs(nowSec - b.mtime))
        .slice(0, limit);
}

const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

function cleanInfo(i) {
    if (!i || typeof i !== 'object' || typeof i.type !== 'string')
        return null;
    return {type: i.type.slice(0, 8), width: num(i.width, 0, 1e6, 0), height: num(i.height, 0, 1e6, 0)};
}

// What goes into the index file. `items` are the in-memory items (newest first); anything that only
// exists in memory (an image whose copy has not been written yet) is left out.
export function serializeItems(items) {
    const out = [];
    for (const it of items) {
        if (typeof it.text === 'string') {
            out.push({t: 'text', ts: it.ts, text: it.text});
        } else if (it.image) {
            const m = it.image;
            if (m.path)
                out.push({t: 'image', ts: it.ts, mime: m.mime, hash: m.hash, size: m.size, info: m.info ?? null, path: m.path, linked: !!m.linked});
        } else if (it.file) {
            out.push({t: 'file', ts: it.ts, path: it.file.path, kind: it.file.kind, size: it.file.size, name: it.file.name});
        }
    }
    return out;
}

// Validates a stored list. Returns clean {t, ...} records, newest first, never more than `max`.
export function reviveItems(raw, max = 200) {
    const out = [];
    if (!Array.isArray(raw))
        return out;
    for (const r of raw) {
        if (out.length >= max)
            break;
        if (!r || typeof r !== 'object')
            continue;
        const ts = num(r.ts, 0, 4e12, 0);
        if (r.t === 'text') {
            if (typeof r.text === 'string' && r.text.trim() && r.text.length <= MAX_CHARS)
                out.push({t: 'text', ts, text: r.text});
        } else if (r.t === 'image') {
            if (typeof r.mime !== 'string' || !r.mime.startsWith('image/') || !HASH_RE.test(r.hash ?? '') ||
                typeof r.path !== 'string')
                continue;
            const linked = r.linked === true;
            if (linked ? !r.path.startsWith('/') : !COPY_RE.test(r.path))
                continue;
            out.push({t: 'image', ts, mime: r.mime, hash: r.hash, size: num(r.size, 0, 2 ** 40, 0), info: cleanInfo(r.info), path: r.path, linked});
        } else if (r.t === 'file') {
            if (typeof r.path !== 'string' || !r.path.startsWith('/') || r.kind !== 'video')
                continue;
            out.push({t: 'file', ts, path: r.path, kind: 'video', size: num(r.size, 0, 2 ** 50, 0), name: baseName(r.path)});
        }
    }
    return out;
}

function fmtBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${Math.round(n / 1024)} KB`;
    if (n < 1024 ** 3)
        return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// Text of a list row for a recorded video / file.
export function fileLabels(f) {
    return {
        name: f.name,
        desc: ['Video', fmtBytes(f.size ?? 0), 'Enter copies the file · Ctrl+Enter plays it · Alt+Enter shows the folder'].join(' · '),
        keywords: `video recording screencast screen record ${f.name}`,
    };
}

// Pure JS (no GI imports): unit-testable under plain node. Helpers for image clipboard items:
// choosing between text and image, reading the size from the file header (no decoding), and
// building the text shown in the list.

// Preferred first. Only formats gdk-pixbuf can render as an icon are worth keeping.
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/bmp', 'image/gif', 'image/webp'];

const TEXT_MIMES = ['text/plain', 'text/plain;charset=utf-8', 'UTF8_STRING', 'STRING', 'TEXT', 'COMPOUND_TEXT'];

// What to read from the clipboard. Text wins whenever it is on offer: copying cells from a
// spreadsheet or text from a web page often advertises an image rendering as well, and the text
// is what the user meant. Returns {kind: 'text'} | {kind: 'image', mime} | null.
export function clipboardKind(mimes, imagesEnabled) {
    const list = Array.isArray(mimes) ? mimes : [];
    if (list.some(m => TEXT_MIMES.includes(m)))
        return {kind: 'text'};
    if (imagesEnabled) {
        const mime = IMAGE_MIMES.find(m => list.includes(m));
        if (mime)
            return {kind: 'image', mime};
    }
    return null;
}

const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// {type, width, height} read from the header bytes, or null when the data is not a recognised
// image. width/height are 0 when the format is known but the size could not be read.
export function imageInfo(b) {
    if (!b || b.length < 12)
        return null;
    // PNG: signature, then the IHDR chunk holds the size.
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        return b.length >= 24 ? {type: 'PNG', width: u32be(b, 16), height: u32be(b, 20)} : {type: 'PNG', width: 0, height: 0};
    }
    // JPEG: walk the marker segments until a start-of-frame marker.
    if (b[0] === 0xff && b[1] === 0xd8) {
        let o = 2;
        while (o + 9 < b.length) {
            if (b[o] !== 0xff) {
                o++;
                continue;
            }
            const m = b[o + 1];
            if (m === 0xff) {
                o++;
                continue;
            }
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
                return {type: 'JPEG', width: (b[o + 7] << 8) | b[o + 8], height: (b[o + 5] << 8) | b[o + 6]};
            o += 2 + ((b[o + 2] << 8) | b[o + 3]);
        }
        return {type: 'JPEG', width: 0, height: 0};
    }
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
        return {type: 'GIF', width: u16le(b, 6), height: u16le(b, 8)};
    if (b[0] === 0x42 && b[1] === 0x4d && b.length >= 26)
        return {type: 'BMP', width: u32le(b, 18) | 0, height: Math.abs(u32le(b, 22) | 0)};
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        // VP8X (extended) carries the canvas size as 24-bit little-endian values minus one.
        if (b.length >= 30 && b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58)
            return {type: 'WEBP', width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16))};
        return {type: 'WEBP', width: 0, height: 0};
    }
    return null;
}

export function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${Math.round(n / 1024)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Text for a list row: {name, desc, keywords}.
export function imageLabels(info, size) {
    const type = info?.type ?? 'Image';
    const dims = info && info.width > 0 && info.height > 0 ? `${info.width}×${info.height}` : '';
    return {
        name: dims ? `Image ${dims}` : 'Image',
        desc: [type, formatBytes(size)].join(' · '),
        keywords: `image picture screenshot photo ${type.toLowerCase()} ${dims ? `${info.width}x${info.height}` : ''}`.trim(),
    };
}

// How many image items may be kept: drops the oldest images beyond `maxImages`.
// items are newest-first; returns the indexes to remove.
export function imagesToDrop(items, maxImages) {
    const drop = [];
    let seen = 0;
    items.forEach((it, i) => {
        if (it.image && ++seen > maxImages)
            drop.push(i);
    });
    return drop;
}

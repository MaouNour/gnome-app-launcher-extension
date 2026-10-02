// Pure JS (no GI imports): unit-testable under plain node. The heavy dataset lives in
// emoji/data.js and is only imported the first time the picker is used; this module turns it
// into searchable entries and holds the (tiny) logic that decides what picking an emoji does.

export const EMOJI_STORES = ['clipboard', 'buffer', 'both', 'none'];
export const EMOJI_PASTE_KEYS = ['auto', 'ctrl-v', 'ctrl-shift-v', 'shift-insert'];

// "data" is the DATA string of emoji/data.js: one emoji per line,
//   emoji TAB label TAB space-separated keywords TAB group index
export function parseEmoji(data, groups) {
    const out = [];
    for (const line of data.split('\n')) {
        const f = line.split('\t');
        if (f.length < 4 || !f[0])
            continue;
        const [glyph, name, keywords, g] = f;
        out.push({
            id: `emoji:${glyph}`,
            kind: 'emoji',
            name,
            desc: groups[Number(g)] ?? '',
            keywords,
            category: 'Emoji',
            glyph,
            payload: {char: glyph},
        });
    }
    return out;
}

// Validates the three settings that decide what choosing an emoji does. "Copy nowhere and do
// not paste" would make the click do nothing at all, so that combination falls back to the
// clipboard rather than silently swallowing the user's choice.
export function emojiOptions({store, paste, keys}) {
    let s = EMOJI_STORES.includes(store) ? store : 'clipboard';
    const p = paste === true;
    if (s === 'none' && !p)
        s = 'clipboard';
    return {store: s, paste: p, keys: EMOJI_PASTE_KEYS.includes(keys) ? keys : 'auto'};
}

// Plan for a choice: which targets receive the emoji and whether the user's own clipboard has to
// be borrowed (and restored) to be able to paste. The clipboard only needs borrowing when we
// paste but the user asked for the emoji NOT to end up on the clipboard.
export function emojiPlan(opts) {
    const o = emojiOptions(opts);
    const toClipboard = o.store === 'clipboard' || o.store === 'both';
    const toBuffer = o.store === 'buffer' || o.store === 'both';
    return {toClipboard, toBuffer, paste: o.paste, borrowClipboard: o.paste && !toClipboard, keys: o.keys};
}

// ":smile" typed in the main search -> "smile"; ":" alone -> ""; anything else -> null.
// A leading colon followed by a space is left alone so ordinary ": text" queries still work.
export function inlineEmojiQuery(q) {
    if (typeof q !== 'string' || q[0] !== ':')
        return null;
    const rest = q.slice(1);
    if (rest.length > 0 && /^\s/.test(rest))
        return null;
    return rest.trim();
}

const TERMINALS = /terminal|konsole|kgx|console|alacritty|kitty|xterm|urxvt|rxvt|tilix|wezterm|foot|ptyxis|terminator|guake|yakuake|blackbox|contour|st-256color|termite|hyper|cool-retro-term|sakura|lxterminal|qterminal/i;

export function isTerminalClass(wmClass) {
    return typeof wmClass === 'string' && TERMINALS.test(wmClass);
}

// Which key chord to send. Terminals use Ctrl+Shift+V because Ctrl+V is a literal control
// character there; everything else uses Ctrl+V. Explicit settings always win over detection.
export function resolvePasteKeys(setting, wmClass) {
    if (setting === 'ctrl-v' || setting === 'ctrl-shift-v' || setting === 'shift-insert')
        return setting;
    return isTerminalClass(wmClass) ? 'ctrl-shift-v' : 'ctrl-v';
}

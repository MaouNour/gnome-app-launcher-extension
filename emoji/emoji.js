
export const EMOJI_STORES = ['clipboard', 'buffer', 'both', 'none'];
export const EMOJI_PASTE_KEYS = ['auto', 'ctrl-v', 'ctrl-shift-v', 'shift-insert'];

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

export function emojiOptions({store, paste, keys}) {
    let s = EMOJI_STORES.includes(store) ? store : 'clipboard';
    const p = paste === true;
    if (s === 'none' && !p)
        s = 'clipboard';
    return {store: s, paste: p, keys: EMOJI_PASTE_KEYS.includes(keys) ? keys : 'auto'};
}

export function emojiPlan(opts) {
    const o = emojiOptions(opts);
    const toClipboard = o.store === 'clipboard' || o.store === 'both';
    const toBuffer = o.store === 'buffer' || o.store === 'both';
    return {toClipboard, toBuffer, paste: o.paste, borrowClipboard: o.paste && !toClipboard, keys: o.keys};
}

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

export function resolvePasteKeys(setting, wmClass) {
    if (setting === 'ctrl-v' || setting === 'ctrl-shift-v' || setting === 'shift-insert')
        return setting;
    return isTerminalClass(wmClass) ? 'ctrl-shift-v' : 'ctrl-v';
}

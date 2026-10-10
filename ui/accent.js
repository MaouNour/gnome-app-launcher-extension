// Pure JS (no GI imports): the colour of the "this application is running" marker.

// GNOME's accent colours (org.gnome.desktop.interface accent-color), as libadwaita draws them.
export const ACCENTS = {
    blue: '#3584e4', teal: '#2190a4', green: '#3a944a', yellow: '#c88800',
    orange: '#ed5b00', red: '#e62d42', pink: '#d56199', purple: '#9141ac', slate: '#6f8396',
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const isColor = s => typeof s === 'string' && HEX.test(s.trim());

// mode: 'system' (the desktop accent colour), 'theme' (the launcher theme's accent) or 'custom'.
// Always returns a usable colour: whatever is missing or malformed falls back to the next choice.
export function activeColor({mode, custom, system, theme}) {
    const sys = ACCENTS[system] ?? system; // the desktop gives a name ("green"), not a colour
    const pick = mode === 'custom' ? [custom, sys, theme] : mode === 'theme' ? [theme, sys, custom] : [sys, theme, custom];
    for (const c of pick) {
        if (isColor(c))
            return c.trim();
    }
    return ACCENTS.blue;
}

// --- the marker on the highlighted row --------------------------------------------------------------------------
// Highlighting used to force the marker to the selection text colour, which is dark on light highlights (and so
// almost black on themes with a pale or translucent selection). Now the marker keeps its own colour whenever that
// is readable on the highlight, and only falls back when it would disappear into it.

function rgba(hex) {
    let h = String(hex).trim().slice(1);
    if (h.length <= 4)
        h = [...h].map(c => c + c).join('');
    const n = i => parseInt(h.slice(i, i + 2), 16);
    return {r: n(0), g: n(2), b: n(4), a: h.length >= 8 ? n(6) / 255 : 1};
}

// `top` (may be translucent) drawn over the opaque `under`.
function over(top, under) {
    return {
        r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a),
        b: top.b * top.a + under.b * (1 - top.a), a: 1,
    };
}

function luminance({r, g, b}) {
    const f = v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Colour of the marker on the highlighted row: `mark` if it is readable there, else the selection text colour,
// else black or white, whichever stands out more. All arguments are hex colours.
export function markOnSelection({mark, selection, background, selectionText}) {
    if (!isColor(mark) || !isColor(selection))
        return isColor(selectionText) ? selectionText : mark;
    const bg = isColor(background) ? rgba(background) : {r: 36, g: 36, b: 36, a: 1};
    const hl = over(rgba(selection), {...bg, a: 1});
    if (contrastRatio(over(rgba(mark), hl), hl) >= 3)
        return mark;
    if (isColor(selectionText) && contrastRatio(over(rgba(selectionText), hl), hl) >= 3)
        return selectionText;
    return contrastRatio({r: 255, g: 255, b: 255}, hl) >= contrastRatio({r: 0, g: 0, b: 0}, hl) ? '#ffffff' : '#000000';
}

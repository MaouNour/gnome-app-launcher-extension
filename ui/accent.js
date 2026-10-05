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

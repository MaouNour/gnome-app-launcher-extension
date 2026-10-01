// Pure JS (no GI imports) so it can be used from both the shell and the prefs process,
// and unit-tested under plain node. Every value that reaches a CSS string passes
// through sanitizeTheme(), so imported theme files cannot inject arbitrary CSS.

const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const FONT = /^[\w\s,\-'"]{0,120}$/;

const num = (key, label, min, max, step, digits = 0) => ({key, label, type: 'number', min, max, step, digits});
const color = (key, label) => ({key, label, type: 'color'});

export const THEME_FIELDS = [
    {key: 'name', label: 'Name', type: 'text'},
    color('background', 'Background'),
    color('foreground', 'Text'),
    color('secondary', 'Secondary text'),
    color('accent', 'Accent'),
    color('selection', 'Selection background'),
    color('selectionText', 'Selection text'),
    color('border', 'Border'),
    color('searchBackground', 'Search field background'),
    num('opacity', 'Background opacity', 0, 1, 0.05, 2),
    num('blur', 'Blur strength (0 = off)', 0, 100, 1),
    num('radius', 'Window corner radius', 0, 60, 1),
    num('rowRadius', 'Result corner radius', 0, 40, 1),
    num('searchRadius', 'Search field corner radius', 0, 40, 1),
    num('borderWidth', 'Border width', 0, 8, 1),
    num('shadowBlur', 'Shadow blur', 0, 120, 1),
    num('shadowOffsetY', 'Shadow vertical offset', -40, 80, 1),
    num('shadowOpacity', 'Shadow opacity', 0, 1, 0.05, 2),
    {key: 'fontFamily', label: 'Font family (empty = system)', type: 'text'},
    num('fontWeight', 'Font weight', 100, 900, 100),
    {key: 'iconStyle', label: 'Icon style', type: 'combo', options: ['requested', 'regular', 'symbolic']},
];

export const THEME_BASE = {
    name: '',
    background: '#242424', foreground: '#ffffff', secondary: '#ffffff99',
    accent: '#3584e4', selection: '#3584e4', selectionText: '#ffffff',
    border: '#ffffff26', searchBackground: '#ffffff14',
    opacity: 0.96, blur: 0, radius: 16, rowRadius: 10, searchRadius: 10, borderWidth: 1,
    shadowBlur: 48, shadowOffsetY: 16, shadowOpacity: 0.45,
    fontFamily: '', fontWeight: 400, iconStyle: 'requested',
};

const PARTIAL_BUILTINS = {
    'default-dark': {},
    'default-light': {
        background: '#fafafa', foreground: '#1c1c1c', secondary: '#1c1c1c99',
        border: '#00000026', searchBackground: '#0000000d', shadowOpacity: 0.25,
    },
    'glass-dark': {
        background: '#101418', opacity: 0.55, blur: 30, border: '#ffffff30',
        searchBackground: '#ffffff1f', shadowOpacity: 0.35,
    },
    'nord': {
        background: '#2e3440', foreground: '#eceff4', secondary: '#d8dee9b3',
        accent: '#88c0d0', selection: '#88c0d0', selectionText: '#2e3440',
        border: '#4c566a', searchBackground: '#3b4252',
    },
    'solarized-light': {
        background: '#fdf6e3', foreground: '#586e75', secondary: '#93a1a1',
        accent: '#268bd2', selection: '#eee8d5', selectionText: '#073642',
        border: '#eee8d5', searchBackground: '#eee8d5', shadowOpacity: 0.2,
    },
};

// Validate/clamp every known field; anything invalid falls back to `base`.
export function sanitizeTheme(raw, base = THEME_BASE) {
    const out = {};
    const src = raw && typeof raw === 'object' ? raw : {};
    for (const f of THEME_FIELDS) {
        const v = src[f.key];
        const fb = base[f.key];
        switch (f.type) {
        case 'color':
            out[f.key] = typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fb;
            break;
        case 'number': {
            const n = typeof v === 'number' ? v : Number.NaN;
            out[f.key] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : fb;
            break;
        }
        case 'combo':
            out[f.key] = f.options.includes(v) ? v : fb;
            break;
        default:
            if (f.key === 'fontFamily')
                out[f.key] = typeof v === 'string' && FONT.test(v) ? v.trim() : fb;
            else
                out[f.key] = typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) : fb;
        }
    }
    return out;
}

let _builtins = null;
export function builtinThemes() {
    if (!_builtins) {
        _builtins = {};
        for (const [name, partial] of Object.entries(PARTIAL_BUILTINS))
            _builtins[name] = sanitizeTheme({...THEME_BASE, ...partial, name});
    }
    return _builtins;
}

export function themeNames(custom) {
    const names = Object.keys(builtinThemes());
    if (Array.isArray(custom)) {
        for (const c of custom) {
            if (c && typeof c.name === 'string' && c.name && !names.includes(c.name))
                names.push(c.name);
        }
    }
    return names;
}

// Resolve the effective theme: built-in or custom theme by name, then user overrides.
export function resolveTheme({custom, name, dark, overrides}) {
    const all = builtinThemes();
    const fallback = all[dark ? 'default-dark' : 'default-light'];
    let t = all[name];
    if (!t && Array.isArray(custom)) {
        const c = custom.find(x => x && x.name === name);
        if (c)
            t = sanitizeTheme(c, fallback);
    }
    t ??= fallback;
    if (overrides && typeof overrides === 'object') {
        const o = {...overrides};
        delete o.name;
        t = sanitizeTheme({...t, ...o}, t);
    }
    return t;
}

// '#rrggbb[aa]' -> css color, optionally multiplying alpha.
export function cssColor(hex, alphaMul = 1) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const a = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
    const alpha = Math.round(a * alphaMul * 1000) / 1000;
    return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

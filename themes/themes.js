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
    opacity: 0.96, radius: 16, rowRadius: 10, searchRadius: 10, borderWidth: 1,
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
        background: '#101418', opacity: 0.55, border: '#ffffff30',
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

    'nord-light': {
        background: '#eceff4', foreground: '#2e3440', secondary: '#4c566a',
        accent: '#5e81ac', selection: '#5e81ac', selectionText: '#eceff4',
        border: '#d8dee9', searchBackground: '#e5e9f0', shadowOpacity: 0.2,
    },
    'solarized-light': {
        background: '#fdf6e3', foreground: '#586e75', secondary: '#93a1a1',
        accent: '#268bd2', selection: '#eee8d5', selectionText: '#073642',
        border: '#eee8d5', searchBackground: '#eee8d5', shadowOpacity: 0.2,
    },
    'solarized-dark': {
        background: '#002b36', foreground: '#93a1a1', secondary: '#657b83',
        accent: '#268bd2', selection: '#073642', selectionText: '#eee8d5',
        border: '#073642', searchBackground: '#073642',
    },
    'catppuccin-mocha': {
        background: '#1e1e2e', foreground: '#cdd6f4', secondary: '#a6adc8',
        accent: '#cba6f7', selection: '#cba6f7', selectionText: '#1e1e2e',
        border: '#45475a', searchBackground: '#313244',
    },
    'catppuccin-latte': {
        background: '#eff1f5', foreground: '#4c4f69', secondary: '#6c6f85',
        accent: '#8839ef', selection: '#8839ef', selectionText: '#eff1f5',
        border: '#ccd0da', searchBackground: '#e6e9ef', shadowOpacity: 0.2,
    },
    'tokyo-night': {
        background: '#1a1b26', foreground: '#c0caf5', secondary: '#787c99',
        accent: '#7aa2f7', selection: '#283457', selectionText: '#c0caf5',
        border: '#292e42', searchBackground: '#16161e',
    },
    'tokyo-day': {
        background: '#e1e2e7', foreground: '#3760bf', secondary: '#6172b0',
        accent: '#2e7de9', selection: '#b7c1e3', selectionText: '#3760bf',
        border: '#c4c8da', searchBackground: '#d0d5e3', shadowOpacity: 0.2,
    },
    'gruvbox-dark': {
        background: '#282828', foreground: '#ebdbb2', secondary: '#a89984',
        accent: '#d79921', selection: '#d79921', selectionText: '#282828',
        border: '#504945', searchBackground: '#3c3836',
    },
    'gruvbox-light': {
        background: '#fbf1c7', foreground: '#3c3836', secondary: '#7c6f64',
        accent: '#b57614', selection: '#b57614', selectionText: '#fbf1c7',
        border: '#d5c4a1', searchBackground: '#ebdbb2', shadowOpacity: 0.2,
    },
    'rose-pine': {
        background: '#191724', foreground: '#e0def4', secondary: '#908caa',
        accent: '#c4a7e7', selection: '#26233a', selectionText: '#e0def4',
        border: '#26233a', searchBackground: '#1f1d2e',
    },
    'rose-pine-dawn': {
        background: '#faf4ed', foreground: '#575279', secondary: '#797593',
        accent: '#d7827e', selection: '#f2e9e1', selectionText: '#575279',
        border: '#dfdad9', searchBackground: '#f2e9e1', shadowOpacity: 0.2,
    },

    // Raycast / Vicinae look-alikes: flat near-solid surface, hairline border, a very subtle
    // row highlight (translucent white/black instead of a solid accent) and a search field
    // with no fill of its own. Raycast's red (#ff6363) and dark surface (#151515) come from
    // Raycast's public brand page; the rest are close approximations, not exact copies.
    'raycast-dark': {
        background: '#151515', foreground: '#f9f9f9', secondary: '#9c9c9d',
        accent: '#ff6363', selection: '#ffffff14', selectionText: '#ffffff',
        border: '#ffffff14', searchBackground: '#ffffff00',
        opacity: 0.98, radius: 12, rowRadius: 8, searchRadius: 8,
        shadowBlur: 40, shadowOffsetY: 12, shadowOpacity: 0.5, fontWeight: 500,
    },
    'raycast-light': {
        background: '#fcfcfc', foreground: '#1d1d1f', secondary: '#6e6e73',
        accent: '#ff6363', selection: '#0000000f', selectionText: '#1d1d1f',
        border: '#0000001a', searchBackground: '#00000000',
        opacity: 0.98, radius: 12, rowRadius: 8, searchRadius: 8,
        shadowBlur: 40, shadowOffsetY: 12, shadowOpacity: 0.22, fontWeight: 500,
    },
    'vicinae-dark': {
        background: '#131315', foreground: '#e8e8ea', secondary: '#8b8b92',
        accent: '#4f8cff', selection: '#ffffff14', selectionText: '#ffffff',
        border: '#2a2a2e', searchBackground: '#ffffff00',
        opacity: 0.98, radius: 10, rowRadius: 8, searchRadius: 8,
        shadowBlur: 36, shadowOffsetY: 10, shadowOpacity: 0.5,
    },
    'vicinae-light': {
        background: '#fafafa', foreground: '#1f1f23', secondary: '#7a7a84',
        accent: '#3b6fe0', selection: '#00000012', selectionText: '#1f1f23',
        border: '#0000001f', searchBackground: '#00000000',
        opacity: 0.98, radius: 10, rowRadius: 8, searchRadius: 8,
        shadowBlur: 36, shadowOffsetY: 10, shadowOpacity: 0.22,
    },
};

// Name pairs for the "quick preset" row in preferences: one click sets both modes.
export const THEME_FAMILIES = {
    'Default': ['default-light', 'default-dark'],
    'Raycast': ['raycast-light', 'raycast-dark'],
    'Vicinae': ['vicinae-light', 'vicinae-dark'],
    'Nord': ['nord-light', 'nord'],
    'Solarized': ['solarized-light', 'solarized-dark'],
    'Catppuccin': ['catppuccin-latte', 'catppuccin-mocha'],
    'Tokyo Night': ['tokyo-day', 'tokyo-night'],
    'Gruvbox': ['gruvbox-light', 'gruvbox-dark'],
    'Rosé Pine': ['rose-pine-dawn', 'rose-pine'],
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

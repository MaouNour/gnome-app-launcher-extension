// Pure JS (no GI imports): shared by the shell process, the prefs process and tests.
// Field specs drive the prefs editor; sanitize*/validate* protect the runtime from
// hand-edited or corrupted settings. Nothing here executes anything.

const MAX = 512;
const clean = v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX) : '');

export const ACTION_TYPES = ['app', 'shell', 'url', 'file', 'dir', 'script', 'gnome'];
export const GNOME_ACTIONS = ['overview', 'app-grid', 'screenshot', 'lock-screen', 'settings', 'logout', 'reboot', 'suspend', 'power-off', 'toggle-dark-mode', 'toggle-dnd'];

const URL_RE = /^(https?:\/\/|ftp:\/\/|mailto:)\S+$/i;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

export const COMMAND_FIELDS = [
    {key: 'name', label: 'Name', type: 'text'},
    {key: 'description', label: 'Description', type: 'text'},
    {key: 'command', label: 'Command (executable, no shell)', type: 'text'},
    {key: 'args', label: 'Arguments (shell-style quoting)', type: 'text'},
    {key: 'env', label: 'Environment (KEY=value pairs, space separated)', type: 'text'},
    {key: 'icon', label: 'Icon (theme name or file path)', type: 'text'},
    {key: 'category', label: 'Category', type: 'text'},
    {key: 'keywords', label: 'Search keywords (words, or a /regex/ between slashes)', type: 'text', help: 'regex'},
    {key: 'shortcut', label: 'Global shortcut', type: 'shortcut'},
    {key: 'windowShortcut', label: 'Window shortcut (only while the launcher is open)', type: 'shortcut', local: true},
    {key: 'enabled', label: 'Enabled', type: 'switch'},
];

export const ACTION_FIELDS = [
    {key: 'name', label: 'Name', type: 'text'},
    {key: 'description', label: 'Description', type: 'text'},
    {key: 'type', label: 'Type', type: 'combo', options: ACTION_TYPES},
    {key: 'target', label: 'Target (desktop id, command line, URL, path or GNOME action)', type: 'text'},
    {key: 'args', label: 'Arguments (scripts)', type: 'text'},
    {key: 'icon', label: 'Icon (theme name or file path)', type: 'text'},
    {key: 'keywords', label: 'Search keywords (words, or a /regex/ between slashes)', type: 'text', help: 'regex'},
    {key: 'category', label: 'Category', type: 'text'},
    {key: 'shortcut', label: 'Global shortcut', type: 'shortcut'},
    {key: 'windowShortcut', label: 'Window shortcut (only while the launcher is open)', type: 'shortcut', local: true},
    {key: 'enabled', label: 'Enabled', type: 'switch'},
];

export const newCommand = () => ({name: 'New command', description: '', command: '', args: '', env: '', icon: '', category: 'Commands', keywords: '', shortcut: '', windowShortcut: '', enabled: true});
export const newAction = () => ({name: 'New action', description: '', type: 'shell', target: '', args: '', icon: '', keywords: '', category: 'Actions', shortcut: '', windowShortcut: '', enabled: true});

export function sanitizeCommand(raw, index = 0) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    return {
        id: clean(raw.id) || `c${index}`,
        name: clean(raw.name), description: clean(raw.description),
        command: clean(raw.command), args: clean(raw.args), env: clean(raw.env),
        icon: clean(raw.icon), category: clean(raw.category), keywords: clean(raw.keywords),
        shortcut: clean(raw.shortcut), windowShortcut: clean(raw.windowShortcut), enabled: raw.enabled !== false,
    };
}

export function sanitizeAction(raw, index = 0) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    return {
        id: clean(raw.id) || `a${index}`,
        name: clean(raw.name), description: clean(raw.description),
        type: ACTION_TYPES.includes(raw.type) ? raw.type : 'shell',
        target: clean(raw.target), args: clean(raw.args),
        icon: clean(raw.icon), keywords: clean(raw.keywords), category: clean(raw.category),
        shortcut: clean(raw.shortcut), windowShortcut: clean(raw.windowShortcut), enabled: raw.enabled !== false,
    };
}

// Return '' when valid, otherwise a human-readable problem.
export function validateCommand(c) {
    if (!c.name)
        return 'missing name';
    if (!c.command)
        return 'missing command';
    if (c.env) {
        for (const pair of c.env.split(/\s+/)) {
            if (!ENV_RE.test(pair))
                return `bad environment entry "${pair}" (expected KEY=value)`;
        }
    }
    return '';
}

export function validateAction(a) {
    if (!a.name)
        return 'missing name';
    if (!a.target)
        return 'missing target';
    if (a.type === 'url' && !URL_RE.test(a.target))
        return 'URL must start with http://, https://, ftp:// or mailto:';
    if (a.type === 'gnome' && !GNOME_ACTIONS.includes(a.target))
        return `unknown GNOME action "${a.target}" (${GNOME_ACTIONS.join(', ')})`;
    return '';
}

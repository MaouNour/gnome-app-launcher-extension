import {prepare} from '../search/engine.js';

// Pure JS (shared with the prefs process). Default entries shipped with the launcher,
// similar to Vicinae's built-ins. Each can be disabled and given a global shortcut and/or a
// window shortcut (active only while the launcher is open) from the preferences.
//   kind 'system': runs a GNOME action; kind 'mode': switches the launcher into a sub-view.
export const BUILTINS = [
    {id: 'clipboard', kind: 'mode', target: 'clipboard', name: 'Clipboard History', desc: 'Browse and re-copy recent clipboard items', icon: 'edit-paste-symbolic', keywords: 'copy paste history clip', category: 'Clipboard', needs: 'clipboard', placeholder: 'Search clipboard history…', empty: 'Clipboard history is empty'},
    {id: 'clear-clipboard', kind: 'system', target: 'clear-clipboard', name: 'Clear Clipboard History', desc: 'Forget all remembered clipboard items', icon: 'edit-clear-all-symbolic', keywords: 'wipe delete', category: 'Clipboard', needs: 'clipboard'},
    // Emoji entries are configured on the Emoji page of the preferences (page: 'emoji'), not in the
    // generic built-in list, so their shortcuts live next to the other emoji options.
    {id: 'emoji', kind: 'mode', target: 'emoji', name: 'Emoji Picker', desc: 'Search emoji and copy or paste them', icon: 'face-smile-symbolic', keywords: 'emoji emoticon smiley symbols unicode', category: 'Emoji', needs: 'emoji', page: 'emoji', placeholder: 'Search emoji…', empty: 'No emoji found'},
    {id: 'emoji-paste-buffer', kind: 'system', target: 'emoji-paste-buffer', name: 'Paste Emoji From Private Buffer', desc: 'Type the last emoji kept in the private buffer into the focused window', icon: 'edit-paste-symbolic', keywords: 'emoji buffer paste private', category: 'Emoji', needs: 'emoji', page: 'emoji'},
    // Accounts live on the Accounts page of the preferences (page: 'accounts'). Passwords are never
    // part of the main search: the vault is a mode of its own.
    {id: 'accounts', kind: 'mode', target: 'accounts', name: 'Passwords & Accounts', desc: 'Find a saved account and copy its password', icon: 'dialog-password-symbolic', keywords: 'password passwords account accounts login credentials vault username', category: 'Passwords', needs: 'accounts', page: 'accounts', placeholder: 'Search accounts…', empty: 'No accounts saved. Add them in Preferences > Accounts.'},
    {id: 'power-off', kind: 'system', target: 'power-off', name: 'Shut Down', desc: 'Power off the computer', icon: 'system-shutdown-symbolic', keywords: 'poweroff shutdown halt turn off'},
    {id: 'reboot', kind: 'system', target: 'reboot', name: 'Restart', desc: 'Restart the computer', icon: 'system-reboot-symbolic', keywords: 'reboot'},
    {id: 'logout', kind: 'system', target: 'logout', name: 'Log Out', desc: 'End the current session', icon: 'system-log-out-symbolic', keywords: 'sign out exit'},
    {id: 'suspend', kind: 'system', target: 'suspend', name: 'Suspend', desc: 'Put the computer to sleep', icon: 'media-playback-pause-symbolic', keywords: 'sleep'},
    {id: 'lock-screen', kind: 'system', target: 'lock-screen', name: 'Lock Screen', desc: 'Lock the session', icon: 'system-lock-screen-symbolic', keywords: 'lock'},
    {id: 'screenshot', kind: 'system', target: 'screenshot', name: 'Take Screenshot', desc: 'Open the screenshot tool', icon: 'camera-photo-symbolic', keywords: 'capture screen record'},
    {id: 'overview', kind: 'system', target: 'overview', name: 'Show Overview', desc: 'Show the windows overview', icon: 'view-fullscreen-symbolic', keywords: 'activities workspaces'},
    {id: 'app-grid', kind: 'system', target: 'app-grid', name: 'Show All Apps', desc: 'Show the application grid', icon: 'view-app-grid-symbolic', keywords: 'applications grid'},
    {id: 'toggle-dark-mode', kind: 'system', target: 'toggle-dark-mode', name: 'Toggle Dark Mode', desc: 'Switch between the light and dark style', icon: 'weather-clear-night-symbolic', keywords: 'theme light dark appearance'},
    {id: 'toggle-dnd', kind: 'system', target: 'toggle-dnd', name: 'Toggle Do Not Disturb', desc: 'Show or hide notification banners', icon: 'notifications-disabled-symbolic', keywords: 'notifications silence focus'},
];

const clean = v => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '');

// {id: {enabled?, shortcut?, windowShortcut?}} from stored JSON; anything malformed is dropped.
export function sanitizeBuiltins(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return out;
    for (const b of BUILTINS) {
        const o = raw[b.id];
        if (!o || typeof o !== 'object')
            continue;
        const e = {};
        if (o.enabled === false)
            e.enabled = false;
        if (clean(o.shortcut))
            e.shortcut = clean(o.shortcut);
        if (clean(o.windowShortcut))
            e.windowShortcut = clean(o.windowShortcut);
        if (Object.keys(e).length)
            out[b.id] = e;
    }
    return out;
}

export function buildBuiltinEntries(overrides, flags = {}) {
    const ov = sanitizeBuiltins(overrides);
    const shared = typeof flags.keyword === 'string' ? flags.keyword.trim().toLowerCase() : '';
    const entries = [];
    const shortcuts = [];
    const windowShortcuts = [];
    for (const b of BUILTINS) {
        const o = ov[b.id] ?? {};
        if (o.enabled === false || (b.needs && !flags[b.needs]))
            continue;
        const id = `system:${b.id}`;
        entries.push(prepare({
            id, kind: b.kind, name: b.name, desc: b.desc, category: b.category ?? 'System',
            icon: b.icon, keywords: shared ? `${b.keywords ?? ''} ${shared}`.trim() : b.keywords,
            payload: {target: b.target, placeholder: b.placeholder, empty: b.empty},
        }));
        if (o.shortcut)
            shortcuts.push({id, accel: o.shortcut});
        if (o.windowShortcut)
            windowShortcuts.push({id, accel: o.windowShortcut});
    }
    return {entries, shortcuts, windowShortcuts};
}

import {prepare} from '../search/engine.js';
import {sanitizeCommand, sanitizeAction, validateCommand, validateAction} from './schema.js';

const KIND_ICON = {command: 'utilities-terminal', action: 'system-run'};
const KIND_CATEGORY = {command: 'Commands', action: 'Actions'};

// Turn the stored JSON arrays into search entries. Invalid or disabled items are skipped
// (invalid ones are reported in `problems`); one bad item can never break the others.
// Pure function: safe to call again whenever the settings change.
export function buildUserEntries(commands, actions, categoryIcons) {
    const entries = [];
    const shortcuts = [];
    const windowShortcuts = [];
    const problems = [];
    const seen = new Set();
    const icons = categoryIcons && typeof categoryIcons === 'object' ? categoryIcons : {};

    const add = (kind, item, err, desc) => {
        if (!item.enabled)
            return;
        if (err) {
            problems.push(`${kind} "${item.name || item.id}": ${err}`);
            return;
        }
        const id = `${kind}:${item.id}`;
        if (seen.has(id)) {
            problems.push(`${kind} "${item.name}": duplicate id "${item.id}"`);
            return;
        }
        seen.add(id);
        const category = item.category || KIND_CATEGORY[kind];
        entries.push(prepare({
            id, kind, name: item.name, desc: item.description || desc,
            category, icon: item.icon || icons[category] || icons[KIND_CATEGORY[kind]] || KIND_ICON[kind],
            keywords: item.keywords, payload: item,
        }));
        if (item.shortcut)
            shortcuts.push({id, accel: item.shortcut});
        if (item.windowShortcut)
            windowShortcuts.push({id, accel: item.windowShortcut});
    };

    (Array.isArray(commands) ? commands : []).forEach((raw, i) => {
        const c = sanitizeCommand(raw, i);
        if (c)
            add('command', c, validateCommand(c), [c.command, c.args].filter(Boolean).join(' '));
    });
    (Array.isArray(actions) ? actions : []).forEach((raw, i) => {
        const a = sanitizeAction(raw, i);
        if (a)
            add('action', a, validateAction(a), `${a.type}: ${a.target}`);
    });
    return {entries, shortcuts, windowShortcuts, problems};
}

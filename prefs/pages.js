import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ACTION_FIELDS, COMMAND_FIELDS, newAction, newCommand, sanitizeAction, sanitizeCommand} from '../commands/schema.js';
import {THEME_FIELDS, THEME_BASE, builtinThemes, resolveTheme, sanitizeTheme, themeNames} from '../themes/themes.js';
import {ListEditor, Overrides, comboRow, entryRow, group, shortcutRow, spinRow, switchRow, toast} from './widgets.js';

const page = (title, icon) => new Adw.PreferencesPage({title, icon_name: icon});

function readJson(settings, key, fallback) {
    try {
        return JSON.parse(settings.get_string(key)) ?? fallback;
    } catch (_e) {
        return fallback;
    }
}

function bump(settings, key) {
    settings.set_int(key, (settings.get_int(key) + 1) % 1000000);
}

function ownShortcuts(settings) {
    const out = [];
    for (const key of ['commands', 'actions']) {
        for (const i of readJson(settings, key, [])) {
            if (i?.shortcut && i.enabled !== false)
                out.push([i.shortcut, i.name || 'Untitled']);
        }
    }
    return out;
}

function general(settings) {
    const p = page('General', 'preferences-system-symbolic');
    const g = group('Behaviour');
    g.add(switchRow(settings, 'reset-query-on-open', 'Clear the search when opening'));
    g.add(comboRow(settings, 'monitor', 'Show on', [['pointer', 'Monitor with the pointer'], ['primary', 'Primary monitor']]));
    g.add(entryRow(settings, 'placeholder', 'Placeholder text'));
    g.add(switchRow(settings, 'show-descriptions', 'Show descriptions'));
    g.add(switchRow(settings, 'show-tags', 'Show entry type labels (App / Command / Action)'));
    p.add(g);
    return p;
}

function shortcuts(window, settings) {
    const p = page('Keyboard Shortcuts', 'input-keyboard-symbolic');
    const g = group('Launcher shortcut', 'Used to open and close the launcher. Conflicts with built-in GNOME shortcuts are flagged.');
    g.add(shortcutRow(window, 'Open / close launcher',
        () => settings.get_strv('shortcut')[0] ?? '',
        v => settings.set_strv('shortcut', v ? [v] : []),
        accel => ownShortcuts(settings).filter(([a]) => a === accel).map(([, n]) => `"${n}"`)));
    g.add(switchRow(settings, 'use-super-key', 'Also open with the Super key',
        'Shell\'s overview reacts to Super too, so it is dismissed right away; a brief flash is possible.'));
    p.add(g);

    const info = group('Per-entry shortcuts', 'Shortcuts for individual commands and actions are set in their own pages. They run the entry directly without opening the launcher.');
    const list = ownShortcuts(settings);
    if (list.length === 0) {
        info.add(new Adw.ActionRow({title: 'No custom shortcuts defined'}));
    } else {
        for (const [accel, name] of list)
            info.add(new Adw.ActionRow({title: name, subtitle: accel}));
    }
    p.add(info);
    return p;
}

function appearance(settings) {
    const p = page('Appearance', 'applications-graphics-symbolic');
    const ov = new Overrides(settings);
    const dark = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('color-scheme') === 'prefer-dark';
    const c = settings;
    const cur = resolveTheme({
        custom: readJson(c, 'custom-themes', []), dark,
        name: dark ? c.get_string('theme-dark') : c.get_string('theme-light'), overrides: {},
    });

    const size = group('Size and layout', 'Pixel values are multiplied by the overall scale.');
    size.add(spinRow(settings, 'scale', 'Overall scale', 0.5, 3, 0.05, '', 2));
    size.add(spinRow(settings, 'width', 'Window width', 300, 2400, 10));
    size.add(spinRow(settings, 'window-height', 'Window minimum height', 0, 2400, 10, '0 = fit the results'));
    size.add(spinRow(settings, 'max-height', 'Maximum height', 100, 2400, 10));
    size.add(spinRow(settings, 'position', 'Vertical position (% of screen height)', 0, 95, 1));
    size.add(comboRow(settings, 'search-position', 'Search bar position', [['top', 'Above the results'], ['bottom', 'Below the results']]));
    size.add(spinRow(settings, 'search-height', 'Search bar height', 24, 200, 1));
    size.add(spinRow(settings, 'search-padding', 'Search field padding', 0, 60, 1));
    size.add(spinRow(settings, 'padding', 'Window padding', 0, 60, 1));
    size.add(spinRow(settings, 'row-height', 'Result row height', 24, 160, 1));
    size.add(spinRow(settings, 'result-spacing', 'Result spacing', 0, 40, 1));
    size.add(spinRow(settings, 'icon-size', 'Icon size', 12, 128, 1));
    size.add(spinRow(settings, 'icon-spacing', 'Icon spacing', 0, 60, 1));
    size.add(spinRow(settings, 'font-size', 'Font size (pt)', 6, 40, 0.5, '', 1));
    p.add(size);

    const anim = group('Animation');
    anim.add(comboRow(settings, 'anim-style', 'Style', [['fade-scale', 'Fade and scale'], ['fade', 'Fade'], ['slide', 'Slide'], ['none', 'None (disabled)']]));
    anim.add(spinRow(settings, 'anim-duration', 'Duration (ms)', 0, 1000, 10));
    p.add(anim);

    const look = group('Look overrides', 'These override the selected theme. Use the undo button to return to the theme value.');
    for (const f of THEME_FIELDS.filter(x => x.key !== 'name'))
        look.add(ov.row(f, cur[f.key]));
    p.add(look);
    return p;
}

function themes(window, settings) {
    const p = page('Themes', 'preferences-desktop-theme-symbolic');
    const custom = readJson(settings, 'custom-themes', []);
    const names = themeNames(custom).map(n => [n, n]);

    const sel = group('Theme selection', 'The theme list refreshes when this window is reopened after adding a theme.');
    sel.add(comboRow(settings, 'theme-mode', 'Mode', [['auto', 'Follow GNOME dark/light mode'], ['light', 'Always light'], ['dark', 'Always dark']]));
    sel.add(comboRow(settings, 'theme-light', 'Light theme', names));
    sel.add(comboRow(settings, 'theme-dark', 'Dark theme', names));
    p.add(sel);

    const editor = new ListEditor({
        window, settings, key: 'custom-themes', title: 'Custom themes',
        description: 'Import/export theme files as JSON to share them.',
        fields: THEME_FIELDS, exportName: 'launcher-themes',
        newItem: () => ({...builtinThemes()['default-dark'], name: 'My theme'}),
        sanitize: raw => {
            const t = sanitizeTheme(raw);
            if (!t.name)
                t.name = 'Imported theme';
            return t;
        },
        itemSubtitle: t => (t.opacity < 1 || t.blur > 0 ? 'translucent' : ''),
    });

    const from = new Adw.ActionRow({title: 'Start from a built-in theme'});
    const drop = Gtk.DropDown.new_from_strings(Object.keys(builtinThemes()));
    drop.valign = Gtk.Align.CENTER;
    const btn = new Gtk.Button({label: 'Create copy', valign: Gtk.Align.CENTER});
    btn.connect('clicked', () => {
        const base = Object.keys(builtinThemes())[drop.selected];
        editor.addItem({...THEME_BASE, ...builtinThemes()[base], name: `${base}-copy`});
        toast(window, 'Theme copied. Edit it below.');
    });
    from.add_suffix(drop);
    from.add_suffix(btn);
    const tools = group('');
    tools.add(from);
    p.add(tools);
    p.add(editor.group);
    return p;
}

function applications(settings) {
    const p = page('Applications', 'view-app-grid-symbolic');
    const g = group('Default icons by category', 'Used for entries without an icon. Per-entry icons are set in the Commands and Actions pages.');
    const icons = readJson(settings, 'category-icons', {});
    for (const cat of ['Applications', 'Commands', 'Actions']) {
        const row = new Adw.EntryRow({title: `${cat} (icon name or file path)`, text: icons[cat] ?? ''});
        row.connect('changed', () => {
            const o = readJson(settings, 'category-icons', {});
            if (row.text)
                o[cat] = row.text;
            else
                delete o[cat];
            settings.set_string('category-icons', JSON.stringify(o));
        });
        g.add(row);
    }
    p.add(g);

    const info = group('Application index', 'Installed applications are cached and updated only when GNOME reports a change.');
    const refresh = new Adw.ActionRow({title: 'Rescan applications now'});
    const b = new Gtk.Button({label: 'Rescan', valign: Gtk.Align.CENTER});
    b.connect('clicked', () => bump(settings, 'cache-generation'));
    refresh.add_suffix(b);
    info.add(refresh);
    p.add(info);
    return p;
}

function search(settings) {
    const p = page('Search', 'system-search-symbolic');
    const g = group('Matching');
    g.add(switchRow(settings, 'fuzzy', 'Fuzzy matching', 'Match characters in order, for example "ffx" finds Firefox.'));
    g.add(switchRow(settings, 'search-descriptions', 'Search descriptions'));
    g.add(switchRow(settings, 'frecency', 'Rank recent and frequent entries higher'));
    p.add(g);
    const r = group('Results');
    r.add(spinRow(settings, 'max-results', 'Maximum results', 5, 200, 1));
    r.add(spinRow(settings, 'initial-results', 'Entries shown before typing', 0, 50, 1));
    p.add(r);
    return p;
}

function performance(window, settings) {
    const p = page('Performance', 'utilities-system-monitor-symbolic');
    const g = group('Startup and caching');
    g.add(switchRow(settings, 'prebuild-ui', 'Prepare the window at login', 'Uses a little memory so the first open is instant. Restart the extension to apply.'));
    g.add(switchRow(settings, 'persist-cache', 'Persist the application cache to disk', 'Makes the first search after login immediate.'));
    p.add(g);
    const t = group('Maintenance');
    for (const [title, key, msg] of [
        ['Clear application cache', 'cache-generation', 'Application cache cleared and rebuilding'],
        ['Reset usage statistics', 'stats-generation', 'Usage statistics reset'],
    ]) {
        const row = new Adw.ActionRow({title});
        const b = new Gtk.Button({label: 'Run', valign: Gtk.Align.CENTER});
        b.connect('clicked', () => {
            bump(settings, key);
            toast(window, msg);
        });
        row.add_suffix(b);
        t.add(row);
    }
    p.add(t);
    return p;
}

function advanced(window, settings) {
    const p = page('Advanced', 'applications-engineering-symbolic');
    const g = group('Diagnostics');
    g.add(switchRow(settings, 'debug', 'Verbose logging', 'View with: journalctl -f -o cat /usr/bin/gnome-shell'));
    p.add(g);
    const r = group('Reset');
    const row = new Adw.ActionRow({title: 'Reset all settings', subtitle: 'Restores every option, including commands, actions and themes.'});
    const b = new Gtk.Button({label: 'Reset…', css_classes: ['destructive-action'], valign: Gtk.Align.CENTER});
    b.connect('clicked', () => {
        const d = new Adw.MessageDialog({transient_for: window, modal: true, heading: 'Reset all settings?', body: 'This cannot be undone.'});
        d.add_response('cancel', 'Cancel');
        d.add_response('reset', 'Reset');
        d.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
        d.connect('response', (_d, id) => {
            if (id === 'reset') {
                for (const k of settings.settings_schema.list_keys())
                    settings.reset(k);
                toast(window, 'Settings reset');
            }
        });
        d.present();
    });
    row.add_suffix(b);
    r.add(row);
    p.add(r);
    return p;
}

export function buildPages(window, settings) {
    const commandsPage = page('Commands', 'utilities-terminal-symbolic');
    commandsPage.add(new ListEditor({
        window, settings, key: 'commands', title: 'Custom commands',
        description: 'Run an executable directly (no shell). Quote arguments like in a shell; "~/" is expanded.',
        fields: COMMAND_FIELDS, newItem: newCommand, sanitize: sanitizeCommand, exportName: 'launcher-commands',
        itemSubtitle: c => [c.command, c.args].filter(Boolean).join(' '),
    }).group);

    const actionsPage = page('Custom Actions', 'system-run-symbolic');
    actionsPage.add(new ListEditor({
        window, settings, key: 'actions', title: 'Custom actions',
        description: 'Launch an app, run a shell snippet, open a URL, file or folder, run a script, or trigger a GNOME action. "shell" actions are executed by /bin/sh exactly as you write them.',
        fields: ACTION_FIELDS, newItem: newAction, sanitize: sanitizeAction, exportName: 'launcher-actions',
        itemSubtitle: a => `${a.type ?? ''}: ${a.target ?? ''}`,
    }).group);

    return [
        general(settings), appearance(settings), themes(window, settings), shortcuts(window, settings),
        applications(settings), commandsPage, actionsPage, search(settings),
        performance(window, settings), advanced(window, settings),
    ];
}

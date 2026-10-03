import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {BUILTINS, sanitizeBuiltins} from '../commands/builtins.js';
import {ACTION_FIELDS, COMMAND_FIELDS, newAction, newCommand, sanitizeAction, sanitizeCommand} from '../commands/schema.js';
import {THEME_FIELDS, THEME_BASE, THEME_FAMILIES, builtinThemes, resolveTheme, sanitizeTheme, themeNames} from '../themes/themes.js';
import {sanitizeProvider, newProvider} from '../search/web.js';
import {accountsPage} from './accounts.js';
import {ListEditor, Overrides, comboRow, entryRow, fileDialog, group, shortcutRow, spinRow, switchRow, toast} from './widgets.js';

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
    const b = sanitizeBuiltins(readJson(settings, 'builtins', {}));
    for (const def of BUILTINS) {
        if (b[def.id]?.shortcut && b[def.id].enabled !== false)
            out.push([b[def.id].shortcut, def.name]);
    }
    return out;
}

// Read/write one built-in entry's overrides ({enabled, shortcut, windowShortcut}) in the
// "builtins" JSON key. Shared by the Built-in Entries page and the Emoji page.
function builtinsStore(settings) {
    const read = () => sanitizeBuiltins(readJson(settings, 'builtins', {}));
    const write = (id, key, value) => {
        const o = read();
        const e = {...(o[id] ?? {})};
        // Clearing a shortcut that has a shipped default is stored as '' so the default stays off.
        const hasDefault = key === 'windowShortcut' && BUILTINS.find(b => b.id === id)?.windowShortcut;
        if (value === undefined || (value === '' && !hasDefault))
            delete e[key];
        else
            e[key] = value;
        if (Object.keys(e).length)
            o[id] = e;
        else
            delete o[id];
        settings.set_string('builtins', JSON.stringify(o));
    };
    return {read, write};
}

function emojiPage(window, settings) {
    const p = page('Emoji', 'face-smile-symbolic');
    const {read, write} = builtinsStore(settings);

    const main = group('Emoji picker',
        'Built in, with no external libraries. Open it from the launcher by typing "emoji", with its shortcut below, or type ":smile" in the main search. The emoji list is only loaded when you use it and released a minute after.');
    main.add(switchRow(settings, 'emoji-enabled', 'Enable the emoji picker'));
    main.add(switchRow(settings, 'emoji-inline', 'Search emoji from the main search', 'Typing a colon, such as :heart, lists matching emoji.'));
    main.add(spinRow(settings, 'emoji-inline-count', 'Emoji shown for a colon search', 1, 50, 1));
    main.add(switchRow(settings, 'emoji-remember', 'Show recent and frequent emoji first',
        'Remembers how often you pick each emoji (counts only, stored with the other usage statistics). Turn off to stop.'));
    p.add(main);

    const look = group('Layout');
    look.add(comboRow(settings, 'emoji-layout', 'Emoji list style', [
        ['list', 'List (one emoji per row, with its name)'],
        ['grid', 'Grid (compact squares, name shown below)'],
    ], 'In the grid the arrow keys move in two directions, Enter picks, and the name of the highlighted emoji is shown under it.'));
    look.add(entryRow(settings, 'emoji-font', 'Emoji font (empty = automatic)'));
    look.add(spinRow(settings, 'emoji-grid-size', 'Grid cell size', 28, 96, 1, 'In pixels, before the overall scale. The number of columns follows the window width.'));
    p.add(look);

    const act = group('When you choose an emoji',
        'The private buffer is kept in memory only. It never touches your clipboard or the clipboard history, and it is forgotten when the extension is disabled or you log out.');
    act.add(comboRow(settings, 'emoji-store', 'Copy it to', [
        ['clipboard', 'The clipboard'],
        ['buffer', 'The private buffer'],
        ['both', 'The clipboard and the private buffer'],
        ['none', 'Nowhere (only paste)'],
    ], 'Choosing "Nowhere" without pasting falls back to the clipboard.'));
    act.add(switchRow(settings, 'emoji-paste', 'Paste it in place and close',
        'Types the emoji into the window you were using. If it is not copied to the clipboard, your own clipboard text is put back afterwards (text only).'));
    act.add(comboRow(settings, 'emoji-paste-keys', 'Keys used to paste', [
        ['auto', 'Automatic (Ctrl+Shift+V in terminals, Ctrl+V elsewhere)'],
        ['ctrl-v', 'Ctrl+V'],
        ['ctrl-shift-v', 'Ctrl+Shift+V'],
        ['shift-insert', 'Shift+Insert'],
    ]));
    p.add(act);

    const keys = group('Shortcuts', 'A global shortcut works anywhere. A window shortcut only works while the launcher is open.');
    const conflicts = name => accel => ownShortcuts(settings).filter(([a, n]) => a === accel && n !== name).map(([, n]) => `"${n}"`);
    const picker = BUILTINS.find(b => b.id === 'emoji');
    const buffer = BUILTINS.find(b => b.id === 'emoji-paste-buffer');
    keys.add(shortcutRow(window, 'Open the emoji picker', () => read().emoji?.shortcut ?? '', v => write('emoji', 'shortcut', v), conflicts(picker.name)));
    keys.add(shortcutRow(window, 'Open the emoji picker (only while the launcher is open)',
        () => read().emoji?.windowShortcut ?? '', v => write('emoji', 'windowShortcut', v), () => [], true));
    keys.add(shortcutRow(window, 'Paste from the private buffer',
        () => read()['emoji-paste-buffer']?.shortcut ?? '', v => write('emoji-paste-buffer', 'shortcut', v), conflicts(buffer.name)));
    p.add(keys);
    return p;
}

function builtinsPage(window, settings) {
    const p = page('Built-in Entries', 'emblem-system-symbolic');
    const opts = group('Options');
    opts.add(switchRow(settings, 'clipboard-enabled', 'Remember clipboard history',
        'Kept in memory (never written to disk), updated when the clipboard changes. Turn off to stop collecting.'));
    opts.add(spinRow(settings, 'clipboard-max', 'Clipboard items to keep', 5, 200, 1));
    opts.add(switchRow(settings, 'clipboard-images', 'Remember copied images',
        'Screenshots and copied pictures, kept in memory only and shown with a thumbnail. Text always wins: an image is only kept when nothing textual was copied with it.'));
    opts.add(spinRow(settings, 'clipboard-image-count', 'Images to keep', 1, 30, 1));
    opts.add(spinRow(settings, 'clipboard-image-mb', 'Largest image to keep (MB)', 1, 32, 1, 'Bigger images are ignored. The most memory images can use is the two numbers multiplied.'));
    opts.add(switchRow(settings, 'calculator', 'Quick calculator', 'Typing an expression such as 12*(3+4) shows the result; Enter copies it.'));
    p.add(opts);

    const {read, write} = builtinsStore(settings);

    const g = group('System and utility entries',
        'Shut Down, Restart and Log Out use GNOME\'s own confirmation dialog. A global shortcut works anywhere; a window shortcut only while the launcher is open.');
    for (const b of BUILTINS.filter(x => !x.page)) { // emoji entries live on the Emoji page
        const row = new Adw.ExpanderRow({title: b.name, subtitle: b.desc});
        const sw = new Gtk.Switch({valign: Gtk.Align.CENTER, active: read()[b.id]?.enabled !== false});
        sw.connect('notify::active', () => write(b.id, 'enabled', sw.active ? undefined : false));
        row.add_suffix(sw);
        row.add_row(shortcutRow(window, 'Global shortcut', () => read()[b.id]?.shortcut ?? '', v => write(b.id, 'shortcut', v),
            accel => ownShortcuts(settings).filter(([a, n]) => a === accel && n !== b.name).map(([, n]) => `"${n}"`)));
        row.add_row(shortcutRow(window, 'Window shortcut (only while the launcher is open)',
            () => read()[b.id]?.windowShortcut ?? b.windowShortcut ?? '', v => write(b.id, 'windowShortcut', v), () => [], true));
        g.add(row);
    }
    p.add(g);
    return p;
}

function general(settings) {
    const p = page('General', 'preferences-system-symbolic');
    const g = group('Behaviour');
    g.add(switchRow(settings, 'reset-query-on-open', 'Clear the search when opening'));
    g.add(comboRow(settings, 'monitor', 'Show on', [['pointer', 'Monitor with the pointer'], ['primary', 'Primary monitor']]));
    g.add(comboRow(settings, 'outside-action', 'Pointer outside the window', [
        ['click', 'Close when clicking outside'], ['hover', 'Close when the pointer leaves the window'], ['none', 'Never close (keyboard only)'],
    ], 'Escape and the shortcut always close the launcher.'));
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
        () => settings.get_strv('gnome-launcher-toggle')[0] ?? '',
        v => settings.set_strv('gnome-launcher-toggle', v ? [v] : []),
        accel => ownShortcuts(settings).filter(([a]) => a === accel).map(([, n]) => `"${n}"`)));
    g.add(switchRow(settings, 'use-super-key', 'Also open with the Super key',
        'While on, runs: gsettings set org.gnome.mutter overlay-key \'\' (the overview no longer opens on Super). Turning it off, or disabling the extension, runs: gsettings reset org.gnome.mutter overlay-key. Super+key shortcuts are unaffected.'));
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

function appearance(window, settings) {
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
    p.add(fontsGroup(settings));

    const field = group('Search field icon', 'The icon at the start of the search field.');
    const iconRow = entryRow(settings, 'search-icon', 'Icon name or file path (empty = no icon)');
    const browse = new Gtk.Button({icon_name: 'document-open-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Choose an image file'});
    browse.connect('clicked', () => fileDialog(window, {save: false, title: 'Choose an icon'}, file => {
        const path = file.get_path();
        if (path)
            iconRow.text = path;
    }));
    iconRow.add_suffix(browse);
    field.add(iconRow);
    field.add(spinRow(settings, 'search-icon-size', 'Search icon size', 8, 64, 1));
    p.add(field);

    const scroll = group('Results list');
    scroll.add(switchRow(settings, 'show-scrollbar', 'Show the scrollbar',
        'Off by default: the list still scrolls with the mouse wheel, touchpad and keyboard, but no scrollbar is ever drawn.'));
    p.add(scroll);

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
    const fams = Object.keys(THEME_FAMILIES);
    const quick = new Adw.ComboRow({
        title: 'Quick preset',
        subtitle: 'Sets the light and dark theme together, for example Raycast or Vicinae.',
        model: Gtk.StringList.new(['Choose a preset…', ...fams]),
    });
    const syncQuick = () => {
        const pair = [settings.get_string('theme-light'), settings.get_string('theme-dark')];
        const i = fams.findIndex(f => THEME_FAMILIES[f][0] === pair[0] && THEME_FAMILIES[f][1] === pair[1]);
        quick.selected = i + 1;
    };
    syncQuick();
    quick.connect('notify::selected', () => {
        const fam = fams[quick.selected - 1];
        if (!fam)
            return;
        settings.set_string('theme-light', THEME_FAMILIES[fam][0]);
        settings.set_string('theme-dark', THEME_FAMILIES[fam][1]);
    });
    settings.connect('changed::theme-light', syncQuick);
    settings.connect('changed::theme-dark', syncQuick);
    sel.add(quick);
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

// One font slot: family (chosen with the system font dialog; empty = the theme's), size, weight.
function fontSlot(settings, {title, subtitle, family, size, sizeMin, sizeTitle, weight}) {
    const row = new Adw.ExpanderRow({title, subtitle});
    const famRow = new Adw.ActionRow({title: 'Font family'});
    const btn = new Gtk.FontDialogButton({dialog: new Gtk.FontDialog(), level: Gtk.FontLevel.FAMILY, valign: Gtk.Align.CENTER});
    const reset = new Gtk.Button({icon_name: 'edit-clear-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Use the theme font'});
    let syncing = false;
    const sync = () => {
        syncing = true;
        const name = settings.get_string(family);
        famRow.subtitle = name || 'Theme font';
        btn.font_desc = Pango.FontDescription.from_string(name || 'Sans');
        reset.sensitive = name !== '';
        syncing = false;
    };
    btn.connect('notify::font-desc', () => {
        if (syncing)
            return;
        const fam = btn.font_desc?.get_family() ?? '';
        if (fam)
            settings.set_string(family, fam);
    });
    reset.connect('clicked', () => settings.set_string(family, ''));
    settings.connect(`changed::${family}`, sync);
    sync();
    famRow.add_suffix(btn);
    famRow.add_suffix(reset);
    row.add_row(famRow);
    row.add_row(spinRow(settings, size, sizeTitle, sizeMin, 40, 0.5, sizeMin === 0 ? 'Automatic follows the main size.' : '', 1));
    row.add_row(spinRow(settings, weight, 'Weight (0 = theme, 400 normal, 700 bold)', 0, 900, 100));
    return row;
}

function fontsGroup(settings) {
    const g = group('Fonts',
        'Three separate fonts. Leave a family empty to use the font of the theme. Very large sizes can be clipped by the row height, which is set under Size.');
    g.add(fontSlot(settings, {
        title: 'Search bar font', subtitle: 'The text you type and its placeholder',
        family: 'font-search', size: 'font-size-search', sizeMin: 0, sizeTitle: 'Font size (pt, 0 = automatic)', weight: 'font-weight-search',
    }));
    g.add(fontSlot(settings, {
        title: 'Main font', subtitle: 'Result titles, the empty-list message and the emoji name line',
        family: 'font-main', size: 'font-size', sizeMin: 6, sizeTitle: 'Font size (pt)', weight: 'font-weight-main',
    }));
    g.add(fontSlot(settings, {
        title: 'Details font', subtitle: 'Descriptions and the small type labels',
        family: 'font-secondary', size: 'font-size-secondary', sizeMin: 0, sizeTitle: 'Font size (pt, 0 = automatic)', weight: 'font-weight-secondary',
    }));
    return g;
}

const WEB_FIELDS = [
    {key: 'name', label: 'Name', type: 'text'},
    {key: 'url', label: 'Address, with {query} where the search text goes', type: 'text'},
    {key: 'icon', label: 'Icon (theme name or file path, optional)', type: 'text'},
    {key: 'ai', label: 'This is an AI assistant (changes the wording)', type: 'switch'},
    {key: 'enabled', label: 'Enabled', type: 'switch'},
];

function webPage(window, settings) {
    const p = page('Web & AI', 'web-browser-symbolic');
    const g = group('When nothing matches',
        'Adds entries that open your browser with what you typed: a web search or an AI assistant. You can always force them by starting the search with "? ", for example "? how to rename a git branch".');
    g.add(comboRow(settings, 'web-fallback', 'Offer web and AI entries', [
        ['empty', 'Only when nothing was found'],
        ['always', 'Always, after the other results'],
        ['off', 'Never (the "? " prefix still works)'],
    ]));
    p.add(g);
    p.add(new ListEditor({
        window, settings, key: 'web-providers', title: 'Search engines and AI assistants',
        description: 'Only http and https addresses that contain {query} are accepted. The text is percent-encoded for you. Prefilling the question works on the sites listed by default; other assistants may only open their start page.',
        fields: WEB_FIELDS, newItem: newProvider, sanitize: sanitizeProvider, exportName: 'launcher-web-search',
        itemSubtitle: w => `${w.ai ? 'AI · ' : ''}${w.url ?? ''}`,
    }).group);
    return p;
}

function search(settings) {
    const p = page('Search', 'system-search-symbolic');
    const rx = group('Regular expressions',
        'Match names, keywords and descriptions with a pattern, for example /^(chrom|fire)/ or /term.*emu/. Matching ignores case.');
    rx.add(comboRow(settings, 'regex-mode', 'Use regular expressions', [
        ['prefix', 'When the search starts with a slash'],
        ['always', 'Always when the text looks like a pattern (falls back to normal search if it is not valid)'],
        ['off', 'Never'],
    ]));
    rx.add(new Adw.ActionRow({
        title: 'Safety limits',
        subtitle: 'Patterns that can freeze the shell are refused: more than two open-ended repeats (*, +), repeated groups that contain repeats or alternatives, back-references and look-behind. Custom commands can also use /regex/ in their keywords.',
    }));
    p.add(rx);
    const g = group('Matching');
    g.add(switchRow(settings, 'fuzzy', 'Fuzzy matching', 'Match characters in order, for example "ffx" finds Firefox.'));
    g.add(switchRow(settings, 'search-descriptions', 'Search descriptions'));
    g.add(switchRow(settings, 'frecency', 'Rank recent and frequent entries higher'));
    p.add(g);
    const k = group('Launcher entries');
    k.add(entryRow(settings, 'own-keyword', 'Shared keyword for the launcher\'s own entries'));
    k.add(new Adw.ActionRow({
        title: 'How it works',
        subtitle: 'Emoji Picker, Clipboard History, the power actions and the other built-in entries all carry this word. Typing exactly it lists all of them at once. Leave it empty to turn this off.',
    }));
    p.add(k);
    const r = group('Results');
    r.add(switchRow(settings, 'unlimited-results', 'Scroll through every result',
        'Shows all entries before typing and every match while typing, with no limit. The two limits below are then ignored. Rows are created as you scroll, so long lists stay cheap.'));
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
        general(settings), appearance(window, settings), themes(window, settings), shortcuts(window, settings),
        applications(settings), builtinsPage(window, settings), emojiPage(window, settings),
        accountsPage(window, settings, builtinsStore(settings), ownShortcuts), commandsPage, actionsPage, search(settings), webPage(window, settings),
        performance(window, settings), advanced(window, settings),
    ];
}

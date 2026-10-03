import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

// --- simple GSettings-bound rows -------------------------------------------

export function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function spinRow(settings, key, title, lo, hi, step, subtitle = '', digits = 0) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({lower: lo, upper: hi, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function entryRow(settings, key, title) {
    const row = new Adw.EntryRow({title});
    settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// "i" button with a popover that explains regular expressions. Shared by the Search page and the
// keywords field of commands/actions.
const REGEX_HELP = `<b>Regular expressions</b>
A pattern is a short rule that matches text. Case is ignored.

<b>In a command or action  (recommended)</b>
Open the entry's <i>Search keywords</i> field and write the pattern between two slashes, next to ordinary words:
<tt>terminal /^(open )?term(inal)?$/</tt>
The pattern is tested against everything typed in the launcher, and the entry is listed when it matches. Add <tt>^</tt> and <tt>$</tt> to require the whole text. This works whatever the search-box setting below is.

<b>In the search box  (optional)</b>
Start with a slash, for example <tt>/chrom|fire</tt>. Turn it on or off under Search, "Use regular expressions".

<b>Cheat sheet</b>
<tt>^</tt> start    <tt>$</tt> end    <tt>.</tt> any character
<tt>a|b</tt> a or b    <tt>(ab)</tt> group    <tt>[abc]</tt> one of
<tt>?</tt> optional    <tt>*</tt> zero or more    <tt>+</tt> one or more
<tt>\\d</tt> digit    <tt>\\w</tt> letter or digit    <tt>\\.</tt> a literal dot

<b>Examples</b>
<tt>/^(vs)?code$/</tt>  matches "code" and "vscode"
<tt>/^(sh|shut)(down)?$/</tt>  matches "sh", "shut", "shutdown"
<tt>/^\\d+$/</tt>  matches a number

<b>Safety</b>
Patterns that could freeze the shell are ignored: more than two <tt>*</tt> or <tt>+</tt>, repeated groups that contain repeats, back-references and look-behind.`;

export function regexHelpButton() {
    const label = new Gtk.Label({
        use_markup: true, label: REGEX_HELP, wrap: true, xalign: 0, max_width_chars: 58,
        margin_top: 12, margin_bottom: 12, margin_start: 14, margin_end: 14,
    });
    const scroll = new Gtk.ScrolledWindow({
        child: label, hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, max_content_height: 460, min_content_width: 420,
    });
    return new Gtk.MenuButton({
        icon_name: 'dialog-information-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER,
        tooltip_text: 'How to write regular expressions', popover: new Gtk.Popover({child: scroll}),
    });
}

// options: [[value, label], ...] bound to a string key.
export function comboRow(settings, key, title, options, subtitle = '') {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new(options.map(o => o[1]))});
    const sync = () => {
        const i = options.findIndex(o => o[0] === settings.get_string(key));
        row.selected = i >= 0 ? i : 0;
    };
    sync();
    row.connect('notify::selected', () => {
        const v = options[row.selected]?.[0];
        if (v !== undefined && v !== settings.get_string(key))
            settings.set_string(key, v);
    });
    settings.connect(`changed::${key}`, sync);
    return row;
}

export function group(title, description = '') {
    return new Adw.PreferencesGroup({title, description});
}

export function toast(window, text) {
    window.add_toast(new Adw.Toast({title: text, timeout: 3}));
}

// --- accelerators ----------------------------------------------------------

export function accelLabel(accel) {
    if (!accel)
        return 'Disabled';
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    return ok ? Gtk.accelerator_get_label(key, mods) : accel;
}

const KEYBINDING_SCHEMAS = [
    'org.gnome.desktop.wm.keybindings', 'org.gnome.shell.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys', 'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
];

// Names of GNOME keybindings that already use `accel` (best effort, read-only).
export function findConflicts(accel) {
    const out = [];
    if (!accel)
        return out;
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    if (!ok)
        return out;
    const source = Gio.SettingsSchemaSource.get_default();
    for (const id of KEYBINDING_SCHEMAS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;
        const s = new Gio.Settings({settings_schema: schema});
        for (const name of schema.list_keys()) {
            const v = s.get_value(name);
            const t = v.get_type_string();
            const values = t === 'as' ? v.deepUnpack() : t === 's' ? [v.deepUnpack()] : [];
            for (const a of values) {
                const [ok2, k2, m2] = Gtk.accelerator_parse(a);
                if (ok2 && k2 === key && m2 === mods)
                    out.push(`${id.split('.').pop()}: ${name}`);
            }
        }
    }
    return out;
}

// Modal "press a shortcut" dialog. callback(accel) gets '' when cleared.
export function captureShortcut(parent, callback) {
    const win = new Adw.Window({modal: true, transient_for: parent, default_width: 380, default_height: 220, title: 'Set shortcut'});
    const page = new Adw.StatusPage({
        icon_name: 'input-keyboard-symbolic', title: 'Press a key combination',
        description: 'Esc cancels, Backspace clears.',
    });
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    view.set_content(page);
    win.set_content(view);

    const ctrl = new Gtk.EventControllerKey();
    ctrl.connect('key-pressed', (_c, keyval, keycode, state) => {
        let mask = state & Gtk.accelerator_get_default_mod_mask();
        mask &= ~Gdk.ModifierType.LOCK_MASK;
        if (!mask && keyval === Gdk.KEY_Escape) {
            win.close();
            return Gdk.EVENT_STOP;
        }
        if (!mask && keyval === Gdk.KEY_BackSpace) {
            callback('');
            win.close();
            return Gdk.EVENT_STOP;
        }
        if (!Gtk.accelerator_valid(keyval, mask) || !mask)
            return Gdk.EVENT_STOP; // modifiers only / bare keys are not accepted
        callback(Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask));
        win.close();
        return Gdk.EVENT_STOP;
    });
    win.add_controller(ctrl);
    win.present();
}

// Row with the current accelerator, a "Set" and a "Clear" button, plus a conflict hint.
// local = a window shortcut (only active while the launcher is open): no GNOME conflict check
// is needed because it is never grabbed globally, but it must include Ctrl, Alt or Super.
export function shortcutRow(window, title, getter, setter, extraConflicts = () => [], local = false) {
    const row = new Adw.ActionRow({title});
    const label = new Gtk.Label({css_classes: ['dim-label'], valign: Gtk.Align.CENTER});
    const set = new Gtk.Button({label: 'Set…', valign: Gtk.Align.CENTER});
    const clear = new Gtk.Button({icon_name: 'edit-clear-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Clear'});
    const refresh = () => {
        const accel = getter();
        label.label = accelLabel(accel);
        const c = [...(local ? [] : findConflicts(accel)), ...extraConflicts(accel)];
        const warn = accel && local && !/<(Control|Ctrl|Primary|Alt|Mod1|Super|Mod4|Meta)>/i.test(accel)
            ? '⚠ Needs Ctrl, Alt or Super to work. ' : '';
        row.subtitle = c.length ? `⚠ Also used by: ${c.join(', ')}`
            : (warn || (local ? 'Only active while the launcher is open.' : ''));
    };
    set.connect('clicked', () => captureShortcut(window, accel => {
        setter(accel);
        refresh();
    }));
    clear.connect('clicked', () => {
        setter('');
        refresh();
    });
    row.add_suffix(label);
    row.add_suffix(set);
    row.add_suffix(clear);
    refresh();
    return row;
}

// --- colour helpers ----------------------------------------------------------

export function hexToRgba(hex) {
    const c = new Gdk.RGBA();
    c.parse(hex.slice(0, 7));
    if (hex.length === 9)
        c.alpha = parseInt(hex.slice(7, 9), 16) / 255;
    return c;
}

export function rgbaToHex(c, withAlpha) {
    const h = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${h(c.red)}${h(c.green)}${h(c.blue)}${withAlpha && c.alpha < 1 ? h(c.alpha) : ''}`;
}

function colorButton(initial, onChange) {
    const btn = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: true}), valign: Gtk.Align.CENTER});
    btn.rgba = hexToRgba(initial);
    btn.connect('notify::rgba', () => onChange(rgbaToHex(btn.rgba, true)));
    return btn;
}

// --- generic list editor over a JSON-array GSettings key --------------------

function readJsonArray(settings, key) {
    try {
        const a = JSON.parse(settings.get_string(key));
        return Array.isArray(a) ? a.filter(o => o && typeof o === 'object' && !Array.isArray(o)) : [];
    } catch (_e) {
        return [];
    }
}

export function fileDialog(window, {save, title, name}, done) {
    const dlg = new Gtk.FileDialog({title, initial_name: name});
    const cb = (d, res) => {
        try {
            done(save ? d.save_finish(res) : d.open_finish(res));
        } catch (e) {
            if (!e.matches?.(Gtk.DialogError, Gtk.DialogError.DISMISSED) && !e.matches?.(Gtk.DialogError, Gtk.DialogError.CANCELLED))
                toast(window, `File error: ${e.message}`);
        }
    };
    if (save)
        dlg.save(window, null, cb);
    else
        dlg.open(window, null, cb);
}

export class ListEditor {
    // opts: {window, settings, key, title, description, fields, newItem(), sanitize(item, i),
    //        exportName, itemSubtitle(item), extraHeaderButtons: [Gtk.Widget]}
    constructor(opts) {
        this._o = opts;
        this._rows = [];
        this.group = new Adw.PreferencesGroup({title: opts.title, description: opts.description ?? ''});

        const box = new Gtk.Box({spacing: 6});
        const mk = (icon, tip, fn) => {
            const b = new Gtk.Button({icon_name: icon, tooltip_text: tip, css_classes: ['flat']});
            b.connect('clicked', fn);
            box.append(b);
        };
        mk('list-add-symbolic', 'Add', () => this._add());
        mk('document-open-symbolic', 'Import from JSON file', () => this._import());
        mk('document-save-symbolic', 'Export to JSON file', () => this._export());
        for (const w of opts.extraHeaderButtons ?? [])
            box.append(w);
        this.group.set_header_suffix(box);

        this._items = readJsonArray(opts.settings, opts.key);
        this._rebuild();
    }

    _save() {
        this._o.settings.set_string(this._o.key, JSON.stringify(this._items));
    }

    _add(template = null) {
        const item = template ?? this._o.newItem();
        item.id ??= GLib.uuid_string_random().slice(0, 8);
        this._items.push(item);
        this._save();
        this._rebuild();
    }

    addItem(item) {
        this._add(item);
    }

    _rebuild() {
        for (const r of this._rows)
            this.group.remove(r);
        this._rows = [];
        for (const item of this._items) {
            const row = this._makeRow(item);
            this.group.add(row);
            this._rows.push(row);
        }
    }

    _makeRow(item) {
        const o = this._o;
        const row = new Adw.ExpanderRow({title: item.name || 'Untitled', subtitle: o.itemSubtitle?.(item) ?? ''});
        const del = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Remove'});
        del.connect('clicked', () => {
            this._items.splice(this._items.indexOf(item), 1);
            this._save();
            this._rebuild();
        });
        row.add_suffix(del);

        const set = (key, value) => {
            item[key] = value;
            if (key === 'name')
                row.title = value || 'Untitled';
            row.subtitle = o.itemSubtitle?.(item) ?? '';
            this._save();
        };
        for (const f of o.fields)
            row.add_row(this._fieldWidget(item, f, set));
        return row;
    }

    _fieldWidget(item, f, set) {
        switch (f.type) {
        case 'switch': {
            const w = new Adw.SwitchRow({title: f.label, active: item[f.key] !== false});
            w.connect('notify::active', () => set(f.key, w.active));
            return w;
        }
        case 'combo': {
            const w = new Adw.ComboRow({title: f.label, model: Gtk.StringList.new(f.options)});
            const i = f.options.indexOf(item[f.key]);
            w.selected = i >= 0 ? i : 0;
            w.connect('notify::selected', () => set(f.key, f.options[w.selected]));
            return w;
        }
        case 'number': {
            const w = new Adw.SpinRow({
                title: f.label, digits: f.digits ?? 0,
                adjustment: new Gtk.Adjustment({lower: f.min, upper: f.max, step_increment: f.step, page_increment: f.step * 10}),
            });
            w.value = typeof item[f.key] === 'number' ? item[f.key] : f.min;
            w.connect('notify::value', () => set(f.key, w.value));
            return w;
        }
        case 'color': {
            const w = new Adw.ActionRow({title: f.label});
            w.add_suffix(colorButton(item[f.key] || '#000000', hex => set(f.key, hex)));
            return w;
        }
        case 'shortcut':
            return shortcutRow(this._o.window, f.label, () => item[f.key] ?? '', v => set(f.key, v),
                accel => this._ownConflicts(item, accel, f), !!f.local);
        default: {
            const w = new Adw.EntryRow({title: f.label, text: item[f.key] ?? ''});
            w.connect('changed', () => set(f.key, w.text));
            if (f.help === 'regex')
                w.add_suffix(regexHelpButton());
            return w;
        }
        }
    }

    _ownConflicts(item, accel, field) {
        if (!accel)
            return [];
        const out = [];
        if (!field.local && this._o.settings.get_strv('gnome-launcher-toggle').includes(accel))
            out.push('launcher shortcut');
        for (const other of this._items) {
            if (other !== item && other[field.key] === accel)
                out.push(`"${other.name || 'Untitled'}"`);
        }
        return out;
    }

    _export() {
        const o = this._o;
        fileDialog(o.window, {save: true, title: 'Export', name: `${o.exportName ?? o.key}.json`}, file => {
            file.replace_contents(new TextEncoder().encode(JSON.stringify(this._items, null, 2)), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            toast(o.window, 'Exported');
        });
    }

    _import() {
        const o = this._o;
        fileDialog(o.window, {save: false, title: 'Import'}, file => {
            const [, bytes] = file.load_contents(null);
            let data = JSON.parse(new TextDecoder().decode(bytes));
            if (!Array.isArray(data))
                data = [data];
            let n = 0;
            for (const raw of data) {
                const item = o.sanitize ? o.sanitize(raw, this._items.length) : raw;
                if (!item)
                    continue;
                item.id = GLib.uuid_string_random().slice(0, 8);
                this._items.push(item);
                n++;
            }
            this._save();
            this._rebuild();
            toast(o.window, `Imported ${n} item${n === 1 ? '' : 's'}`);
        });
    }
}

// Appearance overrides: one JSON object ('theme-overrides') layered over the active theme.
export class Overrides {
    constructor(settings) {
        this._s = settings;
    }

    get() {
        try {
            const o = JSON.parse(this._s.get_string('theme-overrides'));
            return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
        } catch (_e) {
            return {};
        }
    }

    set(key, value) {
        const o = this.get();
        if (value === undefined)
            delete o[key];
        else
            o[key] = value;
        this._s.set_string('theme-overrides', JSON.stringify(o));
    }

    // `field` is a THEME_FIELDS entry; `current` the effective value shown initially.
    row(field, current) {
        const row = new Adw.ActionRow({title: field.label});
        const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Use the theme value'});
        reset.sensitive = field.key in this.get();
        let widget;
        if (field.type === 'color') {
            widget = colorButton(this.get()[field.key] ?? current, hex => {
                this.set(field.key, hex);
                reset.sensitive = true;
            });
        } else if (field.type === 'number') {
            widget = new Gtk.SpinButton({
                valign: Gtk.Align.CENTER, digits: field.digits ?? 0,
                adjustment: new Gtk.Adjustment({lower: field.min, upper: field.max, step_increment: field.step, page_increment: field.step * 10}),
            });
            widget.value = this.get()[field.key] ?? current;
            widget.connect('value-changed', () => {
                this.set(field.key, widget.value);
                reset.sensitive = true;
            });
        } else if (field.type === 'combo') {
            widget = Gtk.DropDown.new_from_strings(field.options);
            widget.valign = Gtk.Align.CENTER;
            widget.selected = Math.max(0, field.options.indexOf(this.get()[field.key] ?? current));
            widget.connect('notify::selected', () => {
                this.set(field.key, field.options[widget.selected]);
                reset.sensitive = true;
            });
        } else {
            widget = new Gtk.Entry({valign: Gtk.Align.CENTER, text: this.get()[field.key] ?? current ?? ''});
            widget.connect('changed', () => {
                this.set(field.key, widget.text);
                reset.sensitive = true;
            });
        }
        reset.connect('clicked', () => {
            this.set(field.key, undefined);
            reset.sensitive = false;
            if (field.type === 'color')
                widget.rgba = hexToRgba(current);
            else if (field.type === 'number')
                widget.value = current;
            else if (field.type === 'combo')
                widget.selected = Math.max(0, field.options.indexOf(current));
            else
                widget.text = current ?? '';
            // Resetting re-triggers the change handler; clear the override again afterwards.
            this.set(field.key, undefined);
            reset.sensitive = false;
        });
        row.add_suffix(widget);
        row.add_suffix(reset);
        return row;
    }
}

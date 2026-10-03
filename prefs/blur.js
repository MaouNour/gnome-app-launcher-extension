import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {EFFECTS, GROUPS, DEFAULT_PIPELINES, newEffect, newPipelineId, newEffectId, pickPipeline, sanitizePipelines} from '../blur/defs.js';
import {comboRow, group, spinRow, switchRow, toast} from './widgets.js';

// The blur page. The effects, their parameters and the pipeline idea come from "Blur my Shell" (aunetx).

function readPipelines(settings) {
    try {
        return sanitizePipelines(JSON.parse(settings.get_string('blur-pipelines')));
    } catch (_e) {
        return sanitizePipelines(null);
    }
}

// One editable parameter of an effect.
function paramRow(spec, value, onChange) {
    switch (spec.type) {
    case 'float':
    case 'integer': {
        const row = new Adw.SpinRow({
            title: spec.name, subtitle: spec.description,
            digits: spec.type === 'integer' ? 0 : (spec.digits ?? 2),
            adjustment: new Gtk.Adjustment({
                lower: spec.min, upper: spec.max, step_increment: spec.increment,
                page_increment: spec.big_increment ?? spec.increment * 10, value,
            }),
        });
        row.connect('notify::value', () => onChange(spec.type === 'integer' ? Math.round(row.value) : row.value));
        return row;
    }
    case 'boolean': {
        const row = new Adw.SwitchRow({title: spec.name, subtitle: spec.description, active: !!value});
        row.connect('notify::active', () => onChange(row.active));
        return row;
    }
    case 'dropdown': {
        const row = new Adw.ComboRow({title: spec.name, subtitle: spec.description, model: Gtk.StringList.new(spec.options)});
        row.selected = Math.min(Math.max(0, value | 0), spec.options.length - 1);
        row.connect('notify::selected', () => onChange(row.selected));
        return row;
    }
    case 'rgba': {
        const row = new Adw.ActionRow({title: spec.name, subtitle: spec.description});
        const rgba = new Gdk.RGBA();
        [rgba.red, rgba.green, rgba.blue, rgba.alpha] = value;
        const btn = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({with_alpha: !!spec.use_alpha}), rgba, valign: Gtk.Align.CENTER});
        btn.connect('notify::rgba', () => {
            const c = btn.rgba;
            onChange([c.red, c.green, c.blue, c.alpha]);
        });
        row.add_suffix(btn);
        return row;
    }
    default:
        return null;
    }
}

function iconButton(icon, tip, onClick) {
    const b = new Gtk.Button({icon_name: icon, tooltip_text: tip, valign: Gtk.Align.CENTER, css_classes: ['flat']});
    b.connect('clicked', onClick);
    return b;
}

export function blurPage(window, settings) {
    const p = new Adw.PreferencesPage({title: 'Blur', icon_name: 'applications-graphics-symbolic'});

    // --- mode ------------------------------------------------------------------------------------
    const g = group('Blur',
        'Built on Blur my Shell. The blur is a separate layer behind the launcher window, not an effect on the window, which avoids the flicker and glitches an effect on the window itself can cause.');
    g.add(comboRow(settings, 'blur-mode', 'Blur mode', [
        ['theme', 'Follow the theme (its Blur strength setting)'],
        ['dynamic', 'Dynamic: blur what is behind the launcher (set below)'],
        ['static', 'Static: blur the wallpaper through a pipeline of effects'],
        ['off', 'Off'],
    ], 'Dynamic blurs windows and wallpaper behind the launcher and follows them. Static only ever shows the blurred wallpaper (cheaper, but windows behind are not blurred, and a fully opaque theme hides it). A theme needs some transparency to show any blur.'));
    p.add(g);

    // --- dynamic ---------------------------------------------------------------------------------
    const d = group('Dynamic blur', 'Used by the Dynamic mode.');
    d.add(spinRow(settings, 'blur-sigma', 'Strength (sigma)', 0, 100, 1, 'Larger blurs more. 0 turns the blur off.'));
    d.add(spinRow(settings, 'blur-brightness', 'Brightness', 0, 1, 0.01, 'Lower darkens the blur, which can make text easier to read.', 2));
    d.add(switchRow(settings, 'blur-corner-auto', 'Corner radius follows the theme',
        'Rounds the blur like the launcher window. Only applies where this GNOME Shell\'s blur supports rounded corners; otherwise the blur stays rectangular and the window\'s own rounded corners still show.'));
    d.add(spinRow(settings, 'blur-corner-radius', 'Corner radius', 0, 150, 1, 'Used when the switch above is off.'));
    d.add(switchRow(settings, 'blur-repaint', 'Keep the blur repainting',
        'Fixes a blur that stops updating while something moves behind the launcher. Turn off only if you see higher GPU use.'));
    p.add(d);

    // --- static pipelines ------------------------------------------------------------------------
    let pipelines = readPipelines(settings);
    let saving = null;
    let rows = [];

    const save = () => {
        if (saving)
            GLib.source_remove(saving);
        saving = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            saving = null;
            settings.set_string('blur-pipelines', JSON.stringify(pipelines));
            return GLib.SOURCE_REMOVE;
        });
    };
    const selectedId = () => pickPipeline(pipelines, settings.get_string('blur-pipeline'));

    const s = group('Static blur pipeline',
        'A pipeline is a list of effects applied in order to the wallpaper. Reorder, add and remove them, and change each one\'s settings. Add a Corner effect last to round the corners.');
    const picker = new Adw.ComboRow({title: 'Pipeline'});
    const nameRow = new Adw.EntryRow({title: 'Name'});
    const bar = new Adw.ActionRow({title: 'Manage pipelines'});
    const addNew = new Gtk.Button({label: 'New', valign: Gtk.Align.CENTER});
    const dup = new Gtk.Button({label: 'Duplicate', valign: Gtk.Align.CENTER});
    const del = new Gtk.Button({label: 'Delete', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
    const reset = new Gtk.Button({label: 'Reset all', valign: Gtk.Align.CENTER});
    for (const b of [addNew, dup, del, reset])
        bar.add_suffix(b);
    s.add(picker);
    s.add(nameRow);
    s.add(bar);
    p.add(s);

    const advanced = new Gtk.Switch({valign: Gtk.Align.CENTER, tooltip_text: 'Also offer the advanced effects: color-space conversions, down/upscaling and a slower exact gaussian blur'});
    const advBox = new Gtk.Box({spacing: 8, valign: Gtk.Align.CENTER});
    advBox.append(new Gtk.Label({label: 'Advanced effects'}));
    advBox.append(advanced);
    const fx = group('Effects of the selected pipeline');
    fx.set_header_suffix(advBox);
    const adder = new Adw.ComboRow({title: 'Add an effect'});
    const addBtn = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER, css_classes: ['suggested-action']});
    adder.add_suffix(addBtn);
    p.add(fx);

    let effectTypes = [];
    const fillAdder = () => {
        effectTypes = [];
        const names = [];
        for (const grp of Object.values(GROUPS)) {
            for (const t of grp.contains) {
                if (!advanced.active && EFFECTS[t].is_advanced)
                    continue;
                effectTypes.push(t);
                names.push(`${grp.name}: ${EFFECTS[t].name}`);
            }
        }
        adder.model = Gtk.StringList.new(names);
    };

    let building = false;
    const fillPicker = () => {
        building = true;
        const ids = Object.keys(pipelines);
        picker.model = Gtk.StringList.new(ids.map(i => pipelines[i].name));
        picker.selected = Math.max(0, ids.indexOf(selectedId()));
        nameRow.text = pipelines[selectedId()].name;
        del.sensitive = !(selectedId() in DEFAULT_PIPELINES);
        building = false;
    };

    const rebuildEffects = () => {
        for (const r of rows)
            fx.remove(r);
        rows = [];
        const id = selectedId();
        const list = pipelines[id].effects;
        list.forEach((eff, i) => {
            const def = EFFECTS[eff.type];
            const row = new Adw.ExpanderRow({title: def.name, subtitle: def.description});
            for (const [key, spec] of Object.entries(def.editable_params)) {
                const w = paramRow(spec, eff.params[key], v => {
                    eff.params[key] = v;
                    save();
                });
                if (w)
                    row.add_row(w);
            }
            const tools = new Adw.ActionRow({title: 'Position in the pipeline', subtitle: `Step ${i + 1} of ${list.length}`});
            const up = iconButton('go-up-symbolic', 'Move up', () => move(i, -1));
            const down = iconButton('go-down-symbolic', 'Move down', () => move(i, 1));
            const rm = iconButton('user-trash-symbolic', 'Remove', () => {
                list.splice(i, 1);
                save();
                rebuildEffects();
            });
            up.sensitive = i > 0;
            down.sensitive = i < list.length - 1;
            tools.add_suffix(up);
            tools.add_suffix(down);
            tools.add_suffix(rm);
            row.add_row(tools);
            fx.add(row);
            rows.push(row);
        });
        if (list.length === 0) {
            const empty = new Adw.ActionRow({title: 'No effects', subtitle: 'The wallpaper is shown without any change. Add an effect below.'});
            fx.add(empty);
            rows.push(empty);
        }
        fx.add(adder);
        rows.push(adder);
    };
    const move = (i, by) => {
        const list = pipelines[selectedId()].effects;
        const j = i + by;
        if (j < 0 || j >= list.length)
            return;
        [list[i], list[j]] = [list[j], list[i]];
        save();
        rebuildEffects();
    };

    const select = id => {
        settings.set_string('blur-pipeline', id);
        fillPicker();
        rebuildEffects();
    };

    picker.connect('notify::selected', () => {
        if (building)
            return;
        const id = Object.keys(pipelines)[picker.selected];
        if (id && id !== selectedId())
            select(id);
    });
    nameRow.connect('changed', () => {
        if (building)
            return;
        pipelines[selectedId()].name = nameRow.text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60) || selectedId();
        save();
    });
    nameRow.connect('apply', () => fillPicker());
    nameRow.show_apply_button = true;
    addNew.connect('clicked', () => {
        const id = newPipelineId();
        pipelines[id] = {name: 'New pipeline', effects: [newEffect('native_static_gaussian_blur')]};
        save();
        select(id);
    });
    dup.connect('clicked', () => {
        const src = pipelines[selectedId()];
        const id = newPipelineId();
        pipelines[id] = {
            name: `${src.name} copy`,
            effects: src.effects.map(e => ({type: e.type, id: newEffectId(), params: JSON.parse(JSON.stringify(e.params))})),
        };
        save();
        select(id);
    });
    del.connect('clicked', () => {
        const id = selectedId();
        if (id in DEFAULT_PIPELINES)
            return;
        delete pipelines[id];
        save();
        select('pipeline_default');
    });
    reset.connect('clicked', () => {
        pipelines = sanitizePipelines(null);
        settings.set_string('blur-pipelines', JSON.stringify(pipelines));
        select('pipeline_default');
        toast(window, 'Pipelines reset to the defaults');
    });
    addBtn.connect('clicked', () => {
        const t = effectTypes[adder.selected];
        if (!t)
            return;
        pipelines[selectedId()].effects.push(newEffect(t));
        save();
        rebuildEffects();
    });
    advanced.connect('notify::active', fillAdder);

    fillAdder();
    fillPicker();
    rebuildEffects();

    // Keep the page in step if the pipelines are changed from outside (dconf, another window).
    settings.connect('changed::blur-pipelines', () => {
        if (saving)
            return; // our own pending write
        const fresh = readPipelines(settings);
        if (JSON.stringify(fresh) !== JSON.stringify(pipelines)) {
            pipelines = fresh;
            fillPicker();
            rebuildEffects();
        }
    });
    return p;
}

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {buildStyles} from './style.js';
import {dbg, warn} from '../utils/log.js';

const TAGS = {
    app: 'App', command: 'Command', action: 'Action', system: 'System',
    mode: 'Mode', clip: 'Clipboard', calc: 'Result',
};
const MOD_MASK = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK;
const NEEDS_MOD = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK;

// "<Control><Alt>t" -> {mods, key} using Clutter.KEY_* constants. Window shortcuts must
// include Ctrl, Alt or Super (otherwise they would swallow normal typing).
function parseAccel(accel) {
    let rest = String(accel ?? '').trim();
    let mods = 0;
    for (let m = /^<([A-Za-z0-9_]+)>/.exec(rest); m; m = /^<([A-Za-z0-9_]+)>/.exec(rest)) {
        const t = m[1].toLowerCase();
        if (t === 'control' || t === 'ctrl' || t === 'primary')
            mods |= Clutter.ModifierType.CONTROL_MASK;
        else if (t === 'alt' || t === 'mod1')
            mods |= Clutter.ModifierType.MOD1_MASK;
        else if (t === 'shift')
            mods |= Clutter.ModifierType.SHIFT_MASK;
        else if (t === 'super' || t === 'mod4' || t === 'meta')
            mods |= Clutter.ModifierType.SUPER_MASK;
        else
            return null;
        rest = rest.slice(m[0].length);
    }
    if (!rest || !(mods & NEEDS_MOD))
        return null;
    const key = Clutter[`KEY_${rest.length === 1 ? rest.toLowerCase() : rest}`];
    return typeof key === 'number' ? {mods, key} : null;
}
const FALLBACK_ICON = 'application-x-executable';

// The scroll adjustment lives under different names across Shell versions.
function vAdjustment(scroll) {
    return scroll.vadjustment ?? scroll.vscroll?.adjustment ?? scroll.get_vscroll_bar?.()?.adjustment ?? null;
}

// Keep `actor` (a row inside the scrolled list) fully visible. Pure arithmetic on the
// adjustment, so it does not depend on any Shell helper that may be moved or removed.
function scrollIntoView(scroll, actor) {
    const adj = vAdjustment(scroll);
    if (!adj)
        return;
    const box = actor.get_allocation_box();
    const top = box.y1;
    const bottom = box.y2;
    if (top < adj.value)
        adj.value = top;
    else if (bottom > adj.value + adj.page_size)
        adj.value = bottom - adj.page_size;
}

function gicon(entry) {
    if (!entry._gi) {
        try {
            entry._gi = Gio.Icon.new_for_string(entry.icon || FALLBACK_ICON);
        } catch (_e) {
            entry._gi = new Gio.ThemedIcon({name: FALLBACK_ICON});
        }
    }
    return entry._gi;
}

// One reusable result row. Rows are pooled: created lazily, then only updated.
class Row {
    constructor(launcher, index) {
        this.index = index;
        this.entry = null;
        this._sel = false;
        this._st = null;

        this.actor = new St.BoxLayout({reactive: true, x_expand: true});
        this.icon = new St.Icon({fallback_icon_name: FALLBACK_ICON, y_align: Clutter.ActorAlign.CENTER});
        this.text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.title = new St.Label({x_expand: true});
        this.sub = new St.Label({x_expand: true});
        this.tag = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        for (const l of [this.title, this.sub])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.text.add_child(this.title);
        this.text.add_child(this.sub);
        this.actor.add_child(this.icon);
        this.actor.add_child(this.text);
        this.actor.add_child(this.tag);

        this.actor.connect('button-release-event', (_a, ev) => {
            if (ev.get_button() === Clutter.BUTTON_PRIMARY)
                launcher._activateIndex(this.index);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('motion-event', () => {
            launcher._hover(this.index);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    restyle(st) {
        this._st = st;
        this.icon.set_icon_size(st.iconSize);
        this.icon.set_style(st.icon);
        this._paint();
        this.entry = null; // force content refresh (description/tag visibility may change)
    }

    _paint() {
        const st = this._st;
        const sel = this._sel;
        this.actor.set_style(sel ? st.rowSel : st.row);
        this.title.set_style(sel ? st.titleSel : st.title);
        this.sub.set_style(sel ? st.subSel : st.sub);
        this.tag.set_style(sel ? st.tagSel : st.tag);
    }

    setSelected(value) {
        if (value === this._sel)
            return;
        this._sel = value;
        if (this._st)
            this._paint();
    }

    set(entry) {
        if (this.entry === entry)
            return;
        this.entry = entry;
        this.title.text = entry.name;
        this.sub.text = entry.desc || '';
        this.sub.visible = this._st.showDesc && !!entry.desc;
        this.tag.text = TAGS[entry.kind] ?? '';
        this.tag.visible = this._st.showTags;
        const gi = gicon(entry);
        if (this.icon.gicon !== gi)
            this.icon.gicon = gi;
    }
}

export class Launcher {
    // search(query) -> entries[]; onActivate(entry); getStyle() -> {layout, theme}; onOpen()
    constructor({config, search, onActivate, getStyle, onOpen, onWindowShortcut}) {
        this._cfg = config;
        this._search = search;
        this._onActivate = onActivate;
        this._getStyle = getStyle;
        this._onOpen = onOpen;
        this._onWindowShortcut = onWindowShortcut;

        this._built = false;
        this._state = 'hidden'; // hidden | opening | open | closing
        this._rows = [];
        this._results = [];
        this._sel = -1;
        this._grab = null;
        this._st = null;
        this._dirty = true;
        this._order = null;
        this._blur = null;
        this._blurWarned = false;
        this._suppress = false;
        this._lastListH = '';
        this._mode = null;
        this._emptyText = 'No results';
        this._win = [];
        this._outside = 'click';
        this._armed = false;
    }

    // [{id, accel}] shortcuts that only work while the window is open (no global grab, so
    // they cannot conflict with anything else). Safe to call before the UI is built.
    setWindowShortcuts(list) {
        this._win = [];
        for (const {id, accel} of list) {
            const a = parseAccel(accel);
            if (a)
                this._win.push({id, ...a});
            else
                warn(`window shortcut "${accel}" ignored (needs Ctrl, Alt or Super plus a key)`);
        }
    }

    get isOpen() {
        return this._state === 'open' || this._state === 'opening';
    }

    build() {
        if (this._built)
            return;
        this._built = true;

        this._overlay = new St.Widget({
            name: 'gnome-launcher-overlay',
            reactive: true,
            visible: false,
            layout_manager: new Clutter.BinLayout(),
        });
        this._box = new St.BoxLayout({
            vertical: true,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._box.set_pivot_point(0.5, 0.5);

        this._entry = new St.Entry({can_focus: true, x_expand: true});
        this._entry.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic'}));
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        this._list = new St.BoxLayout({vertical: true});
        this._scroll.set_child(this._list);
        this._empty = new St.Label({text: 'No results', visible: false});
        this._list.add_child(this._empty);

        this._overlay.add_child(this._box);
        Main.uiGroup.add_child(this._overlay);

        const ct = this._entry.clutter_text;
        ct.connect('text-changed', () => {
            if (!this._suppress)
                this._refresh();
        });
        ct.connect('key-press-event', (_a, ev) => this._onKey(ev));

        this._overlay.connect('key-press-event', (_a, ev) => {
            // Focus can leave the entry after a click; keep Escape and navigation working.
            return this._onKey(ev);
        });
        this._overlay.connect('button-press-event', (_a, ev) => {
            if (this._inside(ev)) {
                ct.grab_key_focus();
            } else if (this._outside === 'click') {
                this.close();
            }
            return Clutter.EVENT_STOP; // 'hover' and 'none' ignore outside clicks
        });
        this._overlay.connect('motion-event', (_a, ev) => this._onMotion(ev));

        this._applyStyle();
    }

    _inside(ev) {
        const src = ev.get_source();
        return !!src && this._box.contains(src);
    }

    // 'hover' mode: close once the pointer leaves the window. It only arms after the pointer
    // has been inside once, so opening the launcher with the pointer elsewhere does not
    // close it straight away.
    _onMotion(ev) {
        if (this._outside !== 'hover')
            return Clutter.EVENT_PROPAGATE;
        if (this._inside(ev))
            this._armed = true;
        else if (this._armed)
            this.close();
        return Clutter.EVENT_PROPAGATE;
    }

    // --- modes (sub-views such as clipboard history) ---

    enterMode(mode, {placeholder = '', empty = 'No results'} = {}) {
        this._mode = mode;
        this._emptyText = empty;
        this._empty.text = empty;
        if (placeholder)
            this._entry.hint_text = placeholder;
        this._suppress = true;
        this._entry.set_text('');
        this._suppress = false;
        this._refresh();
    }

    exitMode() {
        if (!this._mode)
            return false;
        this._resetMode();
        this._suppress = true;
        this._entry.set_text('');
        this._suppress = false;
        this._refresh();
        return true;
    }

    _resetMode() {
        this._mode = null;
        this._emptyText = 'No results';
        if (this._empty)
            this._empty.text = this._emptyText;
        if (this._entry && this._st)
            this._entry.hint_text = this._st.placeholder;
    }

    // --- styling -----------------------------------------------------------

    invalidateStyle() {
        this._dirty = true;
        if (this._built && this._state !== 'hidden')
            this._applyStyle();
    }

    _applyStyle() {
        const {layout, theme} = this._getStyle();
        const st = this._st = buildStyles(layout, theme);
        this._dirty = false;

        this._box.set_style(st.box);
        this._entry.set_style(st.entry);
        this._entry.hint_text = st.placeholder;
        try {
            this._entry.get_hint_actor?.()?.set_style(st.hint);
        } catch (_e) { /* hint actor styling is cosmetic */ }
        this._list.set_style(st.list);
        this._empty.set_style(st.empty);
        for (const r of this._rows)
            r.restyle(st);

        if (this._order !== st.searchPosition) {
            this._order = st.searchPosition;
            this._box.remove_all_children();
            if (st.searchPosition === 'bottom') {
                this._box.add_child(this._scroll);
                this._box.add_child(this._entry);
            } else {
                this._box.add_child(this._entry);
                this._box.add_child(this._scroll);
            }
        }
        this._applyBlur(st.blur);
        this._lastListH = '';
        if (this._state !== 'hidden')
            this._render();
    }

    // Blur uses Shell.BlurEffect (the native Mutter/Shell blur). If it is missing or
    // its construction fails on this Shell version, blur is skipped; transparency still works.
    _applyBlur(sigma) {
        if (this._blur) {
            this._box.remove_effect(this._blur);
            this._blur = null;
        }
        if (!(sigma > 0))
            return;
        if (!Shell.BlurEffect) {
            if (!this._blurWarned)
                warn('Shell.BlurEffect unavailable on this GNOME Shell; blur disabled');
            this._blurWarned = true;
            return;
        }
        const mode = Shell.BlurMode?.BACKGROUND ?? 1;
        let effect = null;
        for (const props of [{sigma, mode}, {radius: sigma * 2, mode}]) {
            try {
                effect = new Shell.BlurEffect(props);
                break;
            } catch (_e) { /* property name differs between Shell versions */ }
        }
        if (!effect) {
            if (!this._blurWarned)
                warn('could not construct Shell.BlurEffect; blur disabled');
            this._blurWarned = true;
            return;
        }
        try {
            effect.brightness = 1.0;
        } catch (_e) { /* optional */ }
        this._box.add_effect_with_name('gl-blur', effect);
        this._blur = effect;
    }

    // --- open / close ------------------------------------------------------

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    open() {
        if (this.isOpen)
            return;
        if (!this._built)
            this.build();
        this._onOpen?.();
        if (this._dirty)
            this._applyStyle();

        this._outside = this._cfg.str('outside-action');
        this._armed = false;
        this._resetMode();
        this._place();
        this._overlay.show();
        if (!this._grab) {
            this._grab = Main.pushModal(this._overlay, {actionMode: Shell.ActionMode.POPUP});
            if (!this._grab) {
                this._overlay.hide();
                this._state = 'hidden';
                warn('could not grab input; launcher not opened');
                return;
            }
        }
        if (this._cfg.bool('reset-query-on-open')) {
            this._suppress = true;
            this._entry.set_text('');
            this._suppress = false;
        }
        this._entry.clutter_text.grab_key_focus();
        this._refresh();
        this._animate(true);
    }

    close() {
        if (this._state === 'hidden' || this._state === 'closing')
            return;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._animate(false);
    }

    _place() {
        const lm = Main.layoutManager;
        const mon = this._cfg.str('monitor') === 'primary'
            ? lm.primaryMonitor
            : (lm.currentMonitor ?? lm.primaryMonitor);
        this._overlay.set_position(mon.x, mon.y);
        this._overlay.set_size(mon.width, mon.height);
        const pos = this._cfg.int('position');
        if (this._order === 'bottom') {
            this._box.y_align = Clutter.ActorAlign.END;
            this._box.margin_top = 0;
            this._box.margin_bottom = Math.round(mon.height * (100 - pos) / 100);
        } else {
            this._box.y_align = Clutter.ActorAlign.START;
            this._box.margin_bottom = 0;
            this._box.margin_top = Math.round(mon.height * pos / 100);
        }
    }

    _animate(opening) {
        const box = this._box;
        box.remove_all_transitions();
        this._state = opening ? 'opening' : 'closing';

        const style = this._cfg.str('anim-style');
        const enabled = St.Settings.get().enable_animations && style !== 'none';
        const duration = enabled ? this._cfg.int('anim-duration') : 0;
        const shown = {opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0};
        const hidden = {
            opacity: 0,
            scale_x: style === 'fade-scale' ? 0.96 : 1,
            scale_y: style === 'fade-scale' ? 0.96 : 1,
            translation_y: style === 'slide' ? -14 : 0,
        };
        const done = () => {
            if (opening) {
                this._state = 'open';
            } else {
                this._overlay.hide();
                this._state = 'hidden';
            }
        };

        if (opening)
            box.set(duration > 0 ? hidden : shown);
        if (duration <= 0) {
            box.set(opening ? shown : hidden);
            done();
            return;
        }
        box.ease({
            ...(opening ? shown : hidden),
            duration: opening ? duration : Math.round(duration * 0.8),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: done,
        });
    }

    // --- search + render ---------------------------------------------------

    _refresh() {
        let results;
        try {
            results = this._search(this._entry.get_text(), this._mode);
        } catch (e) {
            warn('search failed:', e.message);
            results = [];
        }
        this._results = results;
        this._render();
    }

    _render() {
        const st = this._st;
        const n = this._results.length;
        const hasQuery = this._entry.get_text().length > 0;

        for (let i = 0; i < n; i++) {
            const row = this._rows[i] ?? this._makeRow(i);
            row.set(this._results[i]);
            row.actor.show();
        }
        for (let i = n; i < this._rows.length; i++) {
            this._rows[i].actor.hide();
            this._rows[i].setSelected(false);
        }

        const showEmpty = n === 0 && (hasQuery || this._mode !== null);
        this._empty.visible = showEmpty;
        this._scroll.visible = n > 0 || showEmpty;

        // Explicit height (CSS px, same unit as the rows) so the window grows with the
        // results up to the configured maximum, then scrolls.
        let h = '';
        if (n > 0) {
            const need = n * st.rowH + (n - 1) * st.gap;
            h = `height: ${Math.min(need, st.maxListH)}px;`;
        }
        if (h !== this._lastListH) {
            this._scroll.set_style(h);
            this._lastListH = h;
        }

        this._sel = -1;
        this._select(n > 0 ? 0 : -1);
        const adj = vAdjustment(this._scroll);
        if (adj)
            adj.value = 0;
    }

    _makeRow(i) {
        const row = new Row(this, i);
        row.restyle(this._st);
        this._list.add_child(row.actor);
        this._rows.push(row);
        return row;
    }

    _select(i) {
        if (this._sel === i)
            return;
        this._rows[this._sel]?.setSelected(false);
        this._sel = i;
        const row = this._rows[i];
        if (!row)
            return;
        row.setSelected(true);
        try {
            scrollIntoView(this._scroll, row.actor);
        } catch (_e) { /* scrolling is best effort */ }
    }

    _hover(i) {
        if (i !== this._sel)
            this._select(i);
    }

    _move(delta, clamp = false) {
        const n = this._results.length;
        if (n === 0)
            return;
        let i = this._sel + delta;
        i = clamp ? Math.min(n - 1, Math.max(0, i)) : (i + n) % n;
        this._select(i);
    }

    _activateIndex(i) {
        const entry = this._results[i];
        if (entry)
            this._onActivate(entry);
    }

    _onKey(ev) {
        const sym = ev.get_key_symbol();
        const mods = ev.get_state();
        const ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const alt = (mods & Clutter.ModifierType.MOD1_MASK) !== 0;

        // Window-only shortcuts first, so they can override the built-in navigation keys.
        if (this._win.length > 0) {
            const m = mods & MOD_MASK;
            if (m & NEEDS_MOD) {
                const k = sym >= 0x41 && sym <= 0x5a ? sym + 0x20 : sym;
                const hit = this._win.find(w => w.mods === m && w.key === k);
                if (hit) {
                    this._onWindowShortcut?.(hit.id);
                    return Clutter.EVENT_STOP;
                }
            }
        }

        switch (sym) {
        case Clutter.KEY_Escape:
            if (!this.exitMode())
                this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_BackSpace:
            if (this._mode && this._entry.get_text() === '') {
                this.exitMode();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        case Clutter.KEY_Down:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Tab:
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_ISO_Left_Tab:
            this._move(-1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Down:
            this._move(5, true);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Page_Up:
            this._move(-5, true);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_ISO_Enter:
            this._activateIndex(this._sel);
            return Clutter.EVENT_STOP;
        default:
        }

        if (ctrl) {
            switch (sym) {
            case Clutter.KEY_n:
            case Clutter.KEY_j:
                this._move(1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_p:
            case Clutter.KEY_k:
                this._move(-1);
                return Clutter.EVENT_STOP;
            default:
            }
        }
        // Alt+1..9 activates the n-th visible result.
        if (alt && sym >= Clutter.KEY_1 && sym <= Clutter.KEY_9) {
            this._activateIndex(sym - Clutter.KEY_1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._box?.remove_all_transitions();
        this._overlay?.destroy();
        this._overlay = this._box = this._entry = this._scroll = this._list = this._empty = null;
        this._rows = [];
        this._results = [];
        this._blur = null;
        this._built = false;
        this._state = 'hidden';
        dbg('launcher destroyed');
    }
}

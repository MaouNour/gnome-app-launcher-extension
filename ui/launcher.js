import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {buildStyles} from './style.js';
import {Idle} from '../utils/timing.js';
import {dbg, warn} from '../utils/log.js';

const TAGS = {
    app: 'App', command: 'Command', action: 'Action', system: 'System',
    mode: 'Mode', clip: 'Clipboard', clipimage: 'Image', account: 'Account', web: 'Web', calc: 'Result', emoji: 'Emoji',
};

// Rows are created lazily in batches while scrolling, so even a list of thousands of
// entries (emoji, unlimited results) only ever costs a few dozen actors.
const CHUNK = 40;
// Rows kept pooled after the launcher closes; a bigger pool is trimmed to save memory.
const KEEP_ROWS = 60;
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

// Opening/closing animations: how small the window starts (scale), how far it travels vertically (ty,
// in px, as a transform: the layout position never changes) and the easing for each direction.
const AM = Clutter.AnimationMode;
const ANIMS = {
    'fade-scale': {scale: 0.96, ty: 0, open: AM.EASE_OUT_QUAD, close: AM.EASE_OUT_QUAD},
    'fade': {scale: 1, ty: 0, open: AM.EASE_OUT_QUAD, close: AM.EASE_OUT_QUAD},
    'slide': {scale: 1, ty: -14, open: AM.EASE_OUT_QUAD, close: AM.EASE_OUT_QUAD},
    'pop': {scale: 0.9, ty: 0, open: AM.EASE_OUT_BACK, close: AM.EASE_IN_QUAD},
    'drop': {scale: 0.985, ty: -10, open: AM.EASE_OUT_CUBIC, close: AM.EASE_IN_QUAD},
    'rise': {scale: 0.985, ty: 12, open: AM.EASE_OUT_CUBIC, close: AM.EASE_IN_QUAD},
};

// The scroll adjustment lives under different names across Shell versions.
function vAdjustment(scroll) {
    return scroll.vadjustment ?? scroll.vscroll?.adjustment ?? scroll.get_vscroll_bar?.()?.adjustment ?? null;
}

// CSS pixels (what every style string uses) -> actor pixels. Needed for the few sizes set as
// plain actor properties instead of CSS (see _render).
function scaleFactor() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) {
        return 1;
    }
}

// Icon from a theme name or an absolute/home-relative path; null when it cannot be built.
function iconFromString(name) {
    try {
        const n = name.startsWith('~/') ? GLib.build_filenamev([GLib.get_home_dir(), name.slice(2)]) : name;
        return Gio.Icon.new_for_string(n);
    } catch (_e) {
        return null;
    }
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

// One square emoji cell of the grid view.
class Cell {
    constructor(launcher, grid, col) {
        this.col = col;
        this.entry = null;
        this._sel = false;
        this._st = null;
        this.label = new St.Label({x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this.actor = new St.Bin({reactive: true, child: this.label});
        this.actor.connect('button-release-event', (_a, ev) => {
            if (ev.get_button() === Clutter.BUTTON_PRIMARY && this.entry)
                launcher._activateIndex(grid.base + this.col);
            return Clutter.EVENT_STOP;
        });
        this.actor.connect('motion-event', () => {
            if (this.entry)
                launcher._hover(grid.base + this.col);
            return Clutter.EVENT_PROPAGATE;
        });
    }

    restyle(st) {
        this._st = st;
        this._paint();
    }

    _paint() {
        this.actor.set_style(this._sel ? this._st.cellSel : this._st.cell);
        this.label.set_style(this._sel ? this._st.cellTextSel : this._st.cellText);
    }

    setSelected(value) {
        if (value === this._sel)
            return;
        this._sel = value;
        if (this._st)
            this._paint();
    }

    set(entry) {
        this.entry = entry ?? null;
        this.actor.visible = !!entry;
        if (entry && this.label.text !== entry.glyph)
            this.label.text = entry.glyph;
    }
}

// A horizontal line of cells; `base` is the result index of its first cell.
class GridRow {
    constructor(launcher, cols) {
        this.base = 0;
        this.actor = new St.BoxLayout({x_expand: true});
        this.cells = [];
        for (let c = 0; c < cols; c++) {
            const cell = new Cell(launcher, this, c);
            this.cells.push(cell);
            this.actor.add_child(cell.actor);
        }
    }

    restyle(st) {
        this.actor.set_style(st.gridRow);
        for (const c of this.cells)
            c.restyle(st);
    }

    set(results, base) {
        this.base = base;
        for (const c of this.cells)
            c.set(results[base + c.col]);
    }
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
        this.glyph = new St.Label({visible: false, y_align: Clutter.ActorAlign.CENTER});
        this.text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.title = new St.Label({x_expand: true});
        this.sub = new St.Label({x_expand: true});
        this.tag = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        for (const l of [this.title, this.sub])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.text.add_child(this.title);
        this.text.add_child(this.sub);
        this.actor.add_child(this.icon);
        this.actor.add_child(this.glyph);
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
        this.glyph.set_style(sel ? st.glyphSel : st.glyph);
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
        if (entry.glyph) {
            this.glyph.text = entry.glyph;
            this.glyph.visible = true;
            this.icon.visible = false;
            return;
        }
        this.glyph.visible = false;
        this.icon.visible = true;
        const gi = gicon(entry);
        if (this.icon.gicon !== gi)
            this.icon.gicon = gi;
    }
}

export class Launcher {
    // search(query, mode) -> entries[]; onActivate(entry); getStyle() -> {layout, theme}; onOpen();
    // onClose() runs once the window is fully hidden.
    constructor({config, search, onActivate, getStyle, onOpen, onClose, onWindowShortcut}) {
        this._cfg = config;
        this._search = search;
        this._onActivate = onActivate;
        this._getStyle = getStyle;
        this._onOpen = onOpen;
        this._onClose = onClose;
        this._onWindowShortcut = onWindowShortcut;

        this._built = false;
        this._state = 'hidden'; // hidden | opening | open | closing
        this._rows = [];
        this._results = [];
        this._sel = -1;
        this._selItem = null; // the row/cell that is painted as selected right now
        this._grab = null;
        this._st = null;
        this._dirty = true;
        this._order = null;
        this._blurFx = null;
        this._blurSigma = 0;
        this._blurWarned = false;
        this._suppress = false;
        this._lastListH = -2;
        this._shown = 0;
        this._grid = false;
        this._gridRows = [];
        this._gridCols = 0;
        this._siKey = '';
        this._reveal = new Idle(() => this._scrollToSelected(), GLib.PRIORITY_DEFAULT_IDLE);
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

    get mode() {
        return this._mode;
    }

    // Re-run the search with the current text (used when asynchronous data arrives).
    refresh() {
        if (this._built && this.isOpen)
            this._refresh();
    }

    setEmptyText(text) {
        this._emptyText = text;
        if (this._empty)
            this._empty.text = text;
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
        // EXTERNAL: the list still scrolls (wheel, keys, touchpad) but no scrollbar is ever drawn.
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            overlay_scrollbars: true,
        });
        this._list = new St.BoxLayout({vertical: true});
        this._scroll.set_child(this._list);
        this._empty = new St.Label({text: 'No results', visible: false});
        this._list.add_child(this._empty);
        // Name of the highlighted emoji, shown under the grid.
        this._hint = new St.Label({visible: false});
        this._hint.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        this._overlay.add_child(this._box);
        Main.uiGroup.add_child(this._overlay);

        // More rows are created as the user scrolls towards the end of what exists so far.
        const adj = vAdjustment(this._scroll);
        if (adj)
            adj.connect('notify::value', () => this._onScrolled());

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

    // grid: show the results as a grid of square glyph cells instead of rows (used for emoji).
    enterMode(mode, {placeholder = '', empty = 'No results', grid = false} = {}) {
        this._mode = mode;
        this._grid = grid;
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
        this._grid = false;
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
        this._scroll.vscrollbar_policy = st.showScrollbar ? St.PolicyType.AUTOMATIC : St.PolicyType.EXTERNAL;
        this._applySearchIcon(st);
        for (const r of this._rows)
            r.restyle(st);
        this._hint.set_style(st.gridHint);
        if (this._gridCols !== st.gridCols) {
            for (const r of this._gridRows)
                r.actor.destroy();
            this._gridRows = [];
            this._gridCols = st.gridCols;
        } else {
            for (const r of this._gridRows)
                r.restyle(st);
        }

        if (this._order !== st.searchPosition) {
            this._order = st.searchPosition;
            this._box.remove_all_children();
            if (st.searchPosition === 'bottom') {
                this._box.add_child(this._scroll);
                this._box.add_child(this._hint);
                this._box.add_child(this._entry);
            } else {
                this._box.add_child(this._entry);
                this._box.add_child(this._scroll);
                this._box.add_child(this._hint);
            }
        }
        this._applyBlur(st.blur);
        this._lastListH = -2;
        if (this._state !== 'hidden')
            this._render();
    }

    _applySearchIcon(st) {
        const key = `${st.searchIcon}|${st.searchIconSize}|${st.searchIconStyle}`;
        if (key === this._siKey)
            return;
        this._siKey = key;
        const gi = st.searchIcon ? iconFromString(st.searchIcon) : null;
        if (!st.searchIcon) {
            this._entry.set_primary_icon(null);
            return;
        }
        this._entry.set_primary_icon(new St.Icon({
            gicon: gi ?? new Gio.ThemedIcon({name: 'edit-find-symbolic'}),
            fallback_icon_name: 'edit-find-symbolic',
            icon_size: st.searchIconSize,
            style: st.searchIconStyle,
        }));
    }

    // Blur uses Shell.BlurEffect (the native Shell blur). If it is missing or its construction fails
    // on this Shell version, blur is skipped; transparency still works.
    //
    // The effect is only attached while the window is fully open and static. Samples of the
    // background taken while the window is fading or scaling do not line up with the pixels behind
    // it, which showed up as glitches (and flickering window borders/shadows) with an application
    // window behind the launcher. Attaching it after the opening animation and removing it before
    // the closing one avoids that; the blur appears as soon as the window has settled.
    _applyBlur(sigma) {
        this._blurSigma = sigma;
        this._detachBlur();
        if (this._state === 'open')
            this._attachBlur();
    }

    _attachBlur() {
        const sigma = this._blurSigma;
        if (!(sigma > 0) || this._blurFx?.attached)
            return;
        if (!Shell.BlurEffect) {
            if (!this._blurWarned)
                warn('Shell.BlurEffect unavailable on this GNOME Shell; blur disabled');
            this._blurWarned = true;
            return;
        }
        if (!this._blurFx || this._blurFx.sigma !== sigma) {
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
            this._blurFx = {effect, sigma, attached: false};
        }
        this._box.add_effect_with_name('gl-blur', this._blurFx.effect);
        this._blurFx.attached = true;
    }

    _detachBlur() {
        if (!this._blurFx?.attached)
            return;
        this._box?.remove_effect(this._blurFx.effect);
        this._blurFx.attached = false;
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
        this._detachBlur();

        const style = this._cfg.str('anim-style');
        const enabled = St.Settings.get().enable_animations && style !== 'none';
        const duration = enabled ? this._cfg.int('anim-duration') : 0;
        const shown = {opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0};
        const a = ANIMS[style] ?? ANIMS['fade-scale'];
        const hidden = {opacity: 0, scale_x: a.scale, scale_y: a.scale, translation_y: a.ty};
        // While fading, paint the whole window as one flattened layer. Otherwise the translucent
        // background, border and shadow are blended separately and the shadow visibly pulses.
        const redirect = mode => {
            try {
                box.set_offscreen_redirect(mode);
            } catch (_e) { /* cosmetic */ }
        };
        const done = () => {
            redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);
            if (opening) {
                this._state = 'open';
                this._attachBlur();
            } else {
                this._overlay.hide();
                this._state = 'hidden';
                this._clearSel(); // nothing may stay painted as selected while the window is hidden
                this._trimPool();
                this._onClose?.();
            }
        };

        if (opening)
            box.set(duration > 0 ? hidden : shown);
        if (duration <= 0) {
            box.set(opening ? shown : hidden);
            done();
            return;
        }
        redirect(Clutter.OffscreenRedirect.ALWAYS);
        box.ease({
            ...(opening ? shown : hidden),
            duration: opening ? duration : Math.round(duration * 0.8),
            mode: opening ? a.open : a.close,
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
        const grid = this._grid;
        const hasQuery = this._entry.get_text().length > 0;

        // Only the first batch of rows exists up front; _grow() adds more on demand.
        this._shown = 0;
        this._grow(Math.min(n, this._chunk()));
        const perRow = grid ? st.gridCols : 1;
        const gridRowsShown = grid ? Math.ceil(this._shown / perRow) : 0;
        for (let i = grid ? 0 : this._shown; i < this._rows.length; i++) {
            this._rows[i].actor.hide();
            this._rows[i].setSelected(false);
        }
        for (let i = gridRowsShown; i < this._gridRows.length; i++)
            this._gridRows[i].actor.hide();

        const showEmpty = n === 0 && (hasQuery || this._mode !== null);
        this._empty.visible = showEmpty;
        this._scroll.visible = n > 0 || showEmpty;
        this._hint.visible = grid && n > 0;

        // The window grows with the results up to the configured maximum, then scrolls. This is an
        // actor size rather than an inline CSS height: changing the style string re-resolves the
        // style of the whole list on every result-count change, which made the border and shadow
        // flicker while typing. CSS px -> actor px goes through the theme scale factor.
        let need = 0;
        let max = st.maxListH;
        if (grid) {
            const lines = Math.ceil(n / perRow);
            need = lines * st.gridCell + Math.max(0, lines - 1) * st.gridGap;
            max = Math.max(st.gridCell, st.maxListH - st.gridHintH);
        } else {
            need = n * st.rowH + (n - 1) * st.gap;
        }
        const h = n > 0 ? Math.round(Math.min(need, max) * scaleFactor()) : -1;
        if (h !== this._lastListH) {
            this._scroll.set_height(h);
            this._lastListH = h;
        }

        this._clearSel();
        this._select(n > 0 ? 0 : -1);
        const adj = vAdjustment(this._scroll);
        if (adj)
            adj.value = 0;
    }

    // Un-highlight whatever is painted as selected (even if the view switched between list and grid
    // since) and forget the index. Resetting only the index left the previous row/cell highlighted,
    // so two entries looked selected at once.
    _clearSel() {
        this._selItem?.setSelected(false);
        this._selItem = null;
        this._sel = -1;
    }

    // Entries created per batch: a few lines of cells in the grid, 40 rows in the list.
    _chunk() {
        return this._grid ? this._st.gridCols * 6 : CHUNK;
    }

    // Make sure rows/cells for entries [0, upto) exist and show them. Returns whether any were added.
    _grow(upto) {
        const n = this._results.length;
        const from = this._shown;
        let target = Math.min(n, upto > from ? Math.max(upto, from + this._chunk()) : from);
        if (this._grid) {
            const cols = this._st.gridCols;
            const lines = Math.ceil(target / cols);
            for (let r = Math.floor(from / cols); r < lines; r++) {
                const row = this._gridRows[r] ?? this._makeGridRow();
                row.set(this._results, r * cols);
                row.actor.show();
            }
            target = Math.min(n, lines * cols);
        } else {
            for (let i = from; i < target; i++) {
                const row = this._rows[i] ?? this._makeRow(i);
                row.set(this._results[i]);
                row.actor.show();
            }
        }
        this._shown = Math.max(from, target);
        return target > from;
    }

    _makeGridRow() {
        const row = new GridRow(this, this._st.gridCols);
        row.restyle(this._st);
        this._list.add_child(row.actor);
        this._gridRows.push(row);
        return row;
    }

    // Row/cell geometry in actor pixels: distance between lines, size of one line, entries per line.
    _metrics() {
        const st = this._st;
        const sf = scaleFactor();
        if (this._grid)
            return {stride: (st.gridCell + st.gridGap) * sf, size: st.gridCell * sf, perRow: st.gridCols};
        return {stride: (st.rowH + st.gap) * sf, size: st.rowH * sf, perRow: 1};
    }

    // The visual item (row or cell) for result index i.
    _item(i) {
        if (i < 0)
            return null;
        if (this._grid) {
            const cols = this._st.gridCols;
            return this._gridRows[Math.floor(i / cols)]?.cells[i % cols] ?? null;
        }
        return this._rows[i] ?? null;
    }

    // Called on every scroll movement: add the next batch before the user reaches the last row.
    _onScrolled() {
        if (this._shown >= this._results.length || !this._st)
            return;
        const adj = vAdjustment(this._scroll);
        if (!adj)
            return;
        const {stride, perRow} = this._metrics();
        const lines = Math.ceil(this._shown / perRow);
        if (adj.value + adj.page_size >= lines * stride - stride * 3)
            this._grow(this._shown + 1);
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
        this._selItem?.setSelected(false);
        this._selItem = null;
        this._sel = i;
        if (i < 0)
            return;
        const grew = i >= this._shown && this._grow(i + 1);
        const row = this._item(i);
        if (!row)
            return;
        row.setSelected(true);
        this._selItem = row;
        if (this._grid) {
            const e = this._results[i];
            this._hint.text = e ? (e.desc ? `${e.name}  ·  ${e.desc}` : e.name) : '';
        }
        this._scrollToSelected();
        // Rows created just now have no allocation yet, so the scroll range is still the old one.
        // Apply the same scroll again once the layout has caught up.
        if (grew)
            this._reveal.schedule();
    }

    // Keep the selected row fully visible. Pure arithmetic from the row index (rows have a fixed
    // height), so it works for rows that were created a moment ago and does not depend on any
    // Shell helper that may be moved or removed between versions.
    _scrollToSelected() {
        try {
            const adj = vAdjustment(this._scroll);
            const st = this._st;
            if (!adj || !st || this._sel < 0 || adj.page_size <= 0)
                return;
            const {stride, size, perRow} = this._metrics();
            const top = Math.floor(this._sel / perRow) * stride;
            const bottom = top + size;
            if (top < adj.value)
                adj.value = top;
            else if (bottom > adj.value + adj.page_size)
                adj.value = bottom - adj.page_size;
        } catch (_e) { /* scrolling is best effort */ }
    }

    // After the window has closed, give back rows that only a very long list needed.
    _trimPool() {
        this._clearSel();
        for (const row of this._gridRows.splice(KEEP_ROWS / 4))
            row.actor.destroy();
        if (this._rows.length <= KEEP_ROWS)
            return;
        for (const row of this._rows.splice(KEEP_ROWS))
            row.actor.destroy();
        this._shown = Math.min(this._shown, this._rows.length);
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
        // Wrapping from the first row to the last would have to create every row of a very long
        // list at once, so long lists stop at their ends instead (short lists still wrap).
        if (n > this._chunk() * 3 || this._grid)
            clamp = true;
        i = clamp ? Math.min(n - 1, Math.max(0, i)) : (i + n) % n;
        this._select(i);
    }

    // `how` says which modifier was held with Enter: '', 'ctrl', 'alt' or 'shift'. Most entries ignore
    // it; account entries use it to copy the username, open the site or type the password.
    _activateIndex(i, how = '') {
        const entry = this._results[i];
        if (entry)
            this._onActivate(entry, how);
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

        // Grid view: the arrow keys move in two dimensions.
        if (this._grid && !ctrl && !alt) {
            const cols = this._st.gridCols;
            const n = this._results.length;
            switch (sym) {
            case Clutter.KEY_Left:
                this._move(-1, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Right:
                this._move(1, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                this._move(-cols, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                // Already on the last line: stay instead of jumping to the last cell.
                if (n > 0 && Math.floor(this._sel / cols) < Math.floor((n - 1) / cols))
                    this._move(cols, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Page_Down:
                this._move(cols * 4, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Page_Up:
                this._move(-cols * 4, true);
                return Clutter.EVENT_STOP;
            default:
            }
        }

        switch (sym) {
        case Clutter.KEY_Escape:
            // Closes the launcher from anywhere, including clipboard/emoji/accounts. Backspace on an
            // empty field still steps back from a sub-view to the main search.
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
            this._activateIndex(this._sel, ctrl ? 'ctrl' : alt ? 'alt' : (mods & Clutter.ModifierType.SHIFT_MASK) ? 'shift' : '');
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
        this._reveal.cancel();
        this._box?.remove_all_transitions();
        this._overlay?.destroy();
        this._overlay = this._box = this._entry = this._scroll = this._list = this._empty = this._hint = null;
        this._selItem = null;
        this._gridRows = [];
        this._rows = [];
        this._results = [];
        this._blurFx = null;
        this._shown = 0;
        this._siKey = '';
        this._built = false;
        this._state = 'hidden';
        dbg('launcher destroyed');
    }
}

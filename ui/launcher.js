import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {buildStyles} from './style.js';
import {Idle} from '../utils/timing.js';
import {dbg, warn} from '../utils/log.js';
import {IDENTITY} from './identity.js';
import {computePlacement} from './placement.js';

const TAGS = {
    app: 'App', command: 'Command', action: 'Action', system: 'System',
    mode: 'Mode', clip: 'Clipboard', clipimage: 'Image', clipfile: 'File', exec: 'Run', account: 'Account', web: 'Web', calc: 'Result', emoji: 'Emoji',
};

const HAS_CLICK_GESTURE = typeof Clutter.ClickGesture === 'function';

// Connects a signal if this Shell has it. Returns whether it did.
function tryConnect(actor, signal, fn) {
    try {
        actor.connect(signal, fn);
        return true;
    } catch (_e) {
        return false;
    }
}

// fn() runs once per primary-button click, tap or touch on `actor`.
function onPrimaryClick(actor, fn) {
    if (HAS_CLICK_GESTURE) {
        try {
            const g = new Clutter.ClickGesture();
            g.connect('recognize', () => {
                let b = Clutter.BUTTON_PRIMARY;
                try {
                    b = g.get_button();
                } catch (_e) { }
                if (!b || b === Clutter.BUTTON_PRIMARY)
                    fn();
            });
            actor.add_action(g);
        } catch (e) {
            warn(`click gesture unavailable: ${e.message}`);
        }
    }
    tryConnect(actor, 'button-release-event', (_a, ev) => {
        if (ev.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        fn();
        return Clutter.EVENT_STOP;
    });
}

function onSecondaryClick(actor, fn) {
    tryConnect(actor, 'button-release-event', (_a, ev) => {
        if (ev.get_button() !== Clutter.BUTTON_SECONDARY)
            return Clutter.EVENT_PROPAGATE;
        fn();
        return Clutter.EVENT_STOP;
    });
}

function onPointerOver(actor, fn, recentKey) {
    const moved = tryConnect(actor, 'motion-event', () => {
        fn();
        return Clutter.EVENT_PROPAGATE;
    });
    if (moved)
        return;
    actor.track_hover = true;
    actor.connect('notify::hover', () => {
        if (actor.hover && !recentKey())
            fn();
    });
}

const CHUNK = 40;
const KEEP_ROWS = 60;
const MOD_MASK = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK;
const NEEDS_MOD = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK;

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

// Entries that "open the only match" may start.
const AUTO_KINDS = new Set(['app', 'command', 'action']);

const AM = Clutter.AnimationMode;
const ANIMS = {
    'fade-scale': {scale: 0.96, ty: 0, open: AM.EASE_OUT_QUAD, close: AM.EASE_OUT_QUAD},
    'fade': {scale: 1, ty: 0, open: AM.EASE_OUT_QUAD, close: AM.EASE_OUT_QUAD},
    'slide': {scale: 1, ty: -14, open: AM.EASE_OUT_QUAD, close: AM.EASE_OUT_QUAD},
    'pop': {scale: 0.9, ty: 0, open: AM.EASE_OUT_BACK, close: AM.EASE_IN_QUAD},
    'drop': {scale: 0.985, ty: -10, open: AM.EASE_OUT_CUBIC, close: AM.EASE_IN_QUAD},
    'rise': {scale: 0.985, ty: 12, open: AM.EASE_OUT_CUBIC, close: AM.EASE_IN_QUAD},
};

function vAdjustment(scroll) {
    return scroll.vadjustment ?? scroll.vscroll?.adjustment ?? scroll.get_vscroll_bar?.()?.adjustment ?? null;
}

function scaleFactor() {
    try {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
    } catch (_e) {
        return 1;
    }
}

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
        onPrimaryClick(this.actor, () => {
            if (this.entry)
                launcher._clicked(grid.base + this.col);
        });
        onPointerOver(this.actor, () => {
            if (this.entry)
                launcher._hover(grid.base + this.col);
        }, () => launcher._keyRecent());
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

class GridRow {
    constructor(launcher, cols) {
        this.base = 0;
        this.hasHeader = false;
        this.actor = new St.BoxLayout({vertical: true, x_expand: true});
        this.title = new St.Label({x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.END});
        this.header = new St.Bin({child: this.title, x_expand: true, visible: false});
        this.line = new St.BoxLayout({x_expand: true});
        this.cells = [];
        for (let c = 0; c < cols; c++) {
            const cell = new Cell(launcher, this, c);
            this.cells.push(cell);
            this.line.add_child(cell.actor);
        }
        this.actor.add_child(this.header);
        this.actor.add_child(this.line);
    }

    restyle(st) {
        this.line.set_style(st.gridRow);
        this.title.set_style(st.sectionTitle);
        this.header.set_height(Math.round(st.sectionH * scaleFactor()));
        for (const c of this.cells)
            c.restyle(st);
    }

    // line: {base, count, header}
    set(results, line) {
        this.base = line.base;
        this.hasHeader = !!line.header;
        this.header.visible = this.hasHeader;
        if (this.hasHeader && this.title.text !== line.header)
            this.title.text = line.header;
        for (const c of this.cells)
            c.set(c.col < line.count ? results[line.base + c.col] : null);
    }
}

class Row {
    constructor(launcher, index) {
        this.index = index;
        this.entry = null;
        this._sel = false;
        this._st = null;

        this.actor = new St.BoxLayout({reactive: true, x_expand: true});
        this.icon = new St.Icon({fallback_icon_name: FALLBACK_ICON, x_align: Clutter.ActorAlign.CENTER});
        this.iconBox = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        this.iconBox.add_child(this.icon);
        this.glyph = new St.Label({visible: false, y_align: Clutter.ActorAlign.CENTER});
        this.text = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.title = new St.Label({x_expand: true});
        this.sub = new St.Label({x_expand: true});
        this.tag = new St.Label({y_align: Clutter.ActorAlign.CENTER});
        this.mark = new St.Widget({y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._markPos = '';
        for (const l of [this.title, this.sub])
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.text.add_child(this.title);
        this.text.add_child(this.sub);
        this.actor.add_child(this.mark);
        this.actor.add_child(this.iconBox);
        this.actor.add_child(this.glyph);
        this.actor.add_child(this.text);
        this.actor.add_child(this.tag);

        onPrimaryClick(this.actor, () => launcher._clicked(this.index));
        onSecondaryClick(this.actor, () => launcher._rightClicked(this.index));
        onPointerOver(this.actor, () => launcher._hover(this.index), () => launcher._keyRecent());
    }

    restyle(st) {
        this._st = st;
        this.icon.set_icon_size(st.iconSize);
        this.icon.set_style(st.icon);
        this._paint();
        this.entry = null;
    }

    _paint() {
        const st = this._st;
        const sel = this._sel;
        this.actor.set_style(sel ? st.rowSel : st.row);
        this.title.set_style(sel ? st.titleSel : st.title);
        this.sub.set_style(sel ? st.subSel : st.sub);
        this.tag.set_style(sel ? st.tagSel : st.tag);
        this.glyph.set_style(sel ? st.glyphSel : st.glyph);
        this.mark.set_style(sel ? st.activeSel : st.active);
        if (this._markPos !== st.activePos) {
            this._markPos = st.activePos;
            const parent = this.mark.get_parent();
            parent?.remove_child(this.mark);
            if (st.activePos === 'below') {
                this.mark.x_align = Clutter.ActorAlign.CENTER;
                this.iconBox.add_child(this.mark);
            } else {
                this.mark.x_align = Clutter.ActorAlign.FILL;
                if (st.activePos === 'after')
                    this.actor.insert_child_below(this.mark, this.tag);
                else
                    this.actor.insert_child_below(this.mark, this.iconBox);
            }
        }
    }

    setSelected(value) {
        if (value === this._sel)
            return;
        this._sel = value;
        if (this._st)
            this._paint();
    }

    set(entry, fav = false, running = false) {
        if (this.entry === entry && this._fav === fav && this._run === running)
            return;
        this.entry = entry;
        this._fav = fav;
        this._run = running;
        this.mark.visible = running && this._st.activeOn;
        this.title.text = fav ? `★ ${entry.name}` : entry.name;
        this.sub.text = entry.desc || '';
        this.sub.visible = this._st.showDesc && !!entry.desc;
        this.tag.text = TAGS[entry.kind] ?? '';
        this.tag.visible = this._st.showTags;
        if (entry.glyph) {
            this.glyph.text = entry.glyph;
            this.glyph.visible = true;
            this.iconBox.visible = false;
            return;
        }
        this.glyph.visible = false;
        this.iconBox.visible = true;
        const gi = gicon(entry);
        if (this.icon.gicon !== gi)
            this.icon.gicon = gi;
    }
}

export class Launcher {
    constructor({config, search, onActivate, getStyle, onOpen, onClose, onWindowShortcut, onHide, onFavorite, onMenu, favorites, running, history}) {
        this._cfg = config;
        this._search = search;
        this._onActivate = onActivate;
        this._getStyle = getStyle;
        this._onOpen = onOpen;
        this._onClose = onClose;
        this._onWindowShortcut = onWindowShortcut;
        this._onHide = onHide;
        this._onFavorite = onFavorite;
        this._onMenu = onMenu;
        this._menuReturn = null;
        this._extra = [];
        this._extraFor = '';
        this._favorites = favorites;
        this._favSet = new Set();
        this._running = running;
        this._runSet = new Set();
        this._lastClick = 0;
        this._lastKey = 0;
        this._autoTimer = 0;
        this._textLen = 0;

        this._built = false;
        this._state = 'hidden';
        this._rows = [];
        this._results = [];
        this._sel = -1;
        this._selItem = null;
        this._grab = null;
        this._st = null;
        this._dirty = true;
        this._order = null;
        this._suppress = false;
        this._lastListH = -2;
        this._shown = 0;
        this._grid = false;
        this._gridRows = [];
        this._gridCols = 0;
        this._gridShown = 0;
        this._lines = [];
        this._tops = [];
        this._secs = [];
        this._sections = null;
        this._history = history ?? null;
        this._hCursor = -1;
        this._draft = '';
        this._histSet = false;
        this._siKey = '';
        this._reveal = new Idle(() => this._scrollToSelected(), GLib.PRIORITY_DEFAULT_IDLE);
        this._mode = null;
        this._emptyText = 'No results';
        this._win = [];
        this._outside = 'click';
        this._armed = false;
    }

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

    get text() {
        return this._entry?.get_text() ?? '';
    }

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
            name: IDENTITY.overlay.name,
            style_class: IDENTITY.overlay.styleClass,
            accessible_name: IDENTITY.overlay.accessibleName,
            reactive: true,
            visible: false,
            layout_manager: new Clutter.BinLayout(),
        });
        this._box = new St.BoxLayout({
            name: IDENTITY.window.name,
            style_class: IDENTITY.window.styleClass,
            accessible_name: IDENTITY.window.accessibleName,
            vertical: true,
            reactive: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._box.set_pivot_point(0.5, 0.5);

        this._entry = new St.Entry({can_focus: true, x_expand: true});
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

        const adj = vAdjustment(this._scroll);
        if (adj)
            adj.connect('notify::value', () => this._onScrolled());

        const ct = this._entry.clutter_text;
        ct.connect('text-changed', () => {
            if (this._suppress)
                return;
            const len = this._entry.get_text().length;
            const grew = len > this._textLen;
            this._textLen = len;
            if (!this._histSet)
                this._hCursor = -1;
            this._refresh();
            this._autoLaunch(grew && !this._histSet);
        });
        ct.connect('key-press-event', (_a, ev) => this._onKey(ev));

        this._overlay.connect('key-press-event', (_a, ev) => {
            return this._onKey(ev);
        });
        tryConnect(this._overlay, 'button-press-event', (_a, ev) => {
            if (this._inside(ev)) {
                ct.grab_key_focus();
            } else if (this._outside === 'click') {
                this.close();
            }
            return Clutter.EVENT_STOP;
        });
        tryConnect(this._overlay, 'motion-event', (_a, ev) => this._onMotion(ev));
        this._applyStyle();
    }

    _inside(ev) {
        try {
            const [x, y] = ev.get_coords();
            const r = this._box.get_transformed_extents();
            const w = r.get_width();
            const h = r.get_height();
            if (w > 0 && h > 0 && Number.isFinite(x) && Number.isFinite(y))
                return x >= r.get_x() && x <= r.get_x() + w && y >= r.get_y() && y <= r.get_y() + h;
        } catch (_e) { /* fall back to the source actor */ }
        const src = ev.get_source();
        return !src || this._box.contains(src);
    }

    _onMotion(ev) {
        if (this._outside !== 'hover')
            return Clutter.EVENT_PROPAGATE;
        if (this._inside(ev))
            this._armed = true;
        else if (this._armed)
            this.close();
        return Clutter.EVENT_PROPAGATE;
    }

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
        this._hCursor = -1;
        this._grid = false;
        this._emptyText = 'No results';
        if (this._empty)
            this._empty.text = this._emptyText;
        if (this._entry && this._st)
            this._entry.hint_text = this._st.placeholder;
    }

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
            this._gridShown = 0;
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
        this._textLen = this._entry.get_text().length;
        this._hCursor = -1;
        this._draft = '';
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

    _monitor() {
        const lm = Main.layoutManager;
        return this._cfg.str('monitor') === 'primary' ? lm.primaryMonitor : (lm.currentMonitor ?? lm.primaryMonitor);
    }

    _place() {
        const mon = this._monitor();
        this._overlay.set_position(mon.x, mon.y);
        this._overlay.set_size(mon.width, mon.height);
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon.index);
        const scale = this._cfg.num('scale');
        const p = computePlacement({
            anchor: this._cfg.str('window-anchor'),
            pos: this._cfg.int('position'),
            searchAtBottom: this._order === 'bottom',
            gap: this._cfg.int('window-edge-gap'),
            offX: this._cfg.int('window-offset-x'),
            offY: this._cfg.int('window-offset-y'),
            mon: {x: mon.x, y: mon.y, width: mon.width, height: mon.height},
            work: {x: wa.x, y: wa.y, width: wa.width, height: wa.height},
            winW: Math.round(this._cfg.int('width') * scale),
            winH: Math.round(this._cfg.int('max-height') * scale),
        });
        const align = {start: Clutter.ActorAlign.START, center: Clutter.ActorAlign.CENTER, end: Clutter.ActorAlign.END};
        this._box.x_align = align[p.xAlign];
        this._box.y_align = align[p.yAlign];
        this._box.margin_left = p.left;
        this._box.margin_right = p.right;
        this._box.margin_top = p.top;
        this._box.margin_bottom = p.bottom;
    }

    _animate(opening) {
        const box = this._box;
        box.remove_all_transitions();
        if (!opening && this._autoTimer) {
            GLib.source_remove(this._autoTimer);
            this._autoTimer = 0;
        }
        this._state = opening ? 'opening' : 'closing';

        const style = this._cfg.str('anim-style');
        const enabled = St.Settings.get().enable_animations && style !== 'none';
        const duration = enabled ? this._cfg.int('anim-duration') : 0;
        const shown = {opacity: 255, scale_x: 1, scale_y: 1, translation_y: 0};
        const a = ANIMS[style] ?? ANIMS['fade-scale'];
        const hidden = {opacity: 0, scale_x: a.scale, scale_y: a.scale, translation_y: a.ty};
        const redirect = mode => {
            try {
                box.set_offscreen_redirect(mode);
            } catch (_e) { /* cosmetic */ }
        };
        const done = () => {
            redirect(Clutter.OffscreenRedirect.AUTOMATIC_FOR_OPACITY);
            if (opening) {
                this._state = 'open';
            } else {
                this._overlay.hide();
                this._state = 'hidden';
                this._clearSel();
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

    _canBrowse() {
        return !!this._history && this._history.size > 0 && this._mode === null && this._cfg.bool('history-enabled');
    }

    _historyStep(dir) {
        const cur = this._hCursor;
        const next = this._history.step(cur, dir);
        if (next === null)
            return cur >= 0;
        if (cur === -1)
            this._draft = this.text;
        this._hCursor = next;
        this._histSet = true;
        try {
            this._entry.set_text(next === -1 ? this._draft : this._history.at(next));
        } finally {
            this._histSet = false;
        }
        this._entry.clutter_text.set_cursor_position(-1);
        return true;
    }

    _hideSelected() {
        const e = this._results[this._sel];
        if (!e || !this._onHide)
            return;
        const keep = this._sel;
        if (this._onHide(e) && this._results.length > 0)
            this._select(Math.min(keep, this._results.length - 1));
    }

    _autoLaunch(grew) {
        if (this._autoTimer) {
            GLib.source_remove(this._autoTimer);
            this._autoTimer = 0;
        }
        if (!grew || this._mode !== null || !this._cfg.bool('auto-launch-single'))
            return;
        const text = this._entry.get_text();
        if (text.trim().length < 2)
            return;
        const pick = () => {
            const real = this._results.filter(r => r.kind !== 'web');
            return real.length === 1 && AUTO_KINDS.has(real[0].kind) ? real[0] : null;
        };
        const entry = pick();
        if (!entry)
            return;
        const fire = () => {
            this._autoTimer = 0;
            const now = pick();
            if (!this.isOpen || now !== entry || this._entry.get_text() !== text)
                return GLib.SOURCE_REMOVE;
            this._activateIndex(this._results.indexOf(entry));
            return GLib.SOURCE_REMOVE;
        };
        const delay = this._cfg.int('auto-launch-delay');
        if (delay <= 0)
            fire();
        else
            this._autoTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, fire);
    }

    _isRunning(e) {
        return e.kind === 'app' && this._runSet.has(e.payload.appId);
    }

    _refresh() {
        this._favSet = new Set(this._favorites ? this._favorites() : []);
        this._runSet = this._st?.activeOn && this._running ? new Set(this._running()) : new Set();
        let results;
        const text = this._entry.get_text();
        try {
            results = this._search(text, this._mode);
        } catch (e) {
            warn('search failed:', e.message);
            results = [];
        }
        if (this._extraFor !== text.trim() || this._mode !== null)
            this._extra = [];
        if (this._extra.length) {
            const sections = results._sections;
            const web = results.findIndex(r => r.kind === 'web');
            results = web < 0 ? [...results, ...this._extra] : [...results.slice(0, web), ...this._extra, ...results.slice(web)];
            if (sections)
                results._sections = sections;
        }
        this._results = results;
        this._sections = results._sections ?? null;
        this._render();
    }

    _render() {
        const st = this._st;
        const n = this._results.length;
        const grid = this._grid;
        const hasQuery = this._entry.get_text().length > 0;
        if (grid)
            this._layoutGrid();

        let need = 0;
        let max = st.maxListH;
        if (grid) {
            need = this._contentH();
            max = Math.max(st.gridCell, st.maxListH - st.gridHintH);
        } else {
            need = n * st.rowH + (n - 1) * st.gap;
        }
        const h = n > 0 ? Math.round(Math.min(need, max) * scaleFactor()) : -1;
        if (h !== this._lastListH) {
            this._scroll.set_height(h);
            this._lastListH = h;
        }

        this._shown = 0;
        this._gridShown = 0;
        this._grow(Math.min(n, Math.max(this._chunk(), this._fillCount(h))));
        for (let i = grid ? 0 : this._shown; i < this._rows.length; i++) {
            this._rows[i].actor.hide();
            this._rows[i].setSelected(false);
        }
        for (let i = this._gridShown; i < this._gridRows.length; i++)
            this._gridRows[i].actor.hide();

        const showEmpty = n === 0 && (hasQuery || this._mode !== null);
        this._empty.visible = showEmpty;
        this._scroll.visible = n > 0 || showEmpty;
        this._hint.visible = grid && n > 0;

        this._clearSel();
        this._select(n > 0 ? 0 : -1);
        const adj = vAdjustment(this._scroll);
        if (adj)
            adj.value = 0;
    }

    _clearSel() {
        this._selItem?.setSelected(false);
        this._selItem = null;
        this._sel = -1;
    }

    _layoutGrid() {
        const st = this._st;
        const cols = st.gridCols;
        const n = this._results.length;
        const sections = (this._sections ?? []).filter(s => s.count > 0);
        const blocks = sections.length > 0 ? sections : [{title: null, count: n}];
        const lines = [];
        const tops = [];
        const secs = [];
        let y = 0;
        let base = 0;
        for (const s of blocks) {
            const count = Math.min(s.count, n - base);
            if (count <= 0)
                continue;
            secs.push({start: base, count, line0: lines.length});
            const nl = Math.ceil(count / cols);
            for (let k = 0; k < nl; k++) {
                const header = k === 0 && s.title ? s.title : null;
                lines.push({base: base + k * cols, count: Math.min(cols, count - k * cols), header});
                tops.push(y);
                y += (header ? st.sectionH : 0) + st.gridCell + st.gridGap;
            }
            base += count;
        }
        tops.push(y);
        this._lines = lines;
        this._tops = tops;
        this._secs = secs;
        this._laidCols = cols;
    }

    // Height of all lines in CSS px (no trailing gap).
    _contentH() {
        return this._lines.length > 0 ? this._tops[this._lines.length] - this._st.gridGap : 0;
    }

    // {line, col} of result i.
    _gridPos(i) {
        if (this._laidCols !== this._st.gridCols)
            this._layoutGrid();
        const cols = this._st.gridCols;
        for (const s of this._secs) {
            if (i < s.start + s.count) {
                const k = Math.max(0, i - s.start);
                return {line: s.line0 + Math.floor(k / cols), col: k % cols};
            }
        }
        return {line: Math.max(0, this._lines.length - 1), col: 0};
    }

    // Bottom of a line's cells in CSS px (the gap below it is not included).
    _lineBottom(line) {
        const l = this._lines[line];
        return (this._tops[line] ?? 0) + (l?.header ? this._st.sectionH : 0) + this._st.gridCell;
    }

    _fillCount(heightPx) {
        const n = this._results.length;
        if (heightPx <= 0)
            return 0;
        const sf = scaleFactor();
        if (this._grid) {
            let ln = 0;
            while (ln < this._lines.length && this._tops[ln] * sf < heightPx)
                ln++;
            const last = this._lines[Math.min(this._lines.length - 1, ln + 2)];
            return last ? last.base + last.count : 0;
        }
        return Math.min(n, Math.ceil(heightPx / ((this._st.rowH + this._st.gap) * sf)) + 3);
    }

    _chunk() {
        return this._grid ? this._st.gridCols * 6 : CHUNK;
    }

    _grow(upto) {
        const n = this._results.length;
        const from = this._shown;
        let target = Math.min(n, upto > from ? Math.max(upto, from + this._chunk()) : from);
        if (this._grid) {
            const want = target > 0 ? Math.min(this._lines.length, this._gridPos(target - 1).line + 1) : 0;
            for (let ln = this._gridShown; ln < want; ln++) {
                const row = this._gridRows[ln] ?? this._makeGridRow();
                row.set(this._results, this._lines[ln]);
                row.actor.show();
            }
            this._gridShown = Math.max(this._gridShown, want);
            const last = this._lines[this._gridShown - 1];
            target = last ? last.base + last.count : from;
        } else {
            for (let i = from; i < target; i++) {
                const row = this._rows[i] ?? this._makeRow(i);
                row.set(this._results[i], this._favSet.has(this._results[i].id), this._isRunning(this._results[i]));
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

    _metrics() {
        const st = this._st;
        const sf = scaleFactor();
        return {stride: (st.rowH + st.gap) * sf, size: st.rowH * sf};
    }

    // The visual item (row or cell) for result index i.
    _item(i) {
        if (i < 0)
            return null;
        if (this._grid) {
            const p = this._gridPos(i);
            return this._gridRows[p.line]?.cells[p.col] ?? null;
        }
        return this._rows[i] ?? null;
    }

    _onScrolled() {
        if (this._shown >= this._results.length || !this._st)
            return;
        const adj = vAdjustment(this._scroll);
        if (!adj)
            return;
        const sf = scaleFactor();
        if (this._grid) {
            const ahead = (this._st.gridCell + this._st.gridGap) * sf * 3;
            if (adj.value + adj.page_size >= this._tops[this._gridShown] * sf - ahead)
                this._grow(this._shown + 1);
            return;
        }
        const {stride} = this._metrics();
        if (adj.value + adj.page_size >= this._shown * stride - stride * 3)
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
        if (grew)
            this._reveal.schedule();
    }

    _scrollToSelected() {
        try {
            const adj = vAdjustment(this._scroll);
            const st = this._st;
            if (!adj || !st || this._sel < 0 || adj.page_size <= 0)
                return;
            let top;
            let bottom;
            if (this._grid) {
                const ln = this._gridPos(this._sel).line;
                const sf = scaleFactor();
                top = this._tops[ln] * sf;
                bottom = this._lineBottom(ln) * sf;
            } else {
                const {stride, size} = this._metrics();
                top = this._sel * stride;
                bottom = top + size;
            }
            if (top < adj.value)
                adj.value = top;
            else if (bottom > adj.value + adj.page_size)
                adj.value = bottom - adj.page_size;
        } catch (_e) { /* scrolling is best effort */ }
    }

    _trimPool() {
        this._clearSel();
        for (const row of this._gridRows.splice(KEEP_ROWS / 4))
            row.actor.destroy();
        this._gridShown = Math.min(this._gridShown, this._gridRows.length);
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
        if (n > this._chunk() * 3 || this._grid)
            clamp = true;
        i = clamp ? Math.min(n - 1, Math.max(0, i)) : (i + n) % n;
        this._select(i);
    }

    _moveLines(d) {
        if (this._results.length === 0)
            return;
        const p = this._gridPos(Math.max(0, this._sel));
        const target = Math.min(this._lines.length - 1, Math.max(0, p.line + d));
        if (target === p.line) {
            if (d < 0)
                this._select(0);
            return;
        }
        const ln = this._lines[target];
        this._select(ln.base + Math.min(p.col, ln.count - 1));
    }

    _activateIndex(i, how = '') {
        const entry = this._results[i];
        if (entry)
            this._onActivate(entry, how);
    }

    _clicked(i) {
        if (this._state !== 'open' && this._state !== 'opening')
            return;
        const now = GLib.get_monotonic_time();
        if (now - this._lastClick < 400000)
            return;
        this._lastClick = now;
        dbg(`click on result ${i}`);
        this._activateIndex(i);
    }

    _rightClicked(i) {
        if (!this._menuOn() || (this._state !== 'open' && this._state !== 'opening'))
            return;
        this._select(i);
        this._openMenu(i);
    }

    _keyRecent() {
        return GLib.get_monotonic_time() - this._lastKey < 300000;
    }

    addAsyncResults(query, entries) {
        if (!this._built || (this._state !== 'open' && this._state !== 'opening') || this._mode !== null || this.text.trim() !== query)
            return;
        this._extraFor = query;
        this._extra = entries;
        this.refreshResults();
    }

    refreshResults() {
        if (!this._built || (this._state !== 'open' && this._state !== 'opening'))
            return;
        const id = this._results[this._sel]?.id;
        this._refresh();
        const i = id ? this._results.findIndex(e => e.id === id) : -1;
        if (i >= 0)
            this._select(i);
    }

    _menuOn() {
        return this._cfg.bool('action-menu');
    }

    _openMenu(i = this._sel) {
        const e = this._results[i];
        if (!e || this._mode !== null || !this._onMenu)
            return;
        const info = this._onMenu(e);
        if (!info)
            return;
        this._menuReturn = {text: this.text, id: e.id};
        this.enterMode('actions', {placeholder: info.placeholder, empty: 'No matching action'});
    }

    leaveMenu() {
        if (this._mode !== 'actions')
            return false;
        const back = this._menuReturn;
        this._menuReturn = null;
        this._resetMode();
        this._suppress = true;
        this._entry.set_text(back?.text ?? '');
        this._suppress = false;
        this._textLen = this._entry.get_text().length;
        this._refresh();
        const i = back ? this._results.findIndex(r => r.id === back.id) : -1;
        if (i >= 0)
            this._select(i);
        return true;
    }

    // Ctrl+F: add the highlighted entry to the favorites, or remove it.
    _favoriteSelected() {
        const e = this._results[this._sel];
        if (e && this._onFavorite)
            this._onFavorite(e);
    }

    _onKey(ev) {
        this._lastKey = GLib.get_monotonic_time();
        const sym = ev.get_key_symbol();
        const mods = ev.get_state();
        const ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const alt = (mods & Clutter.ModifierType.MOD1_MASK) !== 0;

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
            switch (sym) {
            case Clutter.KEY_Left:
                this._move(-1, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Right:
                this._move(1, true);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Up:
                this._moveLines(-1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Down:
                this._moveLines(1);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Page_Down:
                this._moveLines(4);
                return Clutter.EVENT_STOP;
            case Clutter.KEY_Page_Up:
                this._moveLines(-4);
                return Clutter.EVENT_STOP;
            default:
            }
        }

        switch (sym) {
        case Clutter.KEY_Escape:
            if (this.leaveMenu())
                return Clutter.EVENT_STOP;
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_BackSpace:
            if (this._mode && this._entry.get_text() === '') {
                if (!this.leaveMenu())
                    this.exitMode();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        case Clutter.KEY_Down:
            if (this._hCursor >= 0 && this._historyStep(1))
                return Clutter.EVENT_STOP;
            this._move(1);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Up:
            if (this._canBrowse() && (this._hCursor >= 0 || this._sel <= 0) && this._historyStep(-1))
                return Clutter.EVENT_STOP;
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
            case Clutter.KEY_b:
                if (!this._menuOn())
                    return Clutter.EVENT_PROPAGATE;
                this._openMenu();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_h:
                if (this._menuOn())
                    return Clutter.EVENT_PROPAGATE;
                this._hideSelected();
                return Clutter.EVENT_STOP;
            case Clutter.KEY_f:
            case Clutter.KEY_d:
                if (this._menuOn())
                    return Clutter.EVENT_PROPAGATE;
                this._favoriteSelected();
                return Clutter.EVENT_STOP;
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
        if (this._autoTimer) {
            GLib.source_remove(this._autoTimer);
            this._autoTimer = 0;
        }
        this._box?.remove_all_transitions();
        this._overlay?.destroy();
        this._overlay = this._box = this._entry = this._scroll = this._list = this._empty = this._hint = null;
        this._selItem = null;
        this._gridRows = [];
        this._rows = [];
        this._results = [];
        this._shown = 0;
        this._siKey = '';
        this._built = false;
        this._state = 'hidden';
        dbg('launcher destroyed');
    }
}

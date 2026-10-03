// The launcher's blur, built the way Blur my Shell (aunetx, GPL-3.0) blurs application windows:
//
//  - the blur is NOT an effect on the window itself. It is an empty widget that sits right behind the window
//    ("blur actor"), carries the effect(s), and follows the window's size. An effect on the window would
//    paint all of its children into an off-screen buffer on every frame, which is what glitched before.
//  - dynamic mode: the actor carries the native `BlurEffect` in BACKGROUND mode (it blurs what is behind it:
//    windows, wallpaper), with the radius scaled by the display scale, a brightness and a corner radius.
//    Optionally a paint-signal effect makes the blur repaint whenever the actor is painted ("hacks level 1").
//  - static mode: the actor is as big as the monitor, shows the wallpaper through a `BackgroundManager`,
//    carries a pipeline of effects, and is clipped to the window's rectangle.
//  - effects are recycled by an `EffectsManager`, signals are tracked by `Connections`.
//
// Used by ui/launcher.js through a dynamic import, so a problem in here can never stop the extension from
// loading, and nothing of it is in memory while blur is off.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';

import {Idle} from '../utils/timing.js';
import {dbg, warn} from '../utils/log.js';
import {Connections} from './connections.js';
import {EffectsManager} from './effects_manager.js';
import {PaintSignals} from './paint_signals.js';
import {BlurPipeline} from './pipeline.js';

const NAME = 'gnome-launcher-blur';

export class LauncherBlur {
    // overlay: the container; box: the launcher window inside it (the blur actor goes right below it).
    // hacks(): the current "hacks level" (0 or 1).
    constructor(overlay, box, hacks = () => 1) {
        this._overlay = overlay;
        this._box = box;
        this._hacks = hacks;
        this._conn = new Connections();
        this._paint = new PaintSignals(this._conn);
        this._em = null;
        this._kind = null;
        this._sig = '';
        this._actor = null;
        this._fx = null;
        this._pipeline = null;
        this._bg = null;
        this._mon = null;
        this._failed = '';
        // Following the window is deferred to just before the next frame: it changes the size of an actor,
        // which must not happen in the middle of an allocation.
        this._follow = new Idle(() => this.sync(), GLib.PRIORITY_DEFAULT);
        this._boxSig = box.connect('notify::allocation', () => this._follow.schedule());
    }

    get active() {
        return this._actor !== null;
    }

    // spec: result of resolveBlur() (blur/defs.js). mon: {index, width, height} of the monitor the launcher is on.
    apply(spec, mon) {
        this._mon = mon;
        const sig = JSON.stringify([spec, this._hacks(), spec.kind === 'static' ? [mon.index, mon.width, mon.height] : 0]);
        if ((sig === this._sig && this._actor) || sig === this._failed)
            return;
        this._failed = '';
        let built = false;
        try {
            if (spec.kind === 'dynamic') {
                if (this._kind === 'dynamic' && this._actor && this._hacks() === this._builtHacks) {
                    this._updateDynamic(spec);
                } else {
                    this._rebuild(() => this._buildDynamic(spec));
                    built = true;
                }
            } else if (spec.kind === 'static') {
                this._rebuild(() => this._buildStatic(spec, mon));
                built = true;
            } else {
                this._teardown();
            }
            this._sig = this._actor ? sig : '';
            if (this._actor && built)
                this._copyLook();
        } catch (e) {
            warn(`blur: ${e.message}`);
            this._teardown();
            this._failed = sig; // not tried again until something changes
        }
        this.sync();
    }

    // The launcher moved to another monitor, or the monitor changed size.
    place(mon) {
        this._mon = mon;
        if (this._kind === 'static' && this._monKey !== `${mon.index}:${mon.width}x${mon.height}`) {
            this._sig = '';
            this._lastSpec && this.apply(this._lastSpec, mon);
        }
        this._follow.schedule();
    }

    // Follow the window: size (and, in static mode, the clip) from the window's current allocation.
    sync() {
        const a = this._actor;
        if (!a)
            return;
        let b;
        try {
            b = this._box.get_allocation_box();
        } catch (_e) {
            return;
        }
        const w = b.x2 - b.x1, h = b.y2 - b.y1;
        if (!(w > 0 && h > 0))
            return;
        if (this._kind === 'dynamic') {
            // Same placement rules as the window (alignment and margins), so both land on the same spot.
            const box = this._box;
            a.x_align = box.x_align;
            a.y_align = box.y_align;
            a.margin_top = box.margin_top;
            a.margin_bottom = box.margin_bottom;
            a.margin_left = box.margin_left;
            a.margin_right = box.margin_right;
            if (a.width !== w || a.height !== h)
                a.set_size(w, h);
        } else {
            a.set_clip(b.x1, b.y1, w, h);
            const W = a.width || 1, H = a.height || 1;
            a.set_pivot_point(((b.x1 + b.x2) / 2) / W, ((b.y1 + b.y2) / 2) / H);
        }
    }

    // A blur built while the window is already showing (first open, or a style change) starts from the
    // window's current opacity, scale and offset instead of popping in at full strength.
    _copyLook() {
        const b = this._box;
        this._actor.set({opacity: b.opacity, scale_x: b.scale_x, scale_y: b.scale_y, translation_y: b.translation_y});
    }

    // The window is being animated: the blur follows (opacity, scale, translation).
    set(props) {
        this._actor?.set(props);
    }

    ease(props) {
        this._actor?.ease(props);
    }

    removeTransitions() {
        this._actor?.remove_all_transitions();
    }

    // --- dynamic -------------------------------------------------------------------------------

    _buildDynamic(spec) {
        const actor = new St.Widget({name: NAME, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.START});
        actor.set_pivot_point(0.5, 0.5); // the window scales around its centre
        let fx;
        try {
            fx = this._manager().new_native_dynamic_gaussian_blur_effect({
                unscaled_radius: 2 * spec.sigma, brightness: spec.brightness, corner_radius: spec.cornerRadius,
            });
        } catch (e) {
            actor.destroy();
            throw new Error(`the native blur effect is not available (${e.message})`);
        }
        actor.add_effect(fx);
        this._builtHacks = this._hacks();
        if (this._builtHacks === 1)
            this._paint.connect(actor, fx);
        this._overlay.insert_child_below(actor, this._box);
        this._actor = actor;
        this._fx = fx;
        this._kind = 'dynamic';
        this._lastSpec = spec;
    }

    _updateDynamic(spec) {
        this._fx.unscaled_radius = 2 * spec.sigma;
        this._fx.brightness = spec.brightness;
        this._fx.unscaled_corner_radius = spec.cornerRadius;
        this._lastSpec = spec;
        this._fx.queue_repaint();
    }

    // --- static --------------------------------------------------------------------------------

    _buildStatic(spec, mon) {
        const actor = new St.Widget({name: NAME, y: 0.5, z_position: 1, width: mon.width, height: mon.height});
        const pipeline = new BlurPipeline(this._manager());
        pipeline.apply(actor, spec.pipeline, {cornerRadius: spec.followCorner ? spec.cornerRadius : null});
        let bg;
        try {
            bg = new Background.BackgroundManager({container: actor, monitorIndex: mon.index, controlPosition: false});
        } catch (e) {
            pipeline.clear();
            actor.destroy();
            throw new Error(`could not show the wallpaper (${e.message})`);
        }
        this._overlay.insert_child_below(actor, this._box);
        this._actor = actor;
        this._pipeline = pipeline;
        this._bg = bg;
        this._kind = 'static';
        this._monKey = `${mon.index}:${mon.width}x${mon.height}`;
        this._lastSpec = spec;
    }

    // --- housekeeping --------------------------------------------------------------------------

    _manager() {
        this._em ??= new EffectsManager(this._conn);
        return this._em;
    }

    _rebuild(build) {
        this._teardown();
        build();
        dbg(`blur: ${this._kind} blur ready`);
    }

    _teardown() {
        this._paint.disconnect_all();
        if (this._pipeline) {
            this._pipeline.clear();
            this._pipeline = null;
        }
        if (this._fx) {
            this._em?.remove(this._fx);
            this._fx = null;
        }
        if (this._bg) {
            try {
                this._bg.destroy();
            } catch (_e) { /* already destroyed */ }
            this._bg = null;
        }
        if (this._actor) {
            try {
                this._actor.remove_all_transitions();
                this._actor.destroy();
            } catch (_e) { /* already destroyed with its parent */ }
            this._actor = null;
        }
        this._kind = null;
        this._sig = '';
    }

    destroy() {
        this._follow.cancel();
        if (this._boxSig) {
            try {
                this._box.disconnect(this._boxSig);
            } catch (_e) { /* box already destroyed */ }
            this._boxSig = 0;
        }
        this._teardown();
        this._em?.destroy_all();
        this._em = null;
        this._conn.disconnect_all();
    }
}

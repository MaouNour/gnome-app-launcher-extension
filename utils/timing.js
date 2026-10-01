import GLib from 'gi://GLib';

// Single-shot timer that coalesces repeated calls. Owners must cancel() in destroy/disable.
export class Debounce {
    constructor(ms, fn, priority = GLib.PRIORITY_DEFAULT) {
        this._ms = ms;
        this._fn = fn;
        this._prio = priority;
        this._id = 0;
    }

    call() {
        this.cancel();
        this._id = GLib.timeout_add(this._prio, this._ms, () => {
            this._id = 0;
            this._fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    get pending() {
        return this._id !== 0;
    }

    // Run now if a call is pending.
    flush() {
        if (!this._id)
            return;
        this.cancel();
        this._fn();
    }

    cancel() {
        if (this._id) {
            GLib.source_remove(this._id);
            this._id = 0;
        }
    }
}

// Coalescing idle callback (runs once, at low priority by default).
export class Idle {
    constructor(fn, priority = GLib.PRIORITY_LOW) {
        this._fn = fn;
        this._prio = priority;
        this._id = 0;
    }

    schedule() {
        if (this._id)
            return;
        this._id = GLib.idle_add(this._prio, () => {
            this._id = 0;
            this._fn();
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel() {
        if (this._id) {
            GLib.source_remove(this._id);
            this._id = 0;
        }
    }
}

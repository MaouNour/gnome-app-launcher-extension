import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppIndex} from './applications/appIndex.js';
import {JsonStore} from './cache/store.js';
import {Stats} from './cache/stats.js';
import {Runner} from './commands/runner.js';
import {buildUserEntries} from './commands/userEntries.js';
import {Config} from './config/config.js';
import {SearchEngine} from './search/engine.js';
import {Keybindings} from './shortcuts/keybindings.js';
import {resolveTheme} from './themes/themes.js';
import {Launcher} from './ui/launcher.js';
import {Debounce, Idle} from './utils/timing.js';
import {setDebug, dbg, warn} from './utils/log.js';

const NOTIFY_TITLE = 'GNOME Launcher';

// Keys that only affect appearance: a change just marks the UI style dirty.
const STYLE_KEYS = new Set([
    'width', 'window-height', 'max-height', 'search-height', 'search-position', 'row-height',
    'icon-size', 'font-size', 'scale', 'padding', 'result-spacing', 'search-padding',
    'icon-spacing', 'show-descriptions', 'show-tags', 'placeholder', 'theme-mode',
    'theme-light', 'theme-dark', 'custom-themes', 'theme-overrides',
]);

export default class GnomeLauncherExtension extends Extension {
    enable() {
        this._alive = true;
        this._settings = this.getSettings();
        const cfg = this._config = new Config(this._settings);
        setDebug(cfg.bool('debug'));

        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-launcher']);
        const stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'gnome-launcher']);

        this._userEntries = [];
        this._userById = new Map();
        this._userShortcuts = [];
        this._pending = null;

        this._engine = new SearchEngine();
        this._stats = new Stats(new JsonStore(GLib.build_filenamev([stateDir, 'stats.json']), 1));
        this._engine.stats = this._stats;
        this._runner = new Runner();
        this._keys = new Keybindings();

        this._rebuild = new Idle(() => this._rebuildEntries(), GLib.PRIORITY_DEFAULT_IDLE);
        this._runIdle = new Idle(() => this._runPending(), GLib.PRIORITY_DEFAULT);
        this._restyle = new Debounce(60, () => this._launcher?.invalidateStyle());
        this._prebuild = new Idle(() => this._launcher?.build());

        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._ifaceId = this._iface.connect('changed::color-scheme', () => this._restyle.call());

        this._apps = new AppIndex(new JsonStore(GLib.build_filenamev([cacheDir, 'apps.json']), 1),
            () => this._rebuild.schedule());
        this._apps.setPersist(cfg.bool('persist-cache'));

        this._launcher = new Launcher({
            config: cfg,
            search: q => this._search(q),
            onActivate: e => this._activate(e),
            getStyle: () => this._styleInputs(),
            // Only does work before the cache has arrived; afterwards it is a no-op.
            onOpen: () => {
                if (this._apps.ensureReady())
                    this._rebuildEntries();
            },
        });

        this._buildUser();
        this._bindShortcuts();
        cfg.onChanged(key => this._onConfigChanged(key));

        // Startup work is asynchronous / idle: load usage stats, then the app cache.
        this._stats.load().then(() => {
            if (this._alive)
                this._rebuild.schedule();
        });
        this._apps.start();
        if (cfg.bool('prebuild-ui'))
            this._prebuild.schedule();
        dbg('enabled');
    }

    disable() {
        this._alive = false;
        for (const t of [this._prebuild, this._restyle, this._rebuild, this._runIdle])
            t?.cancel();
        this._keys?.destroy();
        this._launcher?.destroy();
        this._apps?.destroy();
        this._stats?.destroy();
        if (this._ifaceId)
            this._iface.disconnect(this._ifaceId);
        this._config?.destroy();
        this._prebuild = this._restyle = this._rebuild = this._runIdle = null;
        this._keys = this._launcher = this._apps = this._stats = this._engine = this._runner = null;
        this._iface = this._ifaceId = this._config = this._settings = null;
        this._userEntries = this._userById = this._userShortcuts = this._pending = null;
        dbg('disabled');
    }

    // --- configuration -----------------------------------------------------

    _onConfigChanged(key) {
        switch (key) {
        case 'shortcut':
        case 'use-super-key':
            this._bindShortcuts();
            break;
        case 'commands':
        case 'actions':
        case 'category-icons':
            this._buildUser();
            break;
        case 'debug':
            setDebug(this._config.bool('debug'));
            break;
        case 'persist-cache':
            this._apps.setPersist(this._config.bool('persist-cache'));
            break;
        case 'cache-generation':
            this._apps.rebuild();
            break;
        case 'stats-generation':
            this._stats.reset();
            this._rebuild.schedule();
            break;
        default:
            if (STYLE_KEYS.has(key))
                this._restyle.call();
        }
    }

    _bindShortcuts() {
        const ok = this._keys.setMain(this._settings, 'shortcut', () => this._launcher.toggle());
        if (!ok)
            Main.notify(NOTIFY_TITLE, 'The launcher shortcut conflicts with another binding. Choose a different one in the preferences.');
        this._keys.setSuperKey(this._config.bool('use-super-key'), () => this._launcher.open());
    }

    // Rebuild user commands/actions (cheap; the lists are small) and their shortcuts.
    _buildUser() {
        const c = this._config;
        const r = buildUserEntries(c.json('commands', []), c.json('actions', []), c.json('category-icons', {}));
        this._userEntries = r.entries;
        this._userById = new Map(r.entries.map(e => [e.id, e]));
        for (const p of r.problems)
            warn(p);
        if (r.problems.length)
            Main.notify(NOTIFY_TITLE, `${r.problems.length} custom entr${r.problems.length === 1 ? 'y is' : 'ies are'} invalid and skipped: ${r.problems[0]}`);

        const failed = this._keys.setCustom(r.shortcuts.map(s => ({id: s.id, accel: s.accel})), id => {
            const e = this._userById.get(id);
            if (e)
                this._activate(e);
        });
        if (failed.length)
            Main.notify(NOTIFY_TITLE, `Shortcut unavailable (conflict or invalid): ${failed.join(', ')}`);
        this._rebuild.schedule();
    }

    _rebuildEntries() {
        if (!this._engine)
            return;
        this._engine.setEntries([...this._apps.entries(), ...this._userEntries]);
        dbg('entries rebuilt:', this._engine.size);
        if (this._launcher?.isOpen)
            this._launcher._refresh();
    }

    // --- theme -------------------------------------------------------------

    _isDark() {
        const mode = this._config.str('theme-mode');
        if (mode === 'dark')
            return true;
        if (mode === 'light')
            return false;
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    _styleInputs() {
        const c = this._config;
        const dark = this._isDark();
        return {
            layout: {
                width: c.int('width'), windowHeight: c.int('window-height'), maxHeight: c.int('max-height'),
                searchHeight: c.int('search-height'), searchPosition: c.str('search-position'),
                rowHeight: c.int('row-height'), iconSize: c.int('icon-size'), fontSize: c.num('font-size'),
                scale: c.num('scale'), padding: c.int('padding'), resultSpacing: c.int('result-spacing'),
                searchPadding: c.int('search-padding'), iconSpacing: c.int('icon-spacing'),
                showDescriptions: c.bool('show-descriptions'), showTags: c.bool('show-tags'),
                placeholder: c.str('placeholder'),
            },
            theme: resolveTheme({
                custom: c.json('custom-themes', []),
                name: dark ? c.str('theme-dark') : c.str('theme-light'),
                dark,
                overrides: c.json('theme-overrides', {}),
            }),
        };
    }

    // --- search / activation -------------------------------------------------

    _search(query) {
        const c = this._config;
        const t0 = GLib.get_monotonic_time();
        const out = this._engine.search(query, {
            limit: c.int('max-results'),
            initial: c.int('initial-results'),
            fuzzy: c.bool('fuzzy'),
            descriptions: c.bool('search-descriptions'),
            frecency: c.bool('frecency'),
        });
        dbg(`search "${query}": ${((GLib.get_monotonic_time() - t0) / 1000).toFixed(2)} ms, ${out.length} results of ${this._engine.size}`);
        return out;
    }

    _activate(entry) {
        this._launcher.close();
        if (this._config.bool('frecency'))
            this._stats.hit(entry.id);
        // Run after the modal grab is released and the launcher has started closing.
        this._pending = entry;
        this._runIdle.schedule();
    }

    _runPending() {
        const entry = this._pending;
        this._pending = null;
        if (!entry || !this._runner)
            return;
        try {
            this._runner.run(entry);
        } catch (e) {
            warn(`failed to run ${entry.id}: ${e.message}`);
            Main.notify(NOTIFY_TITLE, `Could not run "${entry.name}": ${e.message}`);
            // A missing application means the index is stale: reconcile it.
            if (entry.kind === 'app')
                this._apps.refresh();
        }
    }
}

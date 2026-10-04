import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppIndex} from './applications/appIndex.js';
import {JsonStore} from './cache/store.js';
import {Stats} from './cache/stats.js';
import {accountEntries, clearDelaySeconds} from './accounts/accounts.js';
import {openVault} from './accounts/vault.js';
import {ClipboardHistory, clearClipboardIf, copyText} from './clipboard/history.js';
import {buildBuiltinEntries} from './commands/builtins.js';
import {parseExec} from './commands/exec.js';
import {parseEmoji, emojiPlan, emojiOptions, inlineEmojiQuery} from './emoji/emoji.js';
import {Paster} from './emoji/paste.js';
import {Runner, openUri} from './commands/runner.js';
import {buildUserEntries} from './commands/userEntries.js';
import {Config} from './config/config.js';
import {calculate} from './search/calc.js';
import {parseRegexQuery} from './search/regex.js';
import {DEFAULT_PROVIDERS, explicitWebQuery, offerWeb, sanitizeProviders, webEntries} from './search/web.js';
import {SearchEngine, prepare} from './search/engine.js';
import {QueryHistory} from './search/history.js';
import {Keybindings} from './shortcuts/keybindings.js';
import {compileBlocklist} from './shortcuts/blocklist.js';
import {resolveTheme} from './themes/themes.js';
import {Launcher} from './ui/launcher.js';
import {Debounce, Idle} from './utils/timing.js';
import {setDebug, dbg, warn} from './utils/log.js';

const NOTIFY_TITLE = 'GNOME Launcher';
const SHORTCUT_KEY = 'gnome-launcher-toggle';

// Keys that only affect appearance: a change just marks the UI style dirty.
const STYLE_KEYS = new Set([
    'blur-mode', 'blur-sigma', 'blur-brightness', 'blur-corner-auto', 'blur-corner-radius', 'blur-pipelines',
    'blur-pipeline', 'blur-repaint',
    'width', 'window-height', 'max-height', 'search-height', 'search-position', 'row-height',
    'icon-size', 'font-size', 'scale', 'padding', 'result-spacing', 'search-padding',
    'icon-spacing', 'show-descriptions', 'show-tags', 'placeholder', 'theme-mode',
    'theme-light', 'theme-dark', 'custom-themes', 'theme-overrides',
    'search-icon', 'search-icon-size', 'show-scrollbar', 'emoji-grid-size',
    'font-search', 'font-size-search', 'font-weight-search', 'font-main', 'font-weight-main',
    'font-secondary', 'font-size-secondary', 'font-weight-secondary', 'emoji-font',
]);

// Kinds of search result that have a fixed id and so can be hidden with Ctrl+H.
const HIDEABLE_KINDS = new Set(['app', 'command', 'action', 'system', 'mode']);

// The emoji dataset is only loaded when first needed and released again after this long idle.
const EMOJI_FREE_MS = 60000;

export default class GnomeLauncherExtension extends Extension {
    enable() {
        this._alive = true;
        this._settings = this.getSettings();
        const cfg = this._config = new Config(this._settings);
        setDebug(cfg.bool('debug'));

        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-launcher']);
        const stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'gnome-launcher']);

        this._special = new Map(); // id -> entry for user commands/actions and built-ins
        this._specialEntries = [];
        this._pending = null;
        this._focusSig = 0;
        this._fsSig = 0;
        this._fsWin = null;
        this._block = null;
        this._blockFs = false;

        this._engine = new SearchEngine();
        this._clipEngine = new SearchEngine();
        this._emojiEngine = null; // created lazily by _ensureEmoji()
        this._emojiLoading = false;
        this._accountEngine = new SearchEngine();
        this._pwClear = null; // {id, pw}: a copied password waiting to be taken off the clipboard
        this._buffer = ''; // private emoji buffer: memory only, never on disk or in clipboard history
        this._stats = new Stats(new JsonStore(GLib.build_filenamev([stateDir, 'stats.json']), 1));
        this._engine.stats = this._stats;
        this._history = new QueryHistory(cfg.int('history-max'));
        this._historyStore = new JsonStore(GLib.build_filenamev([stateDir, 'history.json']), 1, {private: true});
        this._historyDirty = false;
        this._historySave = new Debounce(1500, () => this._flushHistory());
        this._runner = new Runner({
            clearClipboard: () => this._clip?.clear(),
            pasteEmojiBuffer: () => this._pasteEmojiBuffer(),
            // Same window `gnome-extensions prefs <uuid>` opens, without spawning a process.
            openPrefs: () => this.openPreferences(),
            saveClipboard: () => this._clip?.captureNow(),
        });
        this._keys = new Keybindings();
        this._clip = new ClipboardHistory(() => this._onClipboardChanged(), {
            openUri: uri => openUri(uri),
            notify: text => Main.notify(NOTIFY_TITLE, text),
        });
        this._clip.setMax(cfg.int('clipboard-max'));

        this._paster = new Paster({
            mute: ms => this._clip?.mute(ms),
            wmClass: () => global.display.focus_window?.get_wm_class?.() ?? null,
        });
        this._emojiFree = new Debounce(EMOJI_FREE_MS, () => this._dropEmoji(), GLib.PRIORITY_LOW);

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
            search: (q, mode) => this._search(q, mode),
            onActivate: (e, how) => this._activate(e, how),
            onWindowShortcut: id => this._activateId(id),
            onClose: () => {
                if (this._emojiEngine)
                    this._emojiFree?.call();
            },
            getStyle: () => this._styleInputs(),
            // Only does work before the cache has arrived; afterwards it is a no-op.
            history: this._history,
            favorites: () => (this._config.bool('favorites-enabled') ? this._favoriteIds() : []),
            onFavorite: entry => this._toggleFavorite(entry),
            onHide: entry => this._hideEntry(entry),
            onOpen: () => {
                this._clip?.ensureWatching();
                if (this._apps.ensureReady())
                    this._rebuildEntries();
            },
        });

        this._buildSpecial();
        this._syncBlocklist();
        this._syncClipboard();
        this._syncAccounts();
        this._bindShortcuts();
        cfg.onChanged(key => this._onConfigChanged(key));

        // Startup work is asynchronous / idle: load usage stats, then the app cache.
        this._stats.load().then(() => {
            if (this._alive)
                this._rebuild.schedule();
        });
        this._loadHistory();
        this._apps.start();
        if (cfg.bool('prebuild-ui'))
            this._prebuild.schedule();
        dbg('enabled');
    }

    disable() {
        this._alive = false;
        for (const t of [this._prebuild, this._restyle, this._rebuild, this._runIdle, this._emojiFree])
            t?.cancel();
        this._finishPasswordClear(); // a copied password never outlives the extension
        this._unwatchFocus();
        this._historySave?.cancel();
        this._flushHistory(true);
        this._historyStore?.cancel();
        this._paster?.destroy(); // puts a borrowed clipboard back
        this._keys?.destroy(); // also gives the Super key back to the overview
        this._launcher?.destroy();
        this._clip?.destroy();
        this._apps?.destroy();
        this._stats?.destroy();
        if (this._ifaceId)
            this._iface.disconnect(this._ifaceId);
        this._config?.destroy();
        this._prebuild = this._restyle = this._rebuild = this._runIdle = this._emojiFree = null;
        this._paster = this._emojiEngine = this._buffer = null;
        this._keys = this._launcher = this._clip = this._apps = this._stats = null;
        this._engine = this._clipEngine = this._runner = null;
        this._iface = this._ifaceId = this._config = this._settings = null;
        this._special = this._specialEntries = this._pending = null;
        dbg('disabled');
    }

    // --- configuration -----------------------------------------------------

    _onConfigChanged(key) {
        switch (key) {
        case 'use-super-key':
            this._keys.setSuperKey(this._config.bool('use-super-key'), () => this._launcher.toggle());
            break;
        case 'blocklist':
        case 'block-fullscreen':
            this._syncBlocklist();
            break;
        case 'commands':
        case 'actions':
        case 'category-icons':
        case 'builtins':
            this._buildSpecial();
            break;
        case 'clipboard-enabled':
            this._syncClipboard();
            this._buildSpecial();
            break;
        case 'accounts':
            this._syncAccounts();
            break;
        case 'web-providers':
            this._webProviders = null;
            break;
        case 'emoji-enabled':
        case 'accounts-enabled':
        case 'own-keyword':
            this._buildSpecial();
            break;
        case 'clipboard-images':
        case 'clipboard-image-count':
        case 'clipboard-image-mb':
            this._syncClipboardImages();
            break;
        case 'clipboard-source':
        case 'clipboard-persist':
        case 'clipboard-dir':
        case 'clipboard-link-files':
        case 'clipboard-screenshot-dir':
        case 'clipboard-videos':
        case 'clipboard-video-dir':
            this._syncClipboardOptions();
            break;
        case 'clipboard-max':
            this._clip.setMax(this._config.int('clipboard-max'));
            break;
        case 'hidden-entries':
            this._rebuild.schedule();
            break;
        case 'favorites':
        case 'favorites-enabled':
            this._launcher?.refreshResults();
            break;
        case 'history-max':
            if (this._history.setMax(this._config.int('history-max')))
                this._markHistory();
            break;
        case 'history-persist':
            if (this._config.bool('history-persist'))
                this._markHistory();
            else
                this._historyStore.remove(); // switching it off deletes what is on disk
            break;
        case 'history-generation':
            this._history.clear();
            this._historyDirty = false;
            this._historyStore.remove();
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

    // The main shortcut is registered once; Mutter follows later changes to the setting itself.
    _bindShortcuts() {
        if (!this._keys.setMain(this._settings, SHORTCUT_KEY, () => this._launcher.toggle()))
            Main.notify(NOTIFY_TITLE, 'Could not register the launcher shortcut. See: journalctl -o cat /usr/bin/gnome-shell | grep gnome-launcher');
        this._keys.setSuperKey(this._config.bool('use-super-key'), () => this._launcher.toggle());
    }

    // --- blocklist -----------------------------------------------------------
    // The launcher shortcuts are released while a blocked application (or any fullscreen window, if
    // chosen) has focus. Nothing runs at idle: the focus signal is only connected while the feature is
    // configured, and a focus change costs a few string comparisons.

    _syncBlocklist() {
        this._block = compileBlocklist(this._config.strv('blocklist'));
        this._blockFs = this._config.bool('block-fullscreen');
        if (this._block.size === 0 && !this._blockFs) {
            this._unwatchFocus();
            this._keys.setBlocked(false);
            return;
        }
        if (!this._focusSig)
            this._focusSig = global.display.connect('notify::focus-window', () => this._checkFocus());
        this._checkFocus(true);
    }

    _unwatchFocus() {
        if (this._focusSig) {
            global.display.disconnect(this._focusSig);
            this._focusSig = 0;
        }
        this._dropFsWatch();
        this._fsWin = null;
    }

    _dropFsWatch() {
        if (this._fsSig && this._fsWin) {
            try {
                this._fsWin.disconnect(this._fsSig);
            } catch (_e) { /* window already destroyed */ }
        }
        this._fsSig = 0;
    }

    _checkFocus(force = false) {
        const win = global.display.focus_window ?? null;
        if (force || win !== this._fsWin) {
            this._dropFsWatch();
            this._fsWin = win;
            if (win && this._blockFs)
                this._fsSig = win.connect('notify::fullscreen', () => this._checkFocus());
        }
        this._keys?.setBlocked(this._isBlocked(win));
    }

    _isBlocked(win) {
        if (!win)
            return false;
        if (this._blockFs && win.is_fullscreen())
            return true;
        if (this._block.size === 0)
            return false;
        const names = [win.get_wm_class?.(), win.get_wm_class_instance?.(), win.get_gtk_application_id?.(), win.get_sandboxed_app_id?.()];
        try {
            const app = Shell.WindowTracker.get_default().get_window_app(win);
            if (app)
                names.push(app.get_id(), app.get_name());
        } catch (_e) { /* no app for this window */ }
        return this._block.test(names);
    }

    _syncAccounts() {
        this._accountEngine.setEntries(accountEntries(this._config.json('accounts', [])));
        if (this._launcher?.mode === 'accounts')
            this._launcher.refresh();
    }

    _syncClipboardImages() {
        const c = this._config;
        this._clip.setImages(c.bool('clipboard-images'), c.int('clipboard-image-count'), c.int('clipboard-image-mb'));
    }

    _syncClipboardOptions() {
        const c = this._config;
        this._clip.configure({
            source: c.str('clipboard-source'), persist: c.bool('clipboard-persist'), dir: c.str('clipboard-dir'),
            link: c.bool('clipboard-link-files'), shotDir: c.str('clipboard-screenshot-dir'),
            videos: c.bool('clipboard-videos'), videoDir: c.str('clipboard-video-dir'),
        });
    }

    _syncClipboard() {
        this._syncClipboardOptions();
        this._syncClipboardImages();
        if (this._config.bool('clipboard-enabled'))
            this._clip.start();
        else
            this._clip.stop();
    }

    // User commands/actions plus the built-in entries, and all of their shortcuts.
    _buildSpecial() {
        const c = this._config;
        const user = buildUserEntries(c.json('commands', []), c.json('actions', []), c.json('category-icons', {}));
        const builtin = buildBuiltinEntries(c.json('builtins', {}), {
            clipboard: c.bool('clipboard-enabled'), emoji: c.bool('emoji-enabled'), accounts: c.bool('accounts-enabled'), keyword: c.str('own-keyword'),
        });
        this._ownEntries = builtin.entries;

        this._specialEntries = [...user.entries, ...builtin.entries];
        this._special = new Map(this._specialEntries.map(e => [e.id, e]));

        for (const p of user.problems)
            warn(p);
        if (user.problems.length)
            Main.notify(NOTIFY_TITLE, `${user.problems.length} custom entr${user.problems.length === 1 ? 'y is' : 'ies are'} invalid and skipped: ${user.problems[0]}`);

        const failed = this._keys.setCustom([...user.shortcuts, ...builtin.shortcuts], id => this._activateId(id));
        if (failed.length)
            Main.notify(NOTIFY_TITLE, `Shortcut unavailable (conflict or invalid): ${failed.join(', ')}`);
        this._launcher.setWindowShortcuts([...user.windowShortcuts, ...builtin.windowShortcuts]);
        this._rebuild.schedule();
    }

    _rebuildEntries() {
        if (!this._engine)
            return;
        const hidden = this._hiddenSet();
        const all = [...this._apps.entries(), ...this._specialEntries];
        this._engine.setEntries(hidden.size ? all.filter(e => !hidden.has(e.id)) : all);
        dbg('entries rebuilt:', this._engine.size);
        this._launcher?.refresh();
    }

    _onClipboardChanged() {
        this._clipEngine?.setEntries(this._clip.entries());
        if (this._launcher?.mode === 'clipboard')
            this._launcher.refresh();
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
                searchIcon: c.str('search-icon').trim(), searchIconSize: c.int('search-icon-size'),
                showScrollbar: c.bool('show-scrollbar'), gridCell: c.int('emoji-grid-size'),
                emojiFont: c.str('emoji-font'),
                fonts: {
                    search: {family: c.str('font-search'), size: c.num('font-size-search'), weight: c.int('font-weight-search')},
                    main: {family: c.str('font-main'), weight: c.int('font-weight-main')},
                    secondary: {family: c.str('font-secondary'), size: c.num('font-size-secondary'), weight: c.int('font-weight-secondary')},
                },
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

    _search(query, mode) {
        const c = this._config;
        if (mode === 'clipboard') {
            if (!query.trim())
                return this._clip.entries();
            return this._clipEngine.search(query, {limit: c.bool('unlimited-results') ? Infinity : c.int('max-results'), frecency: false});
        }
        if (mode === 'emoji')
            return this._emojiMode(query);
        if (mode === 'accounts') {
            return this._accountEngine.search(query, {
                fuzzy: c.bool('fuzzy'), descriptions: true, frecency: false, limit: Infinity, initial: Infinity,
            });
        }
        // "!ls -la": offers to run what follows the prefix (a symbol of your choice; empty = off).
        const ex = parseExec(query, c.str('exec-prefix'));
        if (ex) {
            this._launcher?.setEmptyText(`Type a command after ${c.str('exec-prefix').trim()} and press Enter`);
            if (!ex.command)
                return [];
            return [prepare({
                id: 'exec:run', kind: 'exec', name: ex.command,
                desc: c.bool('exec-shell') ? 'Run in a shell · Enter' : 'Run directly, no shell · Enter',
                icon: 'utilities-terminal-symbolic', category: 'Run', payload: {command: ex.command, shell: c.bool('exec-shell')},
            })];
        }
        // Typing exactly the shared keyword lists every entry that belongs to the launcher itself.
        const own = c.str('own-keyword').trim().toLowerCase();
        if (own && query.trim().toLowerCase() === own && this._ownEntries?.length)
            return this._ownEntries;
        if (c.bool('emoji-enabled') && c.bool('emoji-inline')) {
            const q = inlineEmojiQuery(query);
            if (q !== null)
                return this._emojiSearch(q, c.int('emoji-inline-count'));
        }
        const t0 = GLib.get_monotonic_time();
        const all = c.bool('unlimited-results');

        // "? some words" always searches the web, whatever the settings say.
        const asked = explicitWebQuery(query);
        if (asked !== null)
            return webEntries(this._providers(), asked);

        // Regular expression over names, keywords and descriptions ("/chrom|fire").
        const rx = parseRegexQuery(query, c.str('regex-mode'));
        this._launcher?.setEmptyText(rx?.error ?? 'No results');
        if (rx?.error)
            return [];
        if (rx) {
            return this._engine.searchRegex(rx.re, {
                limit: all ? Infinity : c.int('max-results'),
                descriptions: c.bool('search-descriptions'), frecency: c.bool('frecency'),
            });
        }
        let out = this._engine.search(query, {
            limit: all ? Infinity : c.int('max-results'),
            initial: all ? Infinity : c.int('initial-results'),
            fuzzy: c.bool('fuzzy'),
            descriptions: c.bool('search-descriptions'),
            frecency: c.bool('frecency'),
            recent: c.bool('start-recent') ? {fill: c.bool('start-fill')} : null,
            favorites: c.bool('favorites-enabled') ? this._favoriteIds() : null,
        });
        if (c.bool('calculator')) {
            const value = calculate(query);
            if (value !== null) {
                out = [prepare({
                    id: 'calc:result', kind: 'calc', name: `= ${value}`, desc: `${query.trim()}  ·  Enter copies the result`,
                    icon: 'accessories-calculator-symbolic', category: 'Calculator', payload: {text: value},
                }), ...out];
            }
        }
        if (offerWeb(c.str('web-fallback'), out.length, query))
            out = [...out, ...webEntries(this._providers(), query)];
        dbg(`search "${query}": ${((GLib.get_monotonic_time() - t0) / 1000).toFixed(2)} ms, ${out.length} results of ${this._engine.size}`);
        return out;
    }

    _providers() {
        this._webProviders ??= sanitizeProviders(this._config.json('web-providers', DEFAULT_PROVIDERS));
        return this._webProviders;
    }

    _activateId(id) {
        const e = this._special.get(id);
        if (e)
            this._activate(e);
    }

    _activate(entry, how = '') {
        if (entry.kind !== 'account')
            this._recordSearch(entry);
        switch (entry.kind) {
        case 'account':
            this._useAccount(entry, how);
            return;
        case 'mode':
            // Sub-view: stays open (and opens the launcher first if a global shortcut was used).
            if (!this._launcher.isOpen)
                this._launcher.open();
            this._remember(entry.id);
            if (entry.payload.target === 'emoji')
                this._ensureEmoji();
            this._launcher.enterMode(entry.payload.target, {
                placeholder: entry.payload.placeholder ?? '',
                grid: entry.payload.target === 'emoji' && this._config.str('emoji-layout') === 'grid',
                empty: entry.payload.target === 'emoji' && !this._emojiEngine
                    ? 'Loading emoji…' : (entry.payload.empty ?? 'No results'),
            });
            return;
        case 'emoji':
            this._pickEmoji(entry);
            return;
        case 'web':
            this._launcher.close();
            if (/^https?:\/\//i.test(entry.payload.url))
                openUri(entry.payload.url);
            return;
        case 'clipimage':
            this._useClipImage(entry, how);
            return;
        case 'clipfile':
            this._launcher.close();
            this._clip.useItem(entry.payload.fileId, how);
            return;
        case 'clip':
            this._pasteClip(entry, how);
            return;
        case 'calc':
            this._launcher.close();
            copyText(entry.payload.text);
            this._clip.noteCopied(entry.payload.text);
            return;
        case 'exec':
            // Same path as every other entry: run after the grab is released; no frecency for typed commands.
            this._launcher.close();
            this._pending = entry;
            this._runIdle.schedule();
            return;
        default:
        }
        this._launcher.close();
        this._remember(entry.id);
        // Run after the modal grab is released and the launcher has started closing.
        this._pending = entry;
        this._runIdle.schedule();
    }

    // --- search history ------------------------------------------------------

    _loadHistory() {
        if (!this._config.bool('history-persist'))
            return;
        this._historyStore.load().then(data => {
            if (this._alive && data)
                this._history.merge(data);
        });
    }

    _markHistory() {
        this._historyDirty = true;
        if (this._config.bool('history-persist'))
            this._historySave.call();
    }

    _flushHistory(sync = false) {
        if (!this._historyDirty || !this._history)
            return;
        this._historyDirty = false;
        if (!this._config?.bool('history-persist'))
            return;
        if (sync)
            this._historyStore.saveSync(this._history.toJSON());
        else
            this._historyStore.save(this._history.toJSON());
    }

    // Remembers the text of the search that led to this entry (main search only; nothing typed in the
    // clipboard, emoji or password views). Typed `!commands` are optional.
    _recordSearch(entry) {
        const c = this._config;
        const l = this._launcher;
        if (!c.bool('history-enabled') || !l?.isOpen || l.mode !== null)
            return;
        if (entry.kind === 'exec' && !c.bool('history-commands'))
            return;
        if (this._history.add(l.text))
            this._markHistory();
    }

    // Usage statistics feed both the ranking and the "recently used" start list.
    _remember(id) {
        if (this._config.bool('frecency') || this._config.bool('start-recent'))
            this._stats.hit(id);
    }

    // --- clipboard entries ---------------------------------------------------

    // Enter pastes the entry into the window that had focus before the launcher (or only copies it, if
    // "paste" is switched off). Shift+Enter does the opposite. The text stays on the clipboard afterwards.
    _wantsPaste(how) {
        return this._config.bool('clipboard-paste') !== (how === 'shift');
    }

    _pasteClip(entry, how) {
        const text = entry.payload.text;
        this._launcher.close();
        this._clip.mute(1500); // choosing an entry must not reshuffle the history
        copyText(text);
        if (this._wantsPaste(how))
            this._paster.paste(text, {keys: 'auto', borrow: false}, () => this._pasteFailed());
    }

    // Images go on the clipboard first (a linked file is read asynchronously) and are pasted once they are
    // there. Ctrl+Enter opens the image and Alt+Enter shows its folder instead, as before.
    _useClipImage(entry, how) {
        const open = how === 'ctrl' || how === 'alt';
        this._launcher.close();
        this._clip.mute(2500);
        this._clip.useItem(entry.payload.imageId, open ? how : '',
            !open && this._wantsPaste(how) ? () => this._paster.paste('', {keys: 'auto', borrow: false}, () => this._pasteFailed()) : null);
    }

    // --- favorites -----------------------------------------------------------

    _favoriteList() {
        const list = this._config.json('favorites', []);
        return Array.isArray(list) ? list.filter(x => x && typeof x.id === 'string') : [];
    }

    _favoriteIds() {
        return this._favoriteList().map(x => x.id);
    }

    // Ctrl+D on a result: add it to the favorites, or take it off again. Returns true if it is a favorite now,
    // false if it was removed, null if this kind of entry cannot be a favorite.
    _toggleFavorite(entry) {
        if (!this._config.bool('favorites-enabled'))
            return null;
        if (!HIDEABLE_KINDS.has(entry.kind)) {
            Main.notify(NOTIFY_TITLE, 'This entry cannot be a favorite: it is not a fixed entry.');
            return null;
        }
        const list = this._favoriteList();
        const i = list.findIndex(x => x.id === entry.id);
        if (i >= 0)
            list.splice(i, 1);
        else
            list.push({id: entry.id, name: String(entry.name).slice(0, 120)});
        this._settings.set_string('favorites', JSON.stringify(list));
        return i < 0;
    }

    // --- hiding entries ------------------------------------------------------

    _hiddenSet() {
        const list = this._config.json('hidden-entries', []);
        return new Set(Array.isArray(list) ? list.filter(x => x && typeof x.id === 'string').map(x => x.id) : []);
    }

    // Ctrl+H on a result. Returns true when the entry was hidden. Only entries with a stable id can be hidden
    // (applications, your commands and actions, built-ins); clipboard items, emoji, calculator results and
    // web searches are generated on the fly.
    _hideEntry(entry) {
        if (!HIDEABLE_KINDS.has(entry.kind)) {
            Main.notify(NOTIFY_TITLE, 'This entry cannot be hidden: it is not a fixed entry.');
            return false;
        }
        const list = this._config.json('hidden-entries', []);
        const next = Array.isArray(list) ? list.filter(x => x && typeof x.id === 'string') : [];
        if (!next.some(x => x.id === entry.id))
            next.push({id: entry.id, name: String(entry.name).slice(0, 120)});
        this._settings.set_string('hidden-entries', JSON.stringify(next));
        this._rebuildEntries(); // now, so the launcher shows the shorter list straight away
        return true;
    }

    // --- accounts ------------------------------------------------------------

    // Enter copies the password, Shift+Enter types it into the previous window, Ctrl+Enter copies the
    // username and Alt+Enter opens the site. The password is read from the GNOME Keyring only now,
    // asynchronously (an unlock prompt must not freeze the shell), and is never kept.
    async _useAccount(entry, how) {
        const {accountId, username, url} = entry.payload;
        this._launcher.close();
        if (how === 'ctrl') {
            if (username)
                copyText(username);
            else
                Main.notify(NOTIFY_TITLE, `"${entry.name}" has no username saved.`);
            return;
        }
        if (how === 'alt') {
            if (url)
                openUri(url);
            else
                Main.notify(NOTIFY_TITLE, `"${entry.name}" has no website saved.`);
            return;
        }
        const vault = await openVault();
        if (!vault) {
            Main.notify(NOTIFY_TITLE, 'Saved passwords need libsecret and a keyring (GNOME Keyring). It could not be loaded.');
            return;
        }
        let pw = null;
        try {
            pw = await vault.lookup(accountId);
        } catch (e) {
            warn(`keyring lookup failed: ${e.message}`);
            Main.notify(NOTIFY_TITLE, 'Could not read the keyring. Is it unlocked?');
            return;
        }
        if (!this._alive)
            return;
        if (!pw) {
            Main.notify(NOTIFY_TITLE, `No password is stored for "${entry.name}". Set one in Preferences > Accounts.`);
            return;
        }
        if (how === 'shift')
            this._paster.paste(pw, {keys: 'auto', borrow: true}, () => this._copyPassword(pw));
        else
            this._copyPassword(pw);
    }

    // On the clipboard only for a limited time, and kept out of the clipboard history.
    _copyPassword(pw) {
        this._finishPasswordClear();
        this._clip.mute(1500);
        copyText(pw);
        const secs = clearDelaySeconds(this._config.int('account-clear-seconds'));
        if (secs > 0) {
            const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
                this._pwClear = null;
                this._clip?.mute(1500);
                clearClipboardIf(pw);
                return GLib.SOURCE_REMOVE;
            });
            this._pwClear = {id, pw};
        }
    }

    // Cancels a pending timer and clears right away (used before a new copy and on disable).
    _finishPasswordClear() {
        const p = this._pwClear;
        if (!p)
            return;
        this._pwClear = null;
        GLib.source_remove(p.id);
        this._clip?.mute(1500);
        clearClipboardIf(p.pw);
    }

    // --- emoji ---------------------------------------------------------------

    // The dataset (~130 KB of text) is imported on first use, turned into entries, and dropped
    // again after EMOJI_FREE_MS without use. Returns the engine, or null while it is loading.
    _ensureEmoji() {
        this._emojiFree?.cancel();
        if (this._emojiEngine)
            return this._emojiEngine;
        if (this._emojiLoading)
            return null;
        this._emojiLoading = true;
        import('./emoji/data.js').then(({DATA, GROUPS}) => {
            if (!this._alive)
                return;
            const engine = new SearchEngine();
            engine.setEntries(parseEmoji(DATA, GROUPS).map(prepare));
            this._emojiEngine = engine;
            if (this._launcher?.mode === 'emoji')
                this._launcher.setEmptyText('No emoji found');
            this._launcher?.refresh();
        }).catch(e => {
            warn(`could not load the emoji data: ${e.message}`);
            Main.notify(NOTIFY_TITLE, 'Could not load the emoji data.');
        }).finally(() => {
            this._emojiLoading = false;
        });
        return null;
    }

    _dropEmoji() {
        if (this._launcher?.isOpen)
            return;
        this._emojiEngine = null;
        dbg('emoji data released');
    }

    // The emoji view. In the grid, with nothing typed: a "Recent" section (by last use), then every emoji.
    // Anything else (a search, the list layout, no recent emoji yet) is one plain list.
    _emojiMode(query) {
        const c = this._config;
        if (query.trim() || !c.bool('emoji-recent') || c.str('emoji-layout') !== 'grid')
            return this._emojiSearch(query, Infinity);
        const engine = this._ensureEmoji();
        if (!engine)
            return [];
        const used = [];
        for (const [id, stat] of this._stats.entries()) {
            const e = engine.get(id);
            if (e)
                used.push([stat[1], e]);
        }
        if (used.length === 0)
            return this._emojiSearch(query, Infinity);
        used.sort((a, b) => b[0] - a[0]);
        const recent = used.slice(0, c.int('emoji-recent-count')).map(u => u[1]);
        const all = engine.search('', {fuzzy: false, descriptions: false, frecency: false, natural: true, limit: Infinity, initial: Infinity});
        const out = [...recent, ...all];
        out._sections = [{title: 'Recent', count: recent.length}, {title: 'All emoji', count: all.length}];
        return out;
    }

    _emojiSearch(query, limit) {
        const c = this._config;
        const engine = this._ensureEmoji();
        if (!engine)
            return [];
        const remember = c.bool('emoji-remember');
        engine.stats = remember ? this._stats : null;
        return engine.search(query, {
            fuzzy: false, descriptions: false, frecency: remember, natural: true,
            limit, initial: limit,
        });
    }

    _emojiSettings() {
        const c = this._config;
        return {store: c.str('emoji-store'), paste: c.bool('emoji-paste'), keys: c.str('emoji-paste-keys')};
    }

    _pasteFailed() {
        Main.notify(NOTIFY_TITLE, 'Could not send the paste keys. The text is on the clipboard: paste it manually.');
    }

    _pickEmoji(entry) {
        const char = entry.payload.char;
        const plan = emojiPlan(this._emojiSettings());
        if (this._config.bool('emoji-remember') || this._config.bool('emoji-recent'))
            this._stats.hit(entry.id);
        this._launcher.close();
        if (plan.toBuffer)
            this._buffer = char;
        if (plan.toClipboard)
            copyText(char);
        if (plan.paste)
            this._paster.paste(char, {keys: plan.keys, borrow: plan.borrowClipboard}, () => this._pasteFailed());
    }

    _pasteEmojiBuffer() {
        if (!this._buffer) {
            Main.notify(NOTIFY_TITLE, 'The private emoji buffer is empty. Pick an emoji with "private buffer" selected first.');
            return;
        }
        const {keys} = emojiOptions(this._emojiSettings());
        this._paster.paste(this._buffer, {keys, borrow: true}, () => this._pasteFailed());
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

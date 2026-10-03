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
import {parseEmoji, emojiPlan, emojiOptions, inlineEmojiQuery} from './emoji/emoji.js';
import {Paster} from './emoji/paste.js';
import {Runner, openUri} from './commands/runner.js';
import {buildUserEntries} from './commands/userEntries.js';
import {Config} from './config/config.js';
import {calculate} from './search/calc.js';
import {parseRegexQuery} from './search/regex.js';
import {DEFAULT_PROVIDERS, explicitWebQuery, offerWeb, sanitizeProviders, webEntries} from './search/web.js';
import {SearchEngine, prepare} from './search/engine.js';
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
    'width', 'window-height', 'max-height', 'search-height', 'search-position', 'row-height',
    'icon-size', 'font-size', 'scale', 'padding', 'result-spacing', 'search-padding',
    'icon-spacing', 'show-descriptions', 'show-tags', 'placeholder', 'theme-mode',
    'theme-light', 'theme-dark', 'custom-themes', 'theme-overrides',
    'search-icon', 'search-icon-size', 'show-scrollbar', 'emoji-grid-size',
    'font-search', 'font-size-search', 'font-weight-search', 'font-main', 'font-weight-main',
    'font-secondary', 'font-size-secondary', 'font-weight-secondary', 'emoji-font',
]);

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
        this._runner = new Runner({
            clearClipboard: () => this._clip?.clear(),
            pasteEmojiBuffer: () => this._pasteEmojiBuffer(),
        });
        this._keys = new Keybindings();
        this._clip = new ClipboardHistory(() => this._onClipboardChanged());
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
            onOpen: () => {
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
        this._paster?.destroy(); // puts a borrowed clipboard back
        this._keys?.destroy(); // also resets Mutter's overlay-key if we had taken over Super
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
        case 'clipboard-max':
            this._clip.setMax(this._config.int('clipboard-max'));
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

    _syncClipboard() {
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
        this._engine.setEntries([...this._apps.entries(), ...this._specialEntries]);
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
            return this._emojiSearch(query, Infinity);
        if (mode === 'accounts') {
            return this._accountEngine.search(query, {
                fuzzy: c.bool('fuzzy'), descriptions: true, frecency: false, limit: Infinity, initial: Infinity,
            });
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
        switch (entry.kind) {
        case 'account':
            this._useAccount(entry, how);
            return;
        case 'mode':
            // Sub-view: stays open (and opens the launcher first if a global shortcut was used).
            if (!this._launcher.isOpen)
                this._launcher.open();
            if (this._config.bool('frecency'))
                this._stats.hit(entry.id);
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
            this._launcher.close();
            this._clip.copyImage(entry.payload.imageId);
            return;
        case 'clip':
        case 'calc':
            this._launcher.close();
            copyText(entry.payload.text);
            return;
        default:
        }
        this._launcher.close();
        if (this._config.bool('frecency'))
            this._stats.hit(entry.id);
        // Run after the modal grab is released and the launcher has started closing.
        this._pending = entry;
        this._runIdle.schedule();
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
        if (this._config.bool('emoji-remember'))
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

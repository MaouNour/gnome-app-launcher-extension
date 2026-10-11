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
import {editFile, quitApp} from './applications/launch.js';
import {HIDEABLE_KINDS, menuItems} from './commands/menu.js';
import {FileSearch} from './files/search.js';
import {describeFile, dirName, filterPaths, pickBackend, toTerms} from './files/results.js';
import {buildUserEntries} from './commands/userEntries.js';
import {Config} from './config/config.js';
import {calculate} from './search/calc.js';
import {parseRegexQuery} from './search/regex.js';
import {DEFAULT_PROVIDERS, explicitWebQuery, offerWeb, sanitizeProviders, webEntries} from './search/web.js';
import {SearchEngine, prepare} from './search/engine.js';
import {QueryHistory} from './search/history.js';
import {DEFAULT_MAPS, compileMaps, translateQuery} from './search/layout.js';
import {activeColor} from './ui/accent.js';
import {Keybindings} from './shortcuts/keybindings.js';
import {FocusBlock} from './shortcuts/focusBlock.js';
import {Launcher} from './ui/launcher.js';
import {styleInputs} from './ui/styleInputs.js';
import {Debounce, Idle} from './utils/timing.js';
import {setDebug, dbg, warn} from './utils/log.js';

const NOTIFY_TITLE = 'GNOME Launcher';
const SHORTCUT_KEY = 'gnome-launcher-toggle';

const STYLE_KEYS = new Set([
    'shadow-enabled', 'active-indicator', 'active-accent', 'active-color',
    'active-position', 'search-ring', 'search-ring-color', 'search-ring-width',
    'active-size', 'active-color-selected', 'active-color-selected-custom',
    'width', 'window-height', 'max-height', 'search-height', 'search-position', 'row-height',
    'icon-size', 'font-size', 'scale', 'padding', 'result-spacing', 'search-padding',
    'icon-spacing', 'show-descriptions', 'show-tags', 'placeholder', 'theme-mode',
    'theme-light', 'theme-dark', 'custom-themes', 'theme-overrides',
    'search-icon', 'search-icon-size', 'show-scrollbar', 'emoji-grid-size',
    'font-search', 'font-size-search', 'font-weight-search', 'font-main', 'font-weight-main',
    'font-secondary', 'font-size-secondary', 'font-weight-secondary', 'emoji-font',
]);

const EMOJI_FREE_MS = 60000;

export default class GnomeLauncherExtension extends Extension {
    enable() {
        this._alive = true;
        this._settings = this.getSettings();
        const cfg = this._config = new Config(this._settings);
        setDebug(cfg.bool('debug'));

        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-launcher']);
        const stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'gnome-launcher']);

        this._special = new Map();
        this._specialEntries = [];
        this._pending = null;

        this._engine = new SearchEngine();
        this._clipEngine = new SearchEngine();
        this._emojiEngine = null;
        this._emojiLoading = false;
        this._accountEngine = new SearchEngine();
        this._pwClear = null;
        this._buffer = '';
        this._stats = new Stats(new JsonStore(GLib.build_filenamev([stateDir, 'stats.json']), 1));
        this._engine.stats = this._stats;
        this._files = new FileSearch();
        this._filesFor = '';
        this._filesWait = new Debounce(250, () => this._runFiles());
        this._menuTarget = null;
        this._history = new QueryHistory(cfg.int('history-max'));
        this._historyStore = new JsonStore(GLib.build_filenamev([stateDir, 'history.json']), 1, {private: true});
        this._historyDirty = false;
        this._historySave = new Debounce(1500, () => this._flushHistory());
        this._runner = new Runner({
            clearClipboard: () => this._clip?.clear(),
            pasteEmojiBuffer: () => this._pasteEmojiBuffer(),
            openPrefs: () => this.openPreferences(),
            saveClipboard: () => this._clip?.captureNow(),
        });
        this._keys = new Keybindings();
        this._focus = new FocusBlock(this._keys);
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
        this._accentId = this._iface.settings_schema.has_key('accent-color')
            ? this._iface.connect('changed::accent-color', () => this._restyle.call()) : 0;

        this._apps = new AppIndex(new JsonStore(GLib.build_filenamev([cacheDir, 'apps.json']), 1),
            () => this._rebuild.schedule());
        this._apps.setPersist(cfg.bool('persist-cache'));

        this._launcher = new Launcher({
            config: cfg,
            search: (q, mode) => this._search(q, mode),
            onActivate: (e, how) => this._activate(e, how),
            onWindowShortcut: id => this._activateId(id),
            onClose: () => {
                this._filesWait.cancel();
                this._files.cancel();
                this._filesFor = '';
                this._menuTarget = null;
                if (this._emojiEngine)
                    this._emojiFree?.call();
            },
            onMenu: entry => this._menuInfo(entry),
            getStyle: () => this._styleInputs(),
            // Only does work before the cache has arrived; afterwards it is a no-op.
            history: this._history,
            favorites: () => (this._config.bool('favorites-enabled') ? this._favoriteIds() : []),
            running: () => Shell.AppSystem.get_default().get_running().map(a => a.get_id()),
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
        this._finishPasswordClear();
        this._focus?.destroy();
        this._filesWait?.cancel();
        this._files?.destroy();
        this._historySave?.cancel();
        this._flushHistory(true);
        this._historyStore?.cancel();
        this._paster?.destroy();
        this._keys?.destroy();
        this._launcher?.destroy();
        this._clip?.destroy();
        this._apps?.destroy();
        this._stats?.destroy();
        if (this._ifaceId)
            this._iface.disconnect(this._ifaceId);
        if (this._accentId)
            this._iface.disconnect(this._accentId);
        this._config?.destroy();
        this._configHandlers = null;
        this._prebuild = this._restyle = this._rebuild = this._runIdle = this._emojiFree = null;
        this._paster = this._emojiEngine = this._buffer = null;
        this._focus = this._keys = this._launcher = this._clip = this._apps = this._stats = null;
        this._engine = this._clipEngine = this._runner = null;
        this._iface = this._ifaceId = this._config = this._settings = null;
        this._special = this._specialEntries = this._pending = null;
        dbg('disabled');
    }

    _onConfigChanged(key) {
        this._configHandlers ??= this._buildConfigHandlers();
        const run = this._configHandlers.get(key);
        if (run)
            run();
        else if (STYLE_KEYS.has(key))
            this._restyle.call();
    }

    _buildConfigHandlers() {
        const c = this._config;
        const refresh = () => this._launcher?.refreshResults();
        const resetFiles = () => {
            this._files.cancel();
            this._filesFor = '';
            refresh();
        };
        const table = [
            [['use-super-key'], () => this._keys.setSuperKey(c.bool('use-super-key'), () => this._launcher.toggle())],
            [['blocklist', 'block-fullscreen'], () => this._syncBlocklist()],
            [['commands', 'actions', 'category-icons', 'builtins', 'emoji-enabled', 'accounts-enabled', 'own-keyword'], () => this._buildSpecial()],
            [['clipboard-enabled'], () => {
                this._syncClipboard();
                this._buildSpecial();
            }],
            [['accounts'], () => this._syncAccounts()],
            [['web-providers'], () => (this._webProviders = null)],
            [['layout-maps'], () => {
                this._layoutMaps = null;
                refresh();
            }],
            [['layout-map-enabled', 'favorites', 'favorites-enabled'], refresh],
            [['clipboard-images', 'clipboard-image-count', 'clipboard-image-mb'], () => this._syncClipboardImages()],
            [['clipboard-source', 'clipboard-persist', 'clipboard-dir', 'clipboard-link-files', 'clipboard-screenshot-dir',
                'clipboard-videos', 'clipboard-video-dir'], () => this._syncClipboardOptions()],
            [['clipboard-max'], () => this._clip.setMax(c.int('clipboard-max'))],
            [['hidden-entries'], () => this._rebuild.schedule()],
            [['files-enabled', 'files-backend', 'files-min-chars', 'files-max', 'files-hidden', 'files-outside-home'], resetFiles],
            [['history-max'], () => {
                if (this._history.setMax(c.int('history-max')))
                    this._markHistory();
            }],
            [['history-persist'], () => {
                if (c.bool('history-persist'))
                    this._markHistory();
                else
                    this._historyStore.remove();
            }],
            [['history-generation'], () => {
                this._history.clear();
                this._historyDirty = false;
                this._historyStore.remove();
            }],
            [['debug'], () => setDebug(c.bool('debug'))],
            [['persist-cache'], () => this._apps.setPersist(c.bool('persist-cache'))],
            [['cache-generation'], () => this._apps.rebuild()],
            [['stats-generation'], () => {
                this._stats.reset();
                this._rebuild.schedule();
            }],
        ];
        return new Map(table.flatMap(([keys, fn]) => keys.map(k => [k, fn])));
    }

    _bindShortcuts() {
        if (!this._keys.setMain(this._settings, SHORTCUT_KEY, () => this._launcher.toggle()))
            Main.notify(NOTIFY_TITLE, 'Could not register the launcher shortcut. See: journalctl -o cat /usr/bin/gnome-shell | grep gnome-launcher');
        this._keys.setSuperKey(this._config.bool('use-super-key'), () => this._launcher.toggle());
    }

    _syncBlocklist() {
        this._focus.configure(this._config.strv('blocklist'), this._config.bool('block-fullscreen'));
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

    _isDark() {
        const mode = this._config.str('theme-mode');
        if (mode === 'dark')
            return true;
        if (mode === 'light')
            return false;
        return this._iface.get_string('color-scheme') === 'prefer-dark';
    }

    _activeColor(themeAccent, modeKey = 'active-accent', colorKey = 'active-color') {
        const c = this._config;
        let system = null;
        try {
            if (this._iface?.settings_schema.has_key('accent-color'))
                system = this._iface.get_string('accent-color');
        } catch (_e) { /* an older GNOME has no accent colour */ }
        return activeColor({mode: c.str(modeKey), custom: c.str(colorKey), system, theme: themeAccent});
    }

    _styleInputs() {
        return styleInputs(this._config, this._isDark(), (theme, modeKey, colorKey) => this._activeColor(theme, modeKey, colorKey));
    }

    _search(query, mode) {
        const c = this._config;
        if (mode === 'clipboard') {
            if (!query.trim())
                return this._clip.entries();
            return this._clipEngine.search(query, {limit: c.bool('unlimited-results') ? Infinity : c.int('max-results'), frecency: false});
        }
        if (mode === 'actions')
            return this._menuSearch(query);
        if (mode === 'emoji')
            return this._emojiMode(query);
        if (mode === 'accounts') {
            return this._accountEngine.search(query, {
                fuzzy: c.bool('fuzzy'), descriptions: true, frecency: false, limit: Infinity, initial: Infinity,
            });
        }
        const typed = query;
        if (c.bool('layout-map-enabled') && explicitWebQuery(query) === null)
            query = this._fromLayout(query);

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
        this._wantFiles(typed, query);
        if (offerWeb(c.str('web-fallback'), out.length, query))
            out = [...out, ...webEntries(this._providers(), typed)];
        dbg(`search "${query}": ${((GLib.get_monotonic_time() - t0) / 1000).toFixed(2)} ms, ${out.length} results of ${this._engine.size}`);
        return out;
    }

    _fromLayout(query) {
        this._layoutMaps ??= compileMaps(this._config.json('layout-maps', DEFAULT_MAPS));
        const r = translateQuery(query, this._layoutMaps);
        if (!r)
            return query;
        dbg(`layout map "${r.name}": "${query}" -> "${r.text}"`);
        return r.text;
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
        this._runQuery = this._launcher.isOpen ? this._launcher.text : '';
        if (entry.kind !== 'account' && entry.kind !== 'menu')
            this._recordSearch(entry);
        switch (entry.kind) {
        case 'menu':
            this._runMenu(entry);
            return;
        case 'file':
            this._openFile(entry, how);
            return;
        case 'account':
            this._useAccount(entry, how);
            return;
        case 'mode':
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
            this._launcher.close();
            this._pending = entry;
            this._runIdle.schedule();
            return;
        default:
        }
        this._launcher.close();
        this._remember(entry.id);
        this._pending = entry;
        this._runIdle.schedule();
    }

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

    _remember(id) {
        if (this._config.bool('frecency') || this._config.bool('start-recent'))
            this._stats.hit(id);
    }

    _wantsPaste(how) {
        return this._config.bool('clipboard-paste') !== (how === 'shift');
    }

    _pasteClip(entry, how) {
        const text = entry.payload.text;
        this._launcher.close();
        this._clip.mute(1500);
        copyText(text);
        if (this._wantsPaste(how))
            this._paster.paste(text, {keys: 'auto', borrow: false}, () => this._pasteFailed());
    }

    _useClipImage(entry, how) {
        const open = how === 'ctrl' || how === 'alt';
        this._launcher.close();
        this._clip.mute(2500);
        this._clip.useItem(entry.payload.imageId, open ? how : '',
            !open && this._wantsPaste(how) ? () => this._paster.paste('', {keys: 'auto', borrow: false}, () => this._pasteFailed()) : null);
    }

    _wantFiles(typed, query) {
        const c = this._config;
        const q = typed.trim();
        if (!c.bool('files-enabled') || q.length < c.int('files-min-chars')) {
            if (this._filesFor) {
                this._filesWait.cancel();
                this._files.cancel();
                this._filesFor = '';
            }
            return;
        }
        if (this._filesFor === q)
            return;
        this._filesFor = q;
        this._filesText = query.trim();
        this._files.cancel();
        this._filesWait.call();
    }

    async _runFiles() {
        const c = this._config;
        const query = this._filesFor;
        if (!query || !this._launcher?.isOpen)
            return;
        const avail = this._files.available();
        const backend = pickBackend(c.str('files-backend'), avail);
        if (!backend) {
            this._launcher.setEmptyText('File search is on but no backend is available (GNOME search or locate)');
            return;
        }
        const terms = toTerms(this._filesText || query);
        const order = c.str('files-backend') === 'auto' && backend === 'gnome' && avail.locate ? ['gnome', 'locate'] : [backend];
        let paths = null;
        for (const b of order) {
            try {
                paths = await this._files.search(b, terms);
            } catch (e) {
                warn(`file search (${b}) failed: ${e.message}`);
                paths = [];
            }
            dbg(`file search (${b}) "${terms.join(' ')}": ${paths ? paths.length : 'replaced'} paths`);
            if (!paths || !this._alive || this._filesFor !== query)
                return;
            if (paths.length)
                break;
        }
        const home = GLib.get_home_dir();
        const kept = filterPaths(paths, {home, hidden: c.bool('files-hidden'), outsideHome: c.bool('files-outside-home'), max: c.int('files-max')});
        const entries = kept.map(path => this._fileEntry(path, home));
        this._launcher.addAsyncResults(query, entries);
    }

    _fileEntry(path, home) {
        const d = describeFile(path, home);
        const e = prepare({id: `file:${path}`, kind: 'file', name: d.name, desc: d.desc, keywords: d.keywords, category: 'Files', icon: 'text-x-generic', payload: {path, uri: Gio.File.new_for_path(path).get_uri()}});
        try {
            e._gi = Gio.content_type_get_icon(Gio.content_type_guess(d.name, null)[0]);
        } catch (_e) { /* the generic icon stays */ }
        return e;
    }

    _openFile(entry, how) {
        this._launcher.close();
        const p = entry.payload;
        if (how === 'alt') {
            openUri(Gio.File.new_for_path(dirName(p.path)).get_uri());
        } else if (how === 'ctrl') {
            copyText(p.path);
        } else {
            this._pending = entry;
            this._runIdle.schedule();
        }
    }

    _menuInfo(entry) {
        const items = this._menuItems(entry);
        if (!items.length) {
            Main.notify(NOTIFY_TITLE, 'There are no actions for this entry.');
            return null;
        }
        this._menuTarget = entry;
        this._menuList = items;
        return {placeholder: `Actions for ${entry.name}`};
    }

    _menuItems(e) {
        const stable = HIDEABLE_KINDS.has(e.kind);
        return menuItems(e, {
            favorites: stable && this._config.bool('favorites-enabled'),
            isFavorite: this._favoriteIds().includes(e.id),
            hasUsage: stable && !!this._stats.get(e.id),
        });
    }

    _menuSearch(query) {
        const items = this._menuList ?? [];
        const q = query.trim().toLowerCase();
        return q ? items.filter(i => i.name.toLowerCase().includes(q) || (i.desc ?? '').toLowerCase().includes(q)) : items;
    }

    _runMenu(entry) {
        const p = entry.payload;
        const target = this._menuTarget;
        if (!target)
            return;
        const L = this._launcher;
        const runLater = (kind, payload) => {
            L.close();
            this._pending = {id: target.id, kind, name: target.name, payload};
            this._runIdle.schedule();
        };
        switch (p.op) {
        case 'open':
            L.leaveMenu();
            this._activate(target);
            break;
        case 'newWindow':
            this._remember(target.id);
            runLater('app', {appId: target.payload.appId, newWindow: true});
            break;
        case 'newWorkspace':
            try {
                global.workspace_manager.append_new_workspace(true, global.get_current_time());
            } catch (e) {
                warn(`could not add a workspace: ${e.message}`);
            }
            this._remember(target.id);
            runLater('app', {appId: target.payload.appId, newWindow: true});
            break;
        case 'appaction':
            this._remember(target.id);
            runLater('appaction', {appId: target.payload.appId, action: p.action});
            break;
        case 'quit':
            L.close();
            quitApp(target.payload.appId);
            break;
        case 'showDir':
            L.close();
            openUri(Gio.File.new_for_path(dirName(p.path)).get_uri());
            break;
        case 'editDesktop':
            L.close();
            try {
                editFile(p.path);
            } catch (e) {
                Main.notify(NOTIFY_TITLE, `Could not open ${p.path}: ${e.message}`);
            }
            break;
        case 'copy':
            L.close();
            copyText(p.text);
            break;
        case 'prefs':
            L.close();
            this.openPreferences();
            break;
        case 'favorite':
            this._toggleFavorite(target);
            L.leaveMenu();
            break;
        case 'hide':
            this._hideEntry(target);
            L.leaveMenu();
            break;
        case 'forget':
            this._stats.forget(target.id);
            L.leaveMenu();
            L.refreshResults();
            break;
        default:
        }
    }

    _idList(key) {
        const list = this._config.json(key, []);
        return Array.isArray(list) ? list.filter(x => x && typeof x.id === 'string') : [];
    }

    _favoriteIds() {
        return this._idList('favorites').map(x => x.id);
    }

    _toggleFavorite(entry) {
        if (!this._config.bool('favorites-enabled'))
            return null;
        if (!HIDEABLE_KINDS.has(entry.kind)) {
            Main.notify(NOTIFY_TITLE, 'This entry cannot be a favorite: it is not a fixed entry.');
            return null;
        }
        const list = this._idList('favorites');
        const i = list.findIndex(x => x.id === entry.id);
        if (i >= 0)
            list.splice(i, 1);
        else
            list.push({id: entry.id, name: String(entry.name).slice(0, 120)});
        this._settings.set_string('favorites', JSON.stringify(list));
        return i < 0;
    }

    _hiddenSet() {
        return new Set(this._idList('hidden-entries').map(x => x.id));
    }

    _hideEntry(entry) {
        if (!HIDEABLE_KINDS.has(entry.kind)) {
            Main.notify(NOTIFY_TITLE, 'This entry cannot be hidden: it is not a fixed entry.');
            return false;
        }
        const next = this._idList('hidden-entries');
        if (!next.some(x => x.id === entry.id))
            next.push({id: entry.id, name: String(entry.name).slice(0, 120)});
        this._settings.set_string('hidden-entries', JSON.stringify(next));
        this._rebuildEntries();
        return true;
    }

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

    _finishPasswordClear() {
        const p = this._pwClear;
        if (!p)
            return;
        this._pwClear = null;
        GLib.source_remove(p.id);
        this._clip?.mute(1500);
        clearClipboardIf(p.pw);
    }

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
            this._runner.run(entry, {query: this._runQuery ?? ''});
        } catch (e) {
            warn(`failed to run ${entry.id}: ${e.message}`);
            Main.notify(NOTIFY_TITLE, `Could not run "${entry.name}": ${e.message}`);
            // A missing application means the index is stale: reconcile it.
            if (entry.kind === 'app')
                this._apps.refresh();
        }
    }
}

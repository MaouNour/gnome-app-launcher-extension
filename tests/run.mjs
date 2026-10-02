// Unit tests for the pure modules:  node tests/run.mjs
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {SearchEngine, prepare, fold, frecency} from '../search/engine.js';
import {sanitizeTheme, resolveTheme, builtinThemes, cssColor, THEME_FAMILIES} from '../themes/themes.js';
import {sanitizeCommand, sanitizeAction, validateCommand, validateAction} from '../commands/schema.js';
import {buildUserEntries} from '../commands/userEntries.js';
import {calculate} from '../search/calc.js';
import {BUILTINS, buildBuiltinEntries, sanitizeBuiltins} from '../commands/builtins.js';
import {DATA as EMOJI_DATA, GROUPS as EMOJI_GROUPS} from '../emoji/data.js';
import {parseEmoji, emojiOptions, emojiPlan, inlineEmojiQuery, isTerminalClass, resolvePasteKeys} from '../emoji/emoji.js';

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok   ${name}`);
    } catch (e) {
        console.error(`FAIL ${name}\n${e.stack}`);
        process.exitCode = 1;
    }
}
const mk = (id, name, extra = {}) => prepare({id, kind: 'app', name, category: 'Applications', ...extra});

const apps = [
    mk('a', 'Firefox', {desc: 'Web Browser', keywords: 'internet browser'}),
    mk('b', 'Files', {desc: 'Access and organize files'}),
    mk('c', 'Visual Studio Code', {desc: 'Code editing'}),
    mk('d', 'Éditeur de texte', {desc: 'Edit text'}),
    mk('e', 'Terminal', {desc: 'Use the command line', keywords: 'shell console'}),
    mk('f', 'GNOME Settings', {desc: 'System settings'}),
];
const eng = new SearchEngine();
eng.setEntries(apps);
const ids = (q, o, e = eng) => e.search(q, o).map(x => x.id);

// --- search ---------------------------------------------------------------
test('exact name ranks first', () => assert.equal(ids('firefox')[0], 'a'));
test('shorter prefix match ranks first', () => assert.deepEqual(ids('fi').slice(0, 2), ['b', 'a']));
test('prefix beats substring', () => {
    const e = new SearchEngine();
    e.setEntries([mk('1', 'Xfoo'), mk('2', 'Foobar')]);
    assert.deepEqual(ids('foo', {}, e), ['2', '1']);
});
test('initials match', () => assert.equal(ids('vsc')[0], 'c'));
test('word prefix match', () => assert.equal(ids('studio')[0], 'c'));
test('diacritics folded', () => assert.equal(ids('editeur')[0], 'd'));
test('keyword match', () => assert.equal(ids('console')[0], 'e'));
test('fuzzy subsequence', () => assert.ok(ids('ffx').includes('a')));
test('fuzzy can be disabled', () => assert.deepEqual(ids('ffx', {fuzzy: false}), []));
test('multi-token AND', () => assert.deepEqual(ids('gnome set'), ['f']));
test('no match gives empty', () => assert.deepEqual(ids('zzzz'), []));
test('one-letter query matches names only (no category noise)', () => assert.deepEqual(ids('c'), ['c']));
test('description match needs 3+ chars', () => {
    assert.ok(ids('organize').includes('b'));
    assert.deepEqual(ids('or'), []);
});
test('incremental narrowing equals a full scan', () => {
    const e2 = new SearchEngine();
    e2.setEntries(apps);
    for (const q of ['t', 'te', 'ter', 'term'])
        e2.search(q);
    const narrowed = ids('termi', {}, e2);
    const e3 = new SearchEngine();
    e3.setEntries(apps);
    assert.deepEqual(narrowed, ids('termi', {}, e3));
});
test('shortening the query rescans fully', () => {
    const e2 = new SearchEngine();
    e2.setEntries(apps);
    e2.search('firefox');
    assert.ok(e2.search('fi').length >= 2);
});
test('frecency boosts used entries', () => {
    const e2 = new SearchEngine();
    e2.setEntries(apps);
    const m = new Map([['a', [50, Math.floor(Date.now() / 1000)]]]);
    e2.stats = {get: id => m.get(id), entries: () => m.entries()};
    assert.equal(e2.search('')[0].id, 'a');
    assert.equal(ids('fi', {}, e2)[0], 'a'); // Firefox overtakes Files once heavily used
});
test('frecency decays with age', () => {
    const now = 1e9;
    assert.ok(frecency([10, now], now) > frecency([10, now - 90 * 86400], now));
    assert.equal(frecency(undefined, now), 0);
});
test('empty query gives alphabetical fill', () => assert.equal(eng.search('', {initial: 3}).length, 3));
test('limit respected', () => assert.equal(eng.search('e', {limit: 2}).length, 2));
test('fold lowercases and strips accents', () => assert.equal(fold('ÉCOLE'), 'ecole'));

// --- themes ---------------------------------------------------------------
test('theme sanitizer blocks CSS injection', () => {
    const t = sanitizeTheme({background: 'red;}x{', fontFamily: 'a;}', radius: 1e9, opacity: -5});
    assert.equal(t.background, '#242424');
    assert.equal(t.fontFamily, '');
    assert.equal(t.radius, 60);
    assert.equal(t.opacity, 0);
});
test('theme overrides applied', () => assert.equal(resolveTheme({custom: [], name: 'nord', dark: true, overrides: {blur: 20}}).blur, 20));
test('unknown theme falls back', () => assert.equal(resolveTheme({custom: [], name: 'nope', dark: true}).name, 'default-dark'));
test('custom theme resolved', () => assert.equal(resolveTheme({custom: [{name: 'mine', accent: '#ff0000'}], name: 'mine', dark: true}).accent, '#ff0000'));
test('cssColor alpha', () => assert.equal(cssColor('#000000', 0.5), 'rgba(0,0,0,0.5)'));
test('built-in themes present', () => assert.equal(Object.keys(builtinThemes()).length, 9));
test('raycast and vicinae presets exist in light and dark and survive sanitising', () => {
    const all = builtinThemes();
    for (const n of ['raycast-dark', 'raycast-light', 'vicinae-dark', 'vicinae-light']) {
        assert.ok(all[n], n);
        assert.deepEqual(sanitizeTheme(all[n], all[n]), all[n], `${n} must be valid as written`);
    }
    assert.equal(all['raycast-dark'].accent, '#ff6363');
});
test('theme families only reference existing themes', () => {
    const all = builtinThemes();
    for (const [fam, [light, dark]] of Object.entries(THEME_FAMILIES))
        assert.ok(all[light] && all[dark], fam);
});

// --- commands / actions ---------------------------------------------------
test('valid command builds an entry with shortcut', () => {
    const r = buildUserEntries([{id: '1', name: 'Terminal', command: 'kgx', icon: 'utilities-terminal', shortcut: '<Control><Alt>t'}], [], {});
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].kind, 'command');
    assert.deepEqual(r.shortcuts, [{id: 'command:1', accel: '<Control><Alt>t'}]);
});
test('disabled command is skipped', () => assert.equal(buildUserEntries([{id: '1', name: 'X', command: 'x', enabled: false}], [], {}).entries.length, 0));
test('broken command is reported, not thrown', () => {
    const r = buildUserEntries([{id: '1', name: '', command: ''}, 'garbage', null, 42], [], {});
    assert.equal(r.entries.length, 0);
    assert.ok(r.problems.length >= 1);
});
test('url action validates scheme', () => {
    assert.equal(validateAction(sanitizeAction({name: 'x', type: 'url', target: 'javascript:alert(1)'})), 'URL must start with http://, https://, ftp:// or mailto:');
    assert.equal(validateAction(sanitizeAction({name: 'x', type: 'url', target: 'https://example.com'})), '');
});
test('unknown gnome action rejected', () => assert.ok(validateAction(sanitizeAction({name: 'x', type: 'gnome', target: 'rm-rf'}))));
test('invalid JSON shapes do not throw', () => {
    const r = buildUserEntries('nope', {a: 1}, null);
    assert.equal(r.entries.length, 0);
});
test('category default icon applied', () => {
    const r = buildUserEntries([{id: '1', name: 'A', command: 'a', category: 'Work'}], [], {Work: 'folder'});
    assert.equal(r.entries[0].icon, 'folder');
});
test('duplicate ids reported', () => {
    const r = buildUserEntries([{id: '1', name: 'A', command: 'a'}, {id: '1', name: 'B', command: 'b'}], [], {});
    assert.equal(r.entries.length, 1);
    assert.equal(r.problems.length, 1);
});
test('sanitizers strip control characters and cap length', () => {
    const c = sanitizeCommand({name: `a\u0000b${'x'.repeat(2000)}`, command: 'c'});
    assert.ok(!c.name.includes('\u0000'));
    assert.ok(c.name.length <= 512);
});


// --- calculator -------------------------------------------------------------
test('calculator basics', () => {
    assert.equal(calculate('2+3*4'), '14');
    assert.equal(calculate('(1+2)^2'), '9');
    assert.equal(calculate('10/4'), '2.5');
    assert.equal(calculate('-2^2'), '-4');
    assert.equal(calculate('2^-1'), '0.5');
    assert.equal(calculate('1,5+1'), '2.5');
    assert.equal(calculate('0.1+0.2'), '0.3');
    assert.equal(calculate('7 % 4 + 2 × 3'), '9');
});
test('calculator rejects non-math and unsafe input', () => {
    for (const bad of ['firefox', '5', '-5', '1/0', '2+', '(1+2', '1+2)', 'process.exit()', '2**3x', '', '1+'.repeat(200)])
        assert.equal(calculate(bad), null, `should reject ${JSON.stringify(bad).slice(0, 30)}`);
});

// --- built-in entries -------------------------------------------------------
test('built-ins include power and clipboard entries', () => {
    const ids = BUILTINS.map(b => b.id);
    for (const id of ['power-off', 'reboot', 'logout', 'suspend', 'lock-screen', 'clipboard', 'clear-clipboard'])
        assert.ok(ids.includes(id), id);
});
test('built-ins respect enable flags and clipboard switch', () => {
    const all = buildBuiltinEntries({}, {clipboard: true, emoji: true});
    assert.equal(all.entries.length, BUILTINS.length);
    assert.ok(all.entries.every(e => e.id.startsWith('system:') && ['system', 'mode'].includes(e.kind)));
    assert.ok(!buildBuiltinEntries({}, {clipboard: false}).entries.some(e => e.category === 'Clipboard'));
    assert.ok(!buildBuiltinEntries({'power-off': {enabled: false}}, {clipboard: true}).entries.some(e => e.id === 'system:power-off'));
});
test('built-in shortcuts: global and window-only are kept apart', () => {
    const r = buildBuiltinEntries({reboot: {shortcut: '<Control><Alt>r', windowShortcut: '<Control>r'}}, {clipboard: false});
    assert.deepEqual(r.shortcuts, [{id: 'system:reboot', accel: '<Control><Alt>r'}]);
    assert.deepEqual(r.windowShortcuts, [{id: 'system:reboot', accel: '<Control>r'}]);
});
test('built-in overrides are sanitized', () => {
    assert.deepEqual(sanitizeBuiltins('x'), {});
    assert.deepEqual(sanitizeBuiltins({nope: {enabled: false}, reboot: {enabled: 'yes', shortcut: 5}}), {});
});
test('built-ins are searchable (shutdown/restart/clipboard)', () => {
    const e = new SearchEngine();
    e.setEntries(buildBuiltinEntries({}, {clipboard: true}).entries);
    assert.equal(e.search('shutdown')[0].id, 'system:power-off');
    assert.equal(e.search('reboot')[0].id, 'system:reboot');
    assert.equal(e.search('clip')[0].id, 'system:clipboard');
});
test('window shortcuts are collected for commands and actions', () => {
    const r = buildUserEntries([{id: '1', name: 'A', command: 'a', windowShortcut: '<Control>1'}],
        [{id: '2', name: 'B', type: 'url', target: 'https://x.org', windowShortcut: '<Alt>2'}], {});
    assert.deepEqual(r.windowShortcuts.map(w => w.accel), ['<Control>1', '<Alt>2']);
    assert.deepEqual(r.shortcuts, []);
});
test('new GNOME actions accepted for user actions', () => {
    for (const t of ['reboot', 'toggle-dark-mode', 'toggle-dnd'])
        assert.equal(validateAction(sanitizeAction({name: 'x', type: 'gnome', target: t})), '');
    assert.ok(validateAction(sanitizeAction({name: 'x', type: 'gnome', target: 'clear-clipboard'})));
});

// --- static checks on the Shell-facing code ---------------------------------
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function jsFiles(dir) {
    return readdirSync(dir).flatMap(n => {
        const p = join(dir, n);
        if (n === 'tests' || n === 'tools')
            return [];
        return statSync(p).isDirectory() ? jsFiles(p) : (p.endsWith('.js') ? [p] : []);
    });
}
// Named imports from Shell resource modules fail at load time if the export is moved or
// removed between versions (this once broke the launcher). Only these are allowed.
const SAFE_NAMED = new Set(['Extension', 'ExtensionPreferences']);
// ---- emoji ----------------------------------------------------------------------------------
const emojiEntries = parseEmoji(EMOJI_DATA, EMOJI_GROUPS).map(prepare);
const emojiEngine = () => {
    const e = new SearchEngine();
    e.setEntries(emojiEntries);
    return e;
};
const eopts = {fuzzy: false, descriptions: false, frecency: false, limit: Infinity, initial: Infinity, natural: true};

test('emoji dataset parses into well-formed entries', () => {
    assert.ok(emojiEntries.length > 1800, `only ${emojiEntries.length}`);
    assert.equal(emojiEntries[0].glyph, '😀');
    assert.equal(new Set(emojiEntries.map(e => e.id)).size, emojiEntries.length, 'duplicate ids');
    for (const e of emojiEntries) {
        assert.ok(e.glyph && e.name && e.kind === 'emoji' && e.payload.char === e.glyph);
        assert.ok(!/[\t\n]/.test(e.name));
    }
});
test('emoji search finds the obvious ones, by name, keyword and shortcode', () => {
    const eng = emojiEngine();
    const top = (q, n = 10) => eng.search(q, {...eopts, limit: n}).map(e => e.glyph);
    assert.ok(top('smile', 60).includes('😄'));
    assert.ok(top('smiling', 5).length === 5);
    assert.ok(top('red heart').includes('❤️'));
    assert.ok(top('thumbsup').some(g => g.startsWith('👍')), 'github shortcode');
    assert.ok(top('rocket').some(g => g.startsWith('🚀')));
    assert.ok(top('flag france', 5).includes('🇫🇷'));
    assert.ok(top('zzzzqq').length === 0);
});
test('emoji empty query keeps Unicode order and can return everything', () => {
    const eng = emojiEngine();
    const all = eng.search('', eopts);
    assert.equal(all.length, emojiEntries.length);
    assert.equal(all[0].glyph, '😀');
    assert.equal(eng.search('', {...eopts, initial: 5}).length, 5);
});
test('unlimited limit returns every match; finite limit still caps', () => {
    const eng = emojiEngine();
    const many = eng.search('face', {...eopts, limit: Infinity});
    assert.ok(many.length > 100);
    assert.equal(eng.search('face', {...eopts, limit: 7}).length, 7);
});
test('emoji search over the whole dataset is fast', () => {
    const eng = emojiEngine();
    const t0 = performance.now();
    for (const q of ['s', 'sm', 'smi', 'smil', 'smile', 'heart', 'cat', 'flag'])
        eng.search(q, {...eopts, limit: 60});
    const per = (performance.now() - t0) / 8;
    assert.ok(per < 15, `${per.toFixed(2)} ms per search`);
});
test('emoji frecency floats used emoji to the top of the empty list', () => {
    const eng = emojiEngine();
    const rocket = emojiEntries.find(e => e.glyph === '🚀');
    eng.stats = {get: id => (id === rocket.id ? [5, Math.floor(Date.now() / 1000)] : undefined),
        entries: () => [[rocket.id, [5, Math.floor(Date.now() / 1000)]]]};
    const list = eng.search('', {...eopts, frecency: true, initial: 3});
    assert.equal(list[0].glyph, '🚀');
    assert.equal(list[1].glyph, '😀');
});
test('emojiOptions validates and never produces a do-nothing combination', () => {
    assert.deepEqual(emojiOptions({store: 'buffer', paste: true, keys: 'ctrl-v'}), {store: 'buffer', paste: true, keys: 'ctrl-v'});
    assert.deepEqual(emojiOptions({store: 'nope', paste: 'yes', keys: 'zzz'}), {store: 'clipboard', paste: false, keys: 'auto'});
    assert.equal(emojiOptions({store: 'none', paste: false, keys: 'auto'}).store, 'clipboard');
    assert.equal(emojiOptions({store: 'none', paste: true, keys: 'auto'}).store, 'none');
});
test('emojiPlan: clipboard is only borrowed when pasting without copying to it', () => {
    const plan = (store, paste) => emojiPlan({store, paste, keys: 'auto'});
    assert.deepEqual([plan('clipboard', false).toClipboard, plan('clipboard', false).paste], [true, false]);
    assert.equal(plan('clipboard', true).borrowClipboard, false);
    assert.equal(plan('both', true).borrowClipboard, false);
    assert.equal(plan('buffer', true).borrowClipboard, true);
    assert.equal(plan('buffer', true).toClipboard, false);
    assert.equal(plan('buffer', true).toBuffer, true);
    assert.equal(plan('none', true).borrowClipboard, true);
    assert.equal(plan('buffer', false).borrowClipboard, false);
});
test('inline emoji query detection', () => {
    assert.equal(inlineEmojiQuery(':smile'), 'smile');
    assert.equal(inlineEmojiQuery(':'), '');
    assert.equal(inlineEmojiQuery(': smile'), null);
    assert.equal(inlineEmojiQuery('smile'), null);
    assert.equal(inlineEmojiQuery(':red heart '), 'red heart');
});
test('paste keys: terminals get Ctrl+Shift+V, explicit settings win', () => {
    assert.ok(isTerminalClass('org.gnome.Console') && isTerminalClass('Alacritty') && isTerminalClass('kitty'));
    assert.ok(!isTerminalClass('firefox') && !isTerminalClass(null));
    assert.equal(resolvePasteKeys('auto', 'org.gnome.Ptyxis'), 'ctrl-shift-v');
    assert.equal(resolvePasteKeys('auto', 'firefox'), 'ctrl-v');
    assert.equal(resolvePasteKeys('shift-insert', 'kitty'), 'shift-insert');
});

test('emoji built-ins follow the emoji flag and carry their mode texts', () => {
    const off = buildBuiltinEntries({}, {clipboard: true, emoji: false});
    assert.ok(!off.entries.some(e => e.id.startsWith('system:emoji')));
    const on = buildBuiltinEntries({}, {clipboard: true, emoji: true});
    const picker = on.entries.find(e => e.id === 'system:emoji');
    assert.equal(picker.kind, 'mode');
    assert.equal(picker.payload.target, 'emoji');
    assert.equal(picker.payload.placeholder, 'Search emoji…');
    assert.ok(on.entries.some(e => e.id === 'system:emoji-paste-buffer' && e.kind === 'system'));
    const clip = on.entries.find(e => e.id === 'system:clipboard');
    assert.equal(clip.payload.empty, 'Clipboard history is empty');
});
test('emoji built-in shortcuts are collected like any other built-in', () => {
    const r = buildBuiltinEntries({'emoji-paste-buffer': {shortcut: '<Super>v'}, emoji: {windowShortcut: '<Alt>e'}}, {clipboard: true, emoji: true});
    assert.deepEqual(r.shortcuts, [{id: 'system:emoji-paste-buffer', accel: '<Super>v'}]);
    assert.deepEqual(r.windowShortcuts, [{id: 'system:emoji', accel: '<Alt>e'}]);
});

test('only verified named imports from shell resource modules', () => {
    for (const f of jsFiles(root)) {
        const src = readFileSync(f, 'utf8');
        for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'resource:\/\/\/[^']+'/g)) {
            for (const name of m[1].split(',').map(x => x.trim()).filter(Boolean))
                assert.ok(SAFE_NAMED.has(name), `${f}: unverified named import "${name}"`);
        }
    }
});
test('process separation: shell code never loads GTK, prefs never load Shell libs', () => {
    for (const f of jsFiles(root)) {
        const src = readFileSync(f, 'utf8');
        const inPrefs = f.includes('/prefs');
        const shellOnly = /from 'gi:\/\/(Clutter|St|Shell|Meta)'|ui\/main\.js'/;
        const gtkOnly = /from 'gi:\/\/(Gtk|Gdk|Adw)'/;
        if (inPrefs)
            assert.ok(!shellOnly.test(src), `${f} imports a Shell-only module`);
        else
            assert.ok(!gtkOnly.test(src), `${f} imports a GTK-only module`);
    }
});
test('prefs-reachable modules are pure (only relative imports)', () => {
    for (const f of ['themes/themes.js', 'commands/schema.js', 'commands/builtins.js', 'search/engine.js', 'emoji/emoji.js', 'emoji/data.js']) {
        const src = readFileSync(join(root, f), 'utf8');
        for (const m of src.matchAll(/^import .* from '([^']+)'/gm))
            assert.ok(m[1].startsWith('.'), `${f} imports ${m[1]}`);
    }
});
test('no APIs that are missing on current Shell versions', () => {
    // These broke the launcher on a real Shell: keep them out.
    for (const f of jsFiles(root)) {
        const src = readFileSync(f, 'utf8');
        assert.ok(!src.includes('ensureActorVisibleInScrollView'), `${f} uses ensureActorVisibleInScrollView`);
        assert.ok(!src.includes('keyval_from_name'), `${f} uses Clutter.keyval_from_name`);
        assert.ok(!/addKeybinding\(\s*'shortcut'/.test(src), `${f} registers the generic "shortcut" binding name`);
    }
});
test('every settings key used in code exists in the schema', () => {
    const xml = readFileSync(join(root, 'schemas/org.gnome.shell.extensions.gnome-launcher.gschema.xml'), 'utf8');
    const keys = new Set([...xml.matchAll(/<key name="([^"]+)"/g)].map(m => m[1]));
    const re = /(?:\.(?:str|int|num|bool|strv|json)|get_string|get_int|get_double|get_boolean|get_strv|set_string|set_int|set_strv|(?:switch|spin|entry|combo)Row\(settings,|bump\(settings,|onChanged\()\(?\s*'([a-z][a-z-]+)'/g;
    for (const f of jsFiles(root)) {
        for (const m of readFileSync(f, 'utf8').matchAll(re)) {
            if (!['color-scheme', 'overlay-key', 'show-banners'].includes(m[1])) // keys of GNOME's own schemas
                assert.ok(keys.has(m[1]), `${f}: unknown settings key "${m[1]}"`);
        }
    }
    assert.ok(keys.has('gnome-launcher-toggle') && !keys.has('shortcut'), 'binding key must be unique and not the generic "shortcut"');
    for (const k of ['outside-action', 'builtins', 'clipboard-enabled', 'clipboard-max', 'calculator'])
        assert.ok(keys.has(k), k);
    assert.ok(!keys.has('saved-overlay-key'));
});
test('metadata uuid matches the owner', () => {
    const meta = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));
    assert.equal(meta.uuid, 'gnome-launcher@maou-nournar');
});

console.log(`\n${passed} tests passed`);

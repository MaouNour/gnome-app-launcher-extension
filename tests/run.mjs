// Unit tests for the pure modules:  node tests/run.mjs
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {SearchEngine, prepare, fold, frecency} from '../search/engine.js';
import {sanitizeTheme, resolveTheme, builtinThemes, cssColor, THEME_FAMILIES} from '../themes/themes.js';
import {sanitizeCommand, sanitizeAction, validateCommand, validateAction} from '../commands/schema.js';
import {buildUserEntries} from '../commands/userEntries.js';
import {calculate} from '../search/calc.js';
import {buildStyles, cssFontFamily} from '../ui/style.js';
import {compileBlocklist} from '../shortcuts/blocklist.js';
import {copyName, fileLabels, isCopyName, isSecret, isTempName, isVideoName, linkCandidates, reviveItems, serializeItems, watchedSelections} from '../clipboard/persist.js';
import {parseExec} from '../commands/exec.js';
import {DEFAULT_PIPELINES, EFFECTS, GROUPS, cleanParams, newEffect, pickPipeline, resolveBlur, sanitizePipelines} from '../blur/defs.js';
import {parseRegexQuery, isRiskyPattern, extractRegexKeywords} from '../search/regex.js';
import {sanitizeProviders, sanitizeProvider, validTemplate, buildUrl, webEntries, explicitWebQuery, offerWeb, DEFAULT_PROVIDERS} from '../search/web.js';
import {sanitizeAccount, sanitizeAccounts, accountEntries, safeUrl, hostOf, generatePassword, newAccountId, clearDelaySeconds} from '../accounts/accounts.js';
import {randomBytes} from 'node:crypto';
import {clipboardKind, imageInfo, imageLabels, formatBytes, imagesToDrop} from '../clipboard/image.js';
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
test('built-in themes present', () => assert.equal(Object.keys(builtinThemes()).length, 19));
test('every quick-preset family points at two existing themes', () => {
    const all = builtinThemes();
    for (const [name, pair] of Object.entries(THEME_FAMILIES))
        for (const id of pair)
            assert.ok(all[id], `${name}: unknown theme ${id}`);
    for (const f of ['Tokyo Night', 'Catppuccin', 'Gruvbox', 'Rosé Pine', 'Nord', 'Solarized'])
        assert.ok(THEME_FAMILIES[f], f);
});
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
    const all = buildBuiltinEntries({}, {clipboard: true, emoji: true, accounts: true});
    assert.equal(all.entries.length, BUILTINS.length);
    assert.ok(all.entries.every(e => e.id.startsWith('system:') && ['system', 'mode'].includes(e.kind)));
    assert.ok(!buildBuiltinEntries({}, {clipboard: false}).entries.some(e => e.category === 'Clipboard'));
    assert.ok(!buildBuiltinEntries({'power-off': {enabled: false}}, {clipboard: true}).entries.some(e => e.id === 'system:power-off'));
});
test('built-in shortcuts: global and window-only are kept apart', () => {
    const r = buildBuiltinEntries({reboot: {shortcut: '<Control><Alt>r', windowShortcut: '<Control>r'}}, {clipboard: false});
    assert.deepEqual(r.shortcuts, [{id: 'system:reboot', accel: '<Control><Alt>r'}]);
    assert.deepEqual(r.windowShortcuts.filter(w => w.id === 'system:reboot'), [{id: 'system:reboot', accel: '<Control>r'}]);
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

test('shared keyword is added to every built-in entry and makes them searchable', () => {
    const r = buildBuiltinEntries({}, {clipboard: true, emoji: true, keyword: ' App '});
    assert.ok(r.entries.length > 5);
    for (const e of r.entries)
        assert.ok(e.keywords.split(' ').includes('app'), e.id);
    const eng = new SearchEngine();
    eng.setEntries(r.entries);
    assert.ok(eng.search('app', {limit: 50, fuzzy: false}).length >= r.entries.length - 1);
    const none = buildBuiltinEntries({}, {clipboard: true, emoji: true, keyword: ''});
    assert.ok(!none.entries.some(e => /\bapp\b/.test(e.keywords ?? '')));
});
const LAYOUT = {
    scale: 1, width: 640, windowHeight: 0, maxHeight: 480, padding: 12, searchHeight: 52, searchPadding: 14,
    rowHeight: 48, resultSpacing: 4, iconSize: 32, iconSpacing: 12, fontSize: 11, gridCell: 44,
    searchPosition: 'top', showDescriptions: true, showTags: true, placeholder: '', searchIcon: 'edit-find-symbolic',
    searchIconSize: 16, showScrollbar: false,
};
test('emoji grid geometry: columns fit the window and the grid is centred', () => {
    const st = buildStyles(LAYOUT, builtinThemes()['default-dark']);
    assert.equal(st.gridCell, 44);
    assert.equal(st.gridCols, 12);
    assert.ok(st.gridRow.includes('padding-left: 22px'), st.gridRow);
    const wide = buildStyles({...LAYOUT, width: 900}, builtinThemes()['default-dark']);
    assert.ok(wide.gridCols > st.gridCols);
    const big = buildStyles({...LAYOUT, scale: 2, gridCell: 96}, builtinThemes()['default-dark']);
    assert.ok(big.gridCols >= 1 && big.gridCell === 192);
    const tiny = buildStyles({...LAYOUT, width: 100, gridCell: 96}, builtinThemes()['default-dark']);
    assert.equal(tiny.gridCols, 1);
});
test('the accounts entry appears only when enabled, as a mode that is not part of the main search text', () => {
    const off = buildBuiltinEntries({}, {clipboard: true, emoji: true, accounts: false});
    assert.ok(!off.entries.some(e => e.id === 'system:accounts'));
    const on = buildBuiltinEntries({}, {clipboard: true, emoji: true, accounts: true});
    const e = on.entries.find(x => x.id === 'system:accounts');
    assert.equal(e.kind, 'mode');
    assert.equal(e.payload.target, 'accounts');
    assert.ok(e.payload.empty.includes('Preferences'));
});
test('emoji are drawn with an explicit font when one is set', () => {
    const theme = builtinThemes()['default-dark'];
    const named = buildStyles({...LAYOUT, emojiFont: 'Noto Color Emoji'}, theme);
    for (const k of ['glyph', 'glyphSel', 'cellText', 'cellTextSel'])
        assert.ok(named[k].includes('font-family: "Noto Color Emoji"'), k);
    const auto = buildStyles({...LAYOUT, emojiFont: ''}, theme);
    assert.ok(!auto.glyph.includes('font-family') && !auto.cellText.includes('font-family'));
});
test('font names are made safe for inline styles', () => {
    assert.equal(cssFontFamily('Fira Sans'), '"Fira Sans"');
    assert.equal(cssFontFamily('Fira Code, monospace'), '"Fira Code", monospace');
    assert.equal(cssFontFamily('Inter; background-color: red'), '"Inter background-color red"');
    assert.ok(!/[;{}:]/.test(cssFontFamily('a"; color: red} b{')));
    assert.equal(cssFontFamily(''), '');
    assert.equal(cssFontFamily(null), '');
    assert.equal(cssFontFamily('Noto Sans Arabic, Cairo, Amiri, Tajawal, Extra'), '"Noto Sans Arabic", "Cairo", "Amiri", "Tajawal"');
    assert.equal(cssFontFamily('Sans-Serif'), 'sans-serif');
});
test('three font slots style the search bar, the main text and the details independently', () => {
    const theme = {...builtinThemes()['default-dark'], fontFamily: 'Cantarell', fontWeight: 400};
    const base = buildStyles(LAYOUT, theme);
    assert.ok(base.entry.includes('"Cantarell"') && base.title.includes('"Cantarell"') && base.sub.includes('"Cantarell"'), 'theme font is the fallback');
    const st = buildStyles({...LAYOUT, fonts: {
        search: {family: 'Fira Code', size: 20, weight: 300},
        main: {family: 'Inter', weight: 600},
        secondary: {family: 'Noto Serif', size: 9, weight: 0},
    }}, theme);
    assert.ok(st.entry.includes('"Fira Code"') && st.entry.includes('font-size: 20.00pt') && st.entry.includes('font-weight: 300'));
    assert.ok(st.title.includes('"Inter"') && st.title.includes('font-weight: 600') && st.title.includes('font-size: 11.00pt'));
    assert.ok(st.sub.includes('"Noto Serif"') && st.sub.includes('font-size: 9.00pt') && st.sub.includes('font-weight: 400'));
    assert.ok(st.tag.includes('"Noto Serif"') && !st.tag.includes('font-size: 9.00pt'), 'tags are a bit smaller than details');
    assert.ok(!st.title.includes('Fira') && !st.sub.includes('Inter') && !st.entry.includes('Noto'));
    assert.ok(st.hint.includes('"Fira Code"'), 'placeholder follows the search font');
    // Sizes of 0 mean automatic: relative to the main size.
    const auto = buildStyles({...LAYOUT, fontSize: 12, fonts: {search: {size: 0}, secondary: {size: 0}}}, theme);
    assert.ok(auto.entry.includes('font-size: 15.00pt') && auto.sub.includes('font-size: 9.84pt'));
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
    assert.deepEqual(r.windowShortcuts.filter(w => w.id === 'system:emoji'), [{id: 'system:emoji', accel: '<Alt>e'}]);
});

// ---- clipboard images -----------------------------------------------------------------------
const IMG = {
    png: 'iVBORw0KGgoAAAANSUhEUgAAACUAAAAVCAIAAABOhrD5AAAAJElEQVR4nGP4z8BAT0RXy0btG7Vv1L5R+0btG7Vv1L5R+6iAAEZYBiUyqttGAAAAAElFTkSuQmCC',
    gif: 'R0lGODdhQAAwAIEAAP8AAAAAAAAAAAAAACwAAAAAQAAwAEAIWgABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIsaPHjyBDihxJsqTJkyhTqlzJsqXLlzBjypxJs6bNmzhz6tzJs6fPn0CDCh1KtKjRo0iTKl3KtGnRgAA7',
    jpg: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAwAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDi6KKK+ZP3EKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/9k=',
    webp: 'UklGRlQAAABXRUJQVlA4IEgAAADwAwCdASpAADAAPm02mEkkIyKhIqgAgA2JZwDU9oB+AAAVGmMcPgzAAP7wm0P/8guWF1yNf/8gP+QH/ID/+PfFDYqwyAAAAAA=',
};
const bytesOf = name => new Uint8Array(Buffer.from(IMG[name], 'base64'));
test('image header sniffing reads type and size without decoding', () => {
    assert.deepEqual(imageInfo(bytesOf('png')), {type: 'PNG', width: 37, height: 21});
    assert.deepEqual(imageInfo(bytesOf('gif')), {type: 'GIF', width: 64, height: 48});
    assert.deepEqual(imageInfo(bytesOf('jpg')), {type: 'JPEG', width: 64, height: 48});
    assert.equal(imageInfo(bytesOf('webp')).type, 'WEBP');
    const bmp = new Uint8Array(30);
    bmp.set([0x42, 0x4d], 0);
    new DataView(bmp.buffer).setInt32(18, 20, true);
    new DataView(bmp.buffer).setInt32(22, -10, true);
    assert.deepEqual(imageInfo(bmp), {type: 'BMP', width: 20, height: 10});
});
test('image sniffing rejects junk and truncated data safely', () => {
    assert.equal(imageInfo(null), null);
    assert.equal(imageInfo(new Uint8Array(4)), null);
    assert.equal(imageInfo(new TextEncoder().encode('hello world, not an image')), null);
    assert.deepEqual(imageInfo(bytesOf('png').slice(0, 14)), {type: 'PNG', width: 0, height: 0});
    assert.doesNotThrow(() => imageInfo(bytesOf('jpg').slice(0, 30)));
});
test('clipboardKind prefers text, then images when enabled', () => {
    assert.deepEqual(clipboardKind(['text/plain;charset=utf-8', 'image/png'], true), {kind: 'text'});
    assert.deepEqual(clipboardKind(['image/png', 'image/jpeg'], true), {kind: 'image', mime: 'image/png'});
    assert.deepEqual(clipboardKind(['image/jpeg'], true), {kind: 'image', mime: 'image/jpeg'});
    assert.equal(clipboardKind(['image/png'], false), null);
    assert.equal(clipboardKind(['application/x-weird'], true), null);
    assert.equal(clipboardKind(undefined, true), null);
});
test('image list labels', () => {
    const l = imageLabels({type: 'PNG', width: 1920, height: 1080}, 421888);
    assert.equal(l.name, 'Image 1920×1080');
    assert.equal(l.desc, 'PNG · 412 KB');
    assert.ok(l.keywords.includes('screenshot') && l.keywords.includes('1920x1080'));
    assert.equal(imageLabels(null, 10).name, 'Image');
    assert.equal(formatBytes(2.5 * 1024 * 1024), '2.5 MB');
});
test('imagesToDrop removes only the oldest images beyond the limit', () => {
    const items = [{image: 1}, {text: 'a'}, {image: 2}, {image: 3}, {text: 'b'}, {image: 4}];
    assert.deepEqual(imagesToDrop(items, 2), [3, 5]);
    assert.deepEqual(imagesToDrop(items, 10), []);
    assert.deepEqual(imagesToDrop(items, 0), [0, 2, 3, 5]);
});

// ---- accounts -------------------------------------------------------------------------------
const rnd = n => new Uint8Array(randomBytes(n));
test('safeUrl accepts http(s) and bare hosts only', () => {
    assert.equal(safeUrl('https://example.com/login'), 'https://example.com/login');
    assert.equal(safeUrl('example.com/login'), 'https://example.com/login');
    assert.equal(safeUrl('http://localhost:8080'), 'http://localhost:8080/');
    assert.equal(safeUrl('localhost:3000/app'), 'https://localhost:3000/app');
    assert.equal(safeUrl('HTTPS://Example.COM'), 'https://example.com/');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x.org', 'data:text/html,hi', '', 'http://', 'a b c', 'https://user:pw@evil.com', 'https://exa mple.com', null, 5])
        assert.equal(safeUrl(bad), '', String(bad));
    assert.equal(hostOf('https://www.example.com/x'), 'example.com');
    assert.equal(hostOf('nonsense: nope'), '');
});
test('account records are validated and never carry a password', () => {
    const id = newAccountId(rnd);
    assert.match(id, /^[0-9a-f]{32}$/);
    const ok = sanitizeAccount({id, name: '  GitHub ', username: 'me@x.org', url: 'github.com', password: 'hunter2', extra: 1});
    assert.deepEqual(ok, {id, name: 'GitHub', username: 'me@x.org', url: 'https://github.com/'});
    assert.ok(!('password' in ok));
    assert.equal(sanitizeAccount({id: 'short', name: 'x'}), null);
    assert.equal(sanitizeAccount({id, name: '   '}), null);
    assert.equal(sanitizeAccount({id: 'bad id with spaces!', name: 'x'}), null);
    assert.equal(sanitizeAccount(null), null);
    assert.equal(sanitizeAccount({id, name: 'x', url: 'javascript:alert(1)'}).url, '');
});
test('account lists drop invalid and duplicate records', () => {
    const a = newAccountId(rnd);
    const list = sanitizeAccounts([{id: a, name: 'A'}, {id: a, name: 'dup'}, {name: 'no id'}, 'junk', null]);
    assert.equal(list.length, 1);
    assert.deepEqual(sanitizeAccounts('nope'), []);
    assert.equal(sanitizeAccounts(Array.from({length: 1500}, (_, i) => ({id: `id-${String(i).padStart(8, '0')}`, name: `n${i}`}))).length, 1000);
});
test('account entries are searchable by name, username and site but hold no secret', () => {
    const id = newAccountId(rnd);
    const entries = accountEntries([{id, name: 'GitHub', username: 'octocat', url: 'https://github.com/login'}]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'account');
    assert.deepEqual(Object.keys(entries[0].payload).sort(), ['accountId', 'url', 'username']);
    const eng = new SearchEngine();
    eng.setEntries(entries);
    for (const q of ['git', 'octo', 'github.com'])
        assert.equal(eng.search(q, {limit: 5, fuzzy: false, descriptions: true}).length, 1, q);
});
test('generated passwords have the requested length and every character class', () => {
    for (let i = 0; i < 200; i++) {
        const p = generatePassword(rnd, {length: 20, symbols: true});
        assert.equal(p.length, 20);
        assert.ok(/[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p), p);
    }
    assert.ok(/^[A-Za-z0-9]+$/.test(generatePassword(rnd, {length: 30, symbols: false})));
    assert.equal(generatePassword(rnd, {length: 3}).length, 8, 'minimum length');
    assert.equal(generatePassword(rnd, {length: 999}).length, 128, 'maximum length');
});
test('password generation is unbiased (rejection sampling) and survives poor randomness', () => {
    const counts = {};
    for (let i = 0; i < 400; i++)
        for (const ch of generatePassword(rnd, {length: 40, symbols: false}))
            counts[ch] = (counts[ch] ?? 0) + 1;
    const vals = Object.values(counts);
    assert.ok(Math.max(...vals) / Math.min(...vals) < 1.5, 'distribution too uneven');
    // A source that always returns 255 is rejected by the sampler and must fail loudly, not loop forever.
    assert.throws(() => generatePassword(() => new Uint8Array(100).fill(255), {length: 8}));
});
test('clipboard clear delay is clamped', () => {
    assert.equal(clearDelaySeconds(20), 20);
    assert.equal(clearDelaySeconds(0), 0);
    assert.equal(clearDelaySeconds(-5), 0);
    assert.equal(clearDelaySeconds(99999), 600);
    assert.equal(clearDelaySeconds('x'), 20);
});

// ---- regex search ---------------------------------------------------------------------------
test('regex queries: modes decide what counts as a pattern', () => {
    assert.equal(parseRegexQuery('/fire', 'off'), null);
    assert.equal(parseRegexQuery('firefox', 'prefix'), null);
    assert.equal(parseRegexQuery('fire.*', 'prefix'), null, 'prefix mode needs the slash');
    assert.equal(parseRegexQuery('/fire|chrom', 'prefix').source, 'fire|chrom');
    assert.equal(parseRegexQuery('/fire|chrom/', 'prefix').source, 'fire|chrom', 'closing slash is optional');
    assert.equal(parseRegexQuery('  /^fire', 'prefix').source, '^fire');
    assert.equal(parseRegexQuery('fire.*', 'always').source, 'fire.*');
    assert.equal(parseRegexQuery('firefox', 'always'), null, 'plain words are not regexes in always mode');
    assert.equal(parseRegexQuery('c++', 'always'), null, 'invalid pattern falls back to normal search');
});
test('explicit regex problems are reported, not thrown', () => {
    assert.ok(parseRegexQuery('/', 'prefix').error);
    assert.ok(parseRegexQuery('/(unclosed', 'prefix').error);
    assert.ok(parseRegexQuery('/(a+)+$', 'prefix').error);
    assert.ok(parseRegexQuery('/' + 'a'.repeat(200), 'prefix').error);
    assert.equal(parseRegexQuery('(a+)+$', 'always'), null, 'risky implicit patterns just fall back');
});
test('patterns that backtrack catastrophically are refused', () => {
    for (const bad of ['(a+)+$', '(.*)*x', '(a*)*', '(x{2,})+', '(a|b+)+', '(a|aa)+$', '(a?){0,20}b', '(a)\\1', '(?<=a)b', 'a.*a.*a.*b'])
        assert.ok(isRiskyPattern(bad), bad);
    for (const ok of ['^fire', 'chrom(e|ium)', '^(open )?term(inal)?$', 'a.*b', '\\bgimp\\b', '[a-z]+\\d{2,4}', '(foo)?bar', '(?:abc){2}', 'fire.*fox.*x'])
        assert.ok(!isRiskyPattern(ok), ok);
});
test('every accepted pattern stays fast on long text', () => {
    const long = 'a'.repeat(200);
    const t0 = performance.now();
    for (const src of ['a.*a.*b', '[a-z]+x', 'a{1,50}b', '.*a.*b', '(a)+b']) {
        assert.ok(!isRiskyPattern(src), src);
        new RegExp(src, 'i').test(long);
    }
    assert.ok(performance.now() - t0 < 100, `${(performance.now() - t0).toFixed(1)} ms`);
});
test('regex search matches names first, then keywords, then descriptions', () => {
    const eng = new SearchEngine();
    eng.setEntries([
        prepare({id: 'a', kind: 'app', name: 'Firefox', desc: 'Web browser', keywords: 'internet'}),
        prepare({id: 'b', kind: 'app', name: 'Files', desc: 'Browse files', keywords: 'folder explorer'}),
        prepare({id: 'c', kind: 'app', name: 'Terminal', desc: 'Fire up a shell', keywords: 'console'}),
        prepare({id: 'd', kind: 'app', name: 'Gimp', desc: 'Image editor', keywords: 'photoshop'}),
    ]);
    const ids = (src, o = {}) => eng.searchRegex(new RegExp(src, 'i'), {frecency: false, ...o}).map(e => e.id);
    assert.deepEqual(ids('^fi'), ['b', 'a', 'c'], 'names first (shorter first), then the description match');
    assert.deepEqual(ids('fire'), ['a', 'c'], 'name match above description match');
    assert.deepEqual(ids('photo|console'), ['d', 'c']);
    assert.equal(ids('photo').length, 1);
    assert.deepEqual(ids('fire', {descriptions: false}), ['a']);
    assert.deepEqual(ids('^gimp$'), ['d']);
    assert.equal(eng.searchRegex(/zzz/i).length, 0);
    assert.equal(eng.searchRegex(/./i, {limit: 2}).length, 2);
});
test('regex keywords of commands match the whole query and rank first', () => {
    const {plain, patterns} = extractRegexKeywords('term shell /^(open )?term(inal)?$/ /(bad/ /(a+)+$/');
    assert.equal(plain, 'term shell');
    assert.equal(patterns.length, 1, 'invalid and risky patterns are ignored');
    const eng = new SearchEngine();
    eng.setEntries([
        prepare({id: 'x', kind: 'app', name: 'Alpha terminal emulator', keywords: ''}),
        prepare({id: 'cmd', kind: 'command', name: 'Run shell', keywords: '/^open term(inal)?$/ launch', rxKeywords: true}),
        prepare({id: 'plain', kind: 'command', name: 'Other', keywords: '/^open term(inal)?$/', rxKeywords: false}),
    ]);
    assert.equal(eng.search('open term', {limit: 5})[0].id, 'cmd');
    assert.equal(eng.search('open terminal', {limit: 5})[0].id, 'cmd');
    assert.ok(!eng.search('open terminal now', {limit: 5}).some(e => e.id === 'cmd'), 'anchored pattern must not match');
    assert.ok(eng.search('launch', {limit: 5}).some(e => e.id === 'cmd'), 'plain words still work');
});

// ---- web / AI fallback ----------------------------------------------------------------------
test('web provider templates must be http(s) and contain {query}', () => {
    assert.ok(validTemplate('https://example.com/s?q={query}'));
    for (const bad of ['https://example.com/s', 'ftp://x.org/{query}', 'javascript:alert({query})', 'file:///{query}', '', 5, 'https://a b/{query}'])
        assert.ok(!validTemplate(bad), String(bad));
    assert.equal(sanitizeProvider({name: '', url: 'https://x.org/{query}'}), null);
    assert.equal(sanitizeProvider({name: 'X', url: 'https://x.org/'}), null);
    const p = sanitizeProvider({name: ' X ', url: 'https://x.org/?q={query}', enabled: false, ai: true, id: 'a b!c'});
    assert.deepEqual(p, {id: 'abc', name: 'X', url: 'https://x.org/?q={query}', icon: '', ai: true, enabled: false});
});
test('default providers are all valid and unique', () => {
    const list = sanitizeProviders(DEFAULT_PROVIDERS);
    assert.equal(list.length, DEFAULT_PROVIDERS.length);
    assert.ok(list.some(p => p.ai && p.enabled) && list.some(p => !p.ai && p.enabled));
    assert.equal(sanitizeProviders([...DEFAULT_PROVIDERS, DEFAULT_PROVIDERS[0]]).length, DEFAULT_PROVIDERS.length);
    assert.deepEqual(sanitizeProviders('nope'), []);
});
test('search text is percent-encoded into the url', () => {
    assert.equal(buildUrl('https://x.org/?q={query}', 'a b&c=d/é'), 'https://x.org/?q=a%20b%26c%3Dd%2F%C3%A9');
    assert.equal(buildUrl('https://x.org/{query}/{query}', 'z'), 'https://x.org/z/z');
    assert.equal(buildUrl('https://x.org/', 'z'), '');
    assert.equal(buildUrl('https://x.org/?q={query}', '   '), '');
    assert.ok(buildUrl('https://x.org/?q={query}', 'x'.repeat(2000)).length < 700);
});
test('web entries: one per enabled provider with AI wording where flagged', () => {
    const entries = webEntries(sanitizeProviders(DEFAULT_PROVIDERS), 'how to rename a git branch');
    assert.equal(entries.length, DEFAULT_PROVIDERS.filter(p => p.enabled).length);
    assert.ok(entries.every(e => e.kind === 'web' && e.payload.url.startsWith('https://')));
    assert.ok(entries.some(e => e.name.startsWith('Ask Claude')));
    assert.ok(entries.some(e => e.name.startsWith('Search Google')));
    assert.deepEqual(webEntries(sanitizeProviders(DEFAULT_PROVIDERS), '   '), []);
    assert.deepEqual(webEntries([], 'x'), []);
});
test('when web entries are offered', () => {
    assert.equal(offerWeb('empty', 0, 'x'), true);
    assert.equal(offerWeb('empty', 3, 'x'), false);
    assert.equal(offerWeb('always', 3, 'x'), true);
    assert.equal(offerWeb('off', 0, 'x'), false);
    assert.equal(offerWeb('empty', 0, '  '), false);
    assert.equal(explicitWebQuery('? rust lifetimes'), 'rust lifetimes');
    assert.equal(explicitWebQuery('?rust'), null);
    assert.equal(explicitWebQuery('what?'), null);
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
    for (const f of ['themes/themes.js', 'commands/schema.js', 'commands/builtins.js', 'search/engine.js', 'emoji/emoji.js', 'emoji/data.js', 'clipboard/image.js', 'clipboard/persist.js', 'blur/defs.js', 'commands/exec.js', 'accounts/accounts.js', 'search/regex.js', 'search/web.js']) {
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

test('Launcher Settings is built in with Ctrl+I as the default window shortcut', () => {
    const r = buildBuiltinEntries({}, {});
    assert.ok(r.entries.some(e => e.id === 'system:launcher-settings' && e.kind === 'system'));
    assert.deepEqual(r.windowShortcuts, [{id: 'system:launcher-settings', accel: '<Control>i'}]);
    const own = buildBuiltinEntries({'launcher-settings': {windowShortcut: '<Control>o'}}, {});
    assert.deepEqual(own.windowShortcuts, [{id: 'system:launcher-settings', accel: '<Control>o'}]);
    const cleared = buildBuiltinEntries({'launcher-settings': {windowShortcut: ''}}, {});
    assert.deepEqual(cleared.windowShortcuts, []);
    assert.deepEqual(sanitizeBuiltins({reboot: {windowShortcut: ''}}), {}); // '' only means "cleared" where a default exists
});
const H = 'a'.repeat(64);
test('history on disk: text, copied image, linked image and video survive a round trip', () => {
    const items = [
        {ts: 5, text: 'hello'},
        {ts: 4, image: {mime: 'image/png', hash: H, size: 10, info: {type: 'PNG', width: 3, height: 2}, path: copyName(H, 'image/png'), linked: false}},
        {ts: 3, image: {mime: 'image/png', hash: H, size: 10, info: null, path: '/home/u/Pictures/Screenshots/a.png', linked: true}},
        {ts: 2, file: {path: '/home/u/Videos/Screencasts/r.webm', kind: 'video', size: 99, name: 'r.webm'}},
        {ts: 1, image: {mime: 'image/png', hash: H, size: 10, bytes: {}, path: null, linked: false}}, // memory only: not stored
    ];
    const stored = serializeItems(items);
    assert.equal(stored.length, 4);
    const back = reviveItems(JSON.parse(JSON.stringify(stored)));
    assert.deepEqual(back.map(b => b.t), ['text', 'image', 'image', 'file']);
    assert.equal(back[2].linked, true);
    assert.equal(back[3].name, 'r.webm');
});
test('history on disk: damaged or hostile index entries are rejected', () => {
    const bad = [
        null, 7, {t: 'text', text: '   '}, {t: 'text', text: 'x'.repeat(20001)},
        {t: 'image', mime: 'image/png', hash: 'zz', path: copyName(H, 'image/png')},
        {t: 'image', mime: 'image/png', hash: H, path: '../../etc/passwd', linked: false},      // a copy must be a plain img-<hash> name
        {t: 'image', mime: 'image/png', hash: H, path: 'relative/file.png', linked: true},     // a link must be absolute
        {t: 'image', mime: 'text/plain', hash: H, path: copyName(H, 'image/png')},
        {t: 'file', path: '/x/y.txt', kind: 'script'}, {t: 'file', path: 'rel.webm', kind: 'video'}, {t: 'other'},
    ];
    assert.deepEqual(reviveItems(bad), []);
    assert.deepEqual(reviveItems('nope'), []);
    assert.equal(reviveItems(Array.from({length: 300}, (_, i) => ({t: 'text', text: `t${i}`})), 200).length, 200);
});
test('copied image names: only our own pattern counts as a copy', () => {
    assert.ok(isCopyName(copyName(H, 'image/jpeg')));
    assert.ok(!isCopyName('img-short.png') && !isCopyName('notes.txt') && !isCopyName('../img-' + H + '.png'));
    assert.equal(copyName(H, 'image/webp'), `img-${H}.webp`);
});
test('screenshot linking only considers same-size images saved around the same time', () => {
    const files = [
        {name: 'Screenshot 1.png', size: 500, mtime: 1000},
        {name: 'Screenshot 2.png', size: 500, mtime: 1003},
        {name: 'other.png', size: 501, mtime: 1000},
        {name: 'old.png', size: 500, mtime: 100},
        {name: 'notes.txt', size: 500, mtime: 1000},
        {name: '.hidden.png', size: 500, mtime: 1000},
        {name: 'a.png.part', size: 500, mtime: 1000},
    ];
    assert.deepEqual(linkCandidates(files, 500, 1002).map(f => f.name), ['Screenshot 2.png', 'Screenshot 1.png']);
    assert.deepEqual(linkCandidates(files, 999, 1002), []);
    assert.equal(linkCandidates(files, 500, 1002, 20, 1).length, 1);
});
test('recordings: video names are recognised, unfinished files are not', () => {
    assert.ok(isVideoName('Screencast from 2026.webm') && isVideoName('a.MP4') && !isVideoName('a.png') && !isVideoName('webm'));
    assert.ok(isTempName('.x.webm') && isTempName('a.part') && isTempName('b~') && !isTempName('a.webm'));
    assert.match(fileLabels({name: 'r.webm', size: 5 * 1024 * 1024}).desc, /5\.0 MB/);
});
test('clipboard source decides which selections are watched', () => {
    assert.deepEqual(watchedSelections('clipboard'), {clipboard: true, primary: false});
    assert.deepEqual(watchedSelections('primary'), {clipboard: false, primary: true});
    assert.deepEqual(watchedSelections('both'), {clipboard: true, primary: true});
    assert.deepEqual(watchedSelections('own'), {clipboard: false, primary: false});
    assert.deepEqual(watchedSelections('nonsense'), {clipboard: true, primary: false});
});
test('copies marked secret by a password manager are skipped', () => {
    assert.ok(isSecret(['text/plain', 'x-kde-passwordManagerHint']));
    assert.ok(!isSecret(['text/plain']) && !isSecret(undefined));
});
test('run-a-command prefix', () => {
    assert.deepEqual(parseExec('!ls -la', '!'), {command: 'ls -la'});
    assert.deepEqual(parseExec('  !  echo hi  ', '!'), {command: 'echo hi'});
    assert.deepEqual(parseExec('!', '!'), {command: ''});
    assert.equal(parseExec('ls', '!'), null);
    assert.equal(parseExec('a !b', '!'), null);
    assert.equal(parseExec('!ls', ''), null);
    assert.equal(parseExec('!ls', '   '), null);
    assert.deepEqual(parseExec('>> top', '>>'), {command: 'top'});   // any symbol, also several characters
    assert.equal(parseExec('!ls', undefined), null);
});
test('the history never deletes files it only links', () => {
    const src = readFileSync(join(root, 'clipboard/history.js'), 'utf8');
    const i = src.indexOf('_discard(it) {');
    const body = src.slice(i, src.indexOf('\n    }\n', i));
    assert.ok(body.includes('!it.image.linked') && body.includes('isCopyName'), 'discard must skip linked files and only touch our own copies');
});
test('blur: every effect in the editor has a class, a shader (where it needs one) and defaults', () => {
    const reg = readFileSync(join(root, 'blur/effects/registry.js'), 'utf8');
    for (const [type, def] of Object.entries(EFFECTS)) {
        assert.ok(reg.includes(`${type}: {class:`), `${type} missing from registry.js`);
        assert.ok(existsSync(join(root, `blur/effects/${type}.js`)), `${type}.js missing`);
        for (const k of Object.keys(def.editable_params))
            assert.ok(k in def.defaults, `${type}.${k} has no default`);
    }
    for (const t of ['gaussian_blur', 'monte_carlo_blur', 'color', 'luminosity', 'noise', 'corner', 'derivative', 'downscale', 'upscale', 'rgb_to_hsl', 'hsl_to_rgb'])
        assert.ok(existsSync(join(root, `blur/effects/${t}.glsl`)), `${t}.glsl missing`);
    const grouped = Object.values(GROUPS).flatMap(g => g.contains).sort();
    assert.deepEqual(grouped, Object.keys(EFFECTS).sort(), 'every effect belongs to exactly one group');
});
test('blur: parameters are clamped, unknown keys dropped, missing ones defaulted', () => {
    assert.deepEqual(cleanParams('corner', {radius: 9999, evil: 1, corners_top: 'yes'}), {radius: 150, corners_top: true, corners_bottom: true});
    assert.equal(cleanParams('native_static_gaussian_blur', {unscaled_radius: -5, brightness: 7}).unscaled_radius, 0);
    assert.equal(cleanParams('native_static_gaussian_blur', {brightness: 7}).brightness, 1);
    assert.equal(cleanParams('native_static_gaussian_blur', {unscaled_radius: NaN}).unscaled_radius, 30);
    assert.deepEqual(cleanParams('color', {color: [2, -1, 0.5, 0.5], blend_mode: 99}), {color: [1, 0, 0.5, 0.5], blend_mode: 0});
    assert.deepEqual(cleanParams('rgb_to_hsl', {a: 1}), {});
    assert.equal(cleanParams('noise', null).noise, 0.4);
});
test('blur: stored pipelines are validated and the defaults always exist', () => {
    const p = sanitizePipelines({
        mine: {name: 'Mine\u0007', effects: [{type: 'corner', id: 'e1', params: {radius: 20}}, {type: 'nope'}, null, {type: 'noise', id: 'e1'}]},
        '../bad id': {name: 'x', effects: []},
        broken: {name: 'b', effects: 'no'},
    });
    assert.deepEqual(Object.keys(p).sort(), ['mine', 'pipeline_default', 'pipeline_default_rounded']);
    assert.equal(p.mine.name, 'Mine');
    assert.equal(p.mine.effects.length, 2);
    assert.notEqual(p.mine.effects[0].id, p.mine.effects[1].id, 'duplicate effect ids are renamed');
    assert.deepEqual(Object.keys(sanitizePipelines('junk')), Object.keys(DEFAULT_PIPELINES));
    assert.equal(pickPipeline(p, 'gone'), 'pipeline_default');
    assert.equal(pickPipeline(p, 'mine'), 'mine');
    const e = newEffect('luminosity');
    assert.equal(e.type, 'luminosity');
    assert.equal(e.params.contrast, 1);
});
test('blur: the settings decide which kind of blur is built', () => {
    const base = {themeSigma: 30, themeRadius: 16, sigma: 40, brightness: 0.8, cornerAuto: true, cornerRadius: 5, pipelines: null, pipeline: 'pipeline_default'};
    assert.deepEqual(resolveBlur({...base, mode: 'off'}), {kind: 'none'});
    assert.deepEqual(resolveBlur({...base, mode: 'theme', themeSigma: 0}), {kind: 'none'});
    assert.deepEqual(resolveBlur({...base, mode: 'theme'}), {kind: 'dynamic', sigma: 30, brightness: 1, cornerRadius: 16});
    assert.deepEqual(resolveBlur({...base, mode: 'dynamic'}), {kind: 'dynamic', sigma: 40, brightness: 0.8, cornerRadius: 16});
    assert.equal(resolveBlur({...base, mode: 'dynamic', cornerAuto: false}).cornerRadius, 5);
    assert.equal(resolveBlur({...base, mode: 'dynamic', sigma: 0}).kind, 'none');
    const st = resolveBlur({...base, mode: 'static', pipeline: 'missing'});
    assert.equal(st.kind, 'static');
    assert.equal(st.pipelineId, 'pipeline_default');
    assert.equal(st.pipeline[0].type, 'native_static_gaussian_blur');
    assert.equal(resolveBlur({...base, mode: 'weird'}).kind, 'dynamic'); // unknown mode behaves like "theme"
});
test('blur: the default pipelines in the schema match the code', () => {
    const xml = readFileSync(join(root, 'schemas/org.gnome.shell.extensions.gnome-launcher.gschema.xml'), 'utf8');
    const m = xml.match(/<key name="blur-pipelines" type="s"><default>'(.*)'<\/default>/);
    assert.ok(m, 'blur-pipelines key');
    assert.deepEqual(sanitizePipelines(JSON.parse(m[1])), sanitizePipelines(null));
    assert.deepEqual(Object.keys(JSON.parse(m[1])).sort(), Object.keys(DEFAULT_PIPELINES).sort());
    for (const [id, p] of Object.entries(DEFAULT_PIPELINES))
        assert.deepEqual(JSON.parse(m[1])[id].effects.map(e => [e.type, e.id]), p.effects.map(e => [e.type, e.id]));
});
test('blur: the shell-side module is only ever loaded on demand, and the launcher window itself carries no effect', () => {
    for (const f of jsFiles(root)) {
        if (f.includes('/tests/') || f.includes('/blur/'))
            continue;
        const src = readFileSync(f, 'utf8');
        assert.ok(!/from '\.\.?\/blur\/blur\.js'/.test(src), `${f} imports blur/blur.js statically`);
        assert.ok(!/blur\/effects\//.test(src.replace(/\/\/.*$/gm, '')) || f.includes('prefs/'), `${f} reaches into blur/effects`);
    }
    const ui = readFileSync(join(root, 'ui/launcher.js'), 'utf8');
    assert.ok(ui.includes("import('../blur/blur.js')"));
    assert.ok(!/_box\.add_effect|box\.add_effect/.test(ui), 'the window box must not carry a blur effect');
    assert.ok(!ui.includes('Shell.BlurEffect'), 'blur effects are created in blur/, not in the launcher');
});
test('blur: license notice for the code taken from Blur my Shell is shipped', () => {
    assert.ok(existsSync(join(root, 'blur/LICENSE-blur-my-shell')));
    assert.match(readFileSync(join(root, 'blur/NOTICE.md'), 'utf8'), /GPL/);
});
test('blocklist: exact, case, .desktop and wildcard matching', () => {
    const b = compileBlocklist(['Steam_App_*', 'org.gnome.Nautilus.desktop', '  ', 'vmw?are*']);
    assert.equal(b.size, 3);
    assert.ok(b.test(['steam_app_730']));
    assert.ok(b.test([null, 'org.gnome.nautilus']));
    assert.ok(b.test(['VMwXare-player']));
    assert.ok(!b.test(['VMware']));
    assert.ok(!b.test(['firefox', undefined, '']));
    assert.ok(!b.test(['steam']));
    assert.equal(compileBlocklist(undefined).size, 0);
    assert.ok(!compileBlocklist(['a.b']).test(['axb'])); // dots are literal
});
test('prefs page builders are called with the arguments they declare', () => {
    const src = readFileSync(join(root, 'prefs/pages.js'), 'utf8');
    const argc = str => {
        let depth = 0, n = 0, any = false, q = null;
        for (let i = 0; i < str.length; i++) {
            const c = str[i];
            if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
            if (c === "'" || c === '"' || c === '`') { q = c; any = true; continue; }
            if ('([{'.includes(c)) { depth++; any = true; }
            else if (')]}'.includes(c)) depth--;
            else if (c === ',' && depth === 0) n++;
            else if (!/\s/.test(c)) any = true;
        }
        return any ? n + 1 : 0;
    };
    const callArgs = (name, from) => {
        const out = [];
        const re = new RegExp(`(?<![\\w.])${name}\\(`, 'g');
        for (let m; (m = re.exec(src));) {
            let i = re.lastIndex, depth = 1, q = null;
            for (; i < src.length && depth > 0; i++) {
                const c = src[i];
                if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
                if (c === "'" || c === '"' || c === '`') q = c;
                else if ('([{'.includes(c)) depth++;
                else if (')]}'.includes(c)) depth--;
            }
            out.push([m.index, src.slice(re.lastIndex, i - 1)]);
        }
        return out;
    };
    for (const m of src.matchAll(/^function (\w+)\(([^)]*)\)\s*\{/gm)) {
        const [, name, params] = m;
        if (params.includes('=') || params.includes('{')) continue;
        const want = params.trim() ? params.split(',').length : 0;
        for (const [at, args] of callArgs(name)) {
            if (at === m.index + 'function '.length) continue; // the declaration itself
            assert.equal(argc(args), want, `${name}(${args}) passes ${argc(args)} argument(s), expected ${want} (${params})`);
        }
    }
});

test('every animation style offered in prefs exists in the launcher', () => {
    const pages = readFileSync(join(root, 'prefs/pages.js'), 'utf8');
    const ui = readFileSync(join(root, 'ui/launcher.js'), 'utf8');
    const line = pages.split('\n').find(l => l.includes("'anim-style'"));
    for (const m of line.matchAll(/\['([a-z-]+)', '/g))
        assert.ok(m[1] === 'none' || ui.includes(`'${m[1]}': {scale:`), `animation "${m[1]}" is offered but not defined`);
});
test('Escape closes the launcher from any view', () => {
    const ui = readFileSync(join(root, 'ui/launcher.js'), 'utf8');
    const i = ui.indexOf('case Clutter.KEY_Escape:');
    assert.ok(i > 0 && !ui.slice(i, i + 300).includes('exitMode()'));
});
console.log(`\n${passed} tests passed`);

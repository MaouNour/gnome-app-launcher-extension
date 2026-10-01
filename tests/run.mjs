// Unit tests for the pure modules:  node tests/run.mjs
import assert from 'node:assert/strict';

import {SearchEngine, prepare, fold, frecency} from '../search/engine.js';
import {sanitizeTheme, resolveTheme, builtinThemes, cssColor} from '../themes/themes.js';
import {sanitizeCommand, sanitizeAction, validateCommand, validateAction} from '../commands/schema.js';
import {buildUserEntries} from '../commands/userEntries.js';

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
test('built-in themes present', () => assert.equal(Object.keys(builtinThemes()).length, 5));

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

console.log(`\n${passed} tests passed`);

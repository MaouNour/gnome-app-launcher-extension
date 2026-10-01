// Benchmark the pure search engine:  node tools/bench.mjs [entryCount]
// Figures from node (V8) are indicative only; GJS uses SpiderMonkey. For real numbers
// run it on the target machine:  gjs -m tools/bench.mjs
import {SearchEngine, prepare} from '../search/engine.js';

const N = Number(globalThis.process?.argv?.[2] ?? 20000);
const words = ['firefox', 'files', 'terminal', 'settings', 'calculator', 'editor', 'player', 'music', 'video',
    'photo', 'code', 'studio', 'visual', 'document', 'viewer', 'system', 'monitor', 'manager', 'software', 'center', 'mail', 'chat'];
const rnd = n => Math.floor(Math.random() * n);

const entries = [];
for (let i = 0; i < N; i++) {
    entries.push(prepare({
        id: `e${i}`, kind: 'app', category: 'Applications',
        name: `${words[rnd(words.length)]} ${words[rnd(words.length)]} ${i}`,
        desc: `${words[rnd(words.length)]} application`,
        keywords: words[rnd(words.length)],
    }));
}

const eng = new SearchEngine();
let t0 = performance.now();
eng.setEntries(entries);
console.log(`setEntries(${N}): ${(performance.now() - t0).toFixed(2)} ms`);

function time(label, fn, reps = 20) {
    const s = performance.now();
    for (let i = 0; i < reps; i++)
        fn();
    console.log(`${label.padEnd(44)} ${((performance.now() - s) / reps).toFixed(3)} ms`);
}

time('cold, 1 char  "f"', () => { eng.setEntries(entries); eng.search('f'); });
time('cold, 3 chars "fir"', () => { eng.setEntries(entries); eng.search('fir'); });
time('cold, fuzzy   "vsc"', () => { eng.setEntries(entries); eng.search('vsc'); });
time('cold, 2 tokens "fir ter"', () => { eng.setEntries(entries); eng.search('fir ter'); });
const typing = ['f', 'fi', 'fir', 'fire', 'firef', 'firefo', 'firefox'];
time('typing "firefox" (7 keystrokes total)', () => { eng.setEntries(entries); for (const q of typing) eng.search(q); });

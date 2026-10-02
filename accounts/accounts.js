import {prepare} from '../search/engine.js';

// Pure JS (no GI imports), shared by the shell process and the preferences process and
// unit-testable under plain node.
//
// What is stored where:
//  - the PASSWORD only ever lives in the GNOME Keyring (see accounts/vault.js);
//  - name, username and URL live in the "accounts" GSettings key so the launcher can search
//    them without unlocking the keyring on every keystroke. They are not secrets.

const MAX_ACCOUNTS = 1000;
export const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// http(s) only. A bare "example.com/login" is treated as https. Anything else (file:, javascript:,
// custom schemes, user:pass@ tricks...) is rejected so an account entry can never be used to launch
// something odd. Parsed with a strict pattern instead of the URL class, which is not available in
// every GJS version.
const URL_RE = /^(https?):\/\/([\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?)(?::(\d{1,5}))?([/?#]\S*)?$/iu;

function parseUrl(raw) {
    const t = text(raw, 500);
    if (!t)
        return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/\s:]+:\d{1,5}(?:[/?#]|$)/.test(t) ? t : `https://${t}`;
    const m = URL_RE.exec(withScheme);
    return m ? {scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), port: m[3] ?? '', rest: m[4] ?? '/'} : null;
}

export function safeUrl(raw) {
    const u = parseUrl(raw);
    return u ? `${u.scheme}://${u.host}${u.port ? `:${u.port}` : ''}${u.rest}` : '';
}

export function hostOf(raw) {
    return parseUrl(raw)?.host.replace(/^www\./, '') ?? '';
}

// One stored account record, or null when unusable. Never carries a password.
export function sanitizeAccount(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const id = typeof raw.id === 'string' && ID_RE.test(raw.id) ? raw.id : '';
    const name = text(raw.name, 120);
    if (!id || !name)
        return null;
    return {id, name, username: text(raw.username, 200), url: safeUrl(raw.url)};
}

export function sanitizeAccounts(list) {
    if (!Array.isArray(list))
        return [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const a = sanitizeAccount(raw);
        if (!a || seen.has(a.id))
            continue;
        seen.add(a.id);
        out.push(a);
        if (out.length >= MAX_ACCOUNTS)
            break;
    }
    return out;
}

// Search entries for the launcher (kind 'account'). The payload only holds the id; the password
// is fetched from the keyring at the moment the user picks the entry.
export function accountEntries(list) {
    return sanitizeAccounts(list)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(a => {
            const host = hostOf(a.url);
            return prepare({
                id: `account:${a.id}`, kind: 'account', name: a.name,
                desc: [a.username, host].filter(Boolean).join(' · '),
                category: 'Passwords', icon: 'dialog-password-symbolic',
                keywords: `${a.username} ${host}`.trim(), payload: {accountId: a.id, username: a.username, url: a.url},
            });
        });
}

// --- generation (callers supply the randomness: /dev/urandom in prefs, crypto in tests) ---------

const LOWER = 'abcdefghijkmnopqrstuvwxyz'; // no l
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O
const DIGITS = '23456789'; // no 0, 1
const SYMBOLS = '!@#$%^&*-_=+?';

// rand(n) must return n cryptographically secure random bytes (Uint8Array). Uses rejection
// sampling so every character is equally likely, and retries until the result contains every
// requested kind of character.
export function generatePassword(rand, {length = 20, symbols = true} = {}) {
    const len = Math.min(128, Math.max(8, Math.floor(length) || 20));
    const sets = [LOWER, UPPER, DIGITS, ...(symbols ? [SYMBOLS] : [])];
    const alphabet = sets.join('');
    const limit = 256 - (256 % alphabet.length);
    for (let attempt = 0; attempt < 100; attempt++) {
        let out = '';
        // A healthy source fills the password in one or two draws; a broken one (all bytes rejected)
        // must fail loudly instead of looping forever.
        for (let draws = 0; out.length < len; draws++) {
            if (draws >= 20)
                throw new Error('random source is unusable');
            for (const b of rand(len * 2)) {
                if (b < limit && out.length < len)
                    out += alphabet[b % alphabet.length];
            }
        }
        if (sets.every(set => [...out].some(ch => set.includes(ch))))
            return out;
    }
    throw new Error('could not generate a password');
}

// 128 random bits as hex: unique, safe as a keyring attribute value.
export function newAccountId(rand) {
    return [...rand(16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// How long a copied password may stay on the clipboard: 0 means "never clear it".
export function clearDelaySeconds(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(600, Math.max(0, Math.floor(n))) : 20;
}

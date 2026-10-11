import {prepare} from '../search/engine.js';

const MAX_ACCOUNTS = 1000;
export const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

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

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

export function generatePassword(rand, {length = 20, symbols = true} = {}) {
    const len = Math.min(128, Math.max(8, Math.floor(length) || 20));
    const sets = [LOWER, UPPER, DIGITS, ...(symbols ? [SYMBOLS] : [])];
    const alphabet = sets.join('');
    const limit = 256 - (256 % alphabet.length);
    for (let attempt = 0; attempt < 100; attempt++) {
        let out = '';
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

export function clearDelaySeconds(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(600, Math.max(0, Math.floor(n))) : 20;
}

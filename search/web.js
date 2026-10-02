// Pure JS (no GI imports). "Search the web / ask an AI" fallback entries.

import {prepare} from './engine.js';

export const WEB_MODES = ['off', 'empty', 'always'];

// Shipped defaults (also the default of the "web-providers" setting). `ai` only changes the wording
// and the category label.
export const DEFAULT_PROVIDERS = [
    {id: 'google', name: 'Google', url: 'https://www.google.com/search?q={query}', icon: 'system-search-symbolic', ai: false, enabled: true},
    {id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}', icon: 'system-search-symbolic', ai: false, enabled: false},
    {id: 'claude', name: 'Claude', url: 'https://claude.ai/new?q={query}', icon: 'dialog-question-symbolic', ai: true, enabled: true},
    {id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/?q={query}', icon: 'dialog-question-symbolic', ai: true, enabled: true},
    {id: 'perplexity', name: 'Perplexity', url: 'https://www.perplexity.ai/search?q={query}', icon: 'dialog-question-symbolic', ai: true, enabled: false},
];

const MAX_PROVIDERS = 20;
const MAX_QUERY = 500;
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// http(s) only, and the template must say where the search text goes.
export function validTemplate(url) {
    return typeof url === 'string' && /^https?:\/\/[^\s{}]+$/i.test(url.replace(/\{query\}/g, 'q')) && url.includes('{query}') && url.length <= 400;
}

export function sanitizeProvider(raw, index = 0) {
    if (!raw || typeof raw !== 'object')
        return null;
    const name = clean(raw.name, 60);
    const url = clean(raw.url, 400);
    if (!name || !validTemplate(url))
        return null;
    const id = clean(raw.id, 40).replace(/[^A-Za-z0-9_-]/g, '') || `p${index}`;
    return {id, name, url, icon: clean(raw.icon, 200), ai: raw.ai === true, enabled: raw.enabled !== false};
}

export function sanitizeProviders(list) {
    if (!Array.isArray(list))
        return [];
    const seen = new Set();
    const out = [];
    list.forEach((raw, i) => {
        const p = sanitizeProvider(raw, i);
        if (!p || seen.has(p.id) || out.length >= MAX_PROVIDERS)
            return;
        seen.add(p.id);
        out.push(p);
    });
    return out;
}

export const newProvider = () => ({id: `custom${Date.now().toString(36)}`, name: 'My search', url: 'https://example.com/search?q={query}', icon: '', ai: false, enabled: true});

export function buildUrl(template, query) {
    if (!validTemplate(template))
        return '';
    const q = String(query ?? '').trim().slice(0, MAX_QUERY);
    return q ? template.split('{query}').join(encodeURIComponent(q)) : '';
}

// Entries (kind 'web') for one query, one per enabled provider.
export function webEntries(providers, query) {
    const q = String(query ?? '').trim().slice(0, MAX_QUERY);
    if (!q)
        return [];
    const shown = q.length > 60 ? `${q.slice(0, 60)}…` : q;
    return providers.filter(p => p.enabled).map(p => prepare({
        id: `web:${p.id}`, kind: 'web',
        name: p.ai ? `Ask ${p.name}: “${shown}”` : `Search ${p.name} for “${shown}”`,
        desc: p.ai ? 'Opens in your browser' : 'Opens the results in your browser',
        category: p.ai ? 'Ask AI' : 'Web search',
        icon: p.icon || (p.ai ? 'dialog-question-symbolic' : 'system-search-symbolic'),
        payload: {url: buildUrl(p.url, q)},
    })).filter(e => e.payload.url);
}

// "? some words" forces web results regardless of the setting.
export function explicitWebQuery(query) {
    const m = /^\s*\?\s+(\S.*)$/.exec(String(query ?? ''));
    return m ? m[1] : null;
}

// Whether to add web entries after the local results.
export function offerWeb(mode, localCount, query) {
    if (!String(query ?? '').trim())
        return false;
    return mode === 'always' || (mode === 'empty' && localCount === 0);
}

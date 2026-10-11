
const MAX_LEN = 1000;

export function parseExec(query, prefix) {
    const p = typeof prefix === 'string' ? prefix.trim() : '';
    if (!p || typeof query !== 'string')
        return null;
    const q = query.trimStart();
    if (!q.startsWith(p))
        return null;
    const command = q.slice(p.length).trim();
    return {command: command.slice(0, MAX_LEN)};
}

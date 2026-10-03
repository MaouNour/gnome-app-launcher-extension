// Pure JS (no GI imports): the "run a command" prefix. Typing "!ls -la" (the symbol is configurable)
// offers to run what follows it.

const MAX_LEN = 1000;

// null when the query is not a command query (no prefix configured, or the text does not start with it).
// Otherwise {command}: the text after the prefix, trimmed ('' when nothing has been typed after it yet).
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

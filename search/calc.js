// Pure JS: tiny arithmetic evaluator (recursive descent, NO eval) for the quick-calculator
// entry. Supports + - * / % ^ ( ) and unary signs; "," or "." as decimal separator.
const MAX_LEN = 200;

export function calculate(input) {
    if (typeof input !== 'string' || input.length > MAX_LEN)
        return null;
    const s = input.trim().replace(/×/g, '*').replace(/÷/g, '/');
    if (!/^[0-9+\-*/%^().,\s]+$/.test(s) || !/[0-9]/.test(s))
        return null;
    // Needs a real operator (a leading sign alone is not a calculation).
    if (!/[+\-*/%^]/.test(s.replace(/^\s*[+-]/, '')))
        return null;

    const src = s.includes('.') ? s.replace(/,/g, '') : s.replace(/,/g, '.');
    let i = 0;
    let depth = 0;
    const peek = () => {
        while (src[i] === ' ' || src[i] === '\t')
            i++;
        return src[i];
    };
    const fail = () => {
        throw new Error('syntax');
    };
    const number = () => {
        peek();
        const m = /^(\d+(\.\d+)?|\.\d+)/.exec(src.slice(i));
        if (!m)
            fail();
        i += m[0].length;
        return parseFloat(m[0]);
    };
    const primary = () => {
        if (peek() !== '(')
            return number();
        if (++depth > 40)
            fail();
        i++;
        const v = expr();
        if (peek() !== ')')
            fail();
        i++;
        depth--;
        return v;
    };
    const power = () => {
        const base = primary();
        if (peek() === '^') {
            i++;
            return Math.pow(base, unary());
        }
        return base;
    };
    const unary = () => {
        const c = peek();
        if (c === '-') {
            i++;
            return -unary();
        }
        if (c === '+') {
            i++;
            return unary();
        }
        return power();
    };
    const term = () => {
        let v = unary();
        for (;;) {
            const c = peek();
            if (c === '*') {
                i++;
                v *= unary();
            } else if (c === '/') {
                i++;
                v /= unary();
            } else if (c === '%') {
                i++;
                v %= unary();
            } else {
                return v;
            }
        }
    };
    const expr = () => {
        let v = term();
        for (;;) {
            const c = peek();
            if (c === '+') {
                i++;
                v += term();
            } else if (c === '-') {
                i++;
                v -= term();
            } else {
                return v;
            }
        }
    };

    try {
        const v = expr();
        if (peek() !== undefined || !Number.isFinite(v))
            return null;
        return String(Number(v.toPrecision(12)));
    } catch (_e) {
        return null;
    }
}

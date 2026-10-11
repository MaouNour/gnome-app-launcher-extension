let enabled = false;

export function setDebug(value) {
    enabled = !!value;
}

export function dbg(...args) {
    if (enabled)
        console.log('[gnome-launcher]', ...args);
}

export function warn(...args) {
    console.warn('[gnome-launcher]', ...args);
}

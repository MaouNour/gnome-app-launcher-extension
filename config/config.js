export class Config {
    constructor(settings) {
        this.settings = settings;
        this._json = new Map();
        this._ids = [];
        this._ids.push(settings.connect('changed', (_s, key) => this._json.delete(key)));
    }

    str(key) { return this.settings.get_string(key); }
    int(key) { return this.settings.get_int(key); }
    num(key) { return this.settings.get_double(key); }
    bool(key) { return this.settings.get_boolean(key); }
    strv(key) { return this.settings.get_strv(key); }

    json(key, fallback) {
        if (this._json.has(key))
            return this._json.get(key);
        let value;
        try {
            value = JSON.parse(this.settings.get_string(key));
        } catch (_e) {
            value = fallback;
        }
        this._json.set(key, value);
        return value;
    }

    onChanged(callback) {
        const id = this.settings.connect('changed', (_s, key) => callback(key));
        this._ids.push(id);
        return id;
    }

    destroy() {
        for (const id of this._ids)
            this.settings.disconnect(id);
        this._ids = [];
        this._json.clear();
    }
}

import {dbg} from '../utils/log.js';

const SCHEMA_NAME = 'org.gnome.shell.extensions.gnome-launcher.account';

let loading = null;

// Resolves to a vault object, or null when libsecret cannot be loaded.
export function openVault() {
    if (!loading) {
        loading = import('gi://Secret?version=1').then(m => new Vault(m.default ?? m)).catch(e => {
            dbg(`libsecret unavailable: ${e.message}`);
            return null;
        });
    }
    return loading;
}

const call = (fn, finish) => new Promise((resolve, reject) => {
    fn((_src, res) => {
        try {
            resolve(finish(res));
        } catch (e) {
            reject(e);
        }
    });
});

class Vault {
    constructor(Secret) {
        this._s = Secret;
        this._schema = new Secret.Schema(SCHEMA_NAME, Secret.SchemaFlags.NONE, {
            id: Secret.SchemaAttributeType.STRING,
        });
    }

    store(id, label, password) {
        const S = this._s;
        return call(cb => S.password_store(this._schema, {id}, S.COLLECTION_DEFAULT, label, password, null, cb),
            res => S.password_store_finish(res));
    }

    // Resolves to the password, or null when none is stored under this id.
    lookup(id) {
        const S = this._s;
        return call(cb => S.password_lookup(this._schema, {id}, null, cb), res => S.password_lookup_finish(res));
    }

    remove(id) {
        const S = this._s;
        return call(cb => S.password_clear(this._schema, {id}, null, cb), res => S.password_clear_finish(res));
    }
}

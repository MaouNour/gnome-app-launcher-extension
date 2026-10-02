import {dbg} from '../utils/log.js';

// Password storage in the GNOME Keyring (Secret Service) through libsecret. Used by both the shell
// process (look a password up when the user picks an account) and the preferences process
// (store/delete). Nothing is ever written to a plain file or to GSettings: if libsecret is not
// available there is simply no vault, and callers say so instead of falling back to something weaker.
//
// libsecret is imported on demand so a system without its typelib only loses this feature.

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

    // All three are asynchronous so that a locked keyring asking for the login password never
    // blocks the compositor (or the preferences window).
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

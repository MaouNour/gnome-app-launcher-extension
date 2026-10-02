import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {BUILTINS} from '../commands/builtins.js';
import {generatePassword, hostOf, newAccountId, safeUrl, sanitizeAccounts} from '../accounts/accounts.js';
import {openVault} from '../accounts/vault.js';
import {group, shortcutRow, spinRow, switchRow, toast} from './widgets.js';

// Random bytes from the kernel. Used for generated passwords and account ids.
function randomBytes(n) {
    const stream = Gio.File.new_for_path('/dev/urandom').read(null);
    try {
        return new Uint8Array(stream.read_bytes(n, null).get_data());
    } finally {
        stream.close(null);
    }
}

function readAccounts(settings) {
    try {
        return sanitizeAccounts(JSON.parse(settings.get_string('accounts')));
    } catch (_e) {
        return [];
    }
}

const writeAccounts = (settings, list) => settings.set_string('accounts', JSON.stringify(list));

// Add / edit dialog. `account` is the existing record or null. The password is write-only here: it is
// never read back from the keyring into this window, so editing an account means typing a new
// one or leaving the field empty to keep the stored one.
function editDialog(window, settings, vault, account) {
    const dialog = new Adw.Dialog({title: account ? 'Edit account' : 'Add account', content_width: 460});
    const view = new Adw.ToolbarView();
    const header = new Adw.HeaderBar({show_start_title_buttons: false, show_end_title_buttons: false});
    const cancel = new Gtk.Button({label: 'Cancel'});
    const save = new Gtk.Button({label: 'Save', css_classes: ['suggested-action']});
    header.pack_start(cancel);
    header.pack_end(save);
    view.add_top_bar(header);

    const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_top: 12, margin_bottom: 18, margin_start: 18, margin_end: 18});
    const g = new Adw.PreferencesGroup();
    const name = new Adw.EntryRow({title: 'Name (for example the site)', text: account?.name ?? ''});
    const user = new Adw.EntryRow({title: 'Username or email', text: account?.username ?? ''});
    const pw = new Adw.PasswordEntryRow({title: account ? 'New password (empty keeps the current one)' : 'Password'});
    const url = new Adw.EntryRow({title: 'Website (optional)', text: account?.url ?? ''});
    const gen = new Gtk.Button({icon_name: 'view-refresh-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Generate a strong password'});
    gen.connect('clicked', () => {
        pw.text = generatePassword(randomBytes, {length: 20, symbols: true});
    });
    pw.add_suffix(gen);
    for (const r of [name, user, pw, url])
        g.add(r);
    body.append(g);
    const status = new Gtk.Label({css_classes: ['error'], xalign: 0, wrap: true, visible: false});
    body.append(status);
    view.set_content(body);
    dialog.set_child(view);

    const fail = msg => {
        status.label = msg;
        status.visible = true;
        save.sensitive = true;
    };
    cancel.connect('clicked', () => dialog.close());
    save.connect('clicked', async () => {
        const label = name.text.trim();
        if (!label)
            return fail('Give the account a name.');
        if (!account && !pw.text)
            return fail('Enter a password, or use the button to generate one.');
        if (url.text.trim() && !safeUrl(url.text))
            return fail('The website must be an http or https address.');
        save.sensitive = false;
        const id = account?.id ?? newAccountId(randomBytes);
        try {
            if (pw.text)
                await vault.store(id, label, pw.text);
        } catch (e) {
            return fail(`The keyring refused the password: ${e.message}`);
        }
        const rec = {id, name: label, username: user.text.trim(), url: safeUrl(url.text)};
        const list = readAccounts(settings).filter(a => a.id !== id);
        list.push(rec);
        writeAccounts(settings, list);
        pw.text = '';
        dialog.close();
        toast(window, account ? 'Account updated.' : 'Account saved to the keyring.');
        return undefined;
    });
    dialog.present(window);
}

function confirmDelete(window, settings, vault, account) {
    const dialog = new Adw.AlertDialog({
        heading: `Delete "${account.name}"?`,
        body: 'The account and its password are removed from the keyring. This cannot be undone.',
    });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('delete', 'Delete');
    dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', async (_d, response) => {
        if (response !== 'delete')
            return;
        try {
            await vault.remove(account.id);
        } catch (e) {
            toast(window, `The keyring could not delete the password: ${e.message}`);
            return;
        }
        writeAccounts(settings, readAccounts(settings).filter(a => a.id !== account.id));
        toast(window, 'Account deleted.');
    });
    dialog.present(window);
}

export function accountsPage(window, settings, store, ownShortcuts) {
    const p = new Adw.PreferencesPage({title: 'Accounts', icon_name: 'dialog-password-symbolic'});
    let vault = null;

    const main = group('Passwords and accounts',
        'A small vault inside the launcher. Passwords are stored only in the GNOME Keyring (encrypted, unlocked with your login); ' +
        'the launcher keeps just the name, username and website to search them. Nothing is stored in a plain file, and the vault is ' +
        'a view of its own, so accounts never appear in normal search results.');
    main.add(switchRow(settings, 'accounts-enabled', 'Enable the accounts vault'));
    main.add(spinRow(settings, 'account-clear-seconds', 'Clear a copied password after (seconds)', 0, 600, 5,
        '0 leaves it on the clipboard. A copied password is also kept out of the clipboard history.'));
    p.add(main);

    const list = group('Saved accounts');
    const addBtn = new Gtk.Button({label: 'Add account', css_classes: ['suggested-action'], valign: Gtk.Align.CENTER, sensitive: false});
    addBtn.connect('clicked', () => vault && editDialog(window, settings, vault, null));
    list.set_header_suffix(addBtn);
    p.add(list);

    const notice = new Adw.ActionRow({
        title: 'Checking for the keyring…',
        subtitle: 'Saving passwords needs libsecret and a running keyring such as GNOME Keyring.',
    });
    list.add(notice);

    let rows = [];
    const render = () => {
        for (const r of rows)
            list.remove(r);
        rows = [];
        const accounts = readAccounts(settings).sort((a, b) => a.name.localeCompare(b.name));
        if (vault && accounts.length === 0) {
            notice.title = 'No accounts yet';
            notice.subtitle = 'Use Add account to save one.';
            notice.visible = true;
        } else if (vault) {
            notice.visible = false;
        }
        for (const a of accounts) {
            const row = new Adw.ActionRow({title: a.name, subtitle: [a.username, hostOf(a.url)].filter(Boolean).join(' · ')});
            const edit = new Gtk.Button({icon_name: 'document-edit-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Edit'});
            const del = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: 'Delete'});
            edit.connect('clicked', () => vault && editDialog(window, settings, vault, a));
            del.connect('clicked', () => vault && confirmDelete(window, settings, vault, a));
            row.add_suffix(edit);
            row.add_suffix(del);
            list.add(row);
            rows.push(row);
        }
    };
    settings.connect('changed::accounts', render);
    render();

    openVault().then(v => {
        vault = v;
        addBtn.sensitive = !!v;
        if (!v) {
            notice.title = 'Keyring support is not available';
            notice.subtitle = 'Install libsecret (with its GObject introspection data) and make sure GNOME Keyring is running. Until then no passwords can be saved or read.';
            notice.visible = true;
        } else {
            render();
        }
    });

    const keys = group('How to use it',
        'Open the vault by typing "passwords" in the launcher or with the shortcut below, then:');
    for (const [title, sub] of [
        ['Enter', 'Copy the password (it is cleared from the clipboard after the delay above)'],
        ['Shift+Enter', 'Type the password into the window you were using'],
        ['Ctrl+Enter', 'Copy the username'],
        ['Alt+Enter', 'Open the website'],
    ])
        keys.add(new Adw.ActionRow({title, subtitle: sub}));
    p.add(keys);

    const sc = group('Shortcuts', 'A global shortcut works anywhere. A window shortcut only works while the launcher is open.');
    const def = BUILTINS.find(b => b.id === 'accounts');
    sc.add(shortcutRow(window, 'Open the accounts vault', () => store.read().accounts?.shortcut ?? '', v => store.write('accounts', 'shortcut', v),
        accel => ownShortcuts(settings).filter(([a, n]) => a === accel && n !== def.name).map(([, n]) => `"${n}"`)));
    sc.add(shortcutRow(window, 'Open the accounts vault (only while the launcher is open)',
        () => store.read().accounts?.windowShortcut ?? '', v => store.write('accounts', 'windowShortcut', v), () => [], true));
    p.add(sc);
    return p;
}

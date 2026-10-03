import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {launchApp} from '../applications/launch.js';
import {dbg, warn} from '../utils/log.js';

const ENV_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

function expandHome(p) {
    if (p === '~')
        return GLib.get_home_dir();
    if (p.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), p.slice(2)]);
    return p;
}

// Shell-style tokenising (quotes respected) WITHOUT invoking a shell.
function parseArgv(text) {
    try {
        const [ok, argv] = GLib.shell_parse_argv(text);
        if (!ok || argv.length === 0)
            throw new Error('empty');
        return argv.map(expandHome);
    } catch (_e) {
        throw new Error(`Invalid command syntax: ${text}`);
    }
}

function parseEnv(text) {
    if (!text)
        return [];
    return parseArgv(text).map(pair => {
        const m = ENV_RE.exec(pair);
        if (!m)
            throw new Error(`Bad environment entry: ${pair}`);
        return [m[1], m[2]];
    });
}

function checkExecutable(exe) {
    if (exe.includes('/')) {
        if (!GLib.file_test(exe, GLib.FileTest.IS_REGULAR))
            throw new Error(`"${exe}" does not exist`);
        if (!GLib.file_test(exe, GLib.FileTest.IS_EXECUTABLE))
            throw new Error(`"${exe}" is not executable`);
    } else if (!GLib.find_program_in_path(exe)) {
        throw new Error(`Command "${exe}" not found in PATH`);
    }
}

function spawn(argv, env = [], opts = {}) {
    checkExecutable(argv[0]);
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    for (const [k, v] of env)
        launcher.setenv(k, v, true);
    if (opts.cwd)
        launcher.set_cwd(opts.cwd);
    const proc = launcher.spawnv(argv);
    proc.wait_async(null, (p, res) => {
        try {
            p.wait_finish(res);
        } catch (e) {
            dbg(`${argv[0]} exited abnormally: ${e.message}`);
            return;
        }
        if (p.get_if_exited() && p.get_exit_status() !== 0) {
            dbg(`${argv[0]} exited with status ${p.get_exit_status()}`);
            opts.onFail?.(p.get_exit_status());
        }
    });
}

export function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri_async(uri, global.create_app_launch_context(0, -1), null, (_o, res) => {
        try {
            Gio.AppInfo.launch_default_for_uri_finish(res);
        } catch (e) {
            warn(`could not open ${uri}: ${e.message}`);
            Main.notify('GNOME Launcher', `Could not open ${uri}: ${e.message}`);
        }
    });
}

const GNOME = {
    'reboot': () => spawn(['gnome-session-quit', '--reboot']),
    'toggle-dark-mode': () => {
        const s = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        s.set_string('color-scheme', s.get_string('color-scheme') === 'prefer-dark' ? 'default' : 'prefer-dark');
    },
    'toggle-dnd': () => {
        const s = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        s.set_boolean('show-banners', !s.get_boolean('show-banners'));
    },
    'overview': () => Main.overview.show(),
    'app-grid': () => Main.overview.showApps(),
    'screenshot': () => Main.screenshotUI.open(),
    'lock-screen': () => Main.screenShield.lock(true),
    'settings': () => spawn(['gnome-control-center']),
    'logout': () => spawn(['gnome-session-quit', '--logout']),
    'suspend': () => spawn(['systemctl', 'suspend']),
    'power-off': () => spawn(['gnome-session-quit', '--power-off']),
};

// Executes entries. Every failure path throws an Error with a user-presentable message;
// the caller catches it, so a broken entry never takes the extension down.
export class Runner {
    // hooks: {clearClipboard(), pasteEmojiBuffer(), openPrefs()} provided by the extension for built-in entries.
    constructor(hooks = {}) {
        this._hooks = hooks;
    }

    run(entry) {
        const p = entry.payload;
        switch (entry.kind) {
        case 'app':
            return launchApp(p.appId);
        case 'command':
            return spawn(parseArgv(`${p.command} ${p.args}`.trim()), parseEnv(p.env));
        case 'action':
            return this._action(p);
        case 'system':
            return this._gnome(p.target);
        case 'exec':
            return this._exec(p);
        default:
            throw new Error(`Unknown entry kind "${entry.kind}"`);
        }
    }

    // "!command": through /bin/sh (pipes, &&, $VARS and globs work) or, when `shell` is off, split like a
    // shell would but run directly. Runs in the home folder. A non-zero exit is reported once, nothing is
    // captured (a program that prints a lot or keeps running must never be able to block on its output).
    _exec({command, shell}) {
        const text = String(command ?? '').trim();
        if (!text)
            throw new Error('No command given');
        const argv = shell ? ['/bin/sh', '-c', text] : parseArgv(text);
        const short = text.length > 60 ? `${text.slice(0, 60)}…` : text;
        spawn(argv, [], {
            cwd: GLib.get_home_dir(),
            onFail: status => Main.notify('GNOME Launcher', status === 127
                ? `Command not found: ${short}` : `"${short}" exited with status ${status}`),
        });
    }

    _action(a) {
        switch (a.type) {
        case 'app':
            return launchApp(a.target.endsWith('.desktop') ? a.target : `${a.target}.desktop`);
        case 'shell':
            // Explicit, user-authored shell snippet (the only place a shell is involved).
            return spawn(['/bin/sh', '-c', `${a.target} ${a.args}`.trim()]);
        case 'url':
            return openUri(a.target);
        case 'file':
        case 'dir': {
            const path = expandHome(a.target);
            const want = a.type === 'dir' ? GLib.FileTest.IS_DIR : GLib.FileTest.IS_REGULAR;
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                throw new Error(`"${path}" does not exist`);
            if (!GLib.file_test(path, want))
                throw new Error(`"${path}" is not a ${a.type === 'dir' ? 'directory' : 'file'}`);
            return openUri(Gio.File.new_for_path(path).get_uri());
        }
        case 'script': {
            const path = expandHome(a.target);
            return spawn([path, ...(a.args ? parseArgv(a.args) : [])]);
        }
        case 'gnome':
            return this._gnome(a.target);
        default:
            throw new Error(`Unknown action type "${a.type}"`);
        }
    }

    _gnome(target) {
        if (target === 'clear-clipboard')
            return this._hooks.clearClipboard?.();
        if (target === 'launcher-settings')
            return this._hooks.openPrefs?.();
        if (target === 'save-clipboard')
            return this._hooks.saveClipboard?.();
        if (target === 'emoji-paste-buffer')
            return this._hooks.pasteEmojiBuffer?.();
        const fn = GNOME[target];
        if (!fn)
            throw new Error(`Unknown GNOME action "${target}"`);
        return fn();
    }
}

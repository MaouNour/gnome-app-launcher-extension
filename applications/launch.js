import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

// Launch (or focus) an installed application by desktop-file id. Throws if it is gone,
// so the caller can notify the user and trigger an index refresh.
// opts.newWindow: open another window even when the application is already running.
export function launchApp(appId, opts = {}) {
    const app = Shell.AppSystem.get_default().lookup_app(appId);
    if (app) {
        if (opts.newWindow && app.can_open_new_window()) {
            app.open_new_window(-1);
            return;
        }
        app.activate();
        return;
    }
    const info = Gio.DesktopAppInfo.new(appId);
    if (!info)
        throw new Error(`Application "${appId}" is no longer installed`);
    info.launch([], global.create_app_launch_context(0, -1));
}

// One of the actions a desktop file lists (for example "New Private Window").
export function launchAppAction(appId, action) {
    const info = Gio.DesktopAppInfo.new(appId);
    if (!info)
        throw new Error(`Application "${appId}" is no longer installed`);
    if (!info.list_actions().includes(action))
        throw new Error(`"${action}" is no longer an action of this application`);
    info.launch_action(action, global.create_app_launch_context(0, -1));
}

// What the action menu can offer for an application.
export function describeApp(appId) {
    const info = Gio.DesktopAppInfo.new(appId);
    if (!info)
        return null;
    const app = Shell.AppSystem.get_default().lookup_app(appId);
    return {
        file: info.get_filename(),
        commandline: info.get_commandline() ?? '',
        actions: info.list_actions().map(a => ({id: a, name: info.get_action_name(a) || a})),
        running: !!app && app.get_state() !== Shell.AppState.STOPPED,
        canNewWindow: !!app && app.can_open_new_window(),
    };
}

export function quitApp(appId) {
    Shell.AppSystem.get_default().lookup_app(appId)?.request_quit();
}

// Opens a file in the default text editor (used to edit a desktop file).
export function editFile(path) {
    const f = Gio.File.new_for_path(path);
    const editor = Gio.AppInfo.get_default_for_type('text/plain', false);
    if (!editor)
        throw new Error('No default text editor found');
    editor.launch([f], global.create_app_launch_context(0, -1));
}

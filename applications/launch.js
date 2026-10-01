import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

// Launch (or focus) an installed application by desktop-file id. Throws if it is gone,
// so the caller can notify the user and trigger an index refresh.
export function launchApp(appId) {
    const app = Shell.AppSystem.get_default().lookup_app(appId);
    if (app) {
        app.activate();
        return;
    }
    const info = Gio.DesktopAppInfo.new(appId);
    if (!info)
        throw new Error(`Application "${appId}" is no longer installed`);
    info.launch([], global.create_app_launch_context(0, -1));
}

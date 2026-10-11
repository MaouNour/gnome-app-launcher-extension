export const UUID = 'gnome-launcher@maou-nournar';
export const WM_CLASS = 'gnome-launcher';
export const APP_ID = 'org.gnome.shell.extensions.gnome-launcher';
export const SCHEMA_ID = 'org.gnome.shell.extensions.gnome-launcher';
export const TITLE = 'GNOME Launcher';

export const IDENTITY = {
    // The full-screen layer that holds the window.
    overlay: {name: 'gnome-launcher-overlay', styleClass: 'gnome-launcher-overlay', accessibleName: `${TITLE} overlay`},
    window: {
        name: WM_CLASS,
        styleClass: `gnome-launcher gnome-launcher-window ${WM_CLASS} ${APP_ID.replace(/\./g, '-')}`,
        accessibleName: TITLE,
    },
};

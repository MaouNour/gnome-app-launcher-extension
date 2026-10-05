// Pure JS (no GI imports): the names under which the launcher window can be recognised.
//
// The launcher is a Shell actor, not a window of its own, so it has no WM_CLASS in the window-manager
// sense. These names are what other tools can use to find it: the actor `name` and `style_class` (CSS
// selectors, other extensions walking the actor tree), the accessible name, and the GSettings schema of this
// extension. They are all derived from one place so they never drift apart.
export const UUID = 'gnome-launcher@maou-nournar';
export const WM_CLASS = 'gnome-launcher';
export const APP_ID = 'org.gnome.shell.extensions.gnome-launcher';
export const SCHEMA_ID = 'org.gnome.shell.extensions.gnome-launcher';
export const TITLE = 'GNOME Launcher';

export const IDENTITY = {
    // The full-screen layer that holds the window.
    overlay: {name: 'gnome-launcher-overlay', styleClass: 'gnome-launcher-overlay', accessibleName: `${TITLE} overlay`},
    // The visible launcher window (rounded box with the search field and the results).
    window: {
        name: WM_CLASS,
        styleClass: `gnome-launcher gnome-launcher-window ${WM_CLASS} ${APP_ID.replace(/\./g, '-')}`,
        accessibleName: TITLE,
    },
};

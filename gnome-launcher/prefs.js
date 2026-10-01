import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {buildPages} from './prefs/pages.js';

export default class GnomeLauncherPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        // Keep a reference so the GSettings object lives as long as the window.
        const settings = window._settings = this.getSettings();
        window.set_default_size(720, 760);
        for (const page of buildPages(window, settings))
            window.add(page);
    }
}

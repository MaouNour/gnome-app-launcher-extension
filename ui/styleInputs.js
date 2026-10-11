import {resolveTheme} from '../themes/themes.js';

export function styleInputs(c, dark, activeColor) {
    const theme = resolveTheme({
        custom: c.json('custom-themes', []),
        name: dark ? c.str('theme-dark') : c.str('theme-light'),
        dark,
        overrides: c.json('theme-overrides', {}),
    });
    return {
        layout: {
            width: c.int('width'), windowHeight: c.int('window-height'), maxHeight: c.int('max-height'),
            searchHeight: c.int('search-height'), searchPosition: c.str('search-position'),
            rowHeight: c.int('row-height'), iconSize: c.int('icon-size'), fontSize: c.num('font-size'),
            scale: c.num('scale'), padding: c.int('padding'), resultSpacing: c.int('result-spacing'),
            searchPadding: c.int('search-padding'), iconSpacing: c.int('icon-spacing'),
            showDescriptions: c.bool('show-descriptions'), showTags: c.bool('show-tags'),
            placeholder: c.str('placeholder'),
            searchIcon: c.str('search-icon').trim(), searchIconSize: c.int('search-icon-size'),
            showScrollbar: c.bool('show-scrollbar'), gridCell: c.int('emoji-grid-size'),
            emojiFont: c.str('emoji-font'),
            shadow: c.bool('shadow-enabled'),
            activeIndicator: c.str('active-indicator'), activePosition: c.str('active-position'),
            activeColor: activeColor(theme.accent),
            activeSize: c.int('active-size'), activeSelMode: c.str('active-color-selected'),
            activeSelColor: c.str('active-color-selected-custom'),
            ringColor: c.str('search-ring') === 'off' ? null : activeColor(theme.accent, 'search-ring', 'search-ring-color'),
            ringWidth: c.int('search-ring-width'),
            fonts: {
                search: {family: c.str('font-search'), size: c.num('font-size-search'), weight: c.int('font-weight-search')},
                main: {family: c.str('font-main'), weight: c.int('font-weight-main')},
                secondary: {family: c.str('font-secondary'), size: c.num('font-size-secondary'), weight: c.int('font-weight-secondary')},
            },
        },
        theme,
    };
}

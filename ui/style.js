import {cssColor} from '../themes/themes.js';

// Builds every inline St style string once per settings/theme change (not per
// keystroke). Pure function: layout numbers + resolved theme in, strings out.
export function buildStyles(l, t) {
    const s = l.scale;
    const px = n => `${Math.max(0, Math.round(n * s))}px`;
    const pt = n => `${(n * s).toFixed(2)}pt`;
    const font = (t.fontFamily ? `font-family: ${t.fontFamily}; ` : '') + `font-weight: ${t.fontWeight}; `;
    const shadow = t.shadowOpacity > 0
        ? `box-shadow: 0 ${px(t.shadowOffsetY)} ${px(t.shadowBlur)} rgba(0,0,0,${t.shadowOpacity}); `
        : '';
    const minH = l.windowHeight > 0 ? `min-height: ${px(l.windowHeight)}; ` : '';
    const fg = cssColor(t.foreground);
    const sel = cssColor(t.selectionText);
    const sec = cssColor(t.secondary);
    const rowBase = `height: ${px(l.rowHeight)}; padding: 0 ${px(l.padding)}; border-radius: ${px(t.rowRadius)}; spacing: ${px(l.iconSpacing)}; `;
    const rowH = Math.round(l.rowHeight * s);
    const gap = Math.round(l.resultSpacing * s);

    // Emoji grid: square cells laid out in as many columns as fit the window, centred.
    const cell = Math.round((l.gridCell ?? 44) * s);
    const gridGap = Math.max(2, gap);
    const innerW = Math.round((l.width - l.padding * 2) * s);
    const gridCols = Math.max(1, Math.floor((innerW + gridGap) / (cell + gridGap)));
    const gridPad = Math.max(0, Math.floor((innerW - (gridCols * cell + (gridCols - 1) * gridGap)) / 2));
    const cellBase = `width: ${cell}px; height: ${cell}px; border-radius: ${px(t.rowRadius)}; `;
    const cellFont = `font-size: ${Math.round(cell * 0.58)}px; `;

    return {
        box: `width: ${px(l.width)}; ${minH}padding: ${px(l.padding)}; spacing: ${px(l.padding * 0.6)}; ` +
            `background-color: ${cssColor(t.background, t.opacity)}; ` +
            `border: ${px(t.borderWidth)} solid ${cssColor(t.border)}; border-radius: ${px(t.radius)}; ${shadow}`,
        entry: `min-height: ${px(l.searchHeight)}; padding: 0 ${px(l.searchPadding)}; spacing: ${px(l.iconSpacing)}; ` +
            `border-radius: ${px(t.searchRadius)}; background-color: ${cssColor(t.searchBackground)}; ` +
            `color: ${fg}; caret-color: ${cssColor(t.accent)}; selection-background-color: ${cssColor(t.accent)}; ` +
            `selected-color: ${sel}; font-size: ${pt(l.fontSize * 1.25)}; ${font}border-width: 0;`,
        hint: `color: ${sec};`,
        list: `spacing: ${gap}px;`,
        row: `${rowBase}background-color: transparent;`,
        rowSel: `${rowBase}background-color: ${cssColor(t.selection)};`,
        title: `color: ${fg}; font-size: ${pt(l.fontSize)}; ${font}`,
        titleSel: `color: ${sel}; font-size: ${pt(l.fontSize)}; ${font}`,
        sub: `color: ${sec}; font-size: ${pt(l.fontSize * 0.82)};`,
        subSel: `color: ${cssColor(t.selectionText, 0.75)}; font-size: ${pt(l.fontSize * 0.82)};`,
        tag: `color: ${sec}; font-size: ${pt(l.fontSize * 0.75)};`,
        tagSel: `color: ${cssColor(t.selectionText, 0.75)}; font-size: ${pt(l.fontSize * 0.75)};`,
        icon: `-st-icon-style: ${t.iconStyle};`,
        // Emoji rows draw the glyph as text instead of an icon, sized to fill the icon slot.
        glyph: `color: ${fg}; font-size: ${Math.round(l.iconSize * s * 0.68)}px; min-width: ${Math.round(l.iconSize * s)}px; text-align: center;`,
        cell: cellBase,
        cellSel: `${cellBase}background-color: ${cssColor(t.selection)}; `,
        cellText: `color: ${fg}; ${cellFont}`,
        cellTextSel: `color: ${sel}; ${cellFont}`,
        gridRow: `spacing: ${gridGap}px; padding-left: ${gridPad}px;`,
        gridHint: `color: ${sec}; font-size: ${pt(l.fontSize)}; ${font}padding: ${px(4)} ${px(l.padding)} 0 ${px(l.padding)};`,
        gridHintH: Math.round(l.fontSize * 2 * s + 4 * s),
        gridCols, gridCell: cell, gridGap,
        glyphSel: `color: ${sel}; font-size: ${Math.round(l.iconSize * s * 0.68)}px; min-width: ${Math.round(l.iconSize * s)}px; text-align: center;`,
        empty: `color: ${sec}; font-size: ${pt(l.fontSize)}; padding: ${px(l.padding)};`,
        iconSize: Math.round(l.iconSize * s),
        rowH,
        gap,
        maxListH: Math.max(rowH, Math.round((l.maxHeight - l.searchHeight - l.padding * 3) * s)),
        showDesc: l.showDescriptions,
        showTags: l.showTags,
        searchPosition: l.searchPosition,
        blur: t.blur,
        placeholder: l.placeholder,
        searchIcon: l.searchIcon,
        searchIconSize: Math.max(8, Math.round(l.searchIconSize * s)),
        searchIconStyle: `color: ${sec}; -st-icon-style: ${t.iconStyle};`,
        showScrollbar: l.showScrollbar,
    };
}

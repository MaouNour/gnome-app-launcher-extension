import {cssColor} from '../themes/themes.js';
import {isColor, markOnSelection} from './accent.js';

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);

export function cssFontFamily(name) {
    return String(name ?? '').split(',')
        .map(p => p.replace(/[^\p{L}\p{N} _.-]/gu, '').trim())
        .filter(Boolean).slice(0, 4)
        .map(p => (GENERIC_FAMILIES.has(p.toLowerCase()) ? p.toLowerCase() : `"${p}"`))
        .join(', ');
}

export const MARK_SHAPES = ['dot', 'dash', 'ring', 'square', 'pill', 'bar'];

function markCss(kind, color, s, size, below = false) {
    const k = (s * (size > 0 ? size : 100)) / 100;
    const px = n => `${Math.max(1, Math.round(n * k))}px`;
    const gap = below ? `margin-top: ${Math.max(1, Math.round(2 * s))}px; ` : '';
    const fill = `background-color: ${color}; `;
    switch (kind) {
    case 'dash':
        return `${gap}${fill}width: ${px(14)}; height: ${px(3)}; border-radius: ${px(2)};`;
    case 'pill':
        return `${gap}${fill}width: ${px(18)}; height: ${px(6)}; border-radius: ${px(3)};`;
    case 'square':
        return `${gap}${fill}width: ${px(6)}; height: ${px(6)}; border-radius: ${px(1)};`;
    case 'bar':
        return `${gap}${fill}width: ${px(3)}; height: ${px(16)}; border-radius: ${px(2)};`;
    case 'ring':
        return `${gap}border: ${px(1.5)} solid ${color}; width: ${px(7)}; height: ${px(7)}; border-radius: ${px(5)};`;
    default:
        return `${gap}${fill}width: ${px(6)}; height: ${px(6)}; border-radius: ${px(3)};`;
    }
}

export function buildStyles(l, t) {
    const s = l.scale;
    const px = n => `${Math.max(0, Math.round(n * s))}px`;
    const pt = n => `${(n * s).toFixed(2)}pt`;
    const slotCss = f => {
        const fam = cssFontFamily(f?.family) || cssFontFamily(t.fontFamily);
        return `${fam ? `font-family: ${fam}; ` : ''}font-weight: ${f?.weight > 0 ? f.weight : t.fontWeight}; `;
    };
    const fonts = l.fonts ?? {};
    const searchFont = slotCss(fonts.search);
    const font = slotCss(fonts.main);
    const detailFont = slotCss(fonts.secondary);
    const searchSize = fonts.search?.size > 0 ? fonts.search.size : l.fontSize * 1.25;
    const detailSize = fonts.secondary?.size > 0 ? fonts.secondary.size : l.fontSize * 0.82;
    const tagSize = detailSize * (0.75 / 0.82);
    const shadow = l.shadow && t.shadowOpacity > 0
        ? `box-shadow: 0 ${px(t.shadowOffsetY)} ${px(t.shadowBlur)} rgba(0,0,0,${t.shadowOpacity}); `
        : '';
    const minH = l.windowHeight > 0 ? `min-height: ${px(l.windowHeight)}; ` : '';
    const fg = cssColor(t.foreground);
    const sel = cssColor(t.selectionText);
    const sec = cssColor(t.secondary);
    const below = l.activePosition === 'below';
    const selMark = l.activeSelMode === 'same' ? l.activeColor
        : l.activeSelMode === 'custom' && isColor(l.activeSelColor) ? l.activeSelColor.trim()
        : markOnSelection({mark: l.activeColor, selection: t.selection, background: t.background, selectionText: t.selectionText});
    const rowBase = `height: ${px(l.rowHeight)}; padding: 0 ${px(l.padding)}; border-radius: ${px(t.rowRadius)}; spacing: ${px(l.iconSpacing)}; `;
    const rowH = Math.round(l.rowHeight * s);
    const gap = Math.round(l.resultSpacing * s);

    const cell = Math.round((l.gridCell ?? 44) * s);
    const gridGap = Math.max(2, gap);
    const innerW = Math.round((l.width - l.padding * 2) * s);
    const gridCols = Math.max(1, Math.floor((innerW + gridGap) / (cell + gridGap)));
    const gridPad = Math.max(0, Math.floor((innerW - (gridCols * cell + (gridCols - 1) * gridGap)) / 2));
    const cellBase = `width: ${cell}px; height: ${cell}px; border-radius: ${px(t.rowRadius)}; `;
    const emojiFam = cssFontFamily(l.emojiFont);
    const emojiFace = emojiFam ? `font-family: ${emojiFam}; ` : '';
    const cellFont = `${emojiFace}font-size: ${Math.round(cell * 0.58)}px; `;

    return {
        box: `width: ${px(l.width)}; ${minH}padding: ${px(l.padding)}; spacing: ${px(l.padding * 0.6)}; ` +
            `background-color: ${cssColor(t.background, t.opacity)}; ` +
            `border: ${px(t.borderWidth)} solid ${cssColor(t.border)}; border-radius: ${px(t.radius)}; ${shadow}`,
        entry: `min-height: ${px(l.searchHeight)}; padding: 0 ${px(l.searchPadding)}; spacing: ${px(l.iconSpacing)}; ` +
            `border-radius: ${px(t.searchRadius)}; background-color: ${cssColor(t.searchBackground)}; ` +
            `color: ${fg}; caret-color: ${cssColor(t.accent)}; selection-background-color: ${cssColor(t.accent)}; ` +
            `selected-color: ${sel}; font-size: ${pt(searchSize)}; ${searchFont}border-width: 0; ` +
            (l.ringColor ? `box-shadow: inset 0 0 0 ${px(Math.max(1, l.ringWidth ?? 2))} ${l.ringColor};` : 'box-shadow: none;'),
        hint: `color: ${sec}; ${searchFont}`,
        list: `spacing: ${gap}px;`,
        row: `${rowBase}background-color: transparent;`,
        rowSel: `${rowBase}background-color: ${cssColor(t.selection)};`,
        title: `color: ${fg}; font-size: ${pt(l.fontSize)}; ${font}`,
        titleSel: `color: ${sel}; font-size: ${pt(l.fontSize)}; ${font}`,
        sub: `color: ${sec}; font-size: ${pt(detailSize)}; ${detailFont}`,
        subSel: `color: ${cssColor(t.selectionText, 0.75)}; font-size: ${pt(detailSize)}; ${detailFont}`,
        tag: `color: ${sec}; font-size: ${pt(tagSize)}; ${detailFont}`,
        tagSel: `color: ${cssColor(t.selectionText, 0.75)}; font-size: ${pt(tagSize)}; ${detailFont}`,
        icon: `-st-icon-style: ${t.iconStyle};`,
        active: markCss(l.activeIndicator, l.activeColor, s, l.activeSize, below),
        activeSel: markCss(l.activeIndicator, selMark, s, l.activeSize, below),
        activeOn: MARK_SHAPES.includes(l.activeIndicator),
        activeAfter: l.activePosition === 'after',
        activePos: l.activePosition === 'after' || l.activePosition === 'below' ? l.activePosition : 'before',
        glyph: `color: ${fg}; ${emojiFace}font-size: ${Math.round(l.iconSize * s * 0.68)}px; min-width: ${Math.round(l.iconSize * s)}px; text-align: center;`,
        cell: cellBase,
        cellSel: `${cellBase}background-color: ${cssColor(t.selection)}; `,
        cellText: `color: ${fg}; ${cellFont}`,
        cellTextSel: `color: ${sel}; ${cellFont}`,
        gridRow: `spacing: ${gridGap}px; padding-left: ${gridPad}px;`,
        gridHint: `color: ${sec}; font-size: ${pt(l.fontSize)}; ${font}padding: ${px(4)} ${px(l.padding)} 0 ${px(l.padding)};`,
        gridHintH: Math.round(l.fontSize * 2 * s + 4 * s),
        sectionTitle: `color: ${sec}; font-size: ${pt(detailSize)}; ${detailFont}padding-left: ${gridPad}px;`,
        sectionH: Math.round(l.fontSize * 2 * s),
        gridCols, gridCell: cell, gridGap,
        glyphSel: `color: ${sel}; ${emojiFace}font-size: ${Math.round(l.iconSize * s * 0.68)}px; min-width: ${Math.round(l.iconSize * s)}px; text-align: center;`,
        empty: `color: ${sec}; font-size: ${pt(l.fontSize)}; ${font}padding: ${px(l.padding)};`,
        iconSize: l.activePosition === 'below' && MARK_SHAPES.includes(l.activeIndicator)
            ? Math.max(8, Math.min(Math.round(l.iconSize * s), Math.round(l.rowHeight * s) - Math.round(8 * s * (l.activeSize > 0 ? l.activeSize : 100) / 100) - 4))
            : Math.round(l.iconSize * s),
        rowH,
        gap,
        maxListH: Math.max(rowH, Math.round((l.maxHeight - l.searchHeight - l.padding * 3) * s)),
        showDesc: l.showDescriptions,
        showTags: l.showTags,
        searchPosition: l.searchPosition,
        placeholder: l.placeholder,
        searchIcon: l.searchIcon,
        searchIconSize: Math.max(8, Math.round(l.searchIconSize * s)),
        searchIconStyle: `color: ${sec}; -st-icon-style: ${t.iconStyle};`,
        showScrollbar: l.showScrollbar,
    };
}

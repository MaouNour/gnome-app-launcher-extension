// Pure JS (no GI imports): where the launcher window goes on the monitor.
//
// The window sits in a full-monitor overlay and is placed with an alignment (start / centre / end) per
// axis plus margins. Margins can only be positive, so a move towards the anchor's edge shrinks the
// margin on that edge and a move away from it grows the margin, instead of using a negative number.
// The result is always a complete set (both alignments and all four margins), so nothing from a
// previous placement can linger.

export const ANCHORS = [
    ['custom', 'Custom: centred, at the vertical position above'],
    ['top-left', 'Top left'],
    ['top', 'Top centre'],
    ['top-right', 'Top right'],
    ['left', 'Middle left'],
    ['center', 'Middle (centre of the screen)'],
    ['right', 'Middle right'],
    ['bottom-left', 'Bottom left'],
    ['bottom', 'Bottom centre'],
    ['bottom-right', 'Bottom right'],
];

const KNOWN = new Set(ANCHORS.map(a => a[0]));
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);

// One axis. `align` is start | center | end. `inset` is how much of the monitor's edge the shell uses on
// the anchor side (top bar...), `gap` the distance kept from the edge, `off` the user's move in pixels
// (positive = right / down), `centerShift` how far the middle of the usable area is from the monitor's
// middle, `size` the monitor's size on this axis and `win` the most the window can take of it.
function axis(align, {inset, gap, off, centerShift, size, win}) {
    const room = Math.max(0, size - win); // keep the window fully on the monitor
    let before = 0;
    let after = 0;
    if (align === 'start') {
        before = inset + gap + off;
    } else if (align === 'end') {
        after = inset + gap - off;
    } else {
        // A centred actor whose margin on one side is m ends up m/2 off the middle, so m = 2 x the move.
        const d = centerShift + off;
        if (d >= 0)
            before = 2 * d;
        else
            after = -2 * d;
        return {before: Math.min(before, room), after: Math.min(after, room)};
    }
    return {before: Math.min(Math.max(0, before), room), after: Math.min(Math.max(0, after), room)};
}

// anchor: one of ANCHORS | pos: vertical position in % (the 'custom' anchor) | searchAtBottom: the search bar
// is below the results | gap, offX, offY: pixels | mon, work: {x, y, width, height} of the monitor and of
// its usable area (without the top bar) | winW, winH: the largest size the window can have.
// Returns {xAlign, yAlign, top, bottom, left, right}.
export function computePlacement({anchor, pos, searchAtBottom, gap, offX, offY, mon, work, winW, winH}) {
    const a = KNOWN.has(anchor) ? anchor : 'custom';
    const g = Math.max(0, int(gap, 24));
    const ox = int(offX);
    const oy = int(offY);
    const w = work ?? mon;
    const win = {w: Math.min(Math.max(0, int(winW)), mon.width), h: Math.min(Math.max(0, int(winH)), mon.height)};

    let xAlign = 'center';
    let yAlign = 'start';
    let x;
    let y;
    const xCommon = {size: mon.width, win: win.w, off: ox, gap: g};
    const yCommon = {size: mon.height, win: win.h, off: oy, gap: g};
    const xShift = (w.x + w.width / 2) - (mon.x + mon.width / 2);
    const yShift = (w.y + w.height / 2) - (mon.y + mon.height / 2);

    if (a === 'custom') {
        // The original behaviour: centred horizontally, the top (or, with the search bar at the bottom,
        // the bottom) edge at `pos` percent of the screen height.
        const p = Math.min(95, Math.max(0, int(pos, 18)));
        xAlign = 'center';
        x = axis('center', {...xCommon, gap: 0, inset: 0, centerShift: 0});
        if (searchAtBottom) {
            yAlign = 'end';
            y = axis('end', {...yCommon, gap: 0, inset: Math.round(mon.height * (100 - p) / 100)});
        } else {
            yAlign = 'start';
            y = axis('start', {...yCommon, gap: 0, inset: Math.round(mon.height * p / 100)});
        }
    } else {
        const parts = a.split('-');
        xAlign = parts.includes('left') ? 'start' : parts.includes('right') ? 'end' : 'center';
        yAlign = parts.includes('top') ? 'start' : parts.includes('bottom') ? 'end' : 'center';
        x = axis(xAlign, {...xCommon, centerShift: xShift,
            inset: xAlign === 'start' ? w.x - mon.x : (mon.x + mon.width) - (w.x + w.width)});
        y = axis(yAlign, {...yCommon, centerShift: yShift,
            inset: yAlign === 'start' ? w.y - mon.y : (mon.y + mon.height) - (w.y + w.height)});
    }
    const r = Math.round;
    return {xAlign, yAlign, left: r(x.before), right: r(x.after), top: r(y.before), bottom: r(y.after)};
}

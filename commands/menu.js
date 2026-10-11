import {prepare} from '../search/engine.js';
import {describeApp} from '../applications/launch.js';
import {dirName} from '../files/results.js';
import {warn} from '../utils/log.js';

export const HIDEABLE_KINDS = new Set(['app', 'command', 'action', 'system', 'mode']);

const row = (op, name, desc, icon, extra = {}) => prepare({
    id: `menu:${op}:${extra.action ?? ''}`, kind: 'menu', name, desc, icon, category: 'Action', payload: {op, ...extra},
});
const copy = (name, text, action) => row('copy', name, text, 'edit-copy-symbolic', {text, action});
const open = (label, icon = 'media-playback-start-symbolic') => row('open', label, 'Same as Enter', icon);

function appItems(e) {
    let info = null;
    try {
        info = describeApp(e.payload.appId);
    } catch (err) {
        warn(`describeApp: ${err.message}`);
    }
    const items = [open(info?.running ? 'Switch to it' : 'Open')];
    if (info?.running && info.canNewWindow)
        items.push(row('newWindow', 'New window', 'Open another window of the running application', 'window-new-symbolic'));
    items.push(row('newWorkspace', 'Open in a new workspace', 'Switch to an empty workspace and start it there', 'view-grid-symbolic'));
    for (const a of info?.actions ?? [])
        items.push(row('appaction', a.name, 'Action of the application', 'emblem-system-symbolic', {action: a.id}));
    if (info?.running)
        items.push(row('quit', 'Quit', 'Ask the application to close all its windows', 'application-exit-symbolic'));
    if (info?.file) {
        items.push(row('showDir', 'Show the desktop entry in the file manager', info.file, 'folder-open-symbolic', {path: info.file}));
        items.push(row('editDesktop', 'Open the desktop entry in a text editor', info.file, 'document-edit-symbolic', {path: info.file}));
        items.push(copy('Copy the desktop entry path', info.file, 'path'));
    }
    if (info?.commandline)
        items.push(copy('Copy the command', info.commandline, 'cmd'));
    items.push(copy('Copy the name', e.name, 'name'));
    return items;
}

function entryItems(e) {
    const items = [open('Run')];
    const isCommand = e.kind === 'command';
    const text = isCommand ? `${e.payload.command} ${e.payload.args ?? ''}`.trim() : String(e.payload.target ?? '');
    if (text)
        items.push(copy(isCommand ? 'Copy the command' : 'Copy the target', text, 'cmd'));
    items.push(row('prefs', 'Edit in the preferences', 'Opens the extension preferences', 'preferences-system-symbolic'));
    return items;
}

function fileItems(e) {
    const path = e.payload.path;
    return [
        open('Open', 'document-open-symbolic'),
        row('showDir', 'Show in the file manager', dirName(path), 'folder-open-symbolic', {path}),
        copy('Copy the path', path, 'path'),
        copy('Copy the name', e.name, 'name'),
    ];
}

// ctx: {favorites: bool (feature on), isFavorite, hasUsage}
export function menuItems(e, ctx) {
    let items;
    if (e.kind === 'app')
        items = appItems(e);
    else if (e.kind === 'command' || e.kind === 'action')
        items = entryItems(e);
    else if (e.kind === 'system' || e.kind === 'mode')
        items = [open('Run')];
    else if (e.kind === 'file')
        return fileItems(e);
    else
        return [];

    if (ctx.favorites) {
        items.push(ctx.isFavorite
            ? row('favorite', 'Remove from favorites', 'It is listed first when the launcher opens', 'starred-symbolic')
            : row('favorite', 'Add to favorites', 'List it first when the launcher opens', 'starred-symbolic'));
    }
    items.push(row('hide', 'Hide from search', 'Show it again in the preferences, under Hidden entries', 'view-conceal-symbolic'));
    if (ctx.hasUsage)
        items.push(row('forget', 'Forget usage history', 'Resets how often and when you opened it', 'edit-clear-all-symbolic'));
    return items;
}

import Gio from 'gi://Gio';

const P = Gio.File.prototype;
for (const name of ['load_contents', 'replace_contents', 'replace_contents_bytes', 'copy', 'query_info', 'enumerate_children'])
    Gio._promisify(P, `${name}_async`, name === 'replace_contents_bytes' ? 'replace_contents_finish' : `${name}_finish`);
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');

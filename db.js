// 歌都存在浏览器的 IndexedDB 里（通过酒馆自带的 localforage）。
// 设置文件里只放小东西，歌、封面、歌词都在这里。

const { localforage } = SillyTavern.libs;
const DB_NAME = 'SharedEarphones';

const meta = localforage.createInstance({ name: DB_NAME, storeName: 'meta' });
const audio = localforage.createInstance({ name: DB_NAME, storeName: 'audio' });
const covers = localforage.createInstance({ name: DB_NAME, storeName: 'covers' });
const lyrics = localforage.createInstance({ name: DB_NAME, storeName: 'lyrics' });

/** @typedef {{id:string, title:string, artist:string, file:string, hasCover:boolean, hasLyrics:boolean, duration:number, added:number}} SongMeta */
/** @typedef {{id:string, name:string, songIds:string[]}} Playlist */

export async function loadLibrary() {
    const index = (await meta.getItem('index')) || [];
    const playlists = (await meta.getItem('playlists')) || [];
    return { index, playlists };
}

export const saveIndex = (index) => meta.setItem('index', index);
export const savePlaylists = (playlists) => meta.setItem('playlists', playlists);

export const putAudio = (id, blob) => audio.setItem(id, blob);
export const getAudio = (id) => audio.getItem(id);
export const putCover = (id, blob) => covers.setItem(id, blob);
export const getCover = (id) => covers.getItem(id);
export const putLyrics = (id, text) => lyrics.setItem(id, text);
export const getLyrics = (id) => lyrics.getItem(id);

export async function removeSongData(id) {
    await Promise.all([audio.removeItem(id), covers.removeItem(id), lyrics.removeItem(id)]);
}

export async function clearAll() {
    await Promise.all([meta.clear(), audio.clear(), covers.clear(), lyrics.clear()]);
}

export async function requestPersist() {
    try {
        if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
            await navigator.storage.persist();
        }
    } catch { /* 不支持就算了 */ }
}

// ---------- 备份 ----------
// 格式：'SEBK' + 版本(1字节) + 头长度(4字节) + 头(JSON) + 依次拼接的音频/封面二进制。
// 用 Blob 拼接，不转 base64，几百兆也不会把内存撑爆。

const MAGIC = [0x53, 0x45, 0x42, 0x4b];

export async function exportBackup() {
    const { index, playlists } = await loadLibrary();
    const parts = [];
    const items = [];
    const lyricMap = {};
    let offset = 0;
    for (const s of index) {
        const a = await getAudio(s.id);
        if (a) {
            items.push({ kind: 'audio', id: s.id, type: a.type || 'audio/mpeg', size: a.size, offset });
            parts.push(a); offset += a.size;
        }
        if (s.hasCover) {
            const c = await getCover(s.id);
            if (c) {
                items.push({ kind: 'cover', id: s.id, type: c.type || 'image/jpeg', size: c.size, offset });
                parts.push(c); offset += c.size;
            }
        }
        if (s.hasLyrics) {
            const l = await getLyrics(s.id);
            if (l) lyricMap[s.id] = l;
        }
    }
    const header = new TextEncoder().encode(JSON.stringify({ version: 1, index, playlists, lyrics: lyricMap, items }));
    const pre = new Uint8Array(9);
    pre.set(MAGIC, 0);
    pre[4] = 1;
    new DataView(pre.buffer).setUint32(5, header.length);
    return new Blob([pre, header, ...parts], { type: 'application/octet-stream' });
}

/**
 * 导入备份，和现有的合并：同一首歌不会重复，同名歌单合并歌曲。
 * @returns {Promise<{songs:number, playlists:number}>}
 */
export async function importBackup(file) {
    const pre = new Uint8Array(await file.slice(0, 9).arrayBuffer());
    if (!MAGIC.every((v, i) => pre[i] === v)) throw new Error('这不是共享耳机的备份文件');
    const hlen = new DataView(pre.buffer).getUint32(5);
    const header = JSON.parse(new TextDecoder().decode(await file.slice(9, 9 + hlen).arrayBuffer()));
    const base = 9 + hlen;
    const lib = await loadLibrary();
    const have = new Set(lib.index.map(s => s.id));
    let added = 0;
    for (const s of header.index) {
        if (have.has(s.id)) continue;
        for (const it of header.items.filter(x => x.id === s.id)) {
            const blob = file.slice(base + it.offset, base + it.offset + it.size, it.type);
            // 复制成独立的 Blob 再存，Safari 对切片引用支持不稳
            const copy = new Blob([await blob.arrayBuffer()], { type: it.type });
            if (it.kind === 'audio') await putAudio(s.id, copy);
            else if (it.kind === 'cover') await putCover(s.id, copy);
        }
        if (header.lyrics?.[s.id]) await putLyrics(s.id, header.lyrics[s.id]);
        lib.index.push(s);
        have.add(s.id);
        added++;
    }
    let plAdded = 0;
    for (const p of header.playlists || []) {
        const same = lib.playlists.find(x => x.id === p.id || x.name === p.name);
        if (same) {
            for (const id of p.songIds) if (!same.songIds.includes(id) && have.has(id)) same.songIds.push(id);
        } else {
            lib.playlists.push({ ...p, songIds: p.songIds.filter(id => have.has(id)) });
            plAdded++;
        }
    }
    await saveIndex(lib.index);
    await savePlaylists(lib.playlists);
    return { songs: added, playlists: plAdded };
}

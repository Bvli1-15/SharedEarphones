// 联网补全：歌词来自 LRCLIB（免费开放的歌词库），封面来自苹果音乐的公开搜索。
// 两个服务都允许网页直接访问，不经过任何中转。

const LRCLIB = 'https://lrclib.net/api';
const ITUNES = 'https://itunes.apple.com/search';

const norm = (s) => (s || '').toLowerCase().replace(/[(（[【].*?[)）\]】]/g, '').replace(/[\s\-–—_·・.,，。'"!！?？&/:：]/g, '');

async function getJSON(url, ms = 15000, tries = 2) {
    for (let i = 0; i < tries; i++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), ms);
        try {
            const r = await fetch(url, { signal: ctl.signal });
            if (r.status === 404) return null;
            if (r.status === 429 && i < tries - 1) {
                // 被限速：按对方给的时间等一等再试
                const wait = Math.min(Number(r.headers.get('retry-after')) || 5, 30);
                await new Promise(res => setTimeout(res, wait * 1000));
                continue;
            }
            if (r.status === 403 || r.status === 429) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status, limited: true });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
        } catch (e) {
            if (e.limited || i === tries - 1) throw e;
            await new Promise(res => setTimeout(res, 800)); // 网络抖一下就再试一次
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

// 两个名字有一半以上的字相同就算同一个人（照顾简繁体写法不同，比如 周杰伦 / 周杰倫）
function sameArtist(a, b) {
    const x = norm(a), y = norm(b);
    if (!x || !y) return false;
    if (x.includes(y) || y.includes(x)) return true;
    const set = new Set(y);
    const common = [...x].filter(ch => set.has(ch)).length;
    return common / Math.min(x.length, y.length) >= 0.5 && Math.min(x.length, y.length) >= 2;
}

function toResult(x) {
    return {
        id: x.id,
        title: x.trackName || x.name || '',
        artist: x.artistName || '',
        album: x.albumName || '',
        duration: x.duration || 0,
        synced: x.syncedLyrics || '',
        plain: x.plainLyrics || '',
        instrumental: !!x.instrumental,
    };
}

/**
 * 手动搜索歌词：返回候选列表。
 */
export async function searchLyrics(query) {
    const q = (query || '').trim();
    if (!q) return [];
    const list = await getJSON(`${LRCLIB}/search?q=${encodeURIComponent(q)}`);
    return (list || []).map(toResult);
}

function score(r, title, artist, duration) {
    let s = 0;
    if (r.synced) s += 3; else if (r.plain) s += 1;
    if (r.instrumental) s += 1;
    if (norm(r.title) === norm(title)) s += 3; else if (norm(r.title).includes(norm(title)) || norm(title).includes(norm(r.title))) s += 1;
    if (artist && sameArtist(r.artist, artist)) s += 2;
    if (duration && r.duration) {
        const d = Math.abs(r.duration - duration);
        if (d <= 3) s += 3; else if (d <= 10) s += 1; else if (d > 30) s -= 3;
    }
    return s;
}

/**
 * 自动找歌词。找到返回 {text, instrumental}，找不到返回 null。
 */
export async function findLyrics({ title, artist, duration }) {
    if (!title) return null;
    // 每首歌尽量只问一次歌词库，对它友好一点，也不容易被限速
    const url = artist
        ? `${LRCLIB}/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`
        : `${LRCLIB}/search?q=${encodeURIComponent(title)}`;
    let list = ((await getJSON(url)) || []).map(toResult);
    if (!list.length && artist) list = ((await getJSON(`${LRCLIB}/search?q=${encodeURIComponent(title)}`)) || []).map(toResult);
    if (!list.length) return null;
    list.sort((a, b) => score(b, title, artist, duration) - score(a, title, artist, duration));
    const best = list[0];
    // 太不像就不要了，免得配错。没有歌手信息的时候要求更严：歌名一致而且时长对得上
    if (score(best, title, artist, duration) < (artist ? 4 : 8)) return null;
    if (best.instrumental) return { text: '', instrumental: true };
    if (!best.synced && !best.plain) return null;
    return { text: best.synced || best.plain, instrumental: false };
}

/**
 * 自动找封面。中文歌在台湾、香港区收录得比较全，所以先查这两个区。
 * @returns {Promise<Blob|null>}
 */
export async function findCover({ title, artist }) {
    // 没有歌手信息很容易配错（同名的歌太多），干脆不自动找
    if (!title || !artist) return null;
    const term = encodeURIComponent(`${title} ${artist || ''}`.trim());
    for (const country of ['tw', 'hk', 'us', 'jp']) {
        let data;
        try {
            data = await getJSON(`${ITUNES}?term=${term}&entity=song&limit=8&country=${country}`, 12000, 1);
        } catch (e) {
            if (e.limited) throw Object.assign(new Error('封面搜索太频繁，被暂时限制了'), { limited: true });
            continue;
        }
        const results = data?.results || [];
        let best = null, bestScore = 0;
        for (const r of results) {
            let s = 0;
            const t = norm(r.trackName), want = norm(title);
            if (t === want) s += 3; else if (t.includes(want) || want.includes(t)) s += 1;
            if (sameArtist(r.artistName, artist)) s += 2;
            if (s > bestScore) { best = r; bestScore = s; }
        }
        if (!best || bestScore < 4 || !best.artworkUrl100) continue; // 歌名和歌手都要对得上
        const art = best.artworkUrl100.replace(/\d+x\d+bb/, '600x600bb');
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 12000);
        try {
            const r = await fetch(art, { signal: ctl.signal });
            if (r.ok) return await r.blob();
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

// 流行歌：GD音乐台（music.gdstudio.xyz）的接口。
// 只在线播放，不下载、不存音频。歌单里只记来源和曲目 ID，每次播放时现取链接（链接过一阵会失效）。
// 对方限制 5 分钟 50 次请求，这里自己数着，快到了就先停。

const API = 'https://music-api.gdstudio.xyz/api.php';

export const GD_SOURCES = [
    ['netease', '网易云'],
    ['joox', 'JOOX'],
];
export const GD_NAME = Object.fromEntries(GD_SOURCES);

const WINDOW = 5 * 60 * 1000;
const LIMIT = 45;               // 留一点余量，不顶着 50 次用
const calls = [];

function checkBudget() {
    const now = Date.now();
    while (calls.length && now - calls[0] > WINDOW) calls.shift();
    if (calls.length >= LIMIT) {
        const wait = Math.ceil((WINDOW - (now - calls[0])) / 60000);
        throw Object.assign(new Error(`GD音乐台限制 5 分钟 50 次，这阵子用得有点多，大约 ${wait} 分钟后再试`), { limited: true });
    }
    calls.push(now);
}

async function call(params, ms = 15000) {
    checkBudget();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
        const r = await fetch(`${API}?${new URLSearchParams(params)}`, { signal: ctl.signal });
        if (r.status === 429 || r.status === 403) throw Object.assign(new Error('GD音乐台让我们慢一点，过几分钟再试'), { limited: true });
        if (!r.ok) throw new Error('GD音乐台暂时连不上');
        return await r.json();
    } catch (e) {
        if (e.name === 'AbortError') throw new Error('GD音乐台响应太慢，等会儿再试');
        throw e;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 搜歌。返回 { items, hasMore }。
 */
export async function searchGD(query, source = 'netease', page = 1) {
    const q = (query || '').trim();
    if (!q) return { items: [], hasMore: false };
    const size = 20;
    const list = await call({ types: 'search', source, name: q, count: size, pages: page });
    const items = (Array.isArray(list) ? list : []).filter(x => x?.id).map(x => ({
        source: x.source || source,
        id: String(x.id),
        picId: x.pic_id ? String(x.pic_id) : '',
        title: (x.name || '未命名').trim(),
        artist: (Array.isArray(x.artist) ? x.artist.join(' / ') : (x.artist || '')).trim(),
        album: (x.album || '').trim(),
    }));
    return { items, hasMore: items.length >= size };
}

// 刚取到的链接留几分钟，切回同一首不用再问一次
const urlCache = new Map();
const URL_TTL = 8 * 60 * 1000;

/**
 * 取播放链接。拿不到返回 ''。
 * @param {{source:string, id:string}} gd
 * @param {boolean} fresh 跳过缓存（链接失效时用）
 */
export async function resolveGD(gd, fresh = false) {
    const key = `${gd.source}:${gd.id}`;
    const hit = urlCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < URL_TTL) return hit.url;
    const d = await call({ types: 'url', source: gd.source, id: gd.id, br: 320 });
    const url = (d?.url || '').replace(/^http:\/\//, 'https://');
    if (url) urlCache.set(key, { url, at: Date.now() }); else urlCache.delete(key);
    return url;
}

/** 下载封面，失败就算了 */
export async function fetchGDCover(source, picId) {
    if (!picId) return null;
    try {
        const d = await call({ types: 'pic', source, id: picId, size: 500 }, 12000);
        if (!d?.url) return null;
        const r = await fetch(d.url.replace(/^http:\/\//, 'https://'));
        if (!r.ok) return null;
        const b = await r.blob();
        return b.type.startsWith('image/') ? b : null;
    } catch { return null; }
}

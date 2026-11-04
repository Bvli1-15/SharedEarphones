// 在线找歌：Openverse 收录的开放授权音乐（大多来自 Jamendo）。
// 不用注册，网页能直接搜；歌也允许直接下载存进浏览器。

const API = 'https://api.openverse.org/v1/audio/';

// 中文情绪词 → 英文搜索词（曲库基本是英文的）
export const MOODS = [
    ['钢琴', 'piano'], ['雨天', 'rain'], ['爵士', 'jazz'], ['Lo-fi', 'lofi'], ['夜晚', 'night'],
    ['氛围', 'ambient'], ['电影感', 'cinematic'], ['民谣', 'acoustic folk'], ['悲伤', 'sad'],
    ['温柔', 'gentle'], ['浪漫', 'romantic'], ['悬疑', 'dark suspense'], ['古典', 'classical'], ['复古', 'retro'],
];

const LICENSE = {
    by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc': 'CC BY-NC', 'by-nd': 'CC BY-ND',
    'by-nc-sa': 'CC BY-NC-SA', 'by-nc-nd': 'CC BY-NC-ND', cc0: 'CC0', pdm: '公有领域',
};

const SOURCE = { jamendo: 'Jamendo', freesound: 'Freesound', wikimedia_audio: 'Wikimedia', ccmixter: 'ccMixter' };

function toItem(x) {
    return {
        id: x.id,
        title: (x.title || '未命名').trim(),
        artist: (x.creator || '').trim(),
        url: x.url,
        duration: (x.duration || 0) / 1000,
        license: LICENSE[x.license] || (x.license || '').toUpperCase(),
        licenseUrl: x.license_url || '',
        pageUrl: x.foreign_landing_url || '',
        source: SOURCE[x.source] || x.source || '',
        thumb: x.thumbnail || '',
    };
}

/**
 * 搜歌。返回 { items, hasMore }。
 */
export async function searchFree(query, page = 1) {
    const q = (query || '').trim();
    if (!q) return { items: [], hasMore: false };
    const url = `${API}?q=${encodeURIComponent(q)}&category=music&page_size=20&page=${page}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
        const r = await fetch(url, { signal: ctl.signal });
        if (r.status === 429) throw Object.assign(new Error('搜得太快了，歇一会儿再搜'), { limited: true });
        if (!r.ok) throw new Error('曲库暂时连不上');
        const d = await r.json();
        const items = (d.results || []).filter(x => x.url).map(toItem);
        return { items, hasMore: page < (d.page_count || 1) };
    } finally {
        clearTimeout(timer);
    }
}

/** 下载封面小图，失败就算了 */
export async function fetchThumb(url) {
    if (!url) return null;
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        const b = await r.blob();
        return b.type.startsWith('image/') ? b : null;
    } catch { return null; }
}

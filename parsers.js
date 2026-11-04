// 读取 mp3 里的 ID3 标签（歌名、歌手、封面、内嵌歌词），以及解析 LRC 歌词。
// 只依赖浏览器自带能力，不引外部库。

function syncsafe(b, o) {
    return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

function decodeText(bytes, enc) {
    try {
        if (enc === 0) return new TextDecoder('latin1').decode(bytes);
        if (enc === 1) return new TextDecoder('utf-16').decode(bytes);
        if (enc === 2) return new TextDecoder('utf-16be').decode(bytes);
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return '';
    }
}

function clean(s) {
    return (s || '').replace(/\u0000/g, '').trim();
}

// 找字符串结束符的位置（UTF-16 是两个 0 字节）
function findTerminator(b, start, enc) {
    if (enc === 1 || enc === 2) {
        for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
        return b.length;
    }
    for (let i = start; i < b.length; i++) if (b[i] === 0) return i;
    return b.length;
}

/**
 * 读 ID3v2.3 / v2.4。读不到就返回空对象，不报错。
 * @param {File} file
 * @returns {Promise<{title?:string, artist?:string, cover?:Blob, lyrics?:string}>}
 */
export async function readID3(file) {
    const out = {};
    try {
        const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
        if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out; // "ID3"
        const ver = head[3];
        if (ver < 3 || ver > 4) return out;
        const size = syncsafe(head, 6);
        const b = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
        let p = 0;
        // 跳过扩展头
        if (head[5] & 0x40) {
            const ext = ver === 4 ? syncsafe(b, 0) : ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) + 4;
            p += ext;
        }
        while (p + 10 <= b.length) {
            const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
            if (!/^[A-Z0-9]{4}$/.test(id)) break;
            const fsize = ver === 4 ? syncsafe(b, p + 4) : ((b[p + 4] << 24) | (b[p + 5] << 16) | (b[p + 6] << 8) | b[p + 7]);
            const body = b.subarray(p + 10, p + 10 + fsize);
            p += 10 + fsize;
            if (!fsize || !body.length) continue;
            const enc = body[0];
            if (id === 'TIT2') out.title = clean(decodeText(body.subarray(1), enc));
            else if (id === 'TPE1') out.artist = clean(decodeText(body.subarray(1), enc)).replace(/\u0000/g, '/');
            else if (id === 'USLT' && !out.lyrics) {
                // 编码(1) 语言(3) 描述(以结束符结尾) 正文
                const descEnd = findTerminator(body, 4, enc);
                const textStart = descEnd + ((enc === 1 || enc === 2) ? 2 : 1);
                out.lyrics = clean(decodeText(body.subarray(textStart), enc));
            } else if (id === 'TXXX' && !out.lyrics) {
                // 有些软件把歌词写在自定义字段里，描述叫 LYRICS / UNSYNCEDLYRICS / USLT
                const descEnd = findTerminator(body, 1, enc);
                const desc = clean(decodeText(body.subarray(1, descEnd), enc));
                if (/lyric|uslt/i.test(desc)) {
                    const textStart = descEnd + ((enc === 1 || enc === 2) ? 2 : 1);
                    out.lyrics = clean(decodeText(body.subarray(textStart), enc));
                }
            } else if (id === 'APIC' && !out.cover) {
                const mimeEnd = findTerminator(body, 1, 0);
                const mime = decodeText(body.subarray(1, mimeEnd), 0) || 'image/jpeg';
                const descStart = mimeEnd + 2; // 跳过结束符和图片类型字节
                const descEnd = findTerminator(body, descStart, enc);
                const imgStart = descEnd + ((enc === 1 || enc === 2) ? 2 : 1);
                const img = body.slice(imgStart);
                if (img.length > 100) out.cover = new Blob([img], { type: mime.includes('/') ? mime : 'image/' + mime.toLowerCase() });
            }
        }
    } catch (e) {
        console.warn('[共享耳机] 读取标签失败', e);
    }
    return out;
}

/**
 * 从文件名猜歌名和歌手："歌手 - 歌名.mp3"
 */
export function guessFromFilename(name) {
    const base = name.replace(/\.[^.]+$/, '').trim();
    const m = base.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) return { artist: m[1].trim(), title: m[2].trim(), base };
    return { title: base, artist: '', base };
}

export function normalizeName(s) {
    return (s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[\s\-–—_·・.,，。()（）[\]【】'"]/g, '');
}

/**
 * 解析歌词。带时间轴就按时间排序；没有时间轴就当纯文本。
 * @returns {{timed:boolean, lines:{t:number, text:string}[]}}
 */
export function parseLyrics(text) {
    const lines = [];
    let offset = 0;
    let timed = false;
    const raw = (text || '').replace(/\r/g, '').split('\n');
    for (const line of raw) {
        const off = line.match(/^\[offset:\s*([+-]?\d+)\s*\]/i);
        if (off) { offset = Number(off[1]) / 1000; continue; }
        if (/^\[(ti|ar|al|by|re|ve|length|au):/i.test(line)) continue;
        const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
        const content = line.replace(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
        if (stamps.length) {
            timed = true;
            for (const s of stamps) {
                const t = Number(s[1]) * 60 + Number(s[2].replace(':', '.'));
                lines.push({ t: Math.max(0, t - offset), text: content });
            }
        } else if (content) {
            lines.push({ t: -1, text: content });
        }
    }
    if (timed) {
        const timedLines = lines.filter(l => l.t >= 0).sort((a, b) => a.t - b.t);
        // 去掉开头连续的空行，保留中间的空行作为间奏
        while (timedLines.length && !timedLines[0].text) timedLines.shift();
        return { timed: true, lines: timedLines };
    }
    return { timed: false, lines };
}

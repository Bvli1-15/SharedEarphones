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

// ======================================================
// 其他格式：m4a / flac / ogg / wav
// ======================================================

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);

async function readBytes(file, start, end) {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

// Vorbis 注释：flac 和 ogg 共用
function parseVorbisComments(b, o) {
    const out = {};
    const vlen = u32le(b, o); o += 4 + vlen;
    const n = u32le(b, o); o += 4;
    for (let i = 0; i < n && o + 4 <= b.length; i++) {
        const len = u32le(b, o); o += 4;
        if (o + len > b.length) break;
        const s = utf8(b.subarray(o, o + len)); o += len;
        const eq = s.indexOf('=');
        if (eq < 0) continue;
        const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1).trim();
        if (k === 'TITLE' && !out.title) out.title = v;
        else if (k === 'ARTIST' && !out.artist) out.artist = v;
        else if ((k === 'LYRICS' || k === 'UNSYNCEDLYRICS' || k === 'SYNCEDLYRICS') && !out.lyrics) out.lyrics = v;
    }
    return out;
}

async function readFLAC(file) {
    const out = {};
    let p = 4;
    for (let guard = 0; guard < 64; guard++) {
        const h = await readBytes(file, p, p + 4);
        if (h.length < 4) break;
        const last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
        if (type === 4 || (type === 6 && !out.cover)) {
            const b = await readBytes(file, p + 4, p + 4 + len);
            if (type === 4) Object.assign(out, parseVorbisComments(b, 0), out);
            else {
                let o = 4;
                const ml = u32(b, o); o += 4; const mime = ascii(b, o, ml); o += ml;
                const dl = u32(b, o); o += 4 + dl + 16;
                const size = u32(b, o); o += 4;
                if (size > 100) out.cover = new Blob([b.slice(o, o + size)], { type: mime || 'image/jpeg' });
            }
        }
        p += 4 + len;
        if (last) break;
    }
    return out;
}

async function readOGG(file) {
    // 只在开头 128KB 里找注释块，够用了
    const b = await readBytes(file, 0, 131072);
    const find = (sig) => {
        outer: for (let i = 0; i < b.length - sig.length; i++) {
            for (let j = 0; j < sig.length; j++) if (b[i + j] !== sig[j]) continue outer;
            return i + sig.length;
        }
        return -1;
    };
    let o = find([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]); // OpusTags
    if (o < 0) o = find([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]); // \x03vorbis
    if (o < 0) return {};
    try { return parseVorbisComments(b, o); } catch { return {}; }
}

async function readMP4(file) {
    const out = {};
    // 在顶层找 moov（有的文件 moov 在末尾）
    let p = 0, moov = null;
    for (let guard = 0; guard < 200 && p < file.size; guard++) {
        const h = await readBytes(file, p, p + 16);
        if (h.length < 8) break;
        let size = u32(h, 0);
        const type = ascii(h, 4, 4);
        if (size === 1) size = Number((BigInt(u32(h, 8)) << 32n) | BigInt(u32(h, 12)));
        else if (size === 0) size = file.size - p;
        if (type === 'moov') { moov = await readBytes(file, p + 8, p + size); break; }
        if (size < 8) break;
        p += size;
    }
    if (!moov) return out;
    const walk = (b, start, end, path) => {
        let o = start;
        while (o + 8 <= end) {
            const size = u32(b, o), type = ascii(b, o + 4, 4);
            if (size < 8 || o + size > end) break;
            const body = o + 8;
            if (path === 'ilst') {
                // 每个条目里有一个 data 子块
                let d = body;
                while (d + 16 <= o + size) {
                    const ds = u32(b, d), dt = ascii(b, d + 4, 4);
                    if (ds < 16) break;
                    if (dt === 'data') {
                        const kind = u32(b, d + 8) & 0xffffff;
                        const payload = b.subarray(d + 16, d + ds);
                        if (type === '\u00a9nam') out.title = utf8(payload);
                        else if (type === '\u00a9ART') out.artist = utf8(payload);
                        else if (type === 'aART' && !out.artist) out.artist = utf8(payload);
                        else if (type === '\u00a9lyr') out.lyrics = utf8(payload);
                        else if (type === 'covr' && !out.cover) out.cover = new Blob([payload.slice()], { type: kind === 14 ? 'image/png' : 'image/jpeg' });
                    }
                    d += ds;
                }
            } else if (type === 'udta' || type === 'ilst') walk(b, body, o + size, type);
            else if (type === 'meta') walk(b, body + 4, o + size, 'meta'); // meta 有 4 字节版本号
            o += size;
        }
    };
    walk(moov, 0, moov.length, 'moov');
    return out;
}

async function readWAV(file) {
    const out = {};
    const b = await readBytes(file, 0, Math.min(file.size, 262144));
    let o = 12;
    while (o + 8 <= b.length) {
        const id = ascii(b, o, 4), size = u32le(b, o + 4);
        if (id === 'LIST' && ascii(b, o + 8, 4) === 'INFO') {
            let q = o + 12;
            while (q + 8 <= o + 8 + size && q + 8 <= b.length) {
                const k = ascii(b, q, 4), n = u32le(b, q + 4);
                const v = clean(utf8(b.subarray(q + 8, q + 8 + n)));
                if (k === 'INAM') out.title = v;
                if (k === 'IART') out.artist = v;
                q += 8 + n + (n & 1);
            }
        }
        o += 8 + size + (size & 1);
    }
    return out;
}

/**
 * 按文件开头的特征判断格式，读歌名、歌手、封面、歌词。读不到就返回空对象。
 */
export async function readTags(file) {
    try {
        const h = await readBytes(file, 0, 12);
        const sig = ascii(h, 0, 4);
        if (sig.startsWith('ID3')) return await readID3(file);
        if (sig === 'fLaC') return await readFLAC(file);
        if (sig === 'OggS') return await readOGG(file);
        if (sig === 'RIFF' && ascii(h, 8, 4) === 'WAVE') return await readWAV(file);
        if (ascii(h, 4, 4) === 'ftyp') return await readMP4(file);
    } catch (e) {
        console.warn('[共享耳机] 读取标签失败', e);
    }
    return {};
}

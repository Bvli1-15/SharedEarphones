// 读 zip 压缩包：只用浏览器自带的解压能力，不引外部库。
// 一次只把一个文件读进内存，整包几百兆也没关系。

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
    // Windows 上打的中文压缩包通常是 GBK 编码
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 不是 UTF-8 */ }
    try { return new TextDecoder('gbk').decode(bytes); } catch { return new TextDecoder('latin1').decode(bytes); }
}

/**
 * 列出压缩包里的文件。
 * @returns {Promise<{name:string, method:number, offset:number, csize:number, size:number}[]>}
 */
export async function listZip(file) {
    const tailLen = Math.min(file.size, 65557);
    const tail = new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer());
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { e = i; break; }
    }
    if (e < 0) throw new Error('这个压缩包读不了，可能已经损坏，或者不是 zip 格式');
    const count = u16(tail, e + 10);
    const cdSize = u32(tail, e + 12);
    const cdOffset = u32(tail, e + 16);
    const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
        if (u32(cd, p) !== 0x02014b50) break;
        const flags = u16(cd, p + 8);
        const method = u16(cd, p + 10);
        const csize = u32(cd, p + 20);
        const size = u32(cd, p + 24);
        const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
        const offset = u32(cd, p + 42);
        const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), flags & 0x800);
        p += 46 + nlen + xlen + clen;
        if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name)) continue;
        if (flags & 0x1) continue; // 加密的跳过
        entries.push({ name, method, offset, csize, size });
    }
    return entries;
}

/**
 * 取出压缩包里的一个文件，变成 File。
 */
export async function extractZip(file, entry, type = '') {
    const h = new Uint8Array(await file.slice(entry.offset, entry.offset + 30).arrayBuffer());
    if (u32(h, 0) !== 0x04034b50) throw new Error('压缩包结构不对');
    const start = entry.offset + 30 + u16(h, 26) + u16(h, 28);
    const raw = file.slice(start, start + entry.csize);
    let blob;
    if (entry.method === 0) {
        blob = raw;
    } else if (entry.method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('这个浏览器太旧，解不开压缩包');
        const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        blob = await new Response(stream).blob();
    } else {
        throw new Error('不支持这种压缩方式');
    }
    const base = entry.name.split('/').pop();
    return new File([blob], base, { type });
}

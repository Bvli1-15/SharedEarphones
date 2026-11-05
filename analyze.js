// 本地「听」音频：全在浏览器里算，不花 token。
// 整首歌按 11025Hz 解码（省内存），算速度、节拍清不清楚、音符疏密、响度、明暗、高中低频分布、
// 声场宽窄、大概的调性（大调 / 小调）、整首的强弱走向。结果给共享耳机 API 当「耳朵」用。

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const SR = 11025;
export const ANALYSIS_VERSION = 2;

/** 老办法：按设备原本的采样率解码；大 mp3 只切中间一段，省内存。新办法用不了时退回这里。 */
async function decodeFull(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('这个浏览器不支持音频分析');
    const ac = new AC();
    try {
        if (/mpeg|mp3/.test(blob.type) && blob.size > 3_000_000) {
            const start = Math.floor(blob.size * 0.3);
            try {
                const buf = await ac.decodeAudioData(await blob.slice(start, start + 2_500_000).arrayBuffer());
                buf.partial = true;
                return buf;
            } catch { /* 切片解不开就整个解 */ }
        }
        return await ac.decodeAudioData(await blob.arrayBuffer());
    } finally {
        ac.close?.();
    }
}

/** 整首解码成 11025Hz：OfflineAudioContext 解码时会自动重采样到它自己的采样率，占内存只有原来的四分之一左右。 */
async function decodeLow(blob) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (OAC) {
        try {
            const data = await blob.arrayBuffer();
            const ac = new OAC(2, SR, SR);
            return await new Promise((resolve, reject) => {
                const p = ac.decodeAudioData(data, resolve, reject);
                if (p && typeof p.then === 'function') p.then(resolve, reject);
            });
        } catch { /* 老浏览器不支持低采样率，退回老办法 */ }
    }
    return decodeFull(blob);
}

function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < half; k++) {
                const a = i + k, b = a + half;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
                const nc = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nc;
            }
        }
    }
}

const KEY_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a, b) {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / Math.sqrt((da * db) || 1e-12);
}

/** 大概的调性：抽几十帧做频谱，按音名累加成 12 格，再和大调、小调的典型分布比对。 */
function estimateKey(x, fs) {
    const N = 4096;
    if (x.length < N * 4) return null;
    const count = Math.min(160, Math.floor(x.length / N));
    const hop = Math.floor((x.length - N) / Math.max(1, count - 1));
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const chroma = new Float64Array(12);
    const re = new Float64Array(N), im = new Float64Array(N);
    const kLo = Math.ceil(65 * N / fs), kHi = Math.min(N / 2 - 1, Math.floor(2100 * N / fs));
    let used = 0;
    for (let f = 0; f < count; f++) {
        const o = f * hop;
        let e = 0;
        for (let i = 0; i < N; i++) { const v = x[o + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
        if (e / N < 1e-6) continue; // 安静的地方不算
        fft(re, im);
        for (let k = kLo; k <= kHi; k++) {
            const mag = Math.hypot(re[k], im[k]);
            const midi = 69 + 12 * Math.log2((k * fs / N) / 440);
            chroma[((Math.round(midi) % 12) + 12) % 12] += mag;
        }
        used++;
    }
    if (used < 4) return null;
    const scores = [];
    for (let t = 0; t < 12; t++) {
        const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + t) % 12]);
        scores.push({ key: KEY_NAMES[t], mode: 'major', r: corr(rot, MAJOR) });
        scores.push({ key: KEY_NAMES[t], mode: 'minor', r: corr(rot, MINOR) });
    }
    scores.sort((a, b) => b.r - a.r);
    return { key: scores[0].key, mode: scores[0].mode, keyConf: clamp((scores[0].r - scores[1].r) * 5 + (scores[0].r - 0.5), 0, 1) };
}

/** 从已经解码好的声音里算各项特征（单独拆出来，方便测试） */
export function analyzeBuffer(buf) {
    const sr = buf.sampleRate;
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

    // 降到约 11kHz 单声道；顺便量一下左右差（声场宽窄）
    const step = Math.max(1, Math.round(sr / SR));
    const n = Math.floor(L.length / step);
    const x = new Float32Array(n);
    let midE = 0, sideE = 0;
    for (let i = 0; i < n; i++) {
        let m = 0, d = 0;
        const o = i * step;
        for (let k = 0; k < step; k++) {
            const a = L[o + k], b = R ? R[o + k] : a;
            m += (a + b) * 0.5; d += (a - b) * 0.5;
        }
        m /= step; d /= step;
        x[i] = m; midE += m * m; sideE += d * d;
    }
    const fs = sr / step;

    // 分帧：能量、高频能量
    const frame = 512, hop = 256;
    const frames = Math.max(1, Math.floor((n - frame) / hop));
    const env = new Float32Array(frames);
    let total = 0, totalHi = 0;
    for (let f = 0; f < frames; f++) {
        let e = 0, h = 0;
        const o = f * hop;
        for (let i = 1; i < frame; i++) {
            const v = x[o + i], d = v - x[o + i - 1];
            e += v * v; h += d * d;
        }
        env[f] = Math.sqrt(e / frame);
        total += e; totalHi += h;
    }
    const rms = Math.sqrt(total / (frames * frame));
    const ratio = Math.sqrt(totalHi / Math.max(total, 1e-9)); // 高频占比，越大越亮

    // 起伏：只看有声音的帧，能量取对数后的标准差
    const sorted = Array.from(env).sort((a, b) => a - b);
    const p90 = sorted[Math.floor(sorted.length * 0.9)] || 1e-4;
    const loud = Array.from(env).filter(v => v > p90 * 0.05);
    const logs = (loud.length ? loud : Array.from(env)).map(v => Math.log(v + 1e-4));
    const mean = logs.reduce((s, v) => s + v, 0) / logs.length;
    const std = Math.sqrt(logs.reduce((s, v) => s + (v - mean) ** 2, 0) / logs.length);
    const quiet = 1 - loud.length / env.length; // 几乎没声音的部分占多少

    // 高中低频：一阶低通分出 250Hz 以下和 2000Hz 以下
    const a1 = 1 - Math.exp(-2 * Math.PI * 250 / fs), a2 = 1 - Math.exp(-2 * Math.PI * 2000 / fs);
    let lp1 = 0, lp2 = 0, eLow = 0, eMid = 0, eHigh = 0;
    for (let i = 0; i < n; i++) {
        const v = x[i];
        lp1 += a1 * (v - lp1); lp2 += a2 * (v - lp2);
        eLow += lp1 * lp1; eMid += (lp2 - lp1) ** 2; eHigh += (v - lp2) ** 2;
    }
    const eSum = (eLow + eMid + eHigh) || 1;

    // 速度：能量上升沿做自相关，在 60–180 BPM 之间找最像的周期；最像的有多突出 = 节拍清不清楚
    const onset = new Float32Array(frames);
    for (let f = 1; f < frames; f++) onset[f] = Math.max(0, env[f] - env[f - 1]);
    const fps = fs / hop;
    let best = 0, bestBpm = 0, sum = 0, cnt = 0;
    for (let bpm = 60; bpm <= 180; bpm += 1) {
        const lag = (60 / bpm) * fps;
        const l0 = Math.floor(lag), w = lag - l0;
        let s = 0;
        for (let f = 0; f + l0 + 1 < frames; f++) s += onset[f] * (onset[f + l0] * (1 - w) + onset[f + l0 + 1] * w);
        s *= 1 - 0.25 * Math.abs(Math.log2(bpm / 105)); // 稍微偏向常见速度，减少测成一半或两倍
        sum += s; cnt++;
        if (s > best) { best = s; bestBpm = bpm; }
    }
    const beat = clamp(((best / Math.max(sum / cnt, 1e-12)) - 1) / 1.2, 0, 1);

    // 音符疏密：每秒有几个明显的起音
    let om = 0;
    for (let f = 0; f < frames; f++) om += onset[f];
    om /= frames;
    let os = 0;
    for (let f = 0; f < frames; f++) os += (onset[f] - om) ** 2;
    os = Math.sqrt(os / frames);
    let hits = 0, lastHit = -99;
    for (let f = 1; f < frames - 1; f++) {
        if (onset[f] > om + 1.5 * os && onset[f] >= onset[f - 1] && onset[f] >= onset[f + 1] && f - lastHit > fps * 0.08) { hits++; lastHit = f; }
    }
    const secs = n / fs;
    const density = hits / Math.max(secs, 1);

    // 整首的强弱走向：切成 10 段，每段的响度（相对最响的那段）
    const curve = [];
    const segLen = Math.max(1, Math.floor(frames / 10));
    for (let g = 0; g < 10; g++) {
        let e = 0, c = 0;
        for (let f = g * segLen; f < Math.min(frames, (g + 1) * segLen); f++) { e += env[f] * env[f]; c++; }
        curve.push(c ? Math.sqrt(e / c) : 0);
    }
    const cmax = Math.max(...curve, 1e-9);

    return {
        v: ANALYSIS_VERSION,
        bpm: bestBpm || 0,
        energy: clamp(rms * 4, 0, 1),
        brightness: clamp((ratio - 0.04) / 0.36, 0, 1),
        dynamics: clamp(std / 1.4, 0, 1),
        beat,
        density: Math.round(density * 10) / 10,
        width: clamp(Math.sqrt(sideE / Math.max(midE, 1e-9)), 0, 1),
        low: eLow / eSum, mid: eMid / eSum, high: eHigh / eSum,
        quiet: clamp(quiet, 0, 1),
        curve: curve.map(v => Math.round((v / cmax) * 100) / 100),
        secs: Math.round(secs),
        partial: !!buf.partial,
        ...(estimateKey(x, fs) || {}),
    };
}

/**
 * @returns {Promise<object>} bpm、energy、brightness、dynamics（老的四项），以及 beat、density、width、low/mid/high、quiet、curve、key、mode 等
 */
export async function analyzeAudio(blob) {
    return analyzeBuffer(await decodeLow(blob));
}

// 情绪词表：char 切歌只在这些词里选，规则换算和模型判断都往这里归
export const MOOD_WORDS = ['明亮', '温柔', '伤感', '紧张', '慵懒', '浪漫', '激昂', '安静', '神秘', '怀旧'];

/**
 * 规则换算：零 token，只看声音特征。
 * @returns {{tags:string[], mood:string}}
 */
export function tagsByRules(an) {
    if (!an) return { tags: [], mood: '' };
    const { bpm, energy, brightness, dynamics } = an;
    const tags = [];
    tags.push(bpm < 72 ? '缓慢' : bpm < 96 ? '舒缓' : bpm < 124 ? '轻快' : '急促');
    if (energy < 0.25) tags.push('轻柔'); else if (energy > 0.6) tags.push('饱满');
    if (brightness < 0.35) tags.push('低沉'); else if (brightness > 0.6) tags.push('清亮');
    if (dynamics > 0.75) tags.push('起伏大');
    let mood;
    if (bpm >= 118 && energy > 0.5) mood = brightness > 0.5 ? '激昂' : '紧张';
    else if (bpm >= 100 && brightness >= 0.5) mood = '明亮';
    else if (bpm < 90 && energy < 0.3) mood = brightness < 0.4 ? '伤感' : '安静';
    else if (brightness < 0.4) mood = '慵懒';
    else mood = '温柔';
    return { tags, mood };
}

/** 整首的强弱走向说成人话 */
function describeCurve(c) {
    if (!Array.isArray(c) || c.length < 6) return '';
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const start = avg(c.slice(0, 2)), end = avg(c.slice(-2));
    const max = Math.max(...c), min = Math.min(...c);
    const peak = c.indexOf(max);
    if (max - min < 0.2) return '整首强弱变化不大，比较平稳';
    const parts = [];
    parts.push(start < 0.45 ? '开头很轻' : start > 0.85 ? '一开始就很满' : '开头中等');
    if (peak >= 2 && peak <= 8) {
        const risesTo = c.slice(0, peak + 1).every((v, i, a) => i === 0 || v >= a[i - 1] - 0.08);
        parts.push(`${risesTo && start < 0.6 ? '一路慢慢推上去，' : ''}大约在 ${peak * 10 + 5}% 处最强`);
    }
    const jumps = c.slice(1).some((v, i) => Math.abs(v - c[i]) > 0.35);
    if (jumps) parts.push('中间有突然的强弱转折');
    parts.push(end < 0.4 ? '结尾收得很轻（像淡出）' : end > 0.85 ? '结尾还很满' : '结尾回落一些');
    return parts.join(' → ');
}

/** 把分析结果说成人话，给模型判断时参考 */
export function describeAnalysis(an) {
    if (!an) return '';
    const lines = [];
    const speed = an.bpm < 72 ? '很慢' : an.bpm < 96 ? '偏慢' : an.bpm < 124 ? '中等偏快' : '快';
    let rhythm = `速度约 ${Math.round(an.bpm)} BPM（${speed}）`;
    if (an.beat != null) rhythm += an.beat > 0.6 ? '，节拍清楚、规整' : an.beat < 0.3 ? '，节拍不明显，比较自由、漂浮' : '，节拍中等清楚';
    if (an.density != null) rhythm += an.density < 1.2 ? '，音符稀疏、留白多' : an.density > 4 ? '，音符密集' : '，音符疏密适中';
    lines.push(rhythm);
    const loud = an.energy < 0.25 ? '轻' : an.energy > 0.6 ? '饱满' : '中等';
    lines.push(`响度${loud}${an.dynamics > 0.75 ? '，强弱起伏明显' : an.dynamics < 0.3 ? '，强弱变化小' : ''}`);
    const tone = [an.brightness < 0.35 ? '音色偏暗' : an.brightness > 0.6 ? '音色偏亮' : '音色明暗适中'];
    if (an.low != null) {
        if (an.low > 0.7) tone.push('低频厚重（偏暖、偏沉）');
        else if (an.low < 0.35) tone.push('低频很少（听感轻薄）');
        if (an.mid > 0.45) tone.push('中频突出（人声或旋律乐器站在前面）');
        if (an.high > 0.12) tone.push('高频多（偏脆、偏亮，可能有镲片或气声）');
    }
    lines.push(tone.join('，'));
    if (an.width != null) lines.push(an.width < 0.08 ? '声场很窄，接近单声道，像贴在耳边' : an.width > 0.35 ? '声场很宽，左右铺得很开' : '声场宽窄适中');
    if (an.key) lines.push(`调性大概是 ${an.key} ${an.mode === 'minor' ? '小调' : '大调'}${an.keyConf < 0.25 ? '（把握不大，大小调可能判反）' : ''}`);
    const shape = describeCurve(an.curve);
    if (shape) lines.push(`整首走向：${shape}`);
    if (an.quiet > 0.2) lines.push('安静的段落或停顿比较多');
    if (an.partial) lines.push('（只测了中间一段）');
    return lines.join('；');
}

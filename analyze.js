// 本地分析音频：速度（BPM）、响度、明暗、起伏。全在浏览器里算，不花 token。
// 只取歌的中间一段来算，又快又省内存。

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

async function decode(blob) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('这个浏览器不支持音频分析');
    const ac = new AC();
    try {
        // mp3 是一帧一帧的，可以只切中间一段来解码，省内存；其他格式整个解
        if (/mpeg|mp3/.test(blob.type) && blob.size > 3_000_000) {
            const start = Math.floor(blob.size * 0.3);
            try {
                return await ac.decodeAudioData(await blob.slice(start, start + 2_500_000).arrayBuffer());
            } catch { /* 切片解不开就整个解 */ }
        }
        return await ac.decodeAudioData(await blob.arrayBuffer());
    } finally {
        ac.close?.();
    }
}

/**
 * @returns {Promise<{bpm:number, energy:number, brightness:number, dynamics:number}>}
 */
export async function analyzeAudio(blob) {
    const buf = await decode(blob);
    const sr = buf.sampleRate;
    const a = buf.getChannelData(0);
    const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;

    // 取最多 60 秒，从 30% 处开始（跳过前奏）
    const win = Math.min(a.length, sr * 60);
    const start = a.length > win ? Math.floor((a.length - win) * 0.3) : 0;

    // 降到约 11kHz 单声道
    const step = Math.max(1, Math.round(sr / 11025));
    const n = Math.floor(win / step);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        const o = start + i * step;
        for (let k = 0; k < step; k++) s += b ? (a[o + k] + b[o + k]) * 0.5 : a[o + k];
        x[i] = s / step;
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

    // 起伏：帧能量取对数后的标准差
    let mean = 0;
    const logs = Array.from(env, v => Math.log(v + 1e-4));
    logs.forEach(v => { mean += v; });
    mean /= logs.length;
    const std = Math.sqrt(logs.reduce((s, v) => s + (v - mean) ** 2, 0) / logs.length);

    // 速度：能量上升沿做自相关，在 60–180 BPM 之间找最像的周期
    const onset = new Float32Array(frames);
    for (let f = 1; f < frames; f++) onset[f] = Math.max(0, env[f] - env[f - 1]);
    const fps = fs / hop;
    let best = 0, bestBpm = 0;
    for (let bpm = 60; bpm <= 180; bpm += 1) {
        const lag = (60 / bpm) * fps;
        const l0 = Math.floor(lag), w = lag - l0;
        let s = 0;
        for (let f = 0; f + l0 + 1 < frames; f++) s += onset[f] * (onset[f + l0] * (1 - w) + onset[f + l0 + 1] * w);
        s *= 1 - 0.25 * Math.abs(Math.log2(bpm / 105)); // 稍微偏向常见速度，减少测成一半或两倍
        if (s > best) { best = s; bestBpm = bpm; }
    }

    return {
        bpm: bestBpm || 0,
        energy: clamp(rms * 4, 0, 1),
        brightness: clamp((ratio - 0.04) / 0.36, 0, 1),
        dynamics: clamp(std / 1.4, 0, 1),
    };
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

/** 把分析结果说成人话，给模型判断时参考 */
export function describeAnalysis(an) {
    if (!an) return '';
    const speed = an.bpm < 72 ? '很慢' : an.bpm < 96 ? '偏慢' : an.bpm < 124 ? '中等偏快' : '快';
    const loud = an.energy < 0.25 ? '轻' : an.energy > 0.6 ? '饱满' : '中等';
    const tone = an.brightness < 0.35 ? '偏暗' : an.brightness > 0.6 ? '偏亮' : '适中';
    return `速度约 ${Math.round(an.bpm)} BPM（${speed}），响度${loud}，音色${tone}${an.dynamics > 0.75 ? '，起伏明显' : ''}`;
}

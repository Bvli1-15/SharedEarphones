// 共享耳机 · 播放器本体
// 悬浮球、卡片正面、歌词、歌单、背面耳机线，歌存在浏览器里。
// 导入：文件（多种格式、视频取声音）、zip 压缩包、链接、拖拽、在线找开放授权音乐、流行歌（GD音乐台，只在线播放）；联网自动配歌词（LRCLIB）和封面。
// 让 char 听见：把正在放的歌（氛围、歌词）悄悄塞进提示词；氛围标签；char 根据剧情换歌。

import { BACK_SVG, BACK_VIEWBOX } from './earphones.js';
import { readTags, guessFromFilename, normalizeName, parseLyrics } from './parsers.js';
import { listZip, extractZip } from './zip.js';
import { findLyrics, findCover, searchLyrics } from './online.js';
import { searchFree, fetchThumb, MOODS } from './free.js';
import { searchGD, resolveGD, fetchGDCover, GD_SOURCES, GD_NAME, neteaseSongId, isNeteaseShort, neteaseInfo, neteasePlaylistId, neteasePlaylist, neteaseCover, neteaseAudioUrl } from './gd.js';
import { analyzeAudio, tagsByRules, describeAnalysis, MOOD_WORDS, ANALYSIS_VERSION } from './analyze.js';
import * as db from './db.js';

const MODULE = 'shared_earphones';
const TAG = '[共享耳机]';
const ALL = 'all';

const DEFAULTS = Object.freeze({
    ballVisible: true,
    ballPos: null,          // {x, y}：球中心在屏幕里的比例
    ballIcon: '',           // 自定义图标（压缩后的 dataURL）
    cardY: null,            // 手机上：卡片中心在屏幕高度里的比例；null 就是正中间（手机上只能上下挪）
    cardPC: null,           // 电脑上：卡片中心的位置 {x, y}（比例）；电脑上可以上下左右随便挪
    cardOpen: false,        // 卡片开着没有（关了悬浮球时，刷新后照原样留着）
    material: 'frost',      // frost 磨砂 / liquid 液态玻璃
    tint: 'auto',           // auto 跟随酒馆主题 / light / dark
    playMode: 'order',      // order 顺序 / one 单曲循环 / shuffle 随机
    listId: ALL,            // 正在播放哪个歌单
    songId: null,           // 上次放到哪首
    texts: {},              // 每个角色背面的三行字
    autoLyrics: true,       // 导入时自动去 LRCLIB 找歌词
    autoCover: true,        // 导入时自动补封面
    listen: true,           // 让 char 听见（只在播放时）
    listenMode: 'lines',    // vibe 只给氛围 / lines 氛围+正在唱的几句 / full 氛围+整首歌词
    tagMode: 'model',       // rules 规则换算（零 token）/ model 共享耳机 API 判断（每首一次）
    autoSwitch: true,       // char 根据剧情换歌
    switchCooldown: 3,      // 换过之后隔几轮才能再换
    apiOn: false,           // 共享耳机 API 开关（只给这个插件打标签用）
    apiUrl: '',             // OpenAI 兼容接口地址
    apiKey: '',
    apiModel: '',
    apiModels: [],          // 「获取模型」拉到的列表，下次打开还在
    tagPrompt: '',          // 打标签的分析提示词；空着就用默认的
});

// 共享耳机 API 默认的分析提示词（十个维度）
const DEFAULT_TAG_PROMPT = '请分析我提供的这首音乐（音频/链接/描述），重点详细描述它的整体氛围，而不是只给出“欢快/悲伤/紧张”等简单标签。请从以下维度展开：1）情绪基调与色彩：音乐传达的主要情绪是什么，是单一情绪还是多种情绪交织，是否有明暗、冷暖、轻重、苦甜的变化；2）能量与动态：整体能量高低、强弱起伏、紧张与松弛的转换、是否具有推进感或悬浮感；3）空间感与质感：声音是开阔还是封闭、近还是远、干燥还是湿润、粗糙还是细腻、温暖还是冷冽，是否有回声、混响、噪点、空气感；4）节奏与律动：节拍是否稳定、速度快慢、律动是机械、摇摆、流动还是破碎，是否让人想舞动、行走、静坐或屏息；5）音色与配器：主要乐器/人声的音色特征，哪些声音突出，哪些声音铺底，音色组合带来怎样的氛围；6）和声与旋律：和谐/不和谐、明亮/幽暗、旋律线条是歌唱性、循环性、碎片化还是吟诵式；7）结构与氛围变化：开头、发展、高潮、结尾的氛围如何变化，是否有突然转折、渐进累积或留白；8）联想意象与场景：这段音乐让你联想到什么画面、时间、地点、天气、空间或叙事场景；9）身体与心理反应：听后身体是放松、紧绷、漂浮、下沉还是被推动，心理上更接近孤独、亲密、怀旧、神秘、庄严、梦幻还是不安；10）综合总结：用一段具象、细腻、有画面感的语言概括其氛围，并指出最关键的2—3个氛围关键词。请避免空泛套话，尽量结合具体声音细节说明理由；如果某些维度不明显，可以说明“不明显/较弱”，不要强行编造。';
const INJECT_KEY = 'shared_earphones';

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|wave|ogg|oga|opus|webm|mp4|m4v|mov|aif|aiff|caf|alac|wma)$/i;
const MIME_BY_EXT = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', wave: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', mp4: 'video/mp4', m4v: 'video/mp4',
    mov: 'video/quicktime', aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf',
};
const FILE_ACCEPT = 'audio/*,video/*,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus,.webm,.mp4,.mov,.aiff,.lrc,.zip';

const ctx = () => SillyTavern.getContext();
/** 取酒馆的函数：getContext() 里有就用；老版本没放进去的，从 script.js 直接导入（1.12.0 起就导出了）。 */
async function stFn(name) {
    const f = ctx()[name];
    if (typeof f === 'function') return f;
    try { const m = await import(new URL('../../../../script.js', import.meta.url).href); if (typeof m[name] === 'function') return m[name]; } catch (e) { console.warn(TAG, `拿不到 ${name}`, e); }
    return null;
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let settings;
let library = { index: [], playlists: [] };
const coverUrls = new Map();
const audio = new Audio();
audio.preload = 'metadata';
let audioUrl = null;
let lyricData = null;       // 当前歌的歌词
let lyricIdx = -1;
let userScrolledAt = 0;
let openListId = ALL;       // 歌单详情页正在看的歌单
let importTarget = null;    // 导入的歌要不要顺便放进某个歌单
let lrcTargetId = null;     // 在线找歌词是给哪首歌找
let enriching = false;
let tagging = false;
let turnsSinceSwitch = 99;  // 离上次 char 换歌过了几轮

const el = {};              // 常用元素

// ======================================================
// 设置
// ======================================================
function loadSettings() {
    const store = ctx().extensionSettings;
    const old = store[MODULE];
    store[MODULE] = Object.assign(structuredClone(DEFAULTS), old || {});
    // 以前填过副 API 的，升级后开关默认打开，照旧能用
    if (old && old.apiOn === undefined) store[MODULE].apiOn = !!(old.apiUrl && old.apiModel);
    settings = store[MODULE];
}
const save = () => ctx().saveSettingsDebounced();

// ======================================================
// 小工具
// ======================================================
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : ctx().uuidv4());
const songById = (id) => library.index.find(s => s.id === id);
const currentSong = () => songById(settings.songId);
const toast = (type, msg) => (window.toastr ? toastr[type](msg) : console.log(TAG, msg));

function listSongIds(listId) {
    if (listId === ALL) return library.index.map(s => s.id);
    const pl = library.playlists.find(p => p.id === listId);
    return pl ? pl.songIds.filter(id => songById(id)) : [];
}

function listName(listId) {
    if (listId === ALL) return '全部歌曲';
    return library.playlists.find(p => p.id === listId)?.name || '歌单';
}

async function coverUrl(id) {
    if (coverUrls.has(id)) return coverUrls.get(id);
    const s = songById(id);
    if (!s?.hasCover) return null;
    const blob = await db.getCover(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    coverUrls.set(id, url);
    return url;
}

function pickFiles(accept, multiple = true) {
    return new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept;
        input.multiple = multiple;
        input.style.display = 'none';
        input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
        document.body.appendChild(input);
        input.click();
    });
}

function longPress(node, fn, ms = 520) {
    let timer = null, sx = 0, sy = 0, fired = false;
    node.addEventListener('pointerdown', e => {
        fired = false; sx = e.clientX; sy = e.clientY;
        timer = setTimeout(() => { fired = true; fn(e); }, ms);
    });
    const cancel = () => clearTimeout(timer);
    node.addEventListener('pointermove', e => { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancel(); });
    node.addEventListener('pointerup', cancel);
    node.addEventListener('pointercancel', cancel);
    node.addEventListener('contextmenu', e => e.preventDefault());
    node.addEventListener('click', e => { if (fired) { e.stopPropagation(); e.preventDefault(); } }, true);
}

// ======================================================
// 图标
// ======================================================
const ICON = {
    note: '<svg viewBox="0 0 24 24"><path d="M9 18.5a3 3 0 11-2-2.8V5l11-2v12.5a3 3 0 11-2-2.8V6.4L9 7.8z" fill="var(--se-icon)"/></svg>',
    star: '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8z" fill="none" stroke="var(--se-icon-sub)" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    prev: '<svg width="42" height="26" viewBox="0 0 40 24"><path d="M19 4v16L6 12zM34 4v16L21 12z" fill="var(--se-icon)"/></svg>',
    next: '<svg width="42" height="26" viewBox="0 0 40 24"><path d="M6 4v16l13-8zM21 4v16l13-8z" fill="var(--se-icon)"/></svg>',
    play: '<svg width="26" height="32" viewBox="0 0 24 30"><path d="M4 3v24l19-12z" fill="var(--se-icon)"/></svg>',
    pause: '<svg width="26" height="32" viewBox="0 0 24 30"><rect x="3" y="2" width="6" height="26" rx="1.5" fill="var(--se-icon)"/><rect x="15" y="2" width="6" height="26" rx="1.5" fill="var(--se-icon)"/></svg>',
    lyr: '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 5h16a1.5 1.5 0 011.5 1.5v9A1.5 1.5 0 0120 17h-9l-5 4v-4H4a1.5 1.5 0 01-1.5-1.5v-9A1.5 1.5 0 014 5z" fill="none" stroke="var(--se-icon-sub)" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 9.5h2.5v2.2c0 1.2-.7 2-1.8 2.3M13.5 9.5H16v2.2c0 1.2-.7 2-1.8 2.3" fill="none" stroke="var(--se-icon-sub)" stroke-width="1.6" stroke-linecap="round"/></svg>',
    edit: '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="var(--se-icon-sub)" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    more: '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 20h4.2L19.4 8.8a2 2 0 000-2.8l-1.4-1.4a2 2 0 00-2.8 0L4 15.8V20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    search: '<svg width="20" height="20" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="var(--se-icon-sub)" stroke-width="1.8"/><path d="M15 15l5 5" stroke="var(--se-icon-sub)" stroke-width="1.8" stroke-linecap="round"/></svg>',
};
const LOADING = '<span class="se-dots" aria-label="加载中"><i></i><i></i><i></i></span>';
const BARS = [3, 5, 3, 9, 14, 9, 6, 4].map(h => `<i style="height:${h}px"></i>`).join('');
const progHTML = '<div class="se-prog"><span class="se-cur">0:00</span><div class="se-track"><span><b></b></span></div><span class="se-left">-0:00</span></div>';

// ======================================================
// 搭界面
// ======================================================
function buildUI() {
    const root = document.createElement('div');
    root.id = 'se-root';
    root.innerHTML = `
<div id="se-ball" class="se-glass" role="button" tabindex="0" aria-label="音乐播放器"></div>
<div id="se-card" class="se-glass se-hidden" data-view="front">
  <div class="se-face se-front">
    <div class="se-top">
      <div class="se-cover"></div>
      <div class="se-meta"><div class="se-title"></div><div class="se-artist"></div></div>
      <button class="se-flip" aria-label="翻到背面">${BARS}</button>
    </div>
    ${progHTML}
    <div class="se-ctl">
      <button class="se-btn" data-act="lists" aria-label="歌单">${ICON.star}</button>
      <button class="se-btn" data-act="prev" aria-label="上一首">${ICON.prev}</button>
      <button class="se-btn se-playbtn" data-act="toggle" aria-label="播放">${ICON.play}</button>
      <button class="se-btn" data-act="next" aria-label="下一首">${ICON.next}</button>
      <button class="se-btn" data-act="lyrics" aria-label="歌词">${ICON.lyr}</button>
    </div>
  </div>

  <div class="se-face se-lyrics">
    <div class="se-mini">
      <div class="se-cover se-sm"></div>
      <div class="se-meta"><div class="se-title"></div><div class="se-artist"></div></div>
      <button class="se-btn" data-act="lrcsearch" aria-label="在线找歌词">${ICON.search}</button>
      <button class="se-btn" data-act="editlyrics" aria-label="编辑歌词">${ICON.edit}</button>
      <button class="se-btn" data-act="front" aria-label="回到正面">${ICON.lyr}</button>
    </div>
    <div class="se-lines"></div>
    <div class="se-empty" hidden>
      <span class="se-empty-text">这首还没有歌词</span>
      <div><button class="se-primary" data-act="lrcsearch">在线找</button><button data-act="lrcfile">导入 .lrc</button><button data-act="editlyrics">粘贴</button></div>
    </div>
    ${progHTML}
  </div>

  <div class="se-face se-lists">
    <div class="se-head"><button class="se-back-btn" data-act="front" aria-label="返回">‹</button><span>歌单</span></div>
    <div class="se-seg" role="group" aria-label="播放模式">
      <button data-mode="order">顺序</button><button data-mode="one">单曲循环</button><button data-mode="shuffle">随机</button>
    </div>
    <div class="se-rows se-pl-rows"></div>
    <div class="se-actions"><button class="se-primary" data-act="importmenu">导入歌曲</button><button data-act="importlrc">导入歌词</button></div>
  </div>

  <div class="se-face se-list">
    <div class="se-head"><button class="se-back-btn" data-act="lists" aria-label="返回">‹</button><span class="se-list-name"></span></div>
    <div class="se-rows se-song-rows"></div>
    <div class="se-actions"><button class="se-primary" data-act="importhere">导入歌曲到这里</button></div>
  </div>

  <div class="se-face se-import">
    <div class="se-head"><button class="se-back-btn" data-act="importback" aria-label="返回">‹</button><span class="se-import-title">导入歌曲</span></div>
    <div class="se-opts">
      <button class="se-opt" data-act="impgd"><b>流行歌</b><small>按歌名歌手搜网易云等平台的歌，在线播放，不存进浏览器，没网时放不了</small></button>
      <button class="se-opt" data-act="impsearch"><b>在线找歌</b><small>搜开放授权的免费音乐，适合给剧情配氛围。曲库是英文的，有现成的中文情绪词可以点</small></button>
      <button class="se-opt" data-act="impfiles"><b>选文件</b><small>可以多选。mp3、m4a、flac、wav、ogg 都行；视频只取声音；同时选上 .lrc 会自动配到同名的歌</small></button>
      <button class="se-opt" data-act="impzip"><b>压缩包</b><small>把整个文件夹打成 zip 一次导入，里面同名的 .lrc 也会配上</small></button>
      <button class="se-opt" data-act="implinks"><b>粘贴链接</b></button>
    </div>
  </div>

  <div class="se-face se-lrcsearch">
    <div class="se-head"><button class="se-back-btn" data-act="lrcback" aria-label="返回">‹</button><span>在线找歌词</span></div>
    <div class="se-searchbar"><input class="se-q" type="search" enterkeyhint="search" placeholder="歌名 歌手"><button class="se-primary" data-act="lrcgo">搜索</button></div>
    <div class="se-rows se-lrc-rows"></div>
    <div class="se-tip">歌词来自 LRCLIB 开放歌词库</div>
  </div>

  <div class="se-face se-musicsearch">
    <div class="se-head"><button class="se-back-btn" data-act="musicback" aria-label="返回">‹</button><span>在线找歌</span></div>
    <div class="se-searchbar"><input class="se-mq" type="search" enterkeyhint="search" placeholder="英文关键词，比如 piano"><button class="se-primary" data-act="musicgo">搜索</button></div>
    <div class="se-chips">${MOODS.map(([zh, en]) => `<button data-mood="${en}">${zh}</button>`).join('')}</div>
    <div class="se-rows se-music-rows"></div>
    <div class="se-tip">开放授权音乐，来自 Openverse</div>
  </div>

  <div class="se-face se-gdsearch">
    <div class="se-head"><button class="se-back-btn" data-act="gdback" aria-label="返回">‹</button><span>流行歌</span></div>
    <div class="se-searchbar"><input class="se-gq" type="search" enterkeyhint="search" placeholder="歌名 歌手，比如 十年 陈奕迅"><button class="se-primary" data-act="gdgo">搜索</button></div>
    <div class="se-chips">${GD_SOURCES.map(([k, zh]) => `<button data-gdsrc="${k}"${k === 'netease' ? ' class="se-on"' : ''}>${zh}</button>`).join('')}</div>
    <div class="se-rows se-gd-rows"></div>
    <div class="se-tip">来自 GD音乐台</div>
  </div>

  <div class="se-face se-back">
    <div class="se-stage">
      <button class="se-hot se-hot-flip" data-act="flip" aria-label="翻回正面"></button>
      <button class="se-hot se-hot-play" data-act="toggle" aria-label="播放或暂停"></button>
      <svg viewBox="${BACK_VIEWBOX}" aria-label="两个人共用一副耳机">${BACK_SVG}</svg>
      <svg class="se-notes-layer" viewBox="${BACK_VIEWBOX}" aria-hidden="true"></svg>
      <div class="se-label" data-key="left" contenteditable="plaintext-only" spellcheck="false" style="left:34.8%;top:51.9%"></div>
      <div class="se-label" data-key="right" contenteditable="plaintext-only" spellcheck="false" style="left:65.1%;top:51.9%"></div>
      <textarea class="se-longtext" data-key="long" rows="2" maxlength="60" spellcheck="false" placeholder="点这里写一句话"></textarea>
    </div>
  </div>
</div>`;
    document.body.appendChild(root);
    el.root = root;
    el.ball = $('#se-ball', root);
    el.card = $('#se-card', root);
    el.lines = $('.se-lines', root);
    el.empty = $('.se-empty', root);
    el.plRows = $('.se-pl-rows', root);
    el.songRows = $('.se-song-rows', root);
    el.lrcRows = $('.se-lrc-rows', root);
    el.q = $('.se-q', root);
    el.mq = $('.se-mq', root);
    el.musicRows = $('.se-music-rows', root);
    el.gq = $('.se-gq', root);
    el.gdRows = $('.se-gd-rows', root);
    el.gdFace = $('.se-gdsearch', root);
    // 音符挪到单独的一层：耳机图里有滤镜和头像大图，音符和它们画在一起的话，每动一帧都得把整张图重画一遍
    const oldNotes = $('#se-notes', root);
    el.notes = oldNotes || document.createElementNS('http://www.w3.org/2000/svg', 'g');
    $('.se-notes-layer', root).appendChild(el.notes);
    bindUI();
}

// ======================================================
// 外观：材质、明暗、球的图标和位置
// ======================================================
function applyLook() {
    el.root.classList.toggle('se-liquid', settings.material === 'liquid');
    let dark = settings.tint === 'dark';
    if (settings.tint === 'auto') {
        // 酒馆正文颜色是浅的，说明是深色主题
        const c = getComputedStyle(document.body).getPropertyValue('--SmartThemeBodyColor') || '';
        const m = c.match(/[\d.]+/g);
        if (m && m.length >= 3) {
            const [r, g, b] = m.map(Number);
            dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.55;
        }
    }
    el.root.classList.toggle('se-dark', dark);
    el.ball.classList.toggle('se-hidden', !settings.ballVisible);
    el.ball.innerHTML = settings.ballIcon ? `<img src="${settings.ballIcon}" alt="">` : ICON.note;
    placeBall();
}

function placeBall() {
    const size = 50, pad = 6;
    const W = window.innerWidth, H = window.innerHeight;
    const p = settings.ballPos || { x: 1, y: 0.32 };
    const x = Math.min(Math.max(p.x * W - size / 2, pad), W - size - pad);
    const y = Math.min(Math.max(p.y * H - size / 2, pad), H - size - pad);
    el.ball.style.left = x + 'px';
    el.ball.style.top = y + 'px';
    if (!el.card.classList.contains('se-hidden')) placeCard();
}

/** 酒馆顶栏的底边：卡片最高只能到这里。 */
function cardMinTop() {
    const bar = document.getElementById('top-settings-holder') || document.getElementById('top-bar');
    const r = bar?.getBoundingClientRect();
    return (r && r.height ? Math.max(r.bottom, 0) : 0) + 6;
}

/** 是不是电脑：有鼠标（能悬停、指得准）。手机、平板的手指都不算。 */
const isDesktop = () => matchMedia('(hover: hover) and (pointer: fine)').matches;

/**
 * 摆卡片。手机上永远水平居中，只记上下位置；电脑上上下左右都记。
 * 两边的位置分开存，电脑上拖到角落不会影响手机。
 * centerX / centerY 不给就用记住的位置（默认屏幕正中）。
 */
function placeCard(centerY, centerX) {
    if (el.card.classList.contains('se-hidden')) return;
    const W = window.innerWidth, H = window.innerHeight;
    const cw = el.card.offsetWidth, ch = el.card.offsetHeight;
    const desk = isDesktop();
    const minTop = cardMinTop();
    const maxTop = Math.max(minTop, H - ch - 8);
    const cy = centerY ?? ((desk ? settings.cardPC?.y : settings.cardY) ?? 0.5) * H;
    let left = Math.max((W - cw) / 2, 0);
    if (desk && cw < W - 16) {
        const cx = centerX ?? (settings.cardPC?.x ?? 0.5) * W;
        left = Math.min(Math.max(cx - cw / 2, 8), W - cw - 8);
    }
    el.card.style.left = left + 'px';
    el.card.style.top = Math.min(Math.max(cy - ch / 2, minTop), maxTop) + 'px';
}

// ======================================================
// 交互绑定
// ======================================================
function bindUI() {
    // 悬浮球：拖动 / 点击
    let drag = null;
    el.ball.addEventListener('pointerdown', e => {
        drag = { sx: e.clientX, sy: e.clientY, moved: false, ox: el.ball.offsetLeft, oy: el.ball.offsetTop };
        el.ball.setPointerCapture(e.pointerId);
    });
    el.ball.addEventListener('pointermove', e => {
        if (!drag) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        el.ball.style.left = (drag.ox + dx) + 'px';
        el.ball.style.top = (drag.oy + dy) + 'px';
    });
    el.ball.addEventListener('pointerup', () => {
        if (!drag) return;
        if (drag.moved) {
            const r = el.ball.getBoundingClientRect();
            settings.ballPos = { x: (r.left + r.width / 2) / window.innerWidth, y: (r.top + r.height / 2) / window.innerHeight };
            save();
            placeBall();
        } else {
            toggleCard();
        }
        drag = null;
    });
    el.ball.addEventListener('pointercancel', () => { drag = null; });
    el.ball.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(); } });
    window.addEventListener('resize', placeBall);

    // 卡片：按住空白处（封面、歌名、标题栏）拖。手机上只能上下拖，电脑上上下左右都行；按钮、进度条、列表、歌词这些地方不算
    const NO_DRAG = 'button, input, select, textarea, a, label, [contenteditable], .se-track, .se-lines, .se-rows, .se-chips, .se-seg, .se-opts';
    let cdrag = null;
    el.card.addEventListener('pointerdown', e => {
        if (e.button > 0 || e.target.closest(NO_DRAG)) return;
        const r = el.card.getBoundingClientRect();
        cdrag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cx: r.left + r.width / 2, cy: r.top + r.height / 2, moved: false, free: isDesktop() };
    });
    el.card.addEventListener('pointermove', e => {
        if (!cdrag || e.pointerId !== cdrag.id) return;
        const dy = e.clientY - cdrag.sy;
        const dx = cdrag.free ? e.clientX - cdrag.sx : 0;
        if (!cdrag.moved) {
            if (Math.hypot(dx, dy) < 6) return;
            cdrag.moved = true;
            el.card.setPointerCapture(e.pointerId);
            el.card.classList.add('se-dragging');
        }
        placeCard(cdrag.cy + dy, cdrag.free ? cdrag.cx + dx : undefined);
    });
    const endCardDrag = () => {
        if (!cdrag) return;
        if (cdrag.moved) {
            const r = el.card.getBoundingClientRect();
            const y = (r.top + r.height / 2) / window.innerHeight;
            if (isDesktop()) settings.cardPC = { x: (r.left + r.width / 2) / window.innerWidth, y };
            else settings.cardY = y;
            save();
            el.card.classList.remove('se-dragging');
        }
        cdrag = null;
    };
    el.card.addEventListener('pointerup', endCardDrag);
    el.card.addEventListener('pointercancel', endCardDrag);
    // 换页、歌词加载完，卡片高度会变：重新摆一下，保证不出屏、不盖顶栏
    if (window.ResizeObserver) new ResizeObserver(() => { if (!cdrag?.moved) placeCard(); }).observe(el.card);

    // 卡片里的按钮
    el.card.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (btn) { onAction(btn.dataset.act); return; }
        if (e.target.closest('.se-flip')) { flip(); return; }
        const mood = e.target.closest('[data-mood]');
        if (mood) { el.mq.value = mood.dataset.mood; $$('[data-mood]', el.card).forEach(b => b.classList.toggle('se-on', b === mood)); runMusicSearch(true); return; }
        const gsrc = e.target.closest('[data-gdsrc]');
        if (gsrc) { gdState.source = gsrc.dataset.gdsrc; $$('[data-gdsrc]', el.card).forEach(b => b.classList.toggle('se-on', b === gsrc)); if (el.gq.value.trim()) runGDSearch(true); return; }
        const mode = e.target.closest('[data-mode]');
        if (mode) { settings.playMode = mode.dataset.mode; save(); renderModes(); }
    });

    // 进度条：点或拖
    $$('.se-track', el.card).forEach(track => {
        let seeking = false;
        const seek = (e) => {
            const r = track.getBoundingClientRect();
            const ratio = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
            if (isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
            renderProgress();
        };
        track.addEventListener('pointerdown', e => { seeking = true; track.setPointerCapture(e.pointerId); seek(e); });
        track.addEventListener('pointermove', e => { if (seeking) seek(e); });
        track.addEventListener('pointerup', () => { seeking = false; });
    });

    // 歌词：点一句跳过去；手动滑动后暂停自动滚动几秒
    el.lines.addEventListener('click', e => {
        const line = e.target.closest('.se-line');
        if (!line || !lyricData?.timed) return;
        audio.currentTime = Number(line.dataset.t);
        if (audio.paused) play();
    });
    ['touchstart', 'wheel', 'pointerdown'].forEach(ev => el.lines.addEventListener(ev, () => { userScrolledAt = Date.now(); }, { passive: true }));

    // 拖文件进来就导入（电脑上用）
    [el.card, el.ball].forEach(node => {
        node.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
        node.addEventListener('drop', e => {
            const files = [...(e.dataTransfer?.files || [])];
            if (!files.length) return;
            e.preventDefault();
            if (el.card.classList.contains('se-hidden')) toggleCard(true);
            const into = el.card.dataset.view === 'list' && openListId !== ALL ? openListId : null;
            handleIncoming(files, into);
        });
    });

    // 歌词搜索框回车
    el.q.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); runLyricSearch(); } });
    el.mq.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); $$('[data-mood]', el.card).forEach(b => b.classList.remove('se-on')); runMusicSearch(true); } });

    el.gq.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); runGDSearch(true); } });

    // 背面三行字：两个名字是 contenteditable，一句话是 textarea（iPhone Safari 里 -webkit-box 的可编辑区域打不进字）
    $$('[data-key]', el.card).forEach(node => {
        node.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); node.blur(); } });
        node.addEventListener('input', () => {
            // 一句话不要换行（粘贴进来的换行也换成空格）
            if (node.tagName === 'TEXTAREA' && /\n/.test(node.value)) node.value = node.value.replace(/\s*\n\s*/g, ' ');
            saveTexts();
        });
        if (node.tagName !== 'TEXTAREA') node.addEventListener('paste', e => {
            e.preventDefault();
            const text = (e.clipboardData?.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ');
            document.execCommand('insertText', false, text);
        });
    });
}

function toggleCard(force) {
    const hide = force === undefined ? !el.card.classList.contains('se-hidden') : !force;
    el.card.classList.toggle('se-hidden', hide);
    if (settings.cardOpen !== !hide) { settings.cardOpen = !hide; save(); }
    if (!hide) {
        if (el.card.dataset.view === 'back') refreshBack();
        render();
        placeCard();
        requestAnimationFrame(() => placeCard());
    }
    syncNotesLoop();
}

function setView(view) {
    if (view !== 'musicsearch' && view !== 'gdsearch') stopPreview();
    el.card.dataset.view = view;
    el.gdFace.style.display = view === 'gdsearch' ? 'block' : '';
    if (view === 'lists') renderLists();
    if (view === 'list') renderSongList();
    if (view === 'lyrics') renderLyrics(true);
    if (view === 'back') refreshBack();
    if (view === 'import') $('.se-import-title', el.card).textContent = importTarget ? `导入到「${listName(importTarget)}」` : '导入歌曲';
    placeCard();
    syncNotesLoop();
}

function flip() {
    const to = el.card.dataset.view === 'back' ? 'front' : 'back';
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setView(to); return; }
    el.card.classList.add('se-turn-out');
    setTimeout(() => {
        setView(to);
        el.card.classList.remove('se-turn-out');
        el.card.classList.add('se-turn-in');
        void el.card.offsetWidth;
        el.card.classList.remove('se-turn-in');
    }, 220);
}

async function onAction(act) {
    switch (act) {
        case 'toggle': return audio.paused ? play() : audio.pause();
        case 'prev': return step(-1);
        case 'next': return step(1);
        case 'lists': return setView('lists');
        case 'lyrics': return currentSong() ? setView('lyrics') : setView('lists');
        case 'front': return setView('front');
        case 'flip': return flip();
        case 'importmenu': importTarget = null; return setView('import');
        case 'importhere': importTarget = openListId === ALL ? null : openListId; return setView('import');
        case 'importback': return setView(importTarget ? 'list' : 'lists');
        case 'impfiles': return importFromPicker();
        case 'impzip': return importFromZipPicker();
        case 'implinks': return importFromLinks();
        case 'importlrc': return importLyricFiles();
        case 'lrcfile': return importLyricFiles(true);
        case 'editlyrics': return editLyrics();
        case 'lrcsearch': return openLyricSearch(settings.songId, 'lyrics');
        case 'lrcback': return setView(lrcBackView);
        case 'lrcgo': return runLyricSearch();
        case 'impsearch': return setView('musicsearch');
        case 'musicback': return setView('import');
        case 'musicgo': $$('[data-mood]', el.card).forEach(b => b.classList.remove('se-on')); return runMusicSearch(true);
        case 'musicmore': return runMusicSearch(false);
        case 'impgd': setView('gdsearch'); if (!el.gq.value) el.gq.focus(); return;
        case 'gdback': return setView('import');
        case 'gdgo': return runGDSearch(true);
        case 'gdmore': return runGDSearch(false);
    }
}

// ======================================================
// 播放
// ======================================================
async function loadSong(id, autoplay) {
    const s = songById(id);
    if (!s) return;
    const blob = await db.getAudio(id);
    if (!blob && !s.url && !s.gd) { toast('error', `《${s.title}》的音频找不到了，可能被浏览器清理了`); return; }
    let src = s.url;
    if (!blob && s.gd) {
        // 流行歌：每次现取链接
        try { src = await resolveGD(s.gd); } catch (e) { toast('warning', e.message || 'GD音乐台暂时连不上'); return; }
        if (!src) { toast('warning', `《${s.title}》在${GD_NAME[s.gd.source] || '这个源'}暂时放不了，可以换个源再搜一次`); return; }
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = blob ? URL.createObjectURL(blob) : null;
    gdRetried = false;
    audio.src = audioUrl || src;
    settings.songId = id;
    save();
    await loadLyrics(id);
    render();
    updateMediaSession();
    if (autoplay) play();
}

async function play() {
    if (!audio.src) {
        const ids = listSongIds(settings.listId);
        const id = settings.songId && ids.includes(settings.songId) ? settings.songId : ids[0];
        if (!id) { toast('info', '还没有歌，点星星进歌单导入'); return; }
        await loadSong(id, false);
    }
    try { await audio.play(); } catch (e) { console.warn(TAG, e); }
}

function step(dir, auto = false) {
    let ids = listSongIds(settings.listId);
    if (!ids.length) { ids = listSongIds(ALL); settings.listId = ALL; }
    if (!ids.length) return;
    if (auto && settings.playMode === 'one') { audio.currentTime = 0; play(); return; }
    let i = ids.indexOf(settings.songId);
    let next;
    if (settings.playMode === 'shuffle' && ids.length > 1) {
        do { next = ids[Math.floor(Math.random() * ids.length)]; } while (next === settings.songId);
    } else {
        next = ids[(i + dir + ids.length) % ids.length];
    }
    loadSong(next, true);
}

function playFromList(listId, id) {
    settings.listId = listId;
    save();
    loadSong(id, true);
}

audio.addEventListener('play', () => { stopPreview(); el.root?.classList.add('se-playing'); renderPlayBtn(); syncNotesLoop(); });
audio.addEventListener('pause', () => { el.root?.classList.remove('se-playing'); renderPlayBtn(); });
audio.addEventListener('ended', () => step(1, true));
audio.addEventListener('timeupdate', () => { renderProgress(); renderLyricsTick(); });
audio.addEventListener('loadedmetadata', () => {
    renderProgress();
    const s = currentSong();
    if (s && !s.duration && isFinite(audio.duration)) { s.duration = audio.duration; db.saveIndex(library.index); }
});
let gdRetried = false;
audio.addEventListener('error', async () => {
    if (!audio.src) return;
    const s = currentSong();
    // 流行歌的链接放久了会失效：重新取一次，从刚才的位置接着放
    if (s?.gd && !gdRetried) {
        gdRetried = true;
        const at = audio.currentTime || 0;
        try {
            const url = await resolveGD(s.gd, true);
            if (url) {
                audio.src = url;
                audio.addEventListener('loadedmetadata', () => { if (at) audio.currentTime = at; }, { once: true });
                await audio.play();
                return;
            }
        } catch (e) { console.warn(TAG, e); }
        toast('error', `《${s.title}》现在放不了，可能是这个源暂时没有它`);
        return;
    }
    toast('error', '这首歌播放不了，可能是格式不支持');
});

async function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const s = currentSong();
    if (!s) return;
    const art = await coverUrl(s.id);
    try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: s.title, artist: s.artist, artwork: art ? [{ src: art, sizes: '512x512' }] : [] });
        navigator.mediaSession.setActionHandler('play', play);
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
        navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
        navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
        navigator.mediaSession.setActionHandler('seekto', d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
    } catch { /* 部分浏览器不支持某些动作 */ }
}

// ======================================================
// 渲染
// ======================================================
async function render() {
    const s = currentSong();
    const has = library.index.length > 0;
    $$('.se-title', el.card).forEach(n => { n.textContent = s ? s.title : (has ? '选一首歌' : '还没有歌'); });
    $$('.se-artist', el.card).forEach(n => { n.textContent = s ? (s.artist || '未知歌手') : (has ? '点左下角的星星打开歌单' : '点左下角的星星导入'); });
    const url = s ? await coverUrl(s.id) : null;
    $$('.se-cover', el.card).forEach(n => { n.style.backgroundImage = url ? `url("${url}")` : ''; });
    ['prev', 'toggle', 'next'].forEach(a => $(`[data-act="${a}"]`, el.card).classList.toggle('se-dim', !has));
    renderPlayBtn();
    renderProgress();
    renderModes();
    if (el.card.dataset.view === 'lists') renderLists();
    if (el.card.dataset.view === 'list') renderSongList();
    if (el.card.dataset.view === 'lyrics') renderLyrics(true);
}

function renderPlayBtn() {
    const b = $('.se-playbtn', el.card);
    if (!b) return;
    b.innerHTML = audio.paused ? ICON.play : ICON.pause;
    b.setAttribute('aria-label', audio.paused ? '播放' : '暂停');
}

function renderProgress() {
    const d = isFinite(audio.duration) ? audio.duration : (currentSong()?.duration || 0);
    const t = audio.currentTime || 0;
    $$('.se-cur', el.card).forEach(n => { n.textContent = fmt(t); });
    $$('.se-left', el.card).forEach(n => { n.textContent = '-' + fmt(Math.max(d - t, 0)); });
    $$('.se-track b', el.card).forEach(n => { n.style.width = (d ? (t / d) * 100 : 0) + '%'; });
}

function renderModes() {
    $$('[data-mode]', el.card).forEach(b => {
        const on = b.dataset.mode === settings.playMode;
        b.classList.toggle('se-on', on);
        b.setAttribute('aria-pressed', on);
    });
}

// ---------- 歌单总览 ----------
function renderLists() {
    const s = currentSong();
    const rows = [{ id: ALL, name: '全部歌曲', songIds: library.index.map(x => x.id) }, ...library.playlists];
    el.plRows.innerHTML = rows.map(p => {
        const inIt = s && p.songIds.includes(s.id);
        const playing = !!s && p.id === settings.listId;   // 正在按这个歌单放
        // 右边的圈：当前这首在不在这个歌单里。「全部歌曲」永远都在，不画圈
        const check = s && p.id !== ALL
            ? `<button class="se-check${inIt ? ' se-on' : ''}" data-check="${esc(p.id)}" aria-label="${inIt ? '从这个歌单移出当前歌' : '把当前歌加进这个歌单'}">${inIt ? '✓' : ''}</button>`
            : '';
        return `<div class="se-row${playing ? ' se-playing-row' : ''}" data-id="${esc(p.id)}">
  <div class="se-row-main" data-open="${esc(p.id)}"><div>${esc(p.name)}<small>${listSongIds(p.id).length} 首</small></div>${playing ? '<div class="se-row-sub">正在播放</div>' : ''}</div>
  ${check}
</div>`;
    }).join('') + '<div class="se-row se-new" data-newlist><div class="se-row-main">＋ 新建歌单</div></div>';

    $$('[data-open]', el.plRows).forEach(n => n.addEventListener('click', () => { openListId = n.dataset.open; setView('list'); }));
    $$('[data-check]', el.plRows).forEach(n => n.addEventListener('click', e => { e.stopPropagation(); toggleInList(n.dataset.check); }));
    $('[data-newlist]', el.plRows).addEventListener('click', newPlaylist);
    $$('.se-row[data-id]', el.plRows).forEach(n => { if (n.dataset.id !== ALL) longPress(n, () => editPlaylist(n.dataset.id)); });
    renderModes();
}

async function toggleInList(listId) {
    const s = currentSong();
    const pl = library.playlists.find(p => p.id === listId);
    if (!s || !pl) return;
    const i = pl.songIds.indexOf(s.id);
    if (i >= 0) pl.songIds.splice(i, 1); else pl.songIds.push(s.id);
    await db.savePlaylists(library.playlists);
    renderLists();
}

async function newPlaylist() {
    const { Popup } = ctx();
    const name = await Popup.show.input('新建歌单', '给它起个名字', '');
    if (!name || !String(name).trim()) return;
    library.playlists.push({ id: uid(), name: String(name).trim(), songIds: [] });
    await db.savePlaylists(library.playlists);
    renderLists();
}

async function editPlaylist(id) {
    const pl = library.playlists.find(p => p.id === id);
    if (!pl) return;
    const { Popup, POPUP_TYPE, POPUP_RESULT } = ctx();
    const popup = new Popup('改名，或者删掉这个歌单', POPUP_TYPE.INPUT, pl.name, {
        okButton: '改名',
        cancelButton: '取消',
        customButtons: [{ text: '删除歌单', result: POPUP_RESULT.CUSTOM1, classes: ['red_button'] }],
    });
    const value = await popup.show();
    if (popup.result === POPUP_RESULT.CUSTOM1) {
        const ok = await Popup.show.confirm('删除歌单', `删掉「${pl.name}」？里面的歌不会被删，还在全部歌曲里。`);
        if (!ok) return;
        library.playlists = library.playlists.filter(p => p.id !== id);
        if (settings.listId === id) { settings.listId = ALL; save(); }
    } else if (typeof value === 'string' && value.trim()) {
        pl.name = value.trim();
    } else return;
    await db.savePlaylists(library.playlists);
    renderLists();
}

// ---------- 歌单详情 ----------
function renderSongList() {
    $('.se-list-name', el.card).textContent = listName(openListId);
    const ids = listSongIds(openListId);
    if (!ids.length) {
        el.songRows.innerHTML = `<div class="se-blank">${openListId === ALL ? '还没有歌，点下面导入' : '这个歌单是空的。<br>放歌的时候点星星，在歌单旁边打勾就能加进来'}</div>`;
        return;
    }
    const delText = openListId === ALL ? '删除' : '移出歌单';
    el.songRows.innerHTML = ids.map(id => {
        const s = songById(id);
        const now = id === settings.songId ? ' se-playing-row' : '';
        const tags = [s.artist || '未知歌手'];
        if ((s.url && !s.local) || s.gd) tags.push('在线');
        if (s.instrumental) tags.push('纯音乐');
        if (s.mood) tags.push(s.mood);
        if (s.license) tags.push(s.license);
        return `<div class="se-song" data-song="${esc(id)}">
  <div class="se-row${now}">
    <div class="se-row-main"><div>${esc(s.title)}</div><div class="se-row-sub">${esc(tags.join(' · '))}</div></div>
    <button class="se-more" data-more aria-label="编辑这首歌" aria-expanded="false">${ICON.more}</button>
  </div>
  <div class="se-row-acts" hidden>
    <button data-op="edit">改歌名</button><button data-op="cover">换封面</button><button data-op="lyrics">找歌词</button><button data-op="tag">生成标签</button>${s.notes ? `<button data-op="notes" class="se-notes-sw${s.notesOn ? ' se-on' : ''}" role="switch" aria-checked="${!!s.notesOn}">分析给 char 看</button>` : ''}<button data-op="del" class="se-danger">${delText}</button>
  </div>
</div>`;
    }).join('');
    $$('.se-song', el.songRows).forEach(box => {
        const id = box.dataset.song;
        $('.se-row-main', box).addEventListener('click', () => { playFromList(openListId, id); renderSongList(); });
        $('[data-more]', box).addEventListener('click', e => {
            e.stopPropagation();
            const acts = $('.se-row-acts', box);
            const open = acts.hidden;
            $$('.se-row-acts', el.songRows).forEach(x => { x.hidden = true; });
            $$('[data-more]', el.songRows).forEach(b => { b.classList.remove('se-on'); b.setAttribute('aria-expanded', 'false'); });
            acts.hidden = !open;
            const btn = e.currentTarget;
            btn.classList.toggle('se-on', open);
            btn.setAttribute('aria-expanded', String(open));
        });
        $$('[data-op]', box).forEach(btn => btn.addEventListener('click', e => {
            e.stopPropagation();
            const op = btn.dataset.op;
            if (op === 'edit') editSongInfo(id);
            else if (op === 'notes') toggleNotes(id, btn);
            else if (op === 'cover') changeCover(id);
            else if (op === 'lyrics') openLyricSearch(id, 'list');
            else if (op === 'tag') analyzeOne(id);
            else if (op === 'del') removeSong(id);
        }));
    });
}

/** 歌单里单独给一首歌重新分析、打标签（不管它原来有没有标签） */
async function analyzeOne(id) {
    const s = songById(id);
    if (!s) return;
    const viaApi = settings.tagMode === 'model';
    if (viaApi && !subApiUsable()) { noApiPopup(settings.apiOn ? '' : '共享耳机 API 现在是关着的。'); return; }
    if (s.tagBy === 'user') {
        const ok = await ctx().Popup.show.confirm('重新分析这首歌', `《${s.title}》的标签你手动改过，重新分析会把标签、情绪${viaApi ? '和氛围分析' : ''}都换成新的。确定吗？`);
        if (!ok) return;
        delete s.tagBy;
    }
    if (tagging) toast('info', `前面还有歌在分析，《${s.title}》排在后面`);
    else if (!viaApi) toast('info', `正在用规则换算给《${s.title}》生成标签…设置里「氛围标签怎么来」选的是规则换算，只出标签，不写氛围分析`);
    const n = await tagSongs([id], true);
    // 走共享耳机 API 的，写好、出错都会自己提示；规则换算这里补一句结果
    if (!viaApi && n != null) {
        if (n) toast('success', `《${s.title}》的标签换好了（规则换算）：${[s.mood, ...(s.tags || [])].filter(Boolean).join('、')}`);
        else toast('warning', `《${s.title}》没能听到声音（可能对方不让网页读取），规则换算给不出标签，可以手动填`);
    }
}

/** 歌单里每首歌的开关：这首歌的氛围分析要不要一起给 char 看 */
async function toggleNotes(id, btn) {
    const s = songById(id);
    if (!s?.notes) return;
    s.notesOn = !s.notesOn;
    btn.classList.toggle('se-on', s.notesOn);
    btn.setAttribute('aria-checked', String(s.notesOn));
    await db.saveIndex(library.index);
    if (id === settings.songId) updateInjection();
    toast('info', s.notesOn
        ? `《${s.title}》的氛围分析会一起给 char 看，放这首时每轮多几百到上千 token`
        : `《${s.title}》只给 char 看标签，不给分析`);
}

async function editSongInfo(id) {
    const s = songById(id);
    if (!s) return;
    const { Popup, POPUP_TYPE } = ctx();
    const box = document.createElement('div');
    box.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px;text-align:left">
  <label>歌名<input class="text_pole" data-f="title"></label>
  <label>歌手<input class="text_pole" data-f="artist"></label>
  <label>氛围标签（用逗号隔开）<input class="text_pole" data-f="tags"></label>
  <label>情绪（char 换歌时按这个挑）<select class="text_pole" data-f="mood"><option value="">不设</option>${MOOD_WORDS.map(w => `<option>${w}</option>`).join('')}</select></label>
  <label>氛围分析（共享耳机 API 写的，可以改；要不要给 char 看在歌单里开关）<textarea class="text_pole" data-f="notes" rows="8" placeholder="还没有分析。打开共享耳机 API 后重新生成标签，或者自己写一段"></textarea></label></div>`;
    $('[data-f="title"]', box).value = s.title;
    $('[data-f="artist"]', box).value = s.artist || '';
    $('[data-f="tags"]', box).value = (s.tags || []).join('，');
    $('[data-f="mood"]', box).value = s.mood || '';
    $('[data-f="notes"]', box).value = s.notes || '';
    $('[data-f="notes"]', box).addEventListener('keydown', e => e.stopPropagation());
    const ok = await new Popup(box, POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消' }).show();
    if (!ok) return;
    const title = $('[data-f="title"]', box).value.trim();
    const artist = $('[data-f="artist"]', box).value.trim();
    if (!title) return;
    s.title = title;
    s.artist = artist;
    const tags = $('[data-f="tags"]', box).value.split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 6);
    const mood = $('[data-f="mood"]', box).value;
    if (tags.join() !== (s.tags || []).join() || mood !== (s.mood || '')) { s.tags = tags; s.mood = mood; s.tagBy = 'user'; }
    const notes = $('[data-f="notes"]', box).value.trim();
    if (notes !== (s.notes || '')) { s.notes = notes; if (!notes) s.notesOn = false; }
    await db.saveIndex(library.index);
    if (id === settings.songId) updateInjection();
    render();
    renderSongList();
    if ((!s.hasLyrics && settings.autoLyrics) || (!s.hasCover && settings.autoCover)) enrich([id], true);
}

async function changeCover(id) {
    const s = songById(id);
    if (!s) return;
    const [f] = await pickFiles('image/*', false);
    if (!f) return;
    const blob = await shrinkImage(f, 600, 'blob');
    await db.putCover(id, blob);
    s.hasCover = true;
    if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
    await db.saveIndex(library.index);
    render();
    if (id === settings.songId) updateMediaSession();
    toast('success', '封面换好了');
}

async function removeSong(id) {
    const s = songById(id);
    if (!s) return;
    const { Popup } = ctx();
    if (openListId === ALL) {
        const ok = await Popup.show.confirm('删除歌曲', `把《${s.title}》从浏览器里彻底删掉？所有歌单里都会一起消失。`);
        if (!ok) return;
        if (settings.songId === id) {
            audio.pause(); audio.removeAttribute('src'); audio.load();
            settings.songId = null; lyricData = null; save();
        }
        library.index = library.index.filter(x => x.id !== id);
        library.playlists.forEach(p => { p.songIds = p.songIds.filter(x => x !== id); });
        if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
        await db.removeSongData(id);
        await db.saveIndex(library.index);
    } else {
        const pl = library.playlists.find(p => p.id === openListId);
        if (!pl) return;
        pl.songIds = pl.songIds.filter(x => x !== id);
    }
    await db.savePlaylists(library.playlists);
    render();
    renderSongList();
}

// ======================================================
// 导入歌曲
// ======================================================
const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
const isAudioFile = (f) => /^(audio|video)\//.test(f.type) || AUDIO_EXT.test(f.name);

function progressToast(total, label) {
    if (total < 2 || !window.toastr) return { set() {}, done() {} };
    const tip = toastr.info(`${label} 0/${total}`, '', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
    return {
        set: (n) => tip.find('.toast-message').text(`${label} ${n}/${total}`),
        done: () => toastr.clear(tip),
    };
}

/** 存一首歌。成功返回 id，失败抛错。 */
async function addSongFile(file, extra = {}) {
    const guess = guessFromFilename(file.name);
    const tag = await readTags(file);
    const id = uid();
    const type = file.type || MIME_BY_EXT[extOf(file.name)] || 'audio/mpeg';
    await db.putAudio(id, new Blob([file], { type }));
    if (tag.cover) await db.putCover(id, tag.cover);
    if (tag.lyrics) await db.putLyrics(id, tag.lyrics);
    library.index.push({
        id,
        title: (tag.title || guess.title || '未命名').trim(),
        artist: (tag.artist || guess.artist || '').trim(),
        file: guess.base,
        hasCover: !!tag.cover,
        hasLyrics: !!tag.lyrics,
        duration: 0,
        added: Date.now(),
        ...extra,
    });
    return id;
}

/** 把一批 .lrc 按名字配给歌。返回配上的数量。 */
async function matchLyricTexts(items, preferIds = null) {
    let n = 0;
    for (const { name, text } of items) {
        const key = normalizeName(name);
        const pool = preferIds ? library.index.filter(x => preferIds.includes(x.id)) : library.index;
        const s = [...pool, ...library.index].find(x =>
            normalizeName(x.file) === key || normalizeName(x.title) === key ||
            normalizeName(`${x.artist}-${x.title}`) === key || normalizeName(`${x.title}-${x.artist}`) === key);
        if (s) { await setSongLyrics(s.id, text); n++; }
    }
    return n;
}

/** 文件统一入口：歌、歌词、压缩包、备份都从这里分流。 */
async function handleIncoming(files, intoListId = importTarget) {
    const songs = files.filter(isAudioFile);
    const lrcs = files.filter(f => /\.(lrc|txt)$/i.test(f.name));
    const zips = files.filter(f => /\.zip$/i.test(f.name));
    const backups = files.filter(f => /\.sebk$/i.test(f.name));
    if (!songs.length && !lrcs.length && !zips.length && !backups.length) {
        toast('warning', '没认出能导入的文件');
        return;
    }
    await db.requestPersist();
    const newIds = [];
    let failed = 0;
    const prog = progressToast(songs.length, '正在导入');
    for (const [i, f] of songs.entries()) {
        try { newIds.push(await addSongFile(f)); } catch (e) {
            console.error(TAG, e);
            failed++;
            if (e?.name === 'QuotaExceededError') { toast('error', '浏览器存储空间满了，后面的歌没存进去'); break; }
        }
        prog.set(i + 1);
    }
    prog.done();
    for (const z of zips) {
        const r = await importZip(z);
        newIds.push(...r.ids);
        failed += r.failed;
    }
    for (const bk of backups) {
        try {
            const r = await db.importBackup(bk);
            library = await db.loadLibrary();
            toast('success', `从备份恢复了 ${r.songs} 首歌`);
        } catch (e) { toast('error', e.message || '备份导入失败'); }
    }
    await finishImport(newIds, intoListId, failed);
    if (lrcs.length) {
        const items = await Promise.all(lrcs.map(async f => ({ name: f.name, text: await f.text() })));
        const n = await matchLyricTexts(items, newIds);
        toast(n ? 'success' : 'warning', `歌词配上了 ${n} 个` + (n < items.length ? `，${items.length - n} 个没找到同名的歌` : ''));
    }
}

async function finishImport(newIds, intoListId, failed = 0, { tag = true } = {}) {
    if (intoListId) {
        const pl = library.playlists.find(p => p.id === intoListId);
        if (pl) newIds.forEach(id => { if (!pl.songIds.includes(id)) pl.songIds.push(id); });
    }
    await db.saveIndex(library.index);
    await db.savePlaylists(library.playlists);
    if (newIds.length || failed) toast(newIds.length ? 'success' : 'error', `导入了 ${newIds.length} 首` + (failed ? `，${failed} 首失败` : ''));
    if (!settings.songId && library.index.length) await loadSong(library.index[0].id, false);
    if (el.card.dataset.view === 'import') setView(intoListId ? 'list' : 'lists');
    render();
    if (newIds.length) { enrich(newIds); if (tag) tagSongs(newIds); }
}

async function importFromPicker() {
    const files = await pickFiles(FILE_ACCEPT);
    if (files.length) await handleIncoming(files, importTarget);
}

async function importFromZipPicker() {
    const files = await pickFiles('.zip,application/zip', true);
    if (files.length) await handleIncoming(files, importTarget);
}

async function importZip(zipFile) {
    const ids = [];
    let failed = 0;
    let entries;
    try { entries = await listZip(zipFile); } catch (e) { toast('error', e.message); return { ids, failed: 0 }; }
    const songs = entries.filter(x => AUDIO_EXT.test(x.name));
    const lrcs = entries.filter(x => /\.lrc$/i.test(x.name));
    if (!songs.length) { toast('warning', `「${zipFile.name}」里没找到歌`); return { ids, failed: 0 }; }
    const prog = progressToast(songs.length, '正在解压导入');
    for (const [i, entry] of songs.entries()) {
        try {
            const f = await extractZip(zipFile, entry, MIME_BY_EXT[extOf(entry.name)] || '');
            ids.push(await addSongFile(f));
        } catch (e) {
            console.error(TAG, e);
            failed++;
            if (e?.name === 'QuotaExceededError') { toast('error', '浏览器存储空间满了，后面的歌没存进去'); break; }
        }
        prog.set(i + 1);
    }
    prog.done();
    if (lrcs.length) {
        await db.saveIndex(library.index);
        const items = [];
        for (const entry of lrcs) {
            try { items.push({ name: entry.name.split('/').pop(), text: await (await extractZip(zipFile, entry, 'text/plain')).text() }); } catch { /* 跳过 */ }
        }
        await matchLyricTexts(items, ids);
    }
    return { ids, failed };
}

/** 网易云链接按流行歌的方式加进歌库。不是网易云链接返回 null；加不了抛出带原因的错误。 */
async function addNeteaseLink(job) {
    let nid = neteaseSongId(job.url);
    let info = null;
    if (!nid && isNeteaseShort(job.url) && job.listShare) {
        throw new Error('网易云歌单的短链接解析不了。在网页版打开这个歌单，复制地址栏里带 playlist?id= 的完整链接再粘');
    }
    if (!nid && isNeteaseShort(job.url)) {
        // 短链接解不开跳转，用分享文字里的歌名歌手去搜
        if (!job.title) throw new Error('网易云短链接解析不了，把分享时的整段文字一起粘进来，或者在浏览器打开后复制完整链接');
        const r = await searchGD(`${job.title} ${job.artist}`.trim(), 'netease');
        const hit = r.items.find(m => m.title === job.title) || r.items[0];
        if (!hit) throw new Error(`在网易云没搜到《${job.title}》`);
        nid = hit.id;
        info = { title: hit.title, artist: hit.artist, album: hit.album, picId: hit.picId };
    }
    if (!nid) return null;
    const m = { source: 'netease', id: nid };
    if (haveGD(m)) return { dup: true };
    info ||= await neteaseInfo(nid);
    Object.assign(m, {
        title: info?.title || job.title || `网易云歌曲 ${nid}`,
        artist: info?.artist || job.artist || '',
        album: info?.album || '',
        picId: info?.picId || '',
    });
    return { id: await addGDRecord(m), named: !!(info?.title || job.title) };
}

/** 整张网易云歌单导入：每首按流行歌的方式在线播放，放进一个新歌单（或者正在导入的那个歌单）。 */
async function importNeteasePlaylist(pid) {
    const { Popup } = ctx();
    const tip = window.toastr?.info('正在读网易云歌单…', '', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
    let tracks;
    try { tracks = await neteasePlaylist(pid); } catch (e) { toast('error', e.message); return; } finally { if (tip) window.toastr.clear(tip); }

    // 目标歌单：从某个歌单里点「导入歌曲到这里」进来的，就放那里；不然新建一个
    let listId = importTarget;
    if (!listId) {
        const name = await Popup.show.input('导入网易云歌单', `读到 ${tracks.length} 首。给新歌单起个名字：`, '网易云歌单');
        if (name === null || name === false) return;
        listId = uid();
        library.playlists.push({ id: listId, name: String(name).trim() || '网易云歌单', songIds: [] });
    }
    const pl = library.playlists.find(p => p.id === listId);

    await db.requestPersist();
    const newIds = [];
    let dup = 0;
    const prog = progressToast(tracks.length, '正在导入歌单');
    for (const [i, t] of tracks.entries()) {
        prog.set(i);
        const m = { source: 'netease', id: t.id };
        const old = library.index.find(s => s.gd && gdKey(s.gd) === gdKey(m));
        if (old) {   // 歌库里已经有了，只放进歌单
            dup++;
            if (pl && !pl.songIds.includes(old.id)) pl.songIds.push(old.id);
            continue;
        }
        Object.assign(m, { title: t.title || `网易云歌曲 ${t.id}`, artist: t.artist, album: '', picId: '' });
        newIds.push(await addGDRecord(m, await neteaseCover(t.pic)));
    }
    prog.set(tracks.length);
    prog.done();
    if (dup) toast('info', `${dup} 首歌库里已经有了，直接放进了歌单`);
    if (newIds.length) toast('info', `${newIds.length} 首网易云的歌按流行歌加进来了，在线播放，没网时放不了`);

    // 歌多的时候先问一句再打标签：每首都要下载一遍来听，用共享耳机 API 的话每首还要调一次接口
    let tag = true;
    if (newIds.length > 20) {
        tag = !!(await Popup.show.confirm('现在打标签吗？',
            `这次新加了 ${newIds.length} 首。现在就分析、打标签的话，每首都要下载一遍来听` +
            (settings.tagMode === 'model' ? '，还要各调一次共享耳机 API，会花不少时间' : '') +
            '。<br><br>选「取消」先不打，之后可以在扩展设置里点「给没有标签的歌生成标签」。'));
    }
    await finishImport(newIds, listId, 0, { tag });
}

async function importFromLinks() {
    const { Popup } = ctx();
    const text = await Popup.show.input('粘贴链接', '音频文件的直接链接，一行一个。网易云的歌曲链接，或者 App 里「分享 → 复制链接」的整段文字也可以直接粘。网易云歌单要用网页版地址栏里带 playlist?id= 的完整链接，歌单得是公开的。', '', { rows: 6 });
    if (!text) return;
    // 一行一行看：网易云的分享文字长这样「分享某某的单曲《歌名》: https://163cn.tv/xxxx (来自@网易云音乐)」
    const jobs = [];
    for (const line of String(text).split(/\n+/)) {
        const urls = line.match(/https?:\/\/[^\s"'<>]+/gi) || [];
        const title = line.match(/《(.+?)》/)?.[1]?.trim() || '';
        const artist = line.match(/分享(.+?)的单曲/)?.[1]?.trim() || '';
        const listShare = /的歌单/.test(line);   // 「分享某某创建的歌单「歌单名」: https://163cn.tv/xxxx」
        for (const raw of urls) jobs.push({ url: raw.replace(/[，。,;；)）】]+$/, ''), title, artist, listShare });
    }
    if (!jobs.length) { toast('warning', '没找到链接'); return; }
    // 网易云歌单单独处理：整张读出来，建一个新歌单
    const listJobs = jobs.filter(j => neteasePlaylistId(j.url));
    for (const j of listJobs) await importNeteasePlaylist(neteasePlaylistId(j.url));
    jobs.splice(0, jobs.length, ...jobs.filter(j => !listJobs.includes(j)));
    if (!jobs.length) return;
    await db.requestPersist();
    const newIds = [];
    const failures = [];
    let online = 0, netease = 0, dup = 0, unnamed = 0;
    const prog = progressToast(jobs.length, '正在处理链接');
    for (const [i, job] of jobs.entries()) {
        const { url } = job;
        prog.set(i);
        // 网易云：按流行歌的方式在线播放
        try {
            const r = await addNeteaseLink(job);
            if (r) {
                if (r.dup) dup++;
                else { newIds.push(r.id); netease++; if (!r.named) unnamed++; }
                continue;
            }
        } catch (e) { failures.push(e.message || '网易云暂时连不上'); continue; }

        const name = decodeURIComponent((new URL(url).pathname.split('/').pop() || 'link').replace(/\+/g, ' ')) || '链接歌曲';
        let saved = false;
        let reason = '连不上，或者不是能直接打开的音频文件';
        // 先试试能不能整个下载下来
        try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 90000);
            const r = await fetch(url, { signal: ctl.signal });
            clearTimeout(timer);
            const type = r.headers.get('content-type') || '';
            if (!r.ok) {
                reason = r.status === 404 || r.status === 410 ? '链接里的文件已经不在了（404）'
                    : r.status === 401 || r.status === 403 ? `对方不让访问（${r.status}）`
                    : `对方服务器出错了（${r.status}）`;
            } else if (/text\/html|json|xml/i.test(type)) {
                reason = '打开是网页，不是音频文件';
            } else {
                const blob = await r.blob();
                newIds.push(await addSongFile(new File([blob], AUDIO_EXT.test(name) ? name : name + '.mp3', { type: blob.type || type }), { url, local: true }));
                saved = true;
            }
        } catch { /* 多半是对方不允许网页下载，下面试在线播放 */ }
        if (!saved) {
            if (await canStream(url)) {
                const guess = guessFromFilename(name);
                const id = uid();
                library.index.push({ id, title: guess.title || '链接歌曲', artist: guess.artist || '', file: guess.base, hasCover: false, hasLyrics: false, duration: 0, added: Date.now(), url, local: false });
                newIds.push(id);
                online++;
            } else failures.push(reason);
        }
    }
    prog.set(jobs.length);
    prog.done();
    if (netease) toast('info', `${netease} 首网易云的歌按流行歌加进来了，在线播放，没网时放不了` + (unnamed ? `。其中 ${unnamed} 首没取到歌名，可以在歌单里点铅笔改` : ''));
    if (dup) toast('info', `${dup} 首网易云的歌歌库里已经有了`);
    if (online) toast('info', `${online} 首只能在线播放，没联网的时候放不了。可以在歌单里点铅笔改歌名`);
    const byReason = {};
    failures.forEach(r => { byReason[r] = (byReason[r] || 0) + 1; });
    for (const [r, n] of Object.entries(byReason)) toast('warning', `${n} 个链接放不了：${r}`);
    await finishImport(newIds, importTarget, 0);
}

function canStream(url) {
    return new Promise(resolve => {
        const a = new Audio();
        a.preload = 'metadata';
        const end = (ok) => { clearTimeout(timer); a.removeAttribute('src'); a.load(); resolve(ok); };
        const timer = setTimeout(() => end(false), 12000);
        a.addEventListener('loadedmetadata', () => end(true), { once: true });
        a.addEventListener('error', () => end(false), { once: true });
        a.src = url;
    });
}

// ======================================================
// 在线找歌（开放授权音乐）
// ======================================================
const preview = new Audio();
preview.preload = 'none';
let previewIdx = -1;
let music = { q: '', page: 0, items: [], hasMore: false, busy: false };
const savedFree = new Set();    // 这次搜索里已经收下的

function stopPreview() {
    if (!preview.paused) preview.pause();
    previewIdx = -1;
    gdPreviewIdx = -1;
    $$('[data-prev]', el.musicRows || document).forEach(b => { b.textContent = '▶'; });
    $$('[data-gprev]', el.gdRows || document).forEach(b => { b.textContent = '▶'; });
}
preview.addEventListener('ended', stopPreview);
preview.addEventListener('error', () => { if (previewIdx >= 0 || gdPreviewIdx >= 0) { toast('warning', '这首试听不了'); stopPreview(); } });

async function runMusicSearch(reset) {
    const q = el.mq.value.trim();
    if (!q || music.busy) return;
    if (reset) { stopPreview(); music = { q, page: 0, items: [], hasMore: false, busy: false }; el.musicRows.innerHTML = '<div class="se-blank">正在搜…</div>'; }
    music.busy = true;
    try {
        const r = await searchFree(music.q, music.page + 1);
        music.page++;
        music.items.push(...r.items);
        music.hasMore = r.hasMore;
    } catch (e) {
        if (reset) el.musicRows.innerHTML = `<div class="se-blank">${esc(e.message || '曲库暂时连不上')}</div>`;
        else toast('warning', e.message || '曲库暂时连不上');
        return;
    } finally {
        music.busy = false;
    }
    renderMusicResults();
}

function renderMusicResults() {
    if (!music.items.length) {
        el.musicRows.innerHTML = '<div class="se-blank">没搜到。这个曲库只认英文，换个英文词试试，或者点上面的情绪词</div>';
        return;
    }
    el.musicRows.innerHTML = music.items.map((m, i) => {
        const have = savedFree.has(m.url) || library.index.some(s => s.url === m.url);
        return `<div class="se-row se-music-row">
  <button class="se-mini-btn" data-prev="${i}" aria-label="试听">${previewIdx === i ? '❚❚' : '▶'}</button>
  <div class="se-row-main"><div>${esc(m.title)}</div><div class="se-row-sub">${esc(m.artist || '未知')} · ${fmt(m.duration)} · ${esc(m.license)}</div></div>
  <button class="se-mini-btn${have ? ' se-done' : ''}" data-save="${i}" aria-label="${have ? '已收下' : '收进歌库'}">${have ? '✓' : '＋'}</button>
</div>`;
    }).join('') + (music.hasMore ? '<button class="se-more-results" data-act="musicmore">加载更多</button>' : '');
    $$('[data-prev]', el.musicRows).forEach(b => b.addEventListener('click', e => { e.stopPropagation(); togglePreview(Number(b.dataset.prev)); }));
    $$('[data-save]', el.musicRows).forEach(b => b.addEventListener('click', e => { e.stopPropagation(); saveFreeTrack(Number(b.dataset.save), b); }));
}

function togglePreview(i) {
    const m = music.items[i];
    if (!m) return;
    if (previewIdx === i) { stopPreview(); return; }
    stopPreview();
    if (!audio.paused) audio.pause();
    previewIdx = i;
    preview.src = m.url;
    preview.play().catch(() => { toast('warning', '这首试听不了'); stopPreview(); });
    const b = $(`[data-prev="${i}"]`, el.musicRows);
    if (b) b.textContent = '❚❚';
}

async function saveFreeTrack(i, btn) {
    const m = music.items[i];
    if (!m || btn.classList.contains('se-done') || btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.innerHTML = LOADING;
    await db.requestPersist();
    const extra = { url: m.url, license: m.license, licenseUrl: m.licenseUrl, pageUrl: m.pageUrl, source: m.source, noEnrich: true };
    let id = null;
    try {
        const r = await fetch(m.url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const blob = await r.blob();
        id = await addSongFile(new File([blob], `${m.artist} - ${m.title}.mp3`, { type: blob.type || 'audio/mpeg' }), { ...extra, local: true });
    } catch {
        // 下载不了就在线播放
        id = uid();
        library.index.push({ id, title: m.title, artist: m.artist, file: m.title, hasCover: false, hasLyrics: false, duration: m.duration, added: Date.now(), ...extra, local: false });
    }
    const s = songById(id);
    s.title = m.title;           // 以曲库的信息为准，文件里的标签常常不全
    s.artist = m.artist;
    if (!s.duration) s.duration = m.duration;
    if (!s.hasCover) {
        const thumb = await fetchThumb(m.thumb);
        if (thumb) { await db.putCover(id, thumb); s.hasCover = true; }
    }
    if (importTarget) library.playlists.find(p => p.id === importTarget)?.songIds.push(id);
    await db.saveIndex(library.index);
    await db.savePlaylists(library.playlists);
    savedFree.add(m.url);
    delete btn.dataset.busy;
    btn.textContent = '✓';
    btn.classList.add('se-done');
    if (!settings.songId) await loadSong(id, false);
    render();
    toast('success', `《${m.title}》收进歌库了`);
    tagSongs([id]);
}

// ======================================================
// 流行歌（GD音乐台，只在线播放）
// ======================================================
let gdState = { source: 'netease', q: '', page: 0, items: [], hasMore: false, busy: false };
let gdPreviewIdx = -1;
const gdKey = (m) => `${m.source}:${m.id}`;
const haveGD = (m) => library.index.some(s => s.gd && gdKey(s.gd) === gdKey(m));

async function runGDSearch(reset) {
    const q = el.gq.value.trim();
    if (!q || gdState.busy) return;
    if (reset) {
        stopPreview();
        gdState = { ...gdState, q, page: 0, items: [], hasMore: false, busy: false };
        el.gdRows.innerHTML = '<div class="se-blank">正在搜…</div>';
    }
    gdState.busy = true;
    try {
        const r = await searchGD(gdState.q, gdState.source, gdState.page + 1);
        gdState.page++;
        const seen = new Set(gdState.items.map(gdKey));
        gdState.items.push(...r.items.filter(m => !seen.has(gdKey(m))));
        gdState.hasMore = r.hasMore;
    } catch (e) {
        if (reset) el.gdRows.innerHTML = `<div class="se-blank">${esc(e.message || 'GD音乐台暂时连不上')}</div>`;
        else toast('warning', e.message || 'GD音乐台暂时连不上');
        return;
    } finally {
        gdState.busy = false;
    }
    renderGDResults();
}

function renderGDResults() {
    if (!gdState.items.length) {
        el.gdRows.innerHTML = '<div class="se-blank">没搜到。换个写法，或者点上面换个源试试</div>';
        return;
    }
    el.gdRows.innerHTML = gdState.items.map((m, i) => {
        const have = haveGD(m);
        const sub = [m.artist || '未知歌手', m.album].filter(Boolean).join(' · ');
        return `<div class="se-row se-music-row">
  <button class="se-mini-btn" data-gprev="${i}" aria-label="试听">${gdPreviewIdx === i ? '❚❚' : '▶'}</button>
  <div class="se-row-main"><div>${esc(m.title)}</div><div class="se-row-sub">${esc(sub)}</div></div>
  <button class="se-mini-btn${have ? ' se-done' : ''}" data-gsave="${i}" aria-label="${have ? '已加进歌库' : '加进歌库'}">${have ? '✓' : '＋'}</button>
</div>`;
    }).join('') + (gdState.hasMore ? '<button class="se-more-results" data-act="gdmore">加载更多</button>' : '');
    $$('[data-gprev]', el.gdRows).forEach(b => b.addEventListener('click', e => { e.stopPropagation(); toggleGDPreview(Number(b.dataset.gprev)); }));
    $$('[data-gsave]', el.gdRows).forEach(b => b.addEventListener('click', e => { e.stopPropagation(); saveGDTrack(Number(b.dataset.gsave), b); }));
}

async function toggleGDPreview(i) {
    const m = gdState.items[i];
    if (!m) return;
    if (gdPreviewIdx === i) { stopPreview(); return; }
    stopPreview();
    if (!audio.paused) audio.pause();
    gdPreviewIdx = i;
    const b = $(`[data-gprev="${i}"]`, el.gdRows);
    if (b) b.innerHTML = LOADING;
    let url = '';
    try { url = await resolveGD(m); } catch (e) { toast('warning', e.message); }
    if (gdPreviewIdx !== i) return; // 等链接的时候又点了别的
    if (!url) { toast('warning', '这首在这个源放不了，换个源试试'); stopPreview(); return; }
    preview.src = url;
    preview.play().catch(() => { toast('warning', '这首试听不了'); stopPreview(); });
    if (b) b.textContent = '❚❚';
}

/** 把一首流行歌记进歌库（只记来源和 ID，不下载音频），顺便取封面。返回新 id。
 *  cover 传了（哪怕是 null）就用它，不再去 GD音乐台取，省它的额度。 */
async function addGDRecord(m, cover) {
    const id = uid();
    library.index.push({
        id, title: m.title, artist: m.artist || '', album: m.album || '', file: m.title,
        hasCover: false, hasLyrics: false, duration: 0, added: Date.now(),
        gd: { source: m.source, id: m.id }, source: `GD音乐台 · ${GD_NAME[m.source] || m.source}`, local: false,
    });
    if (cover === undefined) cover = await fetchGDCover(m.source, m.picId);
    if (cover) { await db.putCover(id, cover); songById(id).hasCover = true; }
    return id;
}

async function saveGDTrack(i, btn) {
    const m = gdState.items[i];
    if (!m || btn.classList.contains('se-done') || btn.dataset.busy) return;
    btn.dataset.busy = '1';
    btn.innerHTML = LOADING;
    const id = await addGDRecord(m);
    if (importTarget) library.playlists.find(p => p.id === importTarget)?.songIds.push(id);
    await db.saveIndex(library.index);
    await db.savePlaylists(library.playlists);
    delete btn.dataset.busy;
    btn.textContent = '✓';
    btn.classList.add('se-done');
    if (!settings.songId) await loadSong(id, false);
    render();
    toast('success', `《${m.title}》加进歌库了`);
    enrich([id], true); // 歌词照旧去 LRCLIB 配
    tagSongs([id]);
}

// ======================================================
// 联网补全：时长、封面、歌词
// ======================================================
async function probeDuration(id) {
    const s = songById(id);
    const blob = await db.getAudio(id);
    const src = blob ? URL.createObjectURL(blob) : s?.url;
    if (!src) return 0;
    return new Promise(resolve => {
        const a = new Audio();
        a.preload = 'metadata';
        const end = (d) => { clearTimeout(timer); if (blob) URL.revokeObjectURL(src); a.removeAttribute('src'); a.load(); resolve(d); };
        const timer = setTimeout(() => end(0), 8000);
        a.addEventListener('loadedmetadata', () => end(isFinite(a.duration) ? a.duration : 0), { once: true });
        a.addEventListener('error', () => end(0), { once: true });
        a.src = src;
    });
}

async function enrich(ids, quiet = false) {
    if (enriching) { setTimeout(() => enrich(ids, quiet), 1500); return; }
    if (!settings.autoLyrics && !settings.autoCover) return;
    enriching = true;
    let lyr = 0, cov = 0, inst = 0, coverBlocked = false, lyricBlocked = false;
    try {
        for (const id of ids) {
            const s = songById(id);
            if (!s || s.noEnrich) continue; // 从开放曲库收的歌信息本来就齐，不去打扰歌词库
            if (!s.duration) s.duration = await probeDuration(id);
            if (settings.autoCover && !s.hasCover && !coverBlocked) {
                try {
                    const blob = await findCover(s);
                    if (blob) { await db.putCover(id, blob); s.hasCover = true; cov++; }
                } catch (e) { if (e.limited) coverBlocked = true; else console.warn(TAG, '找封面失败', s.title, e); }
            }
            if (settings.autoLyrics && !s.hasLyrics && !s.instrumental && !lyricBlocked) {
                try {
                    const r = await findLyrics(s);
                    if (r?.instrumental) { s.instrumental = true; inst++; }
                    else if (r?.text) { await db.putLyrics(id, r.text); s.hasLyrics = true; lyr++; }
                } catch (e) { if (e.limited) lyricBlocked = true; console.warn(TAG, '找歌词失败', s.title, e); }
            }
            await db.saveIndex(library.index);
            if (id === settings.songId) {
                if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
                await loadLyrics(id);
                render();
                updateMediaSession();
            }
            if (coverBlocked && lyricBlocked) break;
            await new Promise(r => setTimeout(r, 1200)); // 每首之间歇一下，别把人家服务器问烦了
        }
    } finally {
        enriching = false;
    }
    if (el.card.dataset.view === 'list') renderSongList();
    if (lyr || cov || inst) {
        const parts = [];
        if (lyr) parts.push(`${lyr} 首歌词`);
        if (cov) parts.push(`${cov} 张封面`);
        if (inst) parts.push(`${inst} 首认出是纯音乐`);
        toast('success', '自动配上了 ' + parts.join('、'));
    } else if (!quiet && ids.length && !coverBlocked && !lyricBlocked) {
        toast('info', '网上没找到能对上的歌词或封面，可以在歌词页点放大镜手动搜');
    }
    if (coverBlocked || lyricBlocked) {
        toast('warning', `${lyricBlocked ? '歌词库' : '封面搜索'}让我们慢一点，剩下的先停了。过几分钟去扩展设置里点「补全缺的歌词和封面」就行`);
    }
}

// ======================================================
// 氛围标签：本地分析（零 token）+ 规则换算或共享耳机 API
// ======================================================
// ---------- 共享耳机 API：只给这个插件用，只用来打标签。走酒馆服务器转发（自定义 OpenAI 兼容接口），不受浏览器跨域限制 ----------
const subApiReady = () => !!(settings.apiUrl?.trim() && settings.apiModel?.trim());
const subApiUsable = () => !!settings.apiOn && subApiReady();
const tagPrompt = () => settings.tagPrompt?.trim() || DEFAULT_TAG_PROMPT;

function subApiBody() {
    const url = settings.apiUrl.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
    const key = settings.apiKey?.trim();
    // 酒馆转发时请求头里的 Authorization 默认用它自己存的 key，这里用 custom_include_headers 换成共享耳机 API 的 key
    return { chat_completion_source: 'custom', custom_url: url, custom_include_headers: key ? `Authorization: ${JSON.stringify('Bearer ' + key)}` : '' };
}

async function stHeaders() {
    const f = await stFn('getRequestHeaders');
    return f ? f() : { 'Content-Type': 'application/json' };
}

/** 调共享耳机 API，返回模型回复的文字。等太久（默认 3 分钟）就放弃，不会一直卡着。 */
async function subApiChat(messages, maxTokens = 400, waitMs = 180000) {
    let j, status = 0;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), waitMs);
    try {
        const r = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            headers: await stHeaders(),
            body: JSON.stringify({ ...subApiBody(), model: settings.apiModel.trim(), messages, max_tokens: maxTokens, temperature: 0.7, stream: false }),
            signal: ctl.signal,
        });
        status = r.status;
        j = await r.json().catch(() => null);
    } catch (e) {
        if (ctl.signal.aborted) throw new Error(`等了 ${Math.round(waitMs / 60000)} 分钟还没回，可能是接口太慢`);
        throw new Error('酒馆没能转发请求：' + (e.message || e));
    } finally {
        clearTimeout(timer);
    }
    // 接口报错的样子各家不一样：{error:{message}}、{error:'...'}、{error:true, message}、{message}……都认一下，把原话带出来
    const errMsg = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || (j?.error ? j?.message : '') || '';
    if (errMsg || j?.error) throw new Error(`接口报错：${errMsg || '没给原因'}`);
    if (status >= 400 || !j) throw new Error(`接口报错（${status || '没有回应'}）${j?.message ? '：' + j.message : ''}`);
    const text = j?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.text ?? '';
    if (!String(text).trim()) throw new Error('接口没有返回内容（可能是这个模型用不了，或者思考太长被截断）');
    return String(text);
}

/**
 * 用共享耳机 API 打标签：先按分析提示词写一段氛围分析，最后一行给 JSON 标签。
 * 分析存进 s.notes，要不要给 char 看由歌单里每首歌的开关决定。
 */
async function subApiTags(s) {
    let lyrics = '';
    if (s.hasLyrics) {
        const raw = (await db.getLyrics(s.id)) || '';
        lyrics = parseLyrics(raw).lines.map(l => l.text).filter(Boolean).join('\n').slice(0, 3000);
    }
    const info = [
        '【这首歌的信息】',
        `歌名：${s.title}`,
        s.artist ? `歌手：${s.artist}` : '',
        s.album ? `专辑：${s.album}` : '',
        s.instrumental ? '这是一首纯音乐。' : '',
        s.duration ? `时长：${fmt(s.duration)}` : '',
        s.analysis
            ? `声音特征（插件在浏览器里把整首歌过了一遍测出来的，相当于你的耳朵；粗略，但比瞎猜可靠）：\n- ${describeAnalysis(s.analysis).split('；').join('\n- ')}`
            : '（这首没能在本地测声音特征）',
        lyrics ? `歌词：\n${lyrics}` : '',
        '说明：你听不到音频本身。空间感、节奏、能量走向、调性这些听觉维度，优先依据上面测出来的声音特征来写；你认识这首歌（或这部作品）的话，可以结合你知道的编曲和演唱；两边都没有依据的维度就照实说不明显，不要编。',
    ].filter(Boolean).join('\n');
    const tail = [
        '【输出格式】',
        '直接从第一个维度开始写，不要开场白、不要复述任务、不要客套话。不要用 Markdown 符号（不要 **、#、- 这些），每个维度用「1）情绪基调与色彩：」这样的格式开头，维度之间空一行。',
        '先按上面的要求写完分析。分析写完后，另起一行，只用一行 JSON 收尾，JSON 后面不要再写任何东西：',
        `{"tags":["4到6个中文氛围标签"],"mood":"从 ${MOOD_WORDS.join('/')} 里选一个"}`,
        '标签每个 2 到 8 个字，要具体、有画面，比如「深夜独自回家」「雨后潮湿的街」「克制的想念」，不要只写「安静」「悲伤」这种笼统的词。',
    ].join('\n');
    const prompt = `${info}\n\n【分析要求】\n${tagPrompt()}\n\n${tail}`;
    const out = await subApiChat([
        { role: 'system', content: '你是细腻的音乐氛围分析者。按要求写分析，最后用一行 JSON 收尾。' },
        { role: 'user', content: prompt },
    ], 8000);
    // 有的模型会先吐一段思考过程，去掉；再找最后一个带 tags 的 JSON
    const clean = out.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const all = [...clean.matchAll(/\{[^{}]*\}/g)].filter(m => /"tags"/.test(m[0]));
    const hit = all[all.length - 1];
    if (!hit) {
        const said = clean.replace(/\s+/g, ' ').trim();
        // 回得很短，多半是接口把报错当成回复发回来了
        if (said.length < 400) throw new Error(`接口没有给出分析，它回的是：「${said.slice(0, 160)}」`);
        throw new Error('分析写了但没写完，最后的标签没给出来（可能太长被截断了），再试一次通常就好');
    }
    const j = JSON.parse(hit[0]);
    const tags = (Array.isArray(j.tags) ? j.tags : []).map(x => String(x).trim()).filter(Boolean).slice(0, 6);
    const mood = MOOD_WORDS.includes(j.mood) ? j.mood : (MOOD_WORDS.find(w => tags.includes(w)) || '');
    if (!tags.length && !mood) throw new Error('共享耳机 API 没给出标签');
    // JSON 前面的就是分析；去掉收尾的代码块记号
    const notes = clean.slice(0, hit.index).replace(/```(?:json)?\s*$/i, '')
        .replace(/\*\*/g, '').replace(/^#{1,6}\s*/gm, '').trim();
    return { tags, mood, notes };
}

/** 没开共享耳机 API 时弹窗告诉一声，可以手动加标签 */
async function noApiPopup(reason = '') {
    const { Popup } = ctx();
    const body = `${reason ? reason + '<br><br>' : ''}这几首歌先没打标签。可以在歌单里点歌名右边的铅笔 → 改歌名，手动填氛围标签和情绪；也可以去扩展设置「让 char 听见」里添加并打开共享耳机 API。`;
    if (Popup?.show?.text) await Popup.show.text('没有添加共享耳机 API', body);
    else toast('warning', '没有添加共享耳机 API，可以在歌单里点铅笔手动添加标签');
}

/** 共享耳机 API 加了也开了，但调用出错：把原因原样告诉你 */
async function apiErrorPopup(reason) {
    const { Popup } = ctx();
    const body = `${esc(reason)}<br><br>可以在设置里的模型下拉框换一个模型，再点「重新生成全部标签」。<br>这几首歌先没打标签，也可以在歌单里点铅笔手动填。`;
    if (Popup?.show?.text) await Popup.show.text('共享耳机 API 出错了', body);
    else toast('error', `共享耳机 API 出错了：${reason}`);
}

/**
 * 拿一份音频给本地分析用。存在浏览器里的直接用；在线的歌（流行歌、只能在线放的链接）试着临时下载一份，
 * 只用来分析，不存。对方不让网页读取、或者没网，就算了。
 */
async function audioForAnalysis(s) {
    const blob = await db.getAudio(s.id);
    if (blob) return blob;
    if (!s.gd && !s.url) return null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000); // 连下载带读完一共最多等 1 分钟
    try {
        let r = null;
        // 网易云的歌先走 Meting 取音频，不占 GD音乐台 5 分钟 50 次的额度；不行再走 GD
        if (s.gd?.source === 'netease') {
            try { r = await fetch(neteaseAudioUrl(s.gd.id), { signal: ctl.signal }); } catch { r = null; }
            if (r && (!r.ok || !/audio|octet-stream/i.test(r.headers.get('content-type') || ''))) r = null;
        }
        if (!r) {
            const url = s.gd ? await resolveGD(s.gd) : s.url;
            if (!url) return null;
            r = await fetch(url, { signal: ctl.signal });
        }
        if (!r.ok || /text\/html|json/i.test(r.headers.get('content-type') || '')) return null;
        if (Number(r.headers.get('content-length') || 0) > 25_000_000) return null; // 太大的（无损长曲）不下，手机吃不消
        const b = await r.blob();
        return b.size > 20000 ? b : null;
    } catch { return null; } finally { clearTimeout(timer); }
}

/** 给一个 Promise 限时：超时就当它失败 */
function withTimeout(p, ms) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('超时')), ms); })]).finally(() => clearTimeout(t));
}

/** 打标签时一直挂着的进度提示：正在听哪首、正在写哪首 */
function statusToast() {
    if (!window.toastr) return { set() {}, done() {} };
    let tip = null;
    return {
        set(msg) {
            if (!tip) tip = toastr.info(msg, '共享耳机', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false });
            else tip.find('.toast-message').text(msg);
        },
        done() { if (tip) toastr.clear(tip); tip = null; },
    };
}

/** 给歌打标签。force 为真时连已经有标签的也重做（你手动改过的不动）。 */
async function tagSongs(ids, force = false) {
    if (tagging) { setTimeout(() => tagSongs(ids, force), 2000); return; }
    tagging = true;
    let done = 0, failReason = '', needApi = false;
    const useModel = settings.tagMode === 'model';
    const useApi = useModel && subApiUsable();
    const todo = ids.map(songById).filter(s => s && s.tagBy !== 'user' && (!s.mood || force));
    const tip = useApi ? statusToast() : { set() {}, done() {} };
    const nth = (i) => (todo.length > 1 ? `（${i + 1}/${todo.length}）` : '');
    const doneTitles = [];
    try {
        for (const [i, s] of todo.entries()) {
            const id = s.id;
            // 1. 本地「听」一遍，零 token（背面音符的速度、给 char 的 BPM、给共享耳机 API 的声音特征都靠它）
            if (!s.analysis || s.analysis.v !== ANALYSIS_VERSION) {
                tip.set(`正在听《${s.title}》${nth(i)}…`);
                try {
                    const blob = await audioForAnalysis(s);
                    if (blob) s.analysis = await withTimeout(analyzeAudio(blob), 60000);
                } catch (e) { console.warn(TAG, '音频分析失败（跳过，只靠歌名歌词）', s.title, e); }
            }
            // 2. 规则换算 或 共享耳机 API
            let r = null;
            if (useModel) {
                if (!useApi || failReason) { needApi = true; await db.saveIndex(library.index); continue; }
                tip.set(`正在写《${s.title}》的氛围分析${nth(i)}…一首大概要半分钟到两分钟`);
                try {
                    r = await subApiTags(s);
                    doneTitles.push(s.title);
                    s.tagBy = 'subapi';
                    s.notes = r.notes;
                    if (!r.notes) s.notesOn = false;
                } catch (e) {
                    console.warn(TAG, '共享耳机 API 打标签失败', e);
                    failReason = e?.message || '没连上';
                    needApi = true;
                }
            } else if (s.analysis) {
                r = tagsByRules(s.analysis);
                s.tagBy = 'rules';
            }
            if (r) { s.tags = r.tags; s.mood = r.mood; done++; }
            await db.saveIndex(library.index);
        }
    } finally {
        tagging = false;
        tip.done();
    }
    if (el.card.dataset.view === 'list') renderSongList();
    if (doneTitles.length) toast('success', doneTitles.length === 1
        ? `《${doneTitles[0]}》的氛围分析写好了，在歌单里点铅笔 → 改歌名 能看到`
        : `${doneTitles.length} 首歌的氛围分析写好了`);
    if (needApi) {
        if (failReason) apiErrorPopup(failReason);
        else if (!settings.apiOn && subApiReady()) noApiPopup('共享耳机 API 现在是关着的。');
        else noApiPopup();
    }
    return done;
}

// ======================================================
// 让 char 听见：每次生成前把正在放的歌塞进提示词
// ======================================================
function lyricWindow() {
    if (!lyricData?.lines.length) return '';
    const L = lyricData.lines;
    let i;
    if (lyricData.timed) {
        i = 0;
        for (let k = 0; k < L.length; k++) { if (L[k].t <= audio.currentTime + 0.15) i = k; else break; }
    } else {
        const d = audio.duration || currentSong()?.duration || 0;
        i = d ? Math.floor((audio.currentTime / d) * L.length) : 0;
    }
    return L.slice(Math.max(0, i), i + 3).map(l => l.text).filter(Boolean).join('\n');
}

function libraryMoods() {
    return [...new Set(library.index.map(s => s.mood).filter(Boolean))];
}

function buildInjection() {
    if (!settings.listen || audio.paused) return '';
    const s = currentSong();
    if (!s) return '';
    const c = ctx();
    const out = ['[背景音乐 · 只作为氛围参考]'];
    out.push(`${c.name1 || '用户'}此刻耳机里放着《${s.title}》${s.artist ? '（' + s.artist + '）' : ''}。`);
    const vibe = [s.mood, ...(s.tags || [])].filter(Boolean);
    if (s.instrumental) vibe.push('纯音乐');
    if (s.analysis?.bpm) vibe.push(`约 ${Math.round(s.analysis.bpm)} BPM`);
    if (vibe.length) out.push(`氛围：${[...new Set(vibe)].join('、')}`);
    // 这首歌在歌单里打开了「分析给 char 看」，就把氛围分析一起给
    if (s.notesOn && s.notes) out.push(`氛围分析：\n${s.notes.slice(0, 3000)}`);
    if (settings.listenMode === 'lines') {
        const seg = lyricWindow();
        if (seg) out.push(`此刻唱到：\n${seg}`);
    } else if (settings.listenMode === 'full' && lyricData?.lines.length) {
        const all = lyricData.lines.map(l => l.text).filter(Boolean).join('\n');
        out.push(`歌词：\n${all.slice(0, 2500)}`);
    }
    out.push('写作要求：结合当前情节，把这首歌的情绪和意象自然地化进叙述里，可以体现在语气、节奏、环境细节或人物心境上；场景不搭的时候只轻轻影响语气，不要硬套。用你自己的话写，不要引用或改写歌词原句，也不要提到音乐、歌曲、歌名、耳机或「在听歌」这件事。');
    const moods = libraryMoods();
    if (settings.autoSwitch && turnsSinceSwitch >= settings.switchCooldown && moods.some(m => m !== s.mood)) {
        out.push(`如果这一段正文的情绪和这首歌明显不搭，可以在回复的最后单独写一个 <bgm>情绪词</bgm> 来换背景音乐，情绪词只能从这些里选：${moods.join('、')}。不需要换就别写。正文里不要解释或提到换歌。`);
    }
    return out.join('\n');
}

function updateInjection() {
    const { setExtensionPrompt } = ctx();
    if (!setExtensionPrompt) return;
    // 放在聊天记录里、最后一条消息之前，系统身份：离生成最近，模型最重视
    setExtensionPrompt(INJECT_KEY, buildInjection(), 1, 1, false, 0);
}

// ---------- char 换歌 ----------
const BGM_RE = /\s*<bgm>\s*([^<]{1,12}?)\s*<\/bgm>\s*/gi;

async function onCharMessage(id) {
    const c = ctx();
    const m = c.chat?.[id];
    if (!m || m.is_user || m.is_system) return;
    if (!m.mes || !BGM_RE.test(m.mes)) return;
    BGM_RE.lastIndex = 0;
    let mood = '';
    m.mes = m.mes.replace(BGM_RE, (_, w) => { if (!mood) mood = w.trim(); return ''; }).trimEnd();
    if (Array.isArray(m.swipes) && m.swipe_id != null) m.swipes[m.swipe_id] = m.mes;
    // 翻译之类的扩展会把显示文本另存在 extra.display_text，酒馆渲染时优先用它，所以这里也要删
    if (typeof m.extra?.display_text === 'string') m.extra.display_text = m.extra.display_text.replace(BGM_RE, '').trimEnd();
    const updateMessageBlock = await stFn('updateMessageBlock');
    updateMessageBlock?.(Number(id), m);
    c.saveChat?.();
    if (mood && settings.listen && settings.autoSwitch) switchToMood(mood);
}

function switchToMood(mood) {
    const fits = (s) => s && s.id !== settings.songId && (s.mood === mood || (s.tags || []).includes(mood));
    let pool = listSongIds(settings.listId).map(songById).filter(fits);
    if (!pool.length) pool = library.index.filter(fits);
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    turnsSinceSwitch = 0;
    loadSong(pick.id, true);
    toast('info', `换了一首：《${pick.title}》`);
}

// ---------- 在线找歌词 ----------
let lrcBackView = 'lyrics';
let lrcResults = [];

function openLyricSearch(id, backTo) {
    const s = songById(id);
    if (!s) { toast('info', '先选一首歌'); return; }
    lrcTargetId = id;
    lrcBackView = backTo;
    el.q.value = `${s.title} ${s.artist || ''}`.trim();
    el.lrcRows.innerHTML = '';
    setView('lrcsearch');
    runLyricSearch();
}

async function runLyricSearch() {
    const q = el.q.value.trim();
    if (!q) return;
    el.lrcRows.innerHTML = '<div class="se-blank">正在搜…</div>';
    try {
        lrcResults = await searchLyrics(q);
    } catch {
        el.lrcRows.innerHTML = '<div class="se-blank">连不上歌词库，检查一下网络再试</div>';
        return;
    }
    if (!lrcResults.length) {
        el.lrcRows.innerHTML = '<div class="se-blank">没搜到。可以只搜歌名，或者换成歌手的另一种写法试试</div>';
        return;
    }
    const want = songById(lrcTargetId)?.duration || 0;
    el.lrcRows.innerHTML = lrcResults.slice(0, 30).map((r, i) => {
        const kind = r.instrumental ? '纯音乐' : r.synced ? '带时间轴' : r.plain ? '纯文本' : '无歌词';
        const fit = want && r.duration && Math.abs(r.duration - want) <= 3 ? ' · 时长吻合' : '';
        return `<div class="se-row" data-pick="${i}"><div class="se-row-main"><div>${esc(r.title)}</div><div class="se-row-sub">${esc(r.artist)} · ${fmt(r.duration)} · ${kind}${fit}</div></div></div>`;
    }).join('');
    $$('[data-pick]', el.lrcRows).forEach(n => n.addEventListener('click', () => pickLyricResult(lrcResults[Number(n.dataset.pick)])));
}

async function pickLyricResult(r) {
    const s = songById(lrcTargetId);
    if (!s || !r) return;
    if (r.instrumental) {
        s.instrumental = true;
        await setSongLyrics(s.id, '');
        s.instrumental = true;
        await db.saveIndex(library.index);
        toast('success', '标成纯音乐了');
    } else if (r.synced || r.plain) {
        await setSongLyrics(s.id, r.synced || r.plain);
        toast('success', '歌词换好了');
    } else {
        toast('warning', '这一条没有歌词内容，换一条试试');
        return;
    }
    if (lrcBackView === 'list') setView('list');
    else setView('lyrics');
}

// ======================================================
// 歌词
// ======================================================
async function loadLyrics(id) {
    lyricIdx = -1;
    const s = songById(id);
    const text = s?.hasLyrics ? await db.getLyrics(id) : null;
    lyricData = text ? parseLyrics(text) : null;
}

function renderLyrics(resetScroll) {
    const s = currentSong();
    const has = lyricData && lyricData.lines.length;
    el.empty.hidden = !!has || !s;
    el.lines.hidden = !has;
    $('.se-empty-text', el.card).textContent = s?.instrumental ? '这首是纯音乐，没有歌词' : '这首还没有歌词';
    if (!has) { el.lines.innerHTML = ''; return; }
    el.lines.classList.toggle('se-plain', !lyricData.timed);
    el.lines.innerHTML = lyricData.lines.map(l => `<div class="se-line" data-t="${l.t}">${esc(l.text) || '&nbsp;'}</div>`).join('');
    lyricIdx = -1;
    if (resetScroll) el.lines.scrollTop = 0;
    renderLyricsTick(true);
}

function renderLyricsTick(instant) {
    if (el.card?.dataset.view !== 'lyrics' || !lyricData?.timed) return;
    const t = audio.currentTime;
    const L = lyricData.lines;
    let lo = 0, hi = L.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid].t <= t + 0.15) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx === lyricIdx) return;
    const nodes = el.lines.children;
    nodes[lyricIdx]?.classList.remove('se-now');
    lyricIdx = idx;
    const cur = nodes[idx];
    if (!cur) return;
    cur.classList.add('se-now');
    if (Date.now() - userScrolledAt < 3000) return;
    const top = cur.offsetTop - el.lines.clientHeight / 2 + cur.offsetHeight / 2;
    el.lines.scrollTo({ top, behavior: instant ? 'auto' : 'smooth' });
}

async function setSongLyrics(id, text) {
    const s = songById(id);
    if (!s) return;
    if (text && text.trim()) { await db.putLyrics(id, text); s.hasLyrics = true; s.instrumental = false; }
    else { await db.putLyrics(id, ''); s.hasLyrics = false; }
    await db.saveIndex(library.index);
    if (id === settings.songId) { await loadLyrics(id); renderLyrics(true); }
}

async function editLyrics() {
    const s = currentSong();
    if (!s) return;
    const { Popup } = ctx();
    const old = s.hasLyrics ? (await db.getLyrics(s.id)) || '' : '';
    const text = await Popup.show.input(`《${s.title}》的歌词`, '可以粘贴带时间轴的 LRC，也可以是纯文本。清空就是删除歌词。', old, { rows: 12, wide: true });
    if (text === null || text === false) return;
    await setSongLyrics(s.id, String(text));
}

async function importLyricFiles(forCurrent = false) {
    const files = await pickFiles('.lrc,.txt,text/plain');
    if (!files.length) return;
    let matched = 0;
    const unmatched = [];
    for (const f of files) {
        const text = await f.text();
        if (forCurrent && files.length === 1 && currentSong()) { await setSongLyrics(settings.songId, text); matched++; continue; }
        const key = normalizeName(f.name);
        const s = library.index.find(x =>
            normalizeName(x.file) === key || normalizeName(x.title) === key ||
            normalizeName(`${x.artist}-${x.title}`) === key || normalizeName(`${x.title}-${x.artist}`) === key);
        if (s) { await setSongLyrics(s.id, text); matched++; } else unmatched.push(f);
    }
    if (unmatched.length === 1 && currentSong() && files.length === 1) {
        await setSongLyrics(settings.songId, await unmatched[0].text());
        toast('info', '没找到同名的歌，已经给正在放的这首');
        return;
    }
    toast(matched ? 'success' : 'warning', `配上了 ${matched} 首` + (unmatched.length ? `，${unmatched.length} 个文件没找到同名的歌` : ''));
}

// ======================================================
// 背面
// ======================================================
function chatKey() {
    const c = ctx();
    if (c.groupId) return 'g:' + c.groupId;
    const ch = c.characters?.[c.characterId];
    return ch?.avatar ? 'c:' + ch.avatar : 'none';
}

async function userAvatarFile() {
    try {
        const mod = await import(new URL('../../../personas.js', import.meta.url).href);
        return mod.user_avatar || '';
    } catch { return ''; }
}

function charAvatarFile() {
    const c = ctx();
    if (c.groupId) {
        for (let i = c.chat.length - 1; i >= 0; i--) {
            const m = c.chat[i];
            if (!m.is_user && !m.is_system && m.original_avatar) return m.original_avatar;
        }
        const g = c.groups.find(x => x.id === c.groupId);
        return g?.members?.[0] || '';
    }
    return c.characters?.[c.characterId]?.avatar || '';
}

function setAvatar(node, src, fallback) {
    if (!node) return;
    if (!src) { node.removeAttribute('href'); return; }
    node.onerror = () => { if (fallback && node.getAttribute('href') !== fallback) node.setAttribute('href', fallback); };
    node.setAttribute('href', src);
}

async function refreshBack() {
    const c = ctx();
    const charFile = charAvatarFile();
    const userFile = await userAvatarFile();
    setAvatar($('#se-avL', el.card), charFile ? 'characters/' + encodeURIComponent(charFile) : '', charFile ? c.getThumbnailUrl('avatar', charFile) : '');
    setAvatar($('#se-avR', el.card), userFile ? 'User%20Avatars/' + encodeURIComponent(userFile) : '', userFile ? c.getThumbnailUrl('persona', userFile) : '');
    const saved = settings.texts[chatKey()] || {};
    const defaults = { left: c.name2 || 'char', right: c.name1 || '你', long: '' };
    $$('[data-key]', el.card).forEach(n => {
        if (document.activeElement === n) return;
        setText(n, saved[n.dataset.key] ?? defaults[n.dataset.key]);
    });
}

const getText = (n) => (n.tagName === 'TEXTAREA' ? n.value : n.textContent);
const setText = (n, v) => { if (n.tagName === 'TEXTAREA') n.value = v; else n.textContent = v; };

let textTimer = null;
function saveTexts() {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
        const out = {};
        $$('[data-key]', el.card).forEach(n => { out[n.dataset.key] = getText(n).trim(); });
        settings.texts[chatKey()] = out;
        save();
    }, 400);
}

// ---------- 音符顺着线流 ----------
const NOTE_TYPES = [
    { id: 'se-n-quarter', w: 3, ax: 9 }, { id: 'se-n-eighth', w: 3, ax: 9 }, { id: 'se-n-half', w: 2, ax: 9 },
    { id: 'se-n-sixteenth', w: 2, ax: 9 }, { id: 'se-n-pair', w: 1.4, ax: 21 }, { id: 'se-n-four', w: 0.8, ax: 36 },
];
const NOTE_TOTAL = NOTE_TYPES.reduce((a, t) => a + t.w, 0);
const BEAT = 0.62, SPEED = 110, NOTE_SCALE = 1.25;
let flows = null, notes = [], noteRaf = 0, noteLast = null, noteClock = 0, beatAcc = 0;

function pickNote() {
    let r = Math.random() * NOTE_TOTAL;
    for (const t of NOTE_TYPES) if ((r -= t.w) < 0) return t;
    return NOTE_TYPES[0];
}

function spawnNote(f, s = 0) {
    const t = pickNote();
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', '#' + t.id);
    g.appendChild(u);
    g.setAttribute('fill', 'var(--se-note)');
    g.style.color = 'var(--se-note)';
    el.notes.appendChild(g);
    notes.push({ g, f, t, s, ph: Math.random() * 6.28, tilt: (Math.random() - 0.5) * 16 });
}

/** 沿着耳机线每隔 1 个单位量一个点存起来，动画时直接查表，不用每帧让浏览器重新算曲线 */
function samplePath(path) {
    const len = path.getTotalLength();
    const n = Math.ceil(len) + 2;
    const xs = new Float32Array(n), ys = new Float32Array(n);
    for (let i = 0; i < n; i++) { const pt = path.getPointAtLength(Math.min(i, len)); xs[i] = pt.x; ys[i] = pt.y; }
    return { len, xs, ys };
}

function pointOn(f, s) {
    const i = Math.min(Math.max(Math.floor(s), 0), f.xs.length - 2), t = s - i;
    return { x: f.xs[i] + (f.xs[i + 1] - f.xs[i]) * t, y: f.ys[i] + (f.ys[i + 1] - f.ys[i]) * t };
}

function drawNote(n) {
    const p = n.s / n.f.len;
    const pt = pointOn(n.f, n.s);
    const a = Math.min(1, p / 0.06, (1 - p) / 0.1);
    const k = NOTE_SCALE * (0.55 + 0.45 * a);
    const bob = Math.sin(noteClock * 3 + n.ph) * 3;
    const op = a.toFixed(2);
    if (n.op !== op) { n.op = op; n.g.setAttribute('opacity', op); } // 透明度只在变了的时候才改
    n.g.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${(pt.y + bob).toFixed(1)}) rotate(${n.tilt.toFixed(1)}) scale(${k.toFixed(3)}) translate(${-n.t.ax} -40)`);
}

function noteFrame(ts) {
    // 按真实经过的时间走：中间卡了一下，音符会直接到它该在的位置，不会被拖慢（切到后台回来时最多补 0.3 秒）
    const dt = noteLast === null ? 0 : Math.min(0.3, (ts - noteLast) / 1000);
    noteLast = ts;
    const moving = !audio.paused && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (moving) {
        // 音符跟着这首歌自己的速度走：慢歌流得慢、疏，快歌流得快、密
        const bpm = Math.min(Math.max(currentSong()?.analysis?.bpm || 97, 50), 180);
        const beat = 60 / bpm;
        const speed = SPEED * Math.sqrt(bpm / 97);
        noteClock += dt;
        beatAcc += dt;
        while (beatAcc >= beat * 2) { beatAcc -= beat * 2; flows.forEach(f => spawnNote(f, speed * beatAcc)); }
        notes.forEach(n => { n.s += speed * dt; });
    }
    for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (n.s >= n.f.len) { n.g.remove(); notes.splice(i, 1); } else drawNote(n);
    }
    noteRaf = requestAnimationFrame(noteFrame);
}

function syncNotesLoop() {
    const visible = el.card && !el.card.classList.contains('se-hidden') && el.card.dataset.view === 'back';
    if (visible && !noteRaf) {
        if (!flows) {
            flows = ['#se-cable-left', '#se-cable-right'].map(sel => samplePath($(sel, el.card)));
            for (const f of flows) for (let s = 30; s < f.len - 40; s += SPEED * BEAT * 2) spawnNote(f, s);
        }
        noteLast = null;
        noteRaf = requestAnimationFrame(noteFrame);
    } else if (!visible && noteRaf) {
        cancelAnimationFrame(noteRaf);
        noteRaf = 0;
    }
}

// ======================================================
// 扩展设置面板
// ======================================================
function buildSettingsPanel() {
    const html = `
<div class="se-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>共享耳机</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="se-switch-row" id="se_ball_visible" role="switch" tabindex="0"><span>显示悬浮球</span><i class="se-switch fa-solid fa-toggle-off"></i></div>
      <hr>
      <div class="flex-container alignitemscenter">
        <span>悬浮球图标</span>
        <div class="menu_button" id="se_icon_pick">更换图片</div>
        <div class="menu_button" id="se_icon_reset">恢复默认</div>
      </div>
      <label for="se_material">质感</label>
      <select id="se_material" class="text_pole"><option value="frost">磨砂</option><option value="liquid">液态玻璃</option></select>
      <label for="se_tint">玻璃明暗</label>
      <select id="se_tint" class="text_pole"><option value="auto">跟随酒馆主题</option><option value="light">偏亮</option><option value="dark">偏暗</option></select>
      <div class="se-switch-row" id="se_auto_lyrics" role="switch" tabindex="0"><span>导入时自动找歌词（LRCLIB）</span><i class="se-switch fa-solid fa-toggle-off"></i></div>
      <div class="se-switch-row" id="se_auto_cover" role="switch" tabindex="0"><span>导入时自动补封面</span><i class="se-switch fa-solid fa-toggle-off"></i></div>
      <small>这两项需要联网，找到的东西会存进浏览器，以后离线也能看。</small>
      <div class="menu_button" id="se_fill">补全缺的歌词和封面</div>
      <hr>
      <div class="se-switch-row se-switch-head" id="se_listen" role="switch" tabindex="0" aria-label="让 char 听见"><b>让 char 听见</b><i class="se-switch fa-solid fa-toggle-off"></i></div>
      <label for="se_listen_mode">给模型看什么</label>
      <select id="se_listen_mode" class="text_pole">
        <option value="vibe">只给氛围（每轮约 40 token）</option>
        <option value="lines">氛围 + 正在唱的几句（每轮约 80 token）</option>
        <option value="full">氛围 + 整首歌词（每轮几百到上千 token）</option>
      </select>
      <small>char 会结合剧情把歌的情绪和意象化进正文，不会照搬歌词，也不会提到你在听歌。</small>
      <label for="se_tag_mode">氛围标签怎么来</label>
      <select id="se_tag_mode" class="text_pole">
        <option value="rules">规则换算（零 token，只看快慢明暗）</option>
        <option value="model">共享耳机 API 判断（每首歌导入时花一次，会写一段氛围分析）</option>
      </select>
      <div class="se-subapi">
        <div class="se-switch-row" id="se_api_on" role="switch" tabindex="0"><b>共享耳机 API（只给这个插件打标签用）</b><i class="se-switch fa-solid fa-toggle-off"></i></div>
        <input id="se_api_url" class="text_pole" type="url" autocomplete="off" spellcheck="false" placeholder="接口地址">
        <input id="se_api_key" class="text_pole" type="password" autocomplete="new-password" spellcheck="false" placeholder="API Key">
        <div class="flex-container alignitemscenter se-btn-row">
          <input id="se_api_model" class="text_pole" autocomplete="off" spellcheck="false" placeholder="模型名（可以手打）">
          <div class="menu_button" id="se_api_fetch">获取模型</div>
          <div class="menu_button" id="se_api_test">测试</div>
        </div>
        <select id="se_api_model_pick" class="text_pole" hidden></select>
        <label for="se_api_prompt">分析提示词</label>
        <textarea id="se_api_prompt" class="text_pole" rows="6" spellcheck="false"></textarea>
        <div class="flex-container alignitemscenter se-btn-row"><div class="menu_button" id="se_api_prompt_reset">恢复默认提示词</div></div>
        <small>选「共享耳机 API 判断」并打开开关后，每首歌导入时让它按提示词写一段氛围分析，再从里面提炼标签和情绪，每首只花一次。歌名、歌词、本地测的速度明暗，还有最后输出标签的格式，插件会自动加上，提示词里不用写。分析存在每首歌里，在歌单点铅笔 → 改歌名可以看和改；点铅笔后的「分析给 char 看」决定这首歌放的时候要不要把分析也给 char。<br>开关关着、或者没填好时，不会借酒馆的主 API，会弹窗提醒你手动添加标签。也可以用快速回复按钮 <code>/musicapi</code>（开关切换）、<code>/musicapi on</code>、<code>/musicapi off</code>。<br>支持 OpenAI 兼容的接口，请求由酒馆服务器转发；Key 存在酒馆的设置文件里。</small>
      </div>
      <div class="menu_button" id="se_tag_all">给没有标签的歌生成标签</div>
      <div class="menu_button" id="se_tag_redo">重新生成全部标签（手动改过的不动）</div>
      <div class="se-switch-row" id="se_switch" role="switch" tabindex="0"><span>char 根据剧情换歌</span><i class="se-switch fa-solid fa-toggle-off"></i></div>
      <div class="flex-container alignitemscenter"><span>换过之后隔</span><input type="number" id="se_cooldown" class="text_pole" min="1" max="20" style="width:4em"><span>轮才能再换</span></div>
      <small>剧情的情绪和正在放的歌明显对不上时，char 会悄悄换一首情绪合适的歌，正文里不会提。标签可以在歌单里点铅笔 → 改歌名 里手动改。</small>
      <hr>
      <div class="flex-container alignitemscenter">
        <span>备份歌库</span>
        <div class="menu_button" id="se_export">导出</div>
        <div class="menu_button" id="se_import">导入</div>
      </div>
      <small>歌存在这个浏览器里，清浏览器数据会一起没掉，换设备也不会跟过去。定期导出一份备份比较安心。</small>
      <hr>
      <div class="menu_button red_button" id="se_clear">清空全部歌曲</div>
    </div>
  </div>
</div>`;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;
    host.insertAdjacentHTML('beforeend', html);

    paintBallSwitch = bindSwitch('#se_ball_visible', () => settings.ballVisible, v => setBallVisible(v));
    const mat = $('#se_material');
    mat.value = settings.material;
    mat.addEventListener('change', () => { settings.material = mat.value; save(); applyLook(); });
    bindSwitch('#se_auto_lyrics', () => settings.autoLyrics, v => { settings.autoLyrics = v; save(); });
    bindSwitch('#se_auto_cover', () => settings.autoCover, v => { settings.autoCover = v; save(); });
    $('#se_fill').addEventListener('click', () => {
        const ids = library.index.filter(s => !s.noEnrich && ((!s.hasLyrics && !s.instrumental) || !s.hasCover)).map(s => s.id);
        if (!ids.length) { toast('info', '每首歌都齐了'); return; }
        toast('info', `开始给 ${ids.length} 首歌补全，在后台慢慢来`);
        enrich(ids);
    });
    bindSwitch('#se_listen', () => settings.listen, v => { settings.listen = v; save(); updateInjection(); });
    const lm = $('#se_listen_mode');
    lm.value = settings.listenMode;
    lm.addEventListener('change', () => { settings.listenMode = lm.value; save(); updateInjection(); });
    const tm = $('#se_tag_mode');
    tm.value = settings.tagMode;
    tm.addEventListener('change', () => { settings.tagMode = tm.value; save(); });
    // 共享耳机 API
    paintApiSwitch = bindSwitch('#se_api_on', () => settings.apiOn, v => setApiOn(v, false));
    const ap = $('#se_api_prompt');
    ap.value = tagPrompt();
    ap.addEventListener('input', () => { const v = ap.value.trim(); settings.tagPrompt = v === DEFAULT_TAG_PROMPT ? '' : v; save(); });
    ap.addEventListener('keydown', e => e.stopPropagation());
    $('#se_api_prompt_reset').addEventListener('click', () => { settings.tagPrompt = ''; ap.value = DEFAULT_TAG_PROMPT; save(); toast('info', '提示词恢复成默认的了'); });
    for (const [sel, key] of [['#se_api_url', 'apiUrl'], ['#se_api_key', 'apiKey'], ['#se_api_model', 'apiModel']]) {
        const n = $(sel);
        n.value = settings[key] || '';
        n.addEventListener('input', () => { settings[key] = n.value.trim(); save(); });
        n.addEventListener('keydown', e => e.stopPropagation());
    }
    // 模型下拉框：拉到列表后显示，选一个就填进模型名
    const pick = $('#se_api_model_pick');
    const fillModels = (ids) => {
        if (!ids?.length) { pick.hidden = true; return; }
        const cur = settings.apiModel || '';
        pick.innerHTML = `<option value="">${cur && ids.includes(cur) ? '换一个模型' : '从列表里选一个模型'}（共 ${ids.length} 个）</option>`
            + ids.map(id => `<option value="${esc(id)}"${id === cur ? ' selected' : ''}>${esc(id)}</option>`).join('');
        pick.hidden = false;
    };
    fillModels(settings.apiModels);
    pick.addEventListener('change', () => {
        if (!pick.value) return;
        settings.apiModel = pick.value;
        $('#se_api_model').value = pick.value;
        save();
        toast('success', `模型换成了 ${pick.value}`);
    });
    $('#se_api_fetch').addEventListener('click', async () => {
        if (!settings.apiUrl) { toast('warning', '先填接口地址'); return; }
        try {
            const r = await fetch('/api/backends/chat-completions/status', { method: 'POST', headers: await stHeaders(), body: JSON.stringify(subApiBody()) });
            const j = await r.json().catch(() => null);
            // 各家接口返回的样子不一样：{data:[...]}、{models:[...]}、直接一个数组，元素可能是对象也可能是字符串
            const list = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
            const ids = [...new Set(list.map(x => (typeof x === 'string' ? x : x?.id || x?.name || '')).filter(Boolean))].sort();
            if (!ids.length) throw new Error(j?.error?.message || (j?.error ? '接口拒绝了，检查一下地址和 Key' : '没拿到模型列表，检查一下地址和 Key；也可以直接手打模型名'));
            settings.apiModels = ids;
            save();
            fillModels(ids);
            toast('success', `拿到 ${ids.length} 个模型，在下面的下拉框里选`);
        } catch (e) { toast('error', e.message || '没拿到模型列表'); }
    });
    $('#se_api_test').addEventListener('click', async () => {
        if (!subApiReady()) { toast('warning', '接口地址和模型名都要填'); return; }
        try {
            const out = (await subApiChat([{ role: 'user', content: '只回复两个字：收到' }], 200)).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            // 有的接口会把报错当成回复发回来，所以不只看「通没通」，还看它回的是不是「收到」
            if (/收到/.test(out)) toast('success', `共享耳机 API 能用，它回复：${out.slice(0, 20)}${settings.apiOn ? '' : '。记得把开关打开'}`);
            else toast('warning', `接口通了，但它没回「收到」，回的是：${out.slice(0, 120)}。如果这是一段报错，说明这个模型用不了，换一个试试`);
        } catch (e) { toast('error', `共享耳机 API 连不上：${e.message}`); }
    });
    $('#se_tag_redo').addEventListener('click', async () => {
        const ids = library.index.filter(s => s.tagBy !== 'user').map(s => s.id);
        if (!ids.length) { toast('info', '没有可以重新生成的歌'); return; }
        const { Popup } = ctx();
        const ok = await Popup.show.confirm('重新生成全部标签', `给 ${ids.length} 首歌重新打标签，用${settings.tagMode === 'model' ? '共享耳机 API（会重写氛围分析）' : '规则换算'}。你手动改过的不动。`);
        if (!ok) return;
        if (settings.tagMode === 'model' && !subApiUsable()) { noApiPopup(settings.apiOn ? '' : '共享耳机 API 现在是关着的。'); return; }
        toast('info', `开始重新生成 ${ids.length} 首歌的标签，在后台慢慢来`);
        const n = await tagSongs(ids, true);
        if (n != null) toast('success', `重新生成了 ${n} 首歌的标签`);
    });
    $('#se_tag_all').addEventListener('click', async () => {
        const ids = library.index.filter(s => !s.mood && s.tagBy !== 'user').map(s => s.id);
        if (!ids.length) { toast('info', '每首歌都有标签了'); return; }
        if (settings.tagMode === 'model' && !subApiUsable()) { noApiPopup(settings.apiOn ? '' : '共享耳机 API 现在是关着的。'); return; }
        toast('info', `开始给 ${ids.length} 首歌生成标签，在后台慢慢来`);
        const n = await tagSongs(ids);
        if (n != null) toast('success', `生成了 ${n} 首歌的标签`); // 正在打别的标签时会排队，不报数
    });
    bindSwitch('#se_switch', () => settings.autoSwitch, v => { settings.autoSwitch = v; save(); updateInjection(); });
    const cd = $('#se_cooldown');
    cd.value = settings.switchCooldown;
    cd.addEventListener('change', () => { settings.switchCooldown = Math.min(Math.max(Number(cd.value) || 3, 1), 20); cd.value = settings.switchCooldown; save(); });
    const tint = $('#se_tint');
    tint.value = settings.tint;
    tint.addEventListener('change', () => { settings.tint = tint.value; save(); applyLook(); });

    $('#se_icon_pick').addEventListener('click', async () => {
        const [f] = await pickFiles('image/*', false);
        if (!f) return;
        settings.ballIcon = await shrinkImage(f, 128);
        save(); applyLook();
    });
    $('#se_icon_reset').addEventListener('click', () => { settings.ballIcon = ''; save(); applyLook(); });

    $('#se_export').addEventListener('click', async () => {
        if (!library.index.length) { toast('info', '歌库是空的，没什么可导出'); return; }
        toast('info', '正在打包，歌多的话要等一会儿');
        const blob = await db.exportBackup();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `共享耳机备份-${new Date().toISOString().slice(0, 10)}.sebk`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    });
    $('#se_import').addEventListener('click', async () => {
        const [f] = await pickFiles('.sebk,application/octet-stream', false);
        if (!f) return;
        try {
            await db.requestPersist();
            const r = await db.importBackup(f);
            library = await db.loadLibrary();
            render();
            toast('success', `恢复了 ${r.songs} 首歌，${r.playlists} 个新歌单`);
        } catch (e) { toast('error', e.message || '导入失败'); }
    });
    $('#se_clear').addEventListener('click', async () => {
        const ok = await ctx().Popup.show.confirm('清空全部歌曲', '所有导入的歌、歌词、歌单都会从这个浏览器里删掉，没法撤回。确定吗？');
        if (!ok) return;
        audio.pause(); audio.removeAttribute('src'); audio.load();
        coverUrls.forEach(u => URL.revokeObjectURL(u)); coverUrls.clear();
        await db.clearAll();
        library = { index: [], playlists: [] };
        settings.songId = null; settings.listId = ALL; lyricData = null; save();
        render();
        toast('success', '清空了');
    });
}

/** 设置面板里的开关（和预设里提示词的开关同一个样子）。返回重画函数。 */
function bindSwitch(sel, get, set) {
    const row = $(sel);
    if (!row) return () => {};
    const icon = $('.se-switch', row);
    const paint = () => {
        const on = !!get();
        icon.classList.toggle('fa-toggle-on', on);
        icon.classList.toggle('fa-toggle-off', !on);
        row.classList.toggle('se-on', on);
        row.setAttribute('aria-checked', String(on));
    };
    const flip = () => { set(!get()); paint(); };
    row.addEventListener('click', flip);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    paint();
    return paint;
}
let paintBallSwitch = () => {};

function setBallVisible(v) {
    settings.ballVisible = v;
    save();
    applyLook();
    paintBallSwitch();
}

function shrinkImage(file, size, as = 'dataurl') {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = c.height = size;
            const s = Math.min(img.width, img.height);
            c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
            URL.revokeObjectURL(img.src);
            if (as === 'blob') c.toBlob(b => resolve(b), 'image/jpeg', 0.88);
            else resolve(c.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

// ======================================================
// 斜杠命令：/musicball
// ======================================================
let paintApiSwitch = () => {};
function setApiOn(v, fromCommand = true) {
    settings.apiOn = !!v;
    save();
    paintApiSwitch();
    if (settings.apiOn && !subApiReady()) toast('warning', '共享耳机 API 打开了，但接口地址和模型名还没填全');
    else if (fromCommand) toast('info', `共享耳机 API ${settings.apiOn ? '打开了' : '关上了'}`);
}

function registerCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject) return;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'musicball',
        callback: (_named, value) => {
            const v = String(value ?? '').trim().toLowerCase();
            if (v === 'show') setBallVisible(true);
            else if (v === 'hide') setBallVisible(false);
            else setBallVisible(!settings.ballVisible);
            return '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'show 显示 / hide 隐藏 / 不填就切换',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: ['show', 'hide', 'toggle'],
            }),
        ],
        helpString: '显示或隐藏共享耳机的悬浮球。<code>/musicball</code> 切换，<code>/musicball hide</code> 隐藏，<code>/musicball show</code> 显示。',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'musicapi',
        callback: (_named, value) => {
            const v = String(value ?? '').trim().toLowerCase();
            if (v === 'on') setApiOn(true);
            else if (v === 'off') setApiOn(false);
            else setApiOn(!settings.apiOn);
            return '';
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'on 打开 / off 关上 / 不填就切换',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                enumList: ['on', 'off', 'toggle'],
            }),
        ],
        helpString: '打开或关上共享耳机 API（只给共享耳机打标签用）。<code>/musicapi</code> 切换，<code>/musicapi on</code> 打开，<code>/musicapi off</code> 关上。',
    }));
}

// ======================================================
// 启动
// ======================================================
let started = false;
async function init() {
    if (started) return;
    started = true;
    loadSettings();
    buildUI();
    library = await db.loadLibrary();
    applyLook();
    buildSettingsPanel();
    registerCommand();
    if (settings.songId && songById(settings.songId)) await loadSong(settings.songId, false);
    else render();
    // 关了悬浮球、只留卡片的用法：刷新后卡片照原样留着（原来关着就不打开）
    if (!settings.ballVisible && settings.cardOpen) toggleCard(true);

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => { if (el.card.dataset.view === 'back') refreshBack(); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => { if (el.card.dataset.view === 'back' && ctx().groupId) refreshBack(); });
    if (eventTypes.PERSONA_CHANGED) eventSource.on(eventTypes.PERSONA_CHANGED, () => { if (el.card.dataset.view === 'back') refreshBack(); });
    eventSource.on(eventTypes.SETTINGS_UPDATED, () => { if (settings.tint === 'auto') applyLook(); });
    // 每次生成前更新塞给模型的内容（歌、唱到哪了、能不能换歌）
    eventSource.on(eventTypes.GENERATION_STARTED, () => updateInjection());
    // 收到 char 的回复：数轮次、看有没有换歌标记
    eventSource.on(eventTypes.MESSAGE_RECEIVED, (id, type) => { if (type !== 'first_message') turnsSinceSwitch++; onCharMessage(id); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (id) => onCharMessage(id));
    // 换角色、换聊天时清掉，下次生成再算
    eventSource.on(eventTypes.CHAT_CHANGED, () => { turnsSinceSwitch = 99; updateInjection(); });
    audio.addEventListener('play', updateInjection);
    audio.addEventListener('pause', updateInjection);
    console.log(TAG, '已加载');
}

const { eventSource, eventTypes } = ctx();
eventSource.on(eventTypes.APP_READY, () => { setTimeout(() => init().catch(e => console.error(TAG, e)), 0); });

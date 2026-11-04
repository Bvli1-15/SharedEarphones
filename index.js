// 共享耳机 · 第一步：播放器本体
// 悬浮球、卡片正面、歌词、歌单、背面耳机线，歌存在浏览器里。

import { BACK_SVG, BACK_VIEWBOX } from './earphones.js';
import { readID3, guessFromFilename, normalizeName, parseLyrics } from './parsers.js';
import * as db from './db.js';

const MODULE = 'shared_earphones';
const TAG = '[共享耳机]';
const ALL = 'all';

const DEFAULTS = Object.freeze({
    ballVisible: true,
    ballPos: null,          // {x, y}：球中心在屏幕里的比例
    ballIcon: '',           // 自定义图标（压缩后的 dataURL）
    material: 'frost',      // frost 磨砂 / liquid 液态玻璃
    tint: 'auto',           // auto 跟随酒馆主题 / light / dark
    playMode: 'order',      // order 顺序 / one 单曲循环 / shuffle 随机
    listId: ALL,            // 正在播放哪个歌单
    songId: null,           // 上次放到哪首
    texts: {},              // 每个角色背面的三行字
});

const ctx = () => SillyTavern.getContext();
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

const el = {};              // 常用元素

// ======================================================
// 设置
// ======================================================
function loadSettings() {
    const store = ctx().extensionSettings;
    store[MODULE] = Object.assign(structuredClone(DEFAULTS), store[MODULE] || {});
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
};
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
      <button class="se-btn" data-act="editlyrics" aria-label="编辑歌词">${ICON.edit}</button>
      <button class="se-btn" data-act="front" aria-label="回到正面">${ICON.lyr}</button>
    </div>
    <div class="se-lines"></div>
    <div class="se-empty" hidden>
      <span>这首还没有歌词</span>
      <div><button class="se-primary" data-act="lrcfile">导入 .lrc</button><button data-act="editlyrics">粘贴歌词</button></div>
    </div>
    ${progHTML}
  </div>

  <div class="se-face se-lists">
    <div class="se-head"><button class="se-back-btn" data-act="front" aria-label="返回">‹</button><span>歌单</span></div>
    <div class="se-seg" role="group" aria-label="播放模式">
      <button data-mode="order">顺序</button><button data-mode="one">单曲循环</button><button data-mode="shuffle">随机</button>
    </div>
    <div class="se-rows se-pl-rows"></div>
    <div class="se-actions"><button class="se-primary" data-act="import">导入歌曲</button><button data-act="importlrc">导入歌词</button></div>
  </div>

  <div class="se-face se-list">
    <div class="se-head"><button class="se-back-btn" data-act="lists" aria-label="返回">‹</button><span class="se-list-name"></span></div>
    <div class="se-rows se-song-rows"></div>
    <div class="se-actions"><button class="se-primary" data-act="importhere">导入歌曲到这里</button></div>
  </div>

  <div class="se-face se-back">
    <button class="se-flip" aria-label="翻回正面">${BARS}</button>
    <div class="se-stage">
      <svg viewBox="${BACK_VIEWBOX}" aria-label="两个人共用一副耳机">${BACK_SVG}</svg>
      <div class="se-label" data-key="left" contenteditable="plaintext-only" spellcheck="false" style="left:34.8%;top:56%"></div>
      <div class="se-label" data-key="right" contenteditable="plaintext-only" spellcheck="false" style="left:65.1%;top:56%"></div>
      <div class="se-longtext" data-key="long" contenteditable="plaintext-only" spellcheck="false" data-placeholder="点这里写一句话"></div>
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
    el.notes = $('#se-notes', root);
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
    if (!settings.ballVisible) el.card.classList.add('se-hidden');
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

function placeCard() {
    const b = el.ball.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    const cw = el.card.offsetWidth, ch = el.card.offsetHeight;
    const left = Math.min(Math.max(b.left + b.width / 2 - cw / 2, 8), W - cw - 8);
    let top;
    if (b.top + b.height / 2 < H / 2) top = Math.min(b.bottom + 10, H - ch - 8);
    else top = Math.max(b.top - 10 - ch, 8);
    el.card.style.left = left + 'px';
    el.card.style.top = Math.max(top, 8) + 'px';
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
        if (!el.card.classList.contains('se-hidden')) placeCard();
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

    // 卡片里的按钮
    el.card.addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (btn) { onAction(btn.dataset.act); return; }
        if (e.target.closest('.se-flip')) { flip(); return; }
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

    // 背面三行字
    $$('[data-key]', el.card).forEach(node => {
        node.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); node.blur(); } });
        node.addEventListener('input', () => saveTexts());
        node.addEventListener('paste', e => {
            e.preventDefault();
            const text = (e.clipboardData?.getData('text/plain') || '').replace(/\s*\n\s*/g, ' ');
            document.execCommand('insertText', false, text);
        });
    });
}

function toggleCard(force) {
    const hide = force === undefined ? !el.card.classList.contains('se-hidden') : !force;
    el.card.classList.toggle('se-hidden', hide);
    if (!hide) {
        if (el.card.dataset.view === 'back') refreshBack();
        render();
        placeCard();
        requestAnimationFrame(placeCard);
    }
    syncNotesLoop();
}

function setView(view) {
    el.card.dataset.view = view;
    if (view === 'lists') renderLists();
    if (view === 'list') renderSongList();
    if (view === 'lyrics') renderLyrics(true);
    if (view === 'back') refreshBack();
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
        case 'import': return importSongs(null);
        case 'importhere': return importSongs(openListId === ALL ? null : openListId);
        case 'importlrc': return importLyricFiles();
        case 'lrcfile': return importLyricFiles(true);
        case 'editlyrics': return editLyrics();
    }
}

// ======================================================
// 播放
// ======================================================
async function loadSong(id, autoplay) {
    const s = songById(id);
    if (!s) return;
    const blob = await db.getAudio(id);
    if (!blob) { toast('error', `《${s.title}》的音频找不到了，可能被浏览器清理了`); return; }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    audio.src = audioUrl;
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

audio.addEventListener('play', () => { el.root?.classList.add('se-playing'); renderPlayBtn(); syncNotesLoop(); });
audio.addEventListener('pause', () => { el.root?.classList.remove('se-playing'); renderPlayBtn(); });
audio.addEventListener('ended', () => step(1, true));
audio.addEventListener('timeupdate', () => { renderProgress(); renderLyricsTick(); });
audio.addEventListener('loadedmetadata', () => {
    renderProgress();
    const s = currentSong();
    if (s && !s.duration && isFinite(audio.duration)) { s.duration = audio.duration; db.saveIndex(library.index); }
});
audio.addEventListener('error', () => { if (audio.src) toast('error', '这首歌播放不了，可能是格式不支持'); });

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
        const lock = p.id === ALL ? ' se-locked' : '';
        return `<div class="se-row" data-id="${esc(p.id)}">
  <div class="se-row-main" data-open="${esc(p.id)}"><div>${esc(p.name)}<small>${listSongIds(p.id).length} 首</small></div></div>
  ${s ? `<button class="se-check${inIt ? ' se-on' : ''}${lock}" data-check="${esc(p.id)}" aria-label="${inIt ? '从这个歌单移出当前歌' : '把当前歌加进这个歌单'}">${inIt ? '✓' : ''}</button>` : ''}
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
    el.songRows.innerHTML = ids.map(id => {
        const s = songById(id);
        const now = id === settings.songId ? ' se-playing-row' : '';
        return `<div class="se-row${now}" data-song="${esc(id)}">
  <div class="se-row-main"><div>${esc(s.title)}</div><div class="se-row-sub">${esc(s.artist || '未知歌手')}</div></div>
  <button class="se-more" data-more="${esc(id)}" aria-label="${openListId === ALL ? '删除这首歌' : '从歌单移出'}">···</button>
</div>`;
    }).join('');
    $$('[data-song] .se-row-main', el.songRows).forEach(n => n.addEventListener('click', () => {
        playFromList(openListId, n.parentElement.dataset.song);
        renderSongList();
    }));
    $$('[data-more]', el.songRows).forEach(n => n.addEventListener('click', e => { e.stopPropagation(); removeSong(n.dataset.more); }));
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
async function importSongs(intoListId) {
    const files = await pickFiles('audio/*,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus');
    if (!files.length) return;
    await db.requestPersist();
    let ok = 0;
    const tip = files.length > 1 && window.toastr ? toastr.info(`正在导入 0/${files.length}`, '', { timeOut: 0, extendedTimeOut: 0 }) : null;
    for (const [i, file] of files.entries()) {
        try {
            const guess = guessFromFilename(file.name);
            const tag = await readID3(file);
            const id = uid();
            const blob = new Blob([file], { type: file.type || 'audio/mpeg' });
            await db.putAudio(id, blob);
            if (tag.cover) await db.putCover(id, tag.cover);
            if (tag.lyrics) await db.putLyrics(id, tag.lyrics);
            library.index.push({
                id,
                title: tag.title || guess.title,
                artist: tag.artist || guess.artist,
                file: guess.base,
                hasCover: !!tag.cover,
                hasLyrics: !!tag.lyrics,
                duration: 0,
                added: Date.now(),
            });
            if (intoListId) library.playlists.find(p => p.id === intoListId)?.songIds.push(id);
            ok++;
        } catch (e) {
            console.error(TAG, e);
            const full = e?.name === 'QuotaExceededError';
            toast('error', full ? '浏览器存储空间满了，后面的歌没存进去' : `《${file.name}》导入失败`);
            if (full) break;
        }
        if (tip) tip.find('.toast-message').text(`正在导入 ${i + 1}/${files.length}`);
    }
    if (tip) toastr.clear(tip);
    await db.saveIndex(library.index);
    await db.savePlaylists(library.playlists);
    toast('success', `导入了 ${ok} 首`);
    if (!settings.songId && library.index.length) await loadSong(library.index[0].id, false);
    render();
    if (el.card.dataset.view === 'list') renderSongList();
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
    if (text && text.trim()) { await db.putLyrics(id, text); s.hasLyrics = true; }
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
        n.textContent = saved[n.dataset.key] ?? defaults[n.dataset.key];
    });
}

let textTimer = null;
function saveTexts() {
    clearTimeout(textTimer);
    textTimer = setTimeout(() => {
        const out = {};
        $$('[data-key]', el.card).forEach(n => { out[n.dataset.key] = n.textContent.trim(); });
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

function drawNote(n) {
    const p = n.s / n.f.len;
    const pt = n.f.path.getPointAtLength(n.s);
    const a = Math.min(1, p / 0.06, (1 - p) / 0.1);
    const k = NOTE_SCALE * (0.55 + 0.45 * a);
    const bob = Math.sin(noteClock * 3 + n.ph) * 3;
    n.g.setAttribute('opacity', a.toFixed(3));
    n.g.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${(pt.y + bob).toFixed(1)}) rotate(${n.tilt.toFixed(1)}) scale(${k.toFixed(3)}) translate(${-n.t.ax} -40)`);
}

function noteFrame(ts) {
    const dt = noteLast === null ? 0 : Math.min(0.05, (ts - noteLast) / 1000);
    noteLast = ts;
    const moving = !audio.paused && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (moving) {
        noteClock += dt;
        beatAcc += dt;
        if (beatAcc >= BEAT * 2) { beatAcc -= BEAT * 2; flows.forEach(f => spawnNote(f)); }
        notes.forEach(n => { n.s += SPEED * dt; });
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
            flows = ['#se-cable-left', '#se-cable-right'].map(sel => { const p = $(sel, el.card); return { path: p, len: p.getTotalLength() }; });
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
      <label class="checkbox_label"><input type="checkbox" id="se_ball_visible"><span>显示悬浮球</span></label>
      <small>也可以用快速回复按钮：<code>/musicball</code>（藏/显切换），<code>/musicball hide</code>，<code>/musicball show</code></small>
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

    const vis = $('#se_ball_visible');
    vis.checked = settings.ballVisible;
    vis.addEventListener('change', () => setBallVisible(vis.checked));
    const mat = $('#se_material');
    mat.value = settings.material;
    mat.addEventListener('change', () => { settings.material = mat.value; save(); applyLook(); });
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

function setBallVisible(v) {
    settings.ballVisible = v;
    save();
    applyLook();
    const box = document.getElementById('se_ball_visible');
    if (box) box.checked = v;
}

function shrinkImage(file, size) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = c.height = size;
            const s = Math.min(img.width, img.height);
            c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
            URL.revokeObjectURL(img.src);
            resolve(c.toDataURL('image/png'));
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
    });
}

// ======================================================
// 斜杠命令：/musicball
// ======================================================
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

    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.CHAT_CHANGED, () => { if (el.card.dataset.view === 'back') refreshBack(); });
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => { if (el.card.dataset.view === 'back' && ctx().groupId) refreshBack(); });
    if (eventTypes.PERSONA_CHANGED) eventSource.on(eventTypes.PERSONA_CHANGED, () => { if (el.card.dataset.view === 'back') refreshBack(); });
    eventSource.on(eventTypes.SETTINGS_UPDATED, () => { if (settings.tint === 'auto') applyLook(); });
    console.log(TAG, '已加载');
}

const { eventSource, eventTypes } = ctx();
eventSource.on(eventTypes.APP_READY, () => { setTimeout(() => init().catch(e => console.error(TAG, e)), 0); });

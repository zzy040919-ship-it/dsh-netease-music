window.__ModuleLoader__.load({
  id: 'dsh-netease-music',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useSyncExternalStore } = React;

    const API = '/dsh-netease-music';
    const VOLUME_KEY = 'dsh-netease-music.volume';
    const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

    // 只有播放器：没有背景层、没有特效、没有动画。
    let version = 0;
    const listeners = new Set();
    const store = {
      song: null,
      queue: [],
      index: -1,
      playing: false,
      position: 0,
      duration: 0,
      volume: 0.85,
      open: false,
      vinyl: false,
      query: '',
      busy: false,
      results: [],
      searched: false,
      notice: '',
      lyrics: [],
      account: { loaded: false, ok: false, nickname: '', avatar: '' },
      accountPanel: false,
      cookieDraft: '',
      accountBusy: false,
      accountError: '',
    };
    try {
      const savedVolume = Number(localStorage.getItem(VOLUME_KEY));
      if (!Number.isNaN(savedVolume) && savedVolume >= 0 && savedVolume <= 1) store.volume = savedVolume;
    } catch (error) { /* private mode */ }

    const subscribe = (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const getVersion = () => version;
    const emit = () => { version += 1; for (const listener of listeners) listener(); };
    const useMusic = () => { useSyncExternalStore(subscribe, getVersion, getVersion); return store; };

    function hashHue(text) {
      let hash = 0;
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) | 0;
      return Math.abs(hash) % 360;
    }

    function formatTime(seconds) {
      const value = Math.max(0, Math.floor(seconds || 0));
      return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
    }

    const hasSong = (song) => Boolean(song && (song.name || song.artist));
    const coverOf = (song) => (song && song.cover ? API + '/api/cover?u=' + encodeURIComponent(song.cover) : null);
    const audioOf = (url) => API + '/api/audio?u=' + encodeURIComponent(url);

    function parseLyric(lrc, translation) {
      const parse = (text) => {
        const rows = [];
        for (const raw of String(text || '').split(/\r?\n/)) {
          const match = /^\[(\d+):(\d+)(?:[.:](\d+))?\](.*)$/.exec(raw.trim());
          if (!match) continue;
          const time = Number(match[1]) * 60 + Number(match[2]) + Number('0.' + (match[3] || '0'));
          const line = match[4].trim();
          if (line) rows.push({ t: time, text: line });
        }
        return rows;
      };
      const lines = parse(lrc);
      const second = parse(translation);
      for (const line of lines) {
        const hit = second.find((row) => Math.abs(row.t - line.t) < 0.35);
        if (hit) line.tr = hit.text;
      }
      return lines;
    }

    let audio = null;
    let unlocked = false;

    function ensureAudio() {
      if (audio) return audio;
      audio = new Audio();
      audio.preload = 'auto';
      audio.volume = store.volume;
      audio.addEventListener('play', () => { store.playing = true; emit(); });
      audio.addEventListener('pause', () => { store.playing = false; emit(); });
      audio.addEventListener('ended', () => step(1));
      audio.addEventListener('timeupdate', () => {
        store.position = audio.currentTime || 0;
        if (audio.duration) store.duration = audio.duration;
        emit();
      });
      audio.addEventListener('error', () => {
        store.playing = false;
        if (store.song && audio.src) store.notice = '这首歌加载失败，换一首试试';
        emit();
      });
      return audio;
    }

    function unlockPlayback() {
      if (unlocked) return;
      unlocked = true;
      const player = ensureAudio();
      player.muted = true;
      player.src = SILENCE;
      const started = player.play();
      const restore = () => {
        try {
          player.pause();
          player.removeAttribute('src');
          player.muted = false;
        } catch (error) { /* noop */ }
      };
      if (started && typeof started.then === 'function') started.then(() => setTimeout(restore, 60)).catch(() => { player.muted = false; });
      else setTimeout(restore, 60);
    }

    function publishMetadata(song) {
      if (!('mediaSession' in navigator) || !song) return;
      try {
        const artwork = coverOf(song);
        navigator.mediaSession.metadata = new MediaMetadata({
          title: song.name || '',
          artist: song.artist || '',
          album: song.album || '',
          artwork: artwork ? [{ src: artwork, sizes: '300x300' }] : [],
        });
      } catch (error) { /* older renderer */ }
    }

    async function loadLyrics(id) {
      store.lyrics = [];
      try {
        const response = await fetch(API + '/api/lyric?id=' + encodeURIComponent(id));
        const body = await response.json();
        if (body && body.ok) store.lyrics = parseLyric(body.lrc, body.translation);
      } catch (error) { /* lyrics optional */ }
      emit();
    }

    async function playSong(song) {
      store.notice = '';
      store.song = song;
      store.position = 0;
      store.duration = song.duration || 0;
      store.playing = false;
      emit();
      const player = ensureAudio();
      player.pause();
      loadLyrics(song.id);
      try {
        const response = await fetch(API + '/api/song?id=' + encodeURIComponent(song.id));
        const detail = await response.json();
        store.song = Object.assign({}, song, detail && detail.name ? detail : {});
        publishMetadata(store.song);
        if (!detail || !detail.ok || !detail.url) {
          store.notice = detail && detail.reason === 'paid'
            ? 'VIP / 付费歌：连接账号后才能播'
            : '这首歌暂时拿不到播放地址';
          store.playing = false;
          emit();
          return;
        }
        store.duration = detail.duration || store.duration;
        player.src = audioOf(detail.url);
        const started = player.play();
        if (started && typeof started.catch === 'function') {
          started.catch(() => {
            store.playing = false;
            store.notice = '点一下播放键才能出声';
            emit();
          });
        }
        emit();
      } catch (error) {
        store.notice = '请求网易云失败，检查网络';
        store.playing = false;
        emit();
      }
    }

    function togglePlay() {
      unlockPlayback();
      const player = ensureAudio();
      if (!store.song) { store.open = true; emit(); return; }
      if (!player.src) { playSong(store.song); return; }
      if (player.paused) player.play().catch(() => {});
      else player.pause();
    }

    function step(delta) {
      if (!store.queue.length) return;
      const next = store.index + delta;
      if (next < 0 || next >= store.queue.length) {
        if (delta > 0) { store.playing = false; emit(); }
        return;
      }
      store.index = next;
      playSong(store.queue[next]);
    }

    function seek(ratio) {
      if (!audio || !audio.duration) return;
      audio.currentTime = Math.max(0, Math.min(1, ratio)) * audio.duration;
      store.position = audio.currentTime;
      emit();
    }

    function setVolume(value) {
      const volume = Math.max(0, Math.min(1, value));
      store.volume = volume;
      ensureAudio().volume = volume;
      try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch (error) { /* private mode */ }
      emit();
    }

    async function runSearch() {
      const query = store.query.trim();
      if (!query) return;
      store.busy = true;
      store.searched = false;
      emit();
      try {
        const response = await fetch(API + '/api/search?q=' + encodeURIComponent(query));
        const body = await response.json();
        store.results = Array.isArray(body.songs) ? body.songs : [];
      } catch (error) {
        store.results = [];
      }
      store.busy = false;
      store.searched = true;
      emit();
    }

    function chooseResult(song, index) {
      unlockPlayback();
      store.queue = store.results.slice();
      store.index = index;
      store.query = '';
      playSong(song);
    }

    async function autoLogin() {
      store.notice = '正在读取网易云客户端账号…';
      emit();
      try {
        const response = await fetch(API + '/api/account/auto');
        const body = await response.json();
        if (body && body.ok) {
          store.account = { loaded: true, ok: true, nickname: body.nickname || '', avatar: body.avatar || '' };
          store.accountPanel = false;
          store.notice = '已自动登录：' + (body.nickname || '网易云账号');
        } else {
          store.notice = (body && body.error) || '没读到已登录的网易云账号';
        }
      } catch (error) {
        store.notice = '自动登录失败，检查网络';
      }
      emit();
    }

    async function loadAccount() {
      try {
        const response = await fetch(API + '/api/account');
        const body = await response.json();
        store.account = { loaded: true, ok: Boolean(body.ok), nickname: body.nickname || '', avatar: body.avatar || '' };
      } catch (error) {
        store.account = { loaded: true, ok: false, nickname: '', avatar: '' };
      }
      emit();
    }

    async function saveCookie() {
      const cookie = store.cookieDraft.trim();
      if (!cookie) { store.accountError = '先粘贴 cookie'; emit(); return; }
      store.accountBusy = true;
      store.accountError = '';
      emit();
      try {
        const response = await fetch(API + '/api/account', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cookie: cookie }),
        });
        const body = await response.json();
        if (!body.ok) {
          store.accountError = body.error || 'cookie 无效';
        } else {
          store.account = { loaded: true, ok: true, nickname: body.nickname || '', avatar: body.avatar || '' };
          store.accountPanel = false;
          store.cookieDraft = '';
          store.notice = '已连接网易云账号：' + (body.nickname || '');
        }
      } catch (error) {
        store.accountError = '连接失败，检查网络';
      }
      store.accountBusy = false;
      emit();
    }

    async function logout() {
      store.accountBusy = true;
      emit();
      try {
        await fetch(API + '/api/account', { method: 'DELETE' });
        store.account = { loaded: true, ok: false, nickname: '', avatar: '' };
        store.accountPanel = false;
        store.notice = '已断开账号';
      } catch (error) { /* noop */ }
      store.accountBusy = false;
      emit();
    }

    async function syncClient() {
      store.notice = '正在读取网易云客户端…';
      emit();
      try {
        const response = await fetch(API + '/api/client-now');
        const body = await response.json();
        if (!body.ok) {
          store.notice = '没读到网易云客户端窗口（先打开它并放首歌）';
          emit();
          return;
        }
        const queries = [[body.title, body.artist].filter(Boolean).join(' '), body.title, body.artist].filter(Boolean);
        let songs = [];
        for (const query of queries) {
          const found = await (await fetch(API + '/api/search?q=' + encodeURIComponent(query))).json();
          songs = Array.isArray(found.songs) ? found.songs : [];
          if (songs.length) break;
        }
        if (!songs.length) {
          store.notice = '没搜到客户端里那首「' + body.raw + '」';
          emit();
          return;
        }
        const playable = songs.filter((item) => !item.paid);
        const first = playable[0] || songs[0];
        const start = songs.indexOf(first);
        store.queue = songs.slice();
        store.index = start;
        await playSong(first);
        if (!store.notice) {
          store.notice = '已同步客户端：' + first.name;
          emit();
        }
      } catch (error) {
        store.notice = '同步失败';
        emit();
      }
    }

    function icon(kind) {
      const paths = {
        prev: ['M4 3.2h1.7v9.6H4z', 'M12.7 3.4v9.2L6.4 8z'],
        next: ['M10.3 3.2H12v9.6h-1.7z', 'M3.3 3.4v9.2L9.6 8z'],
        play: ['M5.4 3.3 12.8 8 5.4 12.7z'],
        pause: ['M4.7 3.2h2.2v9.6H4.7z', 'M9.1 3.2h2.2v9.6H9.1z'],
        search: ['M7.1 2.2a4.9 4.9 0 1 0 3.06 8.73l3.03 3.03 1.13-1.13-3.03-3.03A4.9 4.9 0 0 0 7.1 2.2zm0 1.6a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6z'],
        note: ['M12.4 2.2v8.35a2.4 2.4 0 1 1-1.3-2.13V4.1L5.6 5.5v6.55a2.4 2.4 0 1 1-1.3-2.12V4.2z'],
        close: ['M4.2 3.1 8 6.9l3.8-3.8 1.1 1.1L9.1 8l3.8 3.8-1.1 1.1L8 9.1l-3.8 3.8-1.1-1.1L6.9 8 3.1 4.2z'],
        volume: ['M8.6 2.4v11.2l-3.3-2.5H3.1V4.9h2.2z', 'M10.7 5.2a3.7 3.7 0 0 1 0 5.6l-.9-.9a2.5 2.5 0 0 0 0-3.8z'],
        sync: ['M8 2.4a5.6 5.6 0 0 1 5.3 3.8l1.1-.9v3.6h-3.6l1.4-1.2A4.2 4.2 0 0 0 8 4.2z', 'M8 13.6a5.6 5.6 0 0 1-5.3-3.8l-1.1.9V7.1h3.6L3.8 8.3A4.2 4.2 0 0 0 8 11.8z'],
        user: ['M8 2.6a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2z', 'M2.8 13.4c0-2.2 2.3-3.4 5.2-3.4s5.2 1.2 5.2 3.4z'],
      };
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': 'true', focusable: 'false' },
        paths[kind].map((d, index) => h('path', { key: index, d: d, fill: 'currentColor' })));
    }

    function AccountPanel() {
      const state = useMusic();
      if (!state.accountPanel) return null;
      if (state.account.ok) {
        return h('div', { className: 'nm-panel' },
          h('div', { className: 'nm-row' },
            h('span', { className: 'nm-account-name' }, '已连接：' + (state.account.nickname || '网易云用户')),
            h('button', { className: 'nm-mini', type: 'button', onClick: logout, disabled: state.accountBusy }, '断开')),
          h('div', { className: 'nm-hint' }, 'VIP / 高音质曲目现在可以在 DSH 里播放。'));
      }
      return h('div', { className: 'nm-panel' },
        h('div', { className: 'nm-hint' },
          '登录：浏览器打开 music.163.com 登录 → F12 → Application → Cookies → 复制 MUSIC_U=… 那一段贴到下面'),
        h('textarea', {
          className: 'nm-textarea',
          rows: 3,
          spellCheck: false,
          value: state.cookieDraft,
          placeholder: 'MUSIC_U=xxxx; __csrf=yyyy',
          onChange: (event) => { store.cookieDraft = event.target.value; emit(); },
        }),
        state.accountError ? h('div', { className: 'nm-hint nm-warn' }, state.accountError) : null,
        h('div', { className: 'nm-row' },
          h('button', { className: 'nm-mini nm-primary', type: 'button', onClick: saveCookie, disabled: state.accountBusy }, state.accountBusy ? '连接中…' : '连接账号'),
          h('button', { className: 'nm-mini', type: 'button', onClick: () => { store.accountPanel = false; emit(); } }, '取消')));
    }

    function VinylPanel() {
      const state = useMusic();
      const song = state.song;
      const playing = state.playing;
      const cover = coverOf(song);
      const duration = state.duration || 0;
      const ratio = duration > 0 ? Math.min(1, (state.position || 0) / duration) : 0;
      const back = () => { store.vinyl = false; emit(); };
      return h('div', { className: 'nm-vinyl-panel', onClick: back, title: '点击返回播放器' },
        h('div', { className: 'nm-vinyl-stage' },
          h('div', { className: 'nm-vinyl-big', 'data-play': playing ? 'true' : 'false' },
            cover ? h('img', { className: 'nm-vinyl-big-label', src: cover, alt: '', draggable: false }) : null,
            h('span', { className: 'nm-vinyl-big-hole' }),
            h('span', { className: 'nm-vinyl-big-gloss' })),
          h('span', { className: 'nm-tonearm' }, h('span', { className: 'nm-tonearm-head' })),
        ),
        h('div', { className: 'nm-vinyl-title' }, (song && song.name) || '网易云音乐'),
        h('div', { className: 'nm-vinyl-sub' },
          state.notice || (song ? [song.artist, song.album].filter(Boolean).join(' · ') : '')),
        h('div', { className: 'nm-vinyl-progress' }, h('div', { className: 'nm-vinyl-progress-fill', style: { width: (ratio * 100).toFixed(1) + '%' } })),
        h('div', { className: 'nm-vinyl-times' }, h('span', null, formatTime(state.position)), h('span', null, formatTime(duration))),
        h('div', { className: 'nm-vinyl-controls' },
          h('button', { className: 'nm-btn', type: 'button', title: '上一首', 'aria-label': '上一首', onClick: (event) => { event.stopPropagation(); step(-1); } }, icon('prev')),
          h('button', { className: 'nm-btn nm-main', type: 'button', title: playing ? '暂停' : '播放', 'aria-label': playing ? '暂停' : '播放', onClick: (event) => { event.stopPropagation(); togglePlay(); } }, icon(playing ? 'pause' : 'play')),
          h('button', { className: 'nm-btn', type: 'button', title: '下一首', 'aria-label': '下一首', onClick: (event) => { event.stopPropagation(); step(1); } }, icon('next')),
          h('button', { className: 'nm-btn nm-btn-tight', type: 'button', title: '返回', 'aria-label': '返回', onClick: (event) => { event.stopPropagation(); back(); } }, icon('close'))),
      );
    }
    function Player() {
      const state = useMusic();
      const song = state.song;
      const live = hasSong(song);
      const playing = state.playing;
      const player = ensureAudio();
      const duration = state.duration || player.duration || 0;
      const ratio = duration > 0 ? Math.min(1, (state.position || 0) / duration) : 0;
      const hue = hashHue(((song && song.name) || '') + ((song && song.artist) || ''));
      const cover = coverOf(song);
      const inputRef = useRef(null);

      useEffect(() => {
        if (state.open && inputRef.current) inputRef.current.focus();
      }, [state.open]);

      useEffect(() => {
        if (state.open && !state.account.loaded) loadAccount();
      }, [state.open, state.account.loaded]);

      const lines = state.lyrics || [];
      let lineIndex = -1;
      for (let cursor = 0; cursor < lines.length; cursor += 1) {
        if (lines[cursor].t <= state.position + 0.12) lineIndex = cursor;
        else break;
      }

      if (!state.open) {
        if (!live) {
          return h('button', {
            className: 'nm-fab',
            type: 'button',
            title: '网易云音乐',
            'aria-label': '网易云音乐',
            onClick: () => { store.open = true; emit(); },
          }, h('span', { className: 'nm-fab-icon' }, icon('note')));
        }
        return h('div', { className: 'nm-mini', onClick: () => { store.open = true; emit(); }, title: '展开播放器' },
          h('div', { className: 'nm-mini-cover', 'data-play': playing ? 'true' : 'false' },
            cover ? h('img', { src: cover, alt: '', draggable: false }) : null,
            h('span', { className: 'nm-vinyl-hole' })),
          h('div', { className: 'nm-mini-text' },
            h('div', { className: 'nm-mini-title' }, song.name || ''),
            h('div', { className: 'nm-mini-sub' }, song.artist || '')),
          h('button', {
            className: 'nm-mini-play',
            type: 'button',
            title: playing ? '暂停' : '播放',
            'aria-label': playing ? '暂停' : '播放',
            onClick: (event) => { event.stopPropagation(); togglePlay(); },
          }, icon(playing ? 'pause' : 'play')),
          h('div', { className: 'nm-mini-track' }, h('div', { className: 'nm-mini-fill', style: { width: (ratio * 100).toFixed(1) + '%' } })));
      }

      return h('div', {
        className: 'nm-card',
        role: 'dialog',
        'aria-label': '网易云音乐',
        onPointerMove: (event) => {
          const element = event.currentTarget;
          if (!element || !element.getBoundingClientRect) return;
          const rect = element.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          element.style.setProperty('--mx', (((event.clientX - rect.left) / rect.width) * 100).toFixed(1) + '%');
          element.style.setProperty('--my', (((event.clientY - rect.top) / rect.height) * 100).toFixed(1) + '%');
        },
      },
        h('div', { className: 'nm-head', onClick: () => { store.vinyl = true; emit(); }, title: '打开黑胶视图' },
          h('button', { className: 'nm-vinyl', 'data-play': playing ? 'true' : 'false', type: 'button', onClick: togglePlay, title: playing ? '暂停' : '播放' },
            h('span', { className: 'nm-vinyl-sheen' }),
            live && cover ? h('img', { className: 'nm-vinyl-label', src: cover, alt: '', draggable: false }) : null,
            h('span', { className: 'nm-vinyl-hole' })),
          h('div', { className: 'nm-text' },
            h('div', { className: 'nm-title', title: (song && song.name) || '' }, live ? song.name : '网易云音乐'),
            h('div', { className: state.notice ? 'nm-sub nm-warn' : 'nm-sub' },
              state.notice || (live ? [song.artist, song.album].filter(Boolean).join(' · ') : '搜歌、播歌'))),
          h('button', { className: 'nm-btn', type: 'button', title: '收起', 'aria-label': '收起', onClick: () => { store.open = false; emit(); } }, icon('close'))),

        h('div', {
          className: 'nm-track',
          onClick: (event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (rect.width > 0) seek((event.clientX - rect.left) / rect.width);
          },
        }, h('div', { className: 'nm-fill', style: { width: (ratio * 100).toFixed(2) + '%' } })),
        h('div', { className: 'nm-times' }, h('span', null, formatTime(state.position)), h('span', null, formatTime(duration))),

        h('div', { className: 'nm-bar' },
          h('button', { className: 'nm-btn', type: 'button', title: '上一首', 'aria-label': '上一首', onClick: () => step(-1) }, icon('prev')),
          h('button', { className: 'nm-btn nm-main', type: 'button', title: playing ? '暂停' : '播放', 'aria-label': playing ? '暂停' : '播放', onClick: togglePlay }, icon(playing ? 'pause' : 'play')),
          h('button', { className: 'nm-btn', type: 'button', title: '下一首', 'aria-label': '下一首', onClick: () => step(1) }, icon('next')),
          h('button', { className: 'nm-btn nm-btn-tight', type: 'button', title: state.volume > 0 ? '静音' : '恢复音量', 'aria-label': '音量', onClick: () => setVolume(state.volume > 0 ? 0 : 0.85) }, icon('volume')),
          h('input', { className: 'nm-range', type: 'range', min: 0, max: 100, value: Math.round(state.volume * 100), 'aria-label': '音量', onChange: (event) => setVolume(Number(event.target.value) / 100) })),


        h('div', { className: 'nm-tools' },
          h('button', {
            className: state.account.ok ? 'nm-chip nm-chip-on' : 'nm-chip',
            type: 'button',
            title: state.account.ok ? '网易云账号' : '连接网易云账号',
            onClick: autoLogin,
          },
            state.account.ok && state.account.avatar
              ? h('img', { className: 'nm-avatar', src: API + '/api/cover?u=' + encodeURIComponent(state.account.avatar), alt: '' })
              : h('span', { className: 'nm-chip-icon' }, icon('user')),
            h('span', { className: 'nm-chip-text' }, state.account.ok ? (state.account.nickname || '已连接') : '账号')),
          h('button', { className: 'nm-chip', type: 'button', title: '把网易云客户端正在放的歌拉到 DSH', onClick: syncClient },
            h('span', { className: 'nm-chip-icon' }, icon('sync')),
            h('span', { className: 'nm-chip-text' }, '同步客户端'))),

        lines.length
          ? h('div', { className: 'nm-lyric-box' },
              h('div', { className: 'nm-lyric-now' }, lines[lineIndex] ? lines[lineIndex].text : '♪'),
              lines[lineIndex + 1] ? h('div', { className: 'nm-lyric-next' }, lines[lineIndex + 1].text) : null)
          : null,

        h('div', { className: 'nm-search-row' },
          h('span', { className: 'nm-search-icon' }, icon('search')),
          h('input', {
            ref: inputRef,
            className: 'nm-input',
            type: 'text',
            value: state.query,
            placeholder: '搜网易云的歌，回车搜索',
            spellCheck: false,
            onChange: (event) => { store.query = event.target.value; emit(); },
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); runSearch(); }
              if (event.key === 'Escape') { event.preventDefault(); store.open = false; emit(); }
            },
          })),

        state.busy ? h('div', { className: 'nm-hint' }, '搜索中…') : null,
        state.searched && !state.busy && !state.results.length ? h('div', { className: 'nm-hint' }, '没搜到，换个关键词') : null,
        state.results.length ? h('div', { className: 'nm-results' },
          state.results.map((item, index) => h('button', {
            key: item.id + '-' + index,
            className: 'nm-result',
            type: 'button',
            onClick: () => chooseResult(item, index),
          },
            h('span', { className: 'nm-result-meta' },
              h('span', { className: 'nm-result-name' }, item.name),
              h('span', { className: 'nm-result-sub' }, [item.artist, item.album].filter(Boolean).join(' · '))),
            item.paid ? h('span', { className: 'nm-badge' }, 'VIP') : null))) : null);
    }

    function report(message) {
      try { fetch(API + '/api/ping?s=' + encodeURIComponent(message)).catch(() => {}); } catch (error) { /* diagnostics only */ }
    }

    function Root() {
      useEffect(() => {
        try {
          const rect = document.querySelector('.nm-root').getBoundingClientRect();
          report('rendered geom inner=' + window.innerWidth + 'x' + window.innerHeight
            + ' client=' + document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight
            + ' dpr=' + window.devicePixelRatio
            + ' rect=' + Math.round(rect.left) + ',' + Math.round(rect.top) + ',' + Math.round(rect.width) + 'x' + Math.round(rect.height));
        } catch (error) {
          report('rendered (no geom)');
        }
      }, []);
      return h('div', { className: 'nm-root', style: { pointerEvents: 'none' } }, h(Player, null));
    }

    const CSS = [
      '.nm-root{position:absolute;top:74px;right:26px;z-index:60;display:flex;flex-direction:column;align-items:flex-end;gap:10px}',
      '.nm-root>*{pointer-events:auto}',
      '.nm-vinyl-panel{width:300px;box-sizing:border-box;padding:18px 16px 14px;display:flex;flex-direction:column;align-items:center;gap:8px;border-radius:calc(var(--dsw-radius-lg) + 8px);cursor:pointer;background:radial-gradient(120% 90% at 50% 0%,#2a2a30 0%,#1c1c21 48%,#141418 100%);box-shadow:0 26px 60px -26px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.08);color:rgba(255,255,255,.92)}',
      '.nm-vinyl-stage{position:relative;width:250px;height:212px;display:grid;place-items:center}',
      '.nm-vinyl-big{position:relative;width:196px;height:196px;border-radius:50%;background:repeating-radial-gradient(circle at 50% 50%,#17171b 0 1px,#0b0b0e 1px 2.5px);box-shadow:0 0 0 3px #d9c99b,0 0 0 4px rgba(0,0,0,.4),0 14px 30px -10px rgba(0,0,0,.7);animation:nm-spin 12s linear infinite;animation-play-state:paused}',
      ".nm-vinyl-big[data-play='true']{animation-play-state:running}",
      '.nm-vinyl-big-label{position:absolute;left:50%;top:50%;width:108px;height:108px;transform:translate(-50%,-50%);border-radius:50%;object-fit:cover;display:block;box-shadow:0 0 0 2px rgba(0,0,0,.5)}',
      '.nm-vinyl-big-hole{position:absolute;left:50%;top:50%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;background:#0a0a0c;box-shadow:0 0 0 1px rgba(255,255,255,.2)}',
      '.nm-vinyl-big-gloss{position:absolute;inset:0;border-radius:50%;pointer-events:none;background:conic-gradient(from 200deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.14) 40deg,rgba(255,255,255,0) 96deg,rgba(255,255,255,0) 250deg,rgba(255,255,255,.08) 290deg,rgba(255,255,255,0) 330deg)}',
      '.nm-tonearm{position:absolute;right:6px;top:0;width:7px;height:150px;border-radius:4px;transform:rotate(28deg);transform-origin:50% 8%;background:linear-gradient(180deg,#f0e2bd,#c8b483 60%,#9a8a5f);box-shadow:0 4px 10px rgba(0,0,0,.5)}',
      '.nm-tonearm-head{position:absolute;left:50%;bottom:-16px;width:22px;height:12px;border-radius:3px;transform:translateX(-50%) rotate(-12deg);background:linear-gradient(180deg,#e8d8ad,#a8966a)}',
      '.nm-vinyl-title{font-size:14px;line-height:20px;font-weight:600;color:#fff;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-vinyl-sub{font-size:11px;line-height:15px;color:rgba(255,255,255,.55);max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-vinyl-progress{width:100%;height:3px;border-radius:999px;background:rgba(255,255,255,.16);overflow:hidden}',
      '.nm-vinyl-progress-fill{height:100%;background:#d9c99b;transition:width .2s linear}',
      '.nm-vinyl-times{width:100%;display:flex;justify-content:space-between;font-size:10px;color:rgba(255,255,255,.45);font-variant-numeric:tabular-nums}',
      '.nm-vinyl-controls{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:2px}',
      '.nm-vinyl-panel .nm-btn{color:rgba(255,255,255,.72)}',
      '.nm-vinyl-panel .nm-btn:hover{background:rgba(255,255,255,.12);color:#fff}',
      '.nm-vinyl-panel .nm-main{background:#fff;color:#141418}',
      '.nm-vinyl-panel .nm-main:hover{background:#fff;color:#141418;opacity:.88}',
      '.nm-mini{position:relative;display:flex;align-items:center;gap:9px;width:250px;box-sizing:border-box;padding:7px 9px 9px;border-radius:13px;cursor:pointer;overflow:hidden;background:color-mix(in srgb,var(--dsw-specific-menu) 78%,transparent);backdrop-filter:blur(24px) saturate(1.8);-webkit-backdrop-filter:blur(24px) saturate(1.8);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent);box-shadow:0 10px 28px -16px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.55);color:var(--dsw-alias-label-primary)}',
      '.nm-mini-cover{position:relative;flex:none;width:32px;height:32px;border-radius:50%;overflow:hidden;background:repeating-radial-gradient(circle at 50% 50%,#16161a 0 1px,#0b0b0d 1px 2px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.09)}',
      ".nm-mini-cover[data-play='true'] img{animation-play-state:running}",
      '.nm-mini-cover img{width:100%;height:100%;object-fit:cover;display:block}',
      '.nm-mini-text{flex:auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.nm-mini-title{font-size:12px;line-height:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-mini-sub{font-size:10px;line-height:13px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-mini-play{flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:50%;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}',
      '.nm-mini-play:hover{opacity:.86}',
      '.nm-mini-track{position:absolute;left:0;right:0;bottom:0;height:2px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 20%,transparent)}',
      '.nm-mini-fill{height:100%;background:var(--dsw-alias-brand-primary)}',
      '.nm-fab{width:46px;height:46px;padding:0;border:0;border-radius:50%;cursor:pointer;background:var(--dsw-specific-menu);box-shadow:0 4px 16px -6px rgba(0,0,0,.35),0 0 0 .5px color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent);display:grid;place-items:center;color:var(--dsw-alias-label-secondary);overflow:hidden}',
      '.nm-fab:hover{color:var(--dsw-alias-label-primary)}',
      '@keyframes nm-spin{to{transform:rotate(360deg)}}',
      '@media (prefers-reduced-motion:reduce){.nm-vinyl,.nm-mini-cover img{animation:none!important}}',
      '.nm-fab img{width:100%;height:100%;object-fit:cover;display:block}',
      '.nm-fab-icon{display:grid;place-items:center;color:var(--dsw-alias-brand-primary)}',
      '.nm-card{position:relative;overflow:hidden;width:306px;box-sizing:border-box;padding:10px;display:flex;flex-direction:column;gap:9px;border-radius:calc(var(--dsw-radius-lg) + 6px);background:linear-gradient(145deg,rgba(255,255,255,.22) 0%,rgba(255,255,255,.04) 46%,rgba(255,255,255,.14) 100%);backdrop-filter:blur(40px) saturate(2.3) brightness(1.07);-webkit-backdrop-filter:blur(36px) saturate(2.15) brightness(1.04);border:1px solid rgba(255,255,255,.55);box-shadow:0 0 0 .5px rgba(15,23,42,.07),0 28px 66px -28px rgba(15,23,42,.42),inset 0 1px 0 rgba(255,255,255,.95),inset 1px 0 0 rgba(255,255,255,.6),inset -1px 0 0 rgba(255,255,255,.35),inset 0 -26px 42px -28px rgba(255,255,255,.6);color:var(--dsw-alias-label-primary)}',
      'body[data-ds-dark-theme] .nm-card{background:linear-gradient(145deg,rgba(255,255,255,.16) 0%,rgba(255,255,255,.04) 44%,rgba(255,255,255,.11) 100%);border-color:rgba(255,255,255,.24);box-shadow:0 0 0 .5px rgba(0,0,0,.4),0 28px 66px -28px rgba(0,0,0,.66),inset 0 1px 0 rgba(255,255,255,.3),inset 1px 0 0 rgba(255,255,255,.16),inset 0 -26px 42px -28px rgba(255,255,255,.12)}',
      '.nm-card>*{position:relative;z-index:1}',
      '.nm-card::before{content:"";position:absolute;inset:0;z-index:0;pointer-events:none;background:radial-gradient(320px 220px at var(--mx,50%) var(--my,0%),rgba(255,255,255,.55),transparent 70%);opacity:.6;transition:opacity 220ms ease}',
      '.nm-card::after{content:"";position:absolute;inset:-70% -35%;z-index:0;pointer-events:none;background:linear-gradient(115deg,transparent 40%,rgba(255,255,255,.34) 48%,rgba(255,255,255,.1) 54%,transparent 62%);animation:nm-gloss 14s ease-in-out infinite}',
      '@keyframes nm-gloss{0%,100%{transform:translate3d(-16%,-4%,0)}50%{transform:translate3d(16%,4%,0)}}',
      '.nm-head{display:flex;align-items:center;gap:10px}',
      '.nm-card{text-shadow:0 1px 1px rgba(255,255,255,.55)}',
      'body[data-ds-dark-theme] .nm-card{text-shadow:0 1px 2px rgba(0,0,0,.55)}',
      '.nm-title{font-weight:650;letter-spacing:.01em}',
      '.nm-vinyl{position:relative;flex:none;width:48px;height:48px;padding:0;border:0;border-radius:50%;cursor:pointer;background:repeating-radial-gradient(circle at 50% 50%,#16161a 0 1px,#0b0b0d 1px 2px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.09),0 3px 12px rgba(0,0,0,.38);animation:nm-spin 9s linear infinite;animation-play-state:paused}',
      ".nm-vinyl[data-play='true']{animation-play-state:running}",
      '.nm-vinyl-label{position:absolute;left:50%;top:50%;width:54%;height:54%;transform:translate(-50%,-50%);border-radius:50%;object-fit:cover;display:block;box-shadow:0 0 0 1px rgba(0,0,0,.55)}',
      '.nm-vinyl-hole{position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border-radius:50%;background:#0b0b0d;box-shadow:0 0 0 1px rgba(255,255,255,.18)}',
      '.nm-vinyl-sheen{position:absolute;inset:0;border-radius:50%;pointer-events:none;background:conic-gradient(from 35deg,rgba(255,255,255,0) 0deg,rgba(255,255,255,.16) 38deg,rgba(255,255,255,0) 92deg,rgba(255,255,255,0) 214deg,rgba(255,255,255,.1) 254deg,rgba(255,255,255,0) 306deg)}',
      '.nm-mini-cover img{position:absolute;left:22%;top:22%;width:56%;height:56%;border-radius:50%;object-fit:cover;display:block;animation:nm-spin 9s linear infinite;animation-play-state:paused}',
      '.nm-hole{display:none}',
      '.nm-text{flex:auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.nm-title{font-size:13px;line-height:17px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-sub{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.nm-track{position:relative;height:4px;border-radius:999px;cursor:pointer;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 20%,transparent);overflow:hidden}',
      '.nm-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}',
      '.nm-times{display:flex;justify-content:space-between;font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;margin-top:-5px}',
      '.nm-bar{display:flex;align-items:center;gap:4px}',
      '.nm-btn{display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.nm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.nm-btn-tight{width:24px;height:24px;border-radius:7px}',
      '.nm-main{width:32px;height:32px;border-radius:50%;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}',
      '.nm-main:hover{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);opacity:.86}',
      '.nm-volume{display:none}',
      '.nm-range{flex:auto;height:14px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;background:transparent}',
      '.nm-volume-value{font-size:10px;line-height:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:22px;text-align:right}',
      '.nm-tools{display:flex;align-items:center;gap:6px}',
      '.nm-chip{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;cursor:pointer;max-width:100%}',
      '.nm-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.nm-chip-on{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}',
      '.nm-chip-icon{display:grid;place-items:center;flex:none}',
      '.nm-chip-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-avatar{width:16px;height:16px;border-radius:50%;object-fit:cover;flex:none}',
      '.nm-lyric-box{display:flex;flex-direction:column;gap:2px;padding:6px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 40%,transparent)}',
      '.nm-lyric-now{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-lyric-next{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-panel{display:flex;flex-direction:column;gap:7px;padding:9px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 45%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}',
      '.nm-row{display:flex;align-items:center;gap:8px;justify-content:space-between}',
      '.nm-account-name{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-textarea{width:100%;box-sizing:border-box;resize:none;padding:6px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;font-family:ui-monospace,Consolas,monospace;outline:none}',
      '.nm-textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.nm-mini{height:24px;padding:0 10px;border:0;border-radius:7px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:11px;cursor:pointer}',
      '.nm-mini:disabled{opacity:.55;cursor:default}',
      '.nm-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}',
      '.nm-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
      '.nm-search-row{display:flex;align-items:center;gap:8px;padding-top:3px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent)}',
      '.nm-search-icon{display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);flex:none}',
      '.nm-input{flex:auto;min-width:0;height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;outline:none}',
      '.nm-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.nm-results{max-height:212px;overflow-y:auto;display:flex;flex-direction:column;gap:1px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}',
      '.nm-result{display:flex;align-items:center;gap:10px;width:100%;padding:5px 6px;border:0;border-radius:7px;background:transparent;cursor:pointer;text-align:left;color:inherit}',
      '.nm-result:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.nm-result-meta{flex:auto;min-width:0;display:flex;flex-direction:column}',
      '.nm-result-name{font-size:12px;line-height:17px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-result-sub{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.nm-badge{flex:none;font-size:9px;line-height:13px;padding:0 4px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}',
    ].join('\n');

    function apply(ctx) {
      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-netease-music';
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'dsh-netease-music: styles');

      ctx.effect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (store.accountPanel) { store.accountPanel = false; emit(); return; }
          if (store.open) { store.open = false; emit(); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, 'dsh-netease-music: escape');

      try { fetch(API + '/api/ping?s=' + encodeURIComponent('player-only')).catch(() => {}); } catch (error) { /* diagnostics only */ }

      try {
        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'netease-music', order: 40 },
          Root,
        ));
      } catch (error) {
        report('inject failed: ' + ((error && error.message) || error));
      }
    }

    return { name: 'dsh-netease-music', inject: ['slots'], apply: apply };
  },
});

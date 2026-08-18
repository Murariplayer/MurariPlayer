/* Murari Player — vanilla JS, no build step, GitHub Pages friendly. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    player: $('player'), idle: $('idle'), list: $('list'), empty: $('empty'),
    count: $('count'), search: $('search'), nowTitle: $('nowTitle'), nowSub: $('nowSub'),
    seek: $('seek'), curTime: $('curTime'), durTime: $('durTime'),
    play: $('play'), prev: $('prev'), next: $('next'),
    shuffle: $('shuffle'), repeat: $('repeat'), mute: $('mute'), volume: $('volume')
  };

  const STORE = 'murari-player';
  const state = {
    tracks: [],       // full playlist
    view: [],         // filtered indexes into tracks
    current: -1,      // index into state.tracks
    shuffle: false,
    repeat: false,    // repeat the whole playlist
    seeking: false,
    history: []
  };

  const prefs = load();

  /* ---------- helpers ---------- */

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
  }

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        volume: el.player.volume,
        muted: el.player.muted,
        shuffle: state.shuffle,
        repeat: state.repeat,
        lastSrc: state.current >= 0 ? state.tracks[state.current].src : null
      }));
    } catch { /* storage may be disabled */ }
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    const mm = h ? String(m).padStart(2, '0') : m;
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  function prettyName(path) {
    const base = path.split('/').pop().replace(/\.[^.]+$/, '');
    return decodeURIComponent(base).replace(/[_-]+/g, ' ').trim();
  }

  /* ---------- playlist loading ---------- */

  async function boot() {
    let data = [];
    try {
      const res = await fetch('media/playlist.json', { cache: 'no-cache' });
      if (res.ok) data = await res.json();
    } catch { /* missing manifest -> empty player */ }

    state.tracks = (Array.isArray(data) ? data : data.tracks || [])
      .map((t) => (typeof t === 'string' ? { src: t } : t))
      .filter((t) => t && t.src)
      .map((t) => ({
        src: t.src,
        title: t.title || prettyName(t.src),
        artist: t.artist || '',
        poster: t.poster || '',
        duration: null
      }));

    el.player.volume = typeof prefs.volume === 'number' ? prefs.volume : 1;
    el.player.muted = !!prefs.muted;
    el.volume.value = el.player.volume;
    state.shuffle = !!prefs.shuffle;
    state.repeat = !!prefs.repeat;
    el.shuffle.setAttribute('aria-pressed', String(state.shuffle));
    el.repeat.setAttribute('aria-pressed', String(state.repeat));
    syncMuteIcon();

    render();
    probeDurations();

    if (prefs.lastSrc) {
      const i = state.tracks.findIndex((t) => t.src === prefs.lastSrc);
      if (i >= 0) select(i, false);
    }
  }

  /* Read metadata for durations without disturbing playback. */
  function probeDurations() {
    let i = 0;
    const step = () => {
      if (i >= state.tracks.length) return;
      const track = state.tracks[i++];
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.muted = true;
      const done = () => {
        probe.removeAttribute('src');
        probe.load();
        step();
      };
      probe.addEventListener('loadedmetadata', () => {
        track.duration = probe.duration;
        const node = el.list.querySelector(`li[data-src="${CSS.escape(track.src)}"] .dur`);
        if (node) node.textContent = fmt(track.duration);
        done();
      }, { once: true });
      probe.addEventListener('error', done, { once: true });
      probe.src = track.src;
    };
    step();
  }

  /* ---------- rendering ---------- */

  function render() {
    const q = el.search.value.trim().toLowerCase();
    state.view = state.tracks
      .map((t, i) => i)
      .filter((i) => {
        if (!q) return true;
        const t = state.tracks[i];
        return (t.title + ' ' + t.artist).toLowerCase().includes(q);
      });

    el.list.innerHTML = '';
    state.view.forEach((i, n) => {
      const t = state.tracks[i];
      const li = document.createElement('li');
      li.dataset.index = String(i);
      li.dataset.src = t.src;
      li.className = i === state.current ? 'active' : '';
      li.title = t.title;

      const idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = n + 1;

      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.src = t.poster || 'assets/poster.svg';
      thumb.addEventListener('error', () => { thumb.src = 'assets/poster.svg'; }, { once: true });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = t.artist ? `${t.artist} — ${t.title}` : t.title;

      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = t.duration ? fmt(t.duration) : '–:––';

      li.append(idx, thumb, name, dur);
      el.list.append(li);
    });

    el.count.textContent = state.view.length;
    el.empty.classList.toggle('hidden', state.tracks.length > 0);
  }

  function markActive() {
    for (const li of el.list.children) {
      li.classList.toggle('active', Number(li.dataset.index) === state.current);
    }
  }

  /* ---------- playback ---------- */

  function select(index, autoplay = true) {
    if (index < 0 || index >= state.tracks.length) return;
    if (state.current >= 0 && state.current !== index) state.history.push(state.current);

    state.current = index;
    const t = state.tracks[index];
    el.player.poster = t.poster || 'assets/poster.svg';
    el.player.src = t.src;
    el.nowTitle.textContent = t.title;
    el.nowSub.textContent = t.artist || t.src;
    el.idle.classList.add('hidden');
    markActive();
    updateMediaSession(t);
    save();

    if (autoplay) el.player.play().catch(() => { /* autoplay blocked */ });
  }

  function nextIndex() {
    if (!state.tracks.length) return -1;
    if (state.shuffle && state.tracks.length > 1) {
      let i;
      do { i = Math.floor(Math.random() * state.tracks.length); } while (i === state.current);
      return i;
    }
    const i = state.current + 1;
    if (i < state.tracks.length) return i;
    return state.repeat ? 0 : -1;
  }

  function playNext() {
    const i = nextIndex();
    if (i >= 0) select(i);
    else el.play.textContent = '▶';
  }

  function playPrev() {
    if (el.player.currentTime > 3) { el.player.currentTime = 0; return; }
    if (state.shuffle && state.history.length) {
      const i = state.history.pop();
      state.current = -1;
      select(i);
      return;
    }
    const i = state.current - 1;
    select(i >= 0 ? i : state.tracks.length - 1);
  }

  function toggle() {
    if (state.current < 0) { if (state.view.length) select(state.view[0]); return; }
    if (el.player.paused) el.player.play().catch(() => {});
    else el.player.pause();
  }

  function syncMuteIcon() {
    el.mute.textContent = el.player.muted || el.player.volume === 0 ? '🔇' : '🔊';
  }

  function updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || 'Murari Player'
    });
    navigator.mediaSession.setActionHandler('play', () => el.player.play());
    navigator.mediaSession.setActionHandler('pause', () => el.player.pause());
    navigator.mediaSession.setActionHandler('previoustrack', playPrev);
    navigator.mediaSession.setActionHandler('nexttrack', playNext);
  }

  /* ---------- events ---------- */

  el.list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-index]');
    if (li) select(Number(li.dataset.index));
  });

  el.search.addEventListener('input', render);

  el.play.addEventListener('click', toggle);
  el.next.addEventListener('click', playNext);
  el.prev.addEventListener('click', playPrev);

  el.shuffle.addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    el.shuffle.setAttribute('aria-pressed', String(state.shuffle));
    save();
  });

  el.repeat.addEventListener('click', () => {
    state.repeat = !state.repeat;
    el.repeat.setAttribute('aria-pressed', String(state.repeat));
    save();
  });

  el.mute.addEventListener('click', () => {
    el.player.muted = !el.player.muted;
    syncMuteIcon();
    save();
  });

  el.volume.addEventListener('input', () => {
    el.player.volume = Number(el.volume.value);
    if (el.player.volume > 0) el.player.muted = false;
    syncMuteIcon();
    save();
  });

  el.seek.addEventListener('input', () => {
    state.seeking = true;
    const d = el.player.duration;
    if (isFinite(d)) el.curTime.textContent = fmt((el.seek.value / 1000) * d);
  });

  el.seek.addEventListener('change', () => {
    const d = el.player.duration;
    if (isFinite(d)) el.player.currentTime = (el.seek.value / 1000) * d;
    state.seeking = false;
  });

  el.player.addEventListener('play', () => { el.play.textContent = '⏸'; });
  el.player.addEventListener('pause', () => { el.play.textContent = '▶'; });
  el.player.addEventListener('ended', playNext);
  el.player.addEventListener('error', () => {
    el.nowSub.textContent = 'Could not play this file — skipping…';
    setTimeout(playNext, 800);
  });

  el.player.addEventListener('loadedmetadata', () => {
    el.durTime.textContent = fmt(el.player.duration);
    if (state.current >= 0) {
      state.tracks[state.current].duration = el.player.duration;
      const node = el.list.querySelector(`li[data-index="${state.current}"] .dur`);
      if (node) node.textContent = fmt(el.player.duration);
    }
  });

  el.player.addEventListener('timeupdate', () => {
    if (state.seeking) return;
    const d = el.player.duration;
    el.curTime.textContent = fmt(el.player.currentTime);
    el.seek.value = isFinite(d) && d > 0 ? (el.player.currentTime / d) * 1000 : 0;
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const keys = {
      ' ': () => toggle(),
      ArrowRight: () => playNext(),
      ArrowLeft: () => playPrev(),
      ArrowUp: () => { el.volume.value = Math.min(1, el.player.volume + .05); el.volume.dispatchEvent(new Event('input')); },
      ArrowDown: () => { el.volume.value = Math.max(0, el.player.volume - .05); el.volume.dispatchEvent(new Event('input')); },
      m: () => el.mute.click(),
      s: () => el.shuffle.click(),
      r: () => el.repeat.click(),
      f: () => { if (el.player.requestFullscreen) el.player.requestFullscreen().catch(() => {}); }
    };
    const fn = keys[e.key] || keys[e.key.toLowerCase()];
    if (fn) { e.preventDefault(); fn(); }
  });

  boot();
})();

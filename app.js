/* Murari Player — vanilla JS, no build step, GitHub Pages friendly. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    player: $('player'), idle: $('idle'), list: $('list'), empty: $('empty'),
    count: $('count'), search: $('search'), nowTitle: $('nowTitle'), nowSub: $('nowSub'),
    seek: $('seek'), curTime: $('curTime'), durTime: $('durTime'),
    play: $('play'), prev: $('prev'), next: $('next'),
    shuffle: $('shuffle'), repeat: $('repeat'), mute: $('mute'), volume: $('volume'),
    spinner: $('spinner'), banner: $('banner'), bannerMsg: $('bannerMsg'), bannerBtn: $('bannerBtn')
  };

  const STORE = 'murari-player';
  const STALL_MS = 15000;     // how long to buffer before warning about the connection
  const state = {
    tracks: [],       // full playlist
    view: [],         // filtered indexes into tracks
    current: -1,      // index into state.tracks
    shuffle: false,
    repeat: false,    // repeat the whole playlist
    seeking: false,
    history: [],
    stallTimer: null,
    resumeAt: 0       // position to restore once metadata arrives
  };

  const prefs = load();
  let lastSaved = 0;   // throttles writing the playback position

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
        lastSrc: state.current >= 0 ? state.tracks[state.current].src : null,
        lastTime: state.current >= 0 && isFinite(el.player.currentTime) ? el.player.currentTime : 0
      }));
    } catch { /* storage may be disabled */ }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- status banner / spinner ---------- */

  function showBanner(msg, actionLabel, action) {
    el.bannerMsg.textContent = msg;
    el.banner.classList.remove('hidden');
    el.bannerBtn.classList.toggle('hidden', !actionLabel);
    el.bannerBtn.textContent = actionLabel || '';
    el.bannerBtn.onclick = action || null;
  }

  function hideBanner() {
    el.banner.classList.add('hidden');
    el.bannerBtn.onclick = null;
  }

  function busy(on) {
    el.spinner.classList.toggle('hidden', !on);
    if (on) {
      clearTimeout(state.stallTimer);
      state.stallTimer = setTimeout(() => {
        if (el.spinner.classList.contains('hidden')) return;
        showBanner(
          navigator.onLine
            ? 'This is taking a while — the video is still buffering.'
            : 'You are offline.',
          'Retry',
          () => reloadCurrent()
        );
      }, STALL_MS);
    } else {
      clearTimeout(state.stallTimer);
    }
  }

  /* Reload the current track from scratch, keeping the playback position. */
  function reloadCurrent() {
    if (state.current < 0) return;
    const at = el.player.currentTime;
    const wasPlaying = !el.player.paused;
    hideBanner();
    state.resumeAt = isFinite(at) ? at : 0;
    el.player.load();
    if (wasPlaying) el.player.play().catch(() => {});
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

  async function fetchPlaylist() {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('media/playlist.json', { cache: 'no-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!data || (typeof data !== 'object')) throw new Error('Malformed playlist');
        return data;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await sleep(400 * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }

  async function boot() {
    let data = [];
    let failed = false;
    try {
      data = await fetchPlaylist();
      hideBanner();
    } catch (e) {
      failed = true;
      showBanner('Could not load the playlist (' + e.message + ').', 'Retry', () => boot());
    }

    state.tracks = (Array.isArray(data) ? data : data.tracks || [])
      .map((t) => (typeof t === 'string' ? { src: t } : t))
      .filter((t) => t && typeof t.src === 'string' && t.src)
      .map((t) => ({
        src: t.src,
        title: t.title || prettyName(t.src),
        artist: t.artist || '',
        poster: t.poster || '',
        duration: null,
        broken: false,
        retried: false
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

    if (failed && !state.tracks.length) return;

    if (prefs.lastSrc) {
      const i = state.tracks.findIndex((t) => t.src === prefs.lastSrc);
      if (i >= 0) {
        state.resumeAt = Number(prefs.lastTime) > 0 ? Number(prefs.lastTime) : 0;
        select(i, false);
      }
    }
  }

  /* Read metadata for durations without disturbing playback. A hung request must
     not stall the queue, so every probe gets its own timeout. */
  function probeDurations() {
    let i = 0;
    const step = () => {
      if (i >= state.tracks.length) return;
      const track = state.tracks[i++];
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      probe.muted = true;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.removeAttribute('src');
        probe.load();
        step();
      };
      const timer = setTimeout(done, 10000);
      probe.addEventListener('loadedmetadata', () => {
        track.duration = probe.duration;
        const node = el.list.querySelector(`li[data-src="${CSS.escape(track.src)}"] .dur`);
        if (node) node.textContent = fmt(track.duration);
        done();
      }, { once: true });
      probe.addEventListener('error', () => {
        markBroken(track);
        done();
      }, { once: true });
      probe.src = track.src;
    };
    step();
  }

  function markBroken(track) {
    track.broken = true;
    const li = el.list.querySelector(`li[data-src="${CSS.escape(track.src)}"]`);
    if (li) li.classList.add('broken');
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
      if (t.broken) li.classList.add('broken');
      li.title = t.broken ? t.title + ' (unavailable)' : t.title;

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
    t.retried = false;
    lastSaved = 0;
    hideBanner();
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

  function playable() {
    return state.tracks.some((t) => !t.broken);
  }

  function nextIndex() {
    if (!state.tracks.length || !playable()) return -1;
    if (state.shuffle && state.tracks.length > 1) {
      const pool = state.tracks
        .map((t, i) => i)
        .filter((i) => !state.tracks[i].broken && i !== state.current);
      if (!pool.length) return state.tracks[state.current] && !state.tracks[state.current].broken ? state.current : -1;
      return pool[Math.floor(Math.random() * pool.length)];
    }
    for (let i = state.current + 1; i < state.tracks.length; i++) {
      if (!state.tracks[i].broken) return i;
    }
    if (!state.repeat) return -1;
    for (let i = 0; i <= state.current && i < state.tracks.length; i++) {
      if (!state.tracks[i].broken) return i;
    }
    return -1;
  }

  function playNext() {
    const i = nextIndex();
    if (i >= 0) { select(i); return; }
    el.play.textContent = '▶';
    busy(false);
    if (state.tracks.length && !playable()) {
      showBanner('None of the tracks could be played. Check your connection or the playlist.', 'Retry', () => {
        state.tracks.forEach((t) => { t.broken = false; t.retried = false; });
        render();
        playNext();
      });
    }
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
    if (!li) return;
    const i = Number(li.dataset.index);
    const t = state.tracks[i];
    if (t && t.broken) {           // give a failed track a fresh chance on demand
      t.broken = false;
      li.classList.remove('broken');
    }
    select(i);
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
  el.player.addEventListener('pause', () => { el.play.textContent = '▶'; busy(false); });
  el.player.addEventListener('ended', playNext);

  el.player.addEventListener('loadstart', () => busy(true));
  el.player.addEventListener('waiting', () => busy(true));
  el.player.addEventListener('stalled', () => busy(true));
  el.player.addEventListener('canplay', () => { busy(false); hideBanner(); });
  el.player.addEventListener('playing', () => { busy(false); hideBanner(); });

  /* A single bad file must never freeze the player: retry once, then mark it
     broken and move on to the next one that still works. */
  el.player.addEventListener('error', () => {
    busy(false);
    const t = state.tracks[state.current];
    if (!t) return;

    if (!navigator.onLine) {
      showBanner('You are offline — playback paused.', 'Retry', () => reloadCurrent());
      return;
    }

    if (!t.retried) {
      t.retried = true;
      el.nowSub.textContent = 'Hiccup while loading — retrying…';
      setTimeout(() => { if (state.tracks[state.current] === t) reloadCurrent(); }, 1200);
      return;
    }

    markBroken(t);
    showBanner('“' + t.title + '” could not be played — skipping it.');
    el.nowSub.textContent = 'Unavailable';
    setTimeout(playNext, 900);
  });

  el.player.addEventListener('loadedmetadata', () => {
    el.durTime.textContent = fmt(el.player.duration);
    if (state.resumeAt > 0 && isFinite(el.player.duration) && state.resumeAt < el.player.duration - 1) {
      try { el.player.currentTime = state.resumeAt; } catch { /* not seekable yet */ }
    }
    state.resumeAt = 0;
    if (state.current >= 0) {
      state.tracks[state.current].duration = el.player.duration;
      const node = el.list.querySelector(`li[data-index="${state.current}"] .dur`);
      if (node) node.textContent = fmt(el.player.duration);
    }
  });

  window.addEventListener('offline', () => {
    showBanner('You are offline — playback may stop.');
  });

  window.addEventListener('online', () => {
    hideBanner();
    if (state.current >= 0 && el.player.error) reloadCurrent();
  });

  window.addEventListener('pagehide', save);

  el.player.addEventListener('timeupdate', () => {
    if (state.seeking) return;
    const d = el.player.duration;
    el.curTime.textContent = fmt(el.player.currentTime);
    el.seek.value = isFinite(d) && d > 0 ? (el.player.currentTime / d) * 1000 : 0;
    if (el.player.currentTime - lastSaved > 5) { lastSaved = el.player.currentTime; save(); }
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

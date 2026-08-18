/* Murari Dashboard — edit the playlist, capture thumbnails, publish. Vanilla JS. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    owner: $('owner'), repo: $('repo'), branch: $('branch'), token: $('token'),
    remember: $('remember'), status: $('status'), rows: $('rows'), none: $('none'),
    count: $('count'), reload: $('reload'), scan: $('scan'), addRow: $('addRow'),
    download: $('download'), save: $('save'), grabber: $('grabber'), canvas: $('canvas'),
    fixThumbs: $('fixThumbs'),
    wiz: $('wiz'), wizStep: $('wizStep'), wizFile: $('wizFile'), wizVideo: $('wizVideo'),
    wizTime: $('wizTime'), wizTitle: $('wizTitle'), wizArtist: $('wizArtist'),
    wizUse: $('wizUse'), wizSkip: $('wizSkip'), wizCancel: $('wizCancel'),
    gate: $('gate'), app: $('app'), loginForm: $('loginForm'), user: $('user'),
    pass: $('pass'), loginErr: $('loginErr'), logout: $('logout'),
    upload: $('upload'), fileInput: $('fileInput'), drop: $('drop')
  };

  const CFG = 'murari-admin-cfg';
  const TOK = 'murari-admin-token';
  const AUTH_KEY = 'murari-admin-auth';
  // Soft gate only: this file is public, so treat it as a speed bump, not security.
  const AUTH = {
    salt: 'murari-player-v1',
    user: 'e6e246ae0264bd54b83f6e9252d93237dc7afb79fb6d416be12a68bb40805a4c',
    pass: '5e74512a20e95fea5b45e464e9fc2a2f10bd3622b135285a7f26df005a87a711'
  };
  const PLAYLIST_PATH = 'media/playlist.json';
  const THUMB_DIR = 'assets/thumbs';
  const SCAN_DIRS = ['media', 'assets'];
  const MEDIA_EXT = /\.(mp4|webm|ogv|m4v|mov|mp3|m4a|ogg|wav|flac|opus)$/i;

  let tracks = [];
  const pendingThumbs = new Map(); // repo path -> { blob, url }
  const localUrls = new Map();     // repo path -> object URL of the file just uploaded
  const MAX_UPLOAD = 100 * 1024 * 1024;

  /* ---------- config ---------- */

  function detectRepo() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    const seg = location.pathname.split('/').filter(Boolean);
    return { owner: m ? m[1] : '', repo: m && seg.length ? seg[0] : '' };
  }

  function loadCfg() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CFG)) || {}; } catch { /* ignore */ }
    const guess = detectRepo();
    el.owner.value = saved.owner || guess.owner || '';
    el.repo.value = saved.repo || guess.repo || '';
    el.branch.value = saved.branch || 'main';
    const tok = localStorage.getItem(TOK);
    if (tok) { el.token.value = tok; el.remember.checked = true; }
  }

  function saveCfg() {
    try {
      localStorage.setItem(CFG, JSON.stringify({
        owner: el.owner.value.trim(), repo: el.repo.value.trim(), branch: el.branch.value.trim() || 'main'
      }));
      if (el.remember.checked && el.token.value) localStorage.setItem(TOK, el.token.value);
      else localStorage.removeItem(TOK);
    } catch { /* storage disabled */ }
  }

  const cfg = () => ({
    owner: el.owner.value.trim(),
    repo: el.repo.value.trim(),
    branch: el.branch.value.trim() || 'main',
    token: el.token.value.trim()
  });

  function say(msg, kind = '') {
    el.status.textContent = msg;
    el.status.className = 'status ' + kind;
  }

  /* ---------- GitHub API ---------- */

  async function api(path, options = {}) {
    const { token } = cfg();
    const headers = Object.assign({ Accept: 'application/vnd.github+json' }, options.headers || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('https://api.github.com' + path, Object.assign({}, options, { headers }));
    if (res.status === 404) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `GitHub API ${res.status}`);
    return body;
  }

  const repoBase = () => {
    const { owner, repo } = cfg();
    if (!owner || !repo) throw new Error('Set the owner and repo fields first.');
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  };

  async function getSha(path) {
    const { branch } = cfg();
    const info = await api(`${repoBase()}/contents/${path}?ref=${encodeURIComponent(branch)}`);
    return info && info.sha ? info.sha : null;
  }

  async function putFile(path, base64, message) {
    const { branch } = cfg();
    const sha = await getSha(path);
    const body = { message, content: base64, branch };
    if (sha) body.sha = sha;
    return api(`${repoBase()}/contents/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  function b64FromText(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function b64FromBuffer(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  /* ---------- playlist ---------- */

  function normalize(list) {
    return (Array.isArray(list) ? list : [])
      .map((t) => (typeof t === 'string' ? { src: t } : t))
      .filter((t) => t && t.src)
      .map((t) => ({
        src: t.src,
        title: t.title || t.src.split('/').pop().replace(/\.[^.]+$/, ''),
        artist: t.artist || '',
        poster: t.poster || ''
      }));
  }

  function serialize() {
    return JSON.stringify(tracks.map((t) => {
      const out = { src: t.src, title: t.title };
      if (t.artist) out.artist = t.artist;
      if (t.poster) out.poster = t.poster;
      return out;
    }), null, 2) + '\n';
  }

  async function loadPlaylist() {
    say('Loading playlist…');
    try {
      const res = await fetch(PLAYLIST_PATH + '?cb=' + Date.now(), { cache: 'no-store' });
      tracks = res.ok ? normalize(await res.json()) : [];
      render();
      const missing = tracks.filter((t) => !t.poster).length;
      say(`Loaded ${tracks.length} track(s).` +
        (missing ? ` ${missing} have no thumbnail — click “Missing thumbnails”.` : ''), 'ok');
    } catch (e) {
      say('Could not load playlist.json: ' + e.message, 'err');
    }
  }

  async function scanRepo() {
    say('Scanning repository…');
    try {
      const { branch } = cfg();
      const known = new Set(tracks.map((t) => decodeURIComponent(t.src)));
      const found = [];
      for (const dir of SCAN_DIRS) {
        const list = await api(`${repoBase()}/contents/${dir}?ref=${encodeURIComponent(branch)}`);
        if (!Array.isArray(list)) continue;
        for (const f of list) {
          if (f.type === 'file' && MEDIA_EXT.test(f.name) && !known.has(`${dir}/${f.name}`)) {
            found.push(`${dir}/${f.name}`);
          }
        }
      }
      found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const added = [];
      for (const src of found) {
        added.push(tracks.length);
        tracks.push({
          src: src.split('/').map(encodeURIComponent).join('/'),
          title: '', artist: '', poster: ''
        });
      }
      render();
      if (!added.length) return say('No new media files found.', 'ok');
      say(`Found ${added.length} new file(s) — naming them now…`, 'ok');
      await runWizard(added);
    } catch (e) {
      say('Scan failed: ' + e.message, 'err');
    }
  }

  /* ---------- thumbnails ---------- */

  function thumbPath(src) {
    const name = decodeURIComponent(src.split('/').pop()).replace(/\.[^.]+$/, '');
    const safe = name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'thumb';
    return `${THUMB_DIR}/${safe}.jpg`;
  }

  function prettyName(src) {
    return decodeURIComponent(src.split('/').pop()).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  }

  function frameToBlob(v) {
    return new Promise((resolve, reject) => {
      const c = el.canvas;
      const w = v.videoWidth, h = v.videoHeight;
      if (!w || !h) return reject(new Error('This file has no video track.'));
      const scale = Math.min(1, 640 / w);
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      c.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Frame capture failed.')), 'image/jpeg', 0.82);
    });
  }

  function setThumb(track, blob) {
    const path = thumbPath(track.src);
    const prev = pendingThumbs.get(path);
    if (prev) URL.revokeObjectURL(prev.url);
    pendingThumbs.set(path, { blob, url: URL.createObjectURL(blob) });
    track.poster = path;
  }

  function captureFrame(src) {
    return new Promise((resolve, reject) => {
      const v = el.grabber;
      const cleanup = () => {
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('error', onError);
      };
      const onError = () => { cleanup(); reject(new Error('Could not read the video file.')); };
      const onSeeked = () => {
        cleanup();
        frameToBlob(v).then(resolve, reject);
      };

      v.addEventListener('error', onError, { once: true });
      v.addEventListener('loadeddata', () => {
        const d = v.duration;
        v.addEventListener('seeked', onSeeked, { once: true });
        v.currentTime = isFinite(d) && d > 2 ? Math.min(d * 0.15, 10) : 0;
      }, { once: true });

      v.src = localUrls.get(src) || src;
      v.load();
    });
  }

  async function grabThumb(i) {
    const t = tracks[i];
    say(`Capturing thumbnail for “${t.title}”…`);
    try {
      setThumb(t, await captureFrame(t.src));
      render();
      say('Thumbnail ready — it uploads with the next save (or download it below).', 'ok');
    } catch (e) {
      say('Capture failed: ' + e.message, 'err');
    }
  }

  /* ---------- uploading media ---------- */

  function safeName(name) {
    const dot = name.lastIndexOf('.');
    const base = (dot > 0 ? name.slice(0, dot) : name).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '');
    const ext = (dot > 0 ? name.slice(dot) : '').toLowerCase();
    return (base || 'video') + ext;
  }

  async function freeRepoPath(name) {
    let path = `assets/${safeName(name)}`;
    if (!(await getSha(path))) return path;
    const dot = path.lastIndexOf('.');
    for (let n = 2; n < 100; n++) {
      const candidate = `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
      if (!(await getSha(candidate))) return candidate;
    }
    throw new Error('Too many files with that name.');
  }

  async function uploadFiles(fileList) {
    const files = [...fileList].filter((f) => MEDIA_EXT.test(f.name));
    if (!files.length) return say('No playable video or audio files in that selection.', 'err');
    if (!cfg().token) return say('Paste a GitHub token first — uploading needs write access.', 'err');

    const oversized = files.filter((f) => f.size > MAX_UPLOAD);
    if (oversized.length) {
      return say(`Too large for the GitHub API (100 MB max): ${oversized.map((f) => f.name).join(', ')}`, 'err');
    }

    el.upload.disabled = true;
    const added = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const mb = (file.size / 1048576).toFixed(1);
        say(`Uploading ${i + 1}/${files.length} — ${file.name} (${mb} MB)…`);
        const path = await freeRepoPath(file.name);
        await putFile(path, b64FromBuffer(await file.arrayBuffer()), `Add ${path.split('/').pop()}`);

        const src = path.split('/').map(encodeURIComponent).join('/');
        localUrls.set(src, URL.createObjectURL(file));
        added.push(tracks.length);
        tracks.push({ src, title: '', artist: '', poster: '' });
        render();
      }
      say(`Uploaded ${added.length} file(s). Now name them and pick thumbnails…`, 'ok');
      await runWizard(added);
      await saveToGitHub();
    } catch (e) {
      say('Upload failed: ' + e.message, 'err');
    } finally {
      el.upload.disabled = false;
    }
  }

  /* ---------- naming + thumbnail wizard ---------- */

  function wizardStep(track, n, total) {
    return new Promise((resolve) => {
      const v = el.wizVideo;
      el.wizStep.textContent = `Set up track ${n} of ${total}`;
      el.wizFile.textContent = decodeURIComponent(track.src);
      el.wizTitle.value = track.title || prettyName(track.src);
      el.wizArtist.value = track.artist || '';
      el.wizTime.value = 0;
      el.wizTime.disabled = true;
      el.wiz.classList.remove('hidden');

      const onMeta = () => {
        const d = isFinite(v.duration) ? v.duration : 0;
        el.wizTime.max = d || 1;
        el.wizTime.disabled = !d;
        v.currentTime = d > 2 ? Math.min(d * 0.15, 10) : 0;
        el.wizTime.value = v.currentTime;
      };
      const onScrub = () => { v.currentTime = Number(el.wizTime.value); };

      const finish = (action) => {
        v.removeEventListener('loadedmetadata', onMeta);
        el.wizTime.removeEventListener('input', onScrub);
        el.wizUse.removeEventListener('click', onUse);
        el.wizSkip.removeEventListener('click', onSkip);
        el.wizCancel.removeEventListener('click', onCancel);
        el.wiz.classList.add('hidden');
        v.pause();
        v.removeAttribute('src');
        v.load();
        resolve(action);
      };

      const applyText = () => {
        track.title = el.wizTitle.value.trim() || prettyName(track.src);
        track.artist = el.wizArtist.value.trim();
      };

      const onUse = async () => {
        applyText();
        el.wizUse.disabled = true;
        try {
          setThumb(track, await frameToBlob(v));
        } catch (e) {
          say('No thumbnail for this file: ' + e.message, 'err');
        }
        el.wizUse.disabled = false;
        finish('use');
      };
      const onSkip = () => { applyText(); finish('skip'); };
      const onCancel = () => { applyText(); finish('cancel'); };

      v.addEventListener('loadedmetadata', onMeta);
      el.wizTime.addEventListener('input', onScrub);
      el.wizUse.addEventListener('click', onUse);
      el.wizSkip.addEventListener('click', onSkip);
      el.wizCancel.addEventListener('click', onCancel);

      v.src = localUrls.get(track.src) || track.src;
      v.load();
    });
  }

  async function runWizard(indices) {
    for (let n = 0; n < indices.length; n++) {
      const action = await wizardStep(tracks[indices[n]], n + 1, indices.length);
      render();
      if (action === 'cancel') break;
    }
    for (const t of tracks) if (!t.title) t.title = prettyName(t.src) || 'Untitled';
    render();
    say('Ready — review the list, then “Save to GitHub” (or download the JSON).', 'ok');
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- rendering ---------- */

  function render() {
    el.rows.innerHTML = '';
    tracks.forEach((t, i) => el.rows.append(rowFor(t, i)));
    el.count.textContent = tracks.length;
    el.none.classList.toggle('hidden', tracks.length > 0);
  }

  function field(label, value, oninput, placeholder = '') {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.placeholder = placeholder;
    input.addEventListener('input', () => oninput(input.value));
    wrap.append(input);
    return wrap;
  }

  function button(label, title, onclick, cls = 'btn tiny') {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', onclick);
    return b;
  }

  function rowFor(t, i) {
    const row = document.createElement('div');
    row.className = 'row';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumbwrap';
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';
    const pending = t.poster && pendingThumbs.get(t.poster);
    img.src = pending ? pending.url : (t.poster || 'assets/poster.svg');
    img.addEventListener('error', () => { img.src = 'assets/poster.svg'; }, { once: true });
    thumbWrap.append(img, button('📷 Capture', 'Grab a frame from the video', () => grabThumb(i)));
    if (pending) {
      thumbWrap.append(button('⬇ .jpg', 'Download this thumbnail', () =>
        downloadBlob(pending.blob, t.poster.split('/').pop())));
    }

    const left = document.createElement('div');
    left.append(
      field('Title', t.title, (v) => { t.title = v; }, 'Track name'),
      field('Thumbnail path', t.poster, (v) => { t.poster = v.trim(); }, 'assets/thumbs/name.jpg')
    );
    left.style.display = 'grid';
    left.style.gap = '8px';

    const right = document.createElement('div');
    right.append(
      field('Artist / subtitle', t.artist, (v) => { t.artist = v; }, 'optional'),
      field('File path', t.src, (v) => { t.src = v.trim(); }, 'assets/video.mp4')
    );
    right.style.display = 'grid';
    right.style.gap = '8px';

    const btns = document.createElement('div');
    btns.className = 'rowbtns';
    btns.append(
      button('↑', 'Move up', () => move(i, -1)),
      button('↓', 'Move down', () => move(i, 1)),
      button('✕', 'Remove from playlist (the file itself is kept)', () => {
        tracks.splice(i, 1);
        render();
      })
    );

    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = decodeURIComponent(t.src);

    row.append(thumbWrap, left, right, btns, src);
    return row;
  }

  function move(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= tracks.length) return;
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
    render();
  }

  /* ---------- publish ---------- */

  async function saveToGitHub() {
    const { token } = cfg();
    if (!token) return say('Paste a GitHub token with Contents: read and write access first.', 'err');
    if (!tracks.length && !confirm('The playlist is empty. Save anyway?')) return;

    el.save.disabled = true;
    try {
      let n = 0;
      for (const [path, { blob }] of pendingThumbs) {
        n++;
        say(`Uploading thumbnail ${n}/${pendingThumbs.size}…`);
        const buf = await blob.arrayBuffer();
        await putFile(path, b64FromBuffer(buf), `Add thumbnail ${path.split('/').pop()}`);
      }
      for (const { url } of pendingThumbs.values()) URL.revokeObjectURL(url);
      pendingThumbs.clear();

      say('Committing playlist.json…');
      const res = await putFile(PLAYLIST_PATH, b64FromText(serialize()), 'Update playlist via dashboard');
      saveCfg();
      const link = res && res.commit && res.commit.html_url ? '\n' + res.commit.html_url : '';
      say('Committed. Waiting for GitHub Pages to publish…' + link, 'ok');
      pollLive(link);
    } catch (e) {
      say('Save failed: ' + e.message, 'err');
    } finally {
      el.save.disabled = false;
    }
  }

  /* Poll the published file until it matches what we just committed. */
  async function pollLive(link) {
    const expected = serialize().trim();
    const deadline = Date.now() + 180000;
    const tick = async () => {
      try {
        const res = await fetch(PLAYLIST_PATH + '?cb=' + Date.now(), { cache: 'no-store' });
        if (res.ok && (await res.text()).trim() === expected) {
          return say('Live — the site is serving your changes.' + link, 'ok');
        }
      } catch { /* keep waiting */ }
      if (Date.now() < deadline) setTimeout(tick, 5000);
      else say('Committed, but the site has not refreshed yet. Check the Actions tab.' + link, 'ok');
    };
    setTimeout(tick, 5000);
  }

  /* ---------- events ---------- */

  el.reload.addEventListener('click', loadPlaylist);
  el.scan.addEventListener('click', scanRepo);
  el.save.addEventListener('click', saveToGitHub);

  el.fixThumbs.addEventListener('click', () => {
    const missing = tracks.map((t, i) => i).filter((i) => tracks[i].src && !tracks[i].poster);
    if (!missing.length) return say('Every track already has a thumbnail.', 'ok');
    runWizard(missing);
  });

  el.upload.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    const files = [...el.fileInput.files];
    el.fileInput.value = '';
    uploadFiles(files);
  });

  for (const type of ['dragenter', 'dragover']) {
    el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    el.drop.addEventListener(type, () => el.drop.classList.remove('over'));
  }
  el.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  el.addRow.addEventListener('click', () => {
    tracks.push({ src: '', title: `Track ${String(tracks.length + 1).padStart(2, '0')}`, artist: '', poster: '' });
    render();
  });

  el.download.addEventListener('click', () => {
    downloadBlob(new Blob([serialize()], { type: 'application/json' }), 'playlist.json');
    say('Downloaded. Upload it to media/playlist.json in the repo.', 'ok');
  });

  for (const input of [el.owner, el.repo, el.branch, el.token]) {
    input.addEventListener('change', saveCfg);
  }
  el.remember.addEventListener('change', saveCfg);

  /* ---------- sign in ---------- */

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(AUTH.salt + ':' + text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function unlock() {
    el.gate.classList.add('hidden');
    el.app.classList.remove('hidden');
    loadCfg();
    loadPlaylist();
  }

  el.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await sha256(el.user.value.trim().toLowerCase()) === AUTH.user &&
               await sha256(el.pass.value) === AUTH.pass;
    if (!ok) {
      el.loginErr.classList.remove('hidden');
      el.pass.value = '';
      el.pass.focus();
      return;
    }
    try { sessionStorage.setItem(AUTH_KEY, '1'); } catch { /* storage disabled */ }
    unlock();
  });

  el.logout.addEventListener('click', () => {
    try { sessionStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
    location.reload();
  });

  let signedIn = false;
  try { signedIn = sessionStorage.getItem(AUTH_KEY) === '1'; } catch { /* ignore */ }
  if (signedIn) unlock();
})();

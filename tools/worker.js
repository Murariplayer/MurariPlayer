/*
 * Murari Player upload proxy — Cloudflare Worker.
 *
 * Holds the GitHub token server-side so the dashboard needs no token at all.
 * Deploy at https://workers.cloudflare.com (free plan is plenty), then set these
 * variables under Settings → Variables:
 *
 *   GH_TOKEN     (secret)  fine-grained PAT, Contents: Read and write on the repo
 *   ADMIN_USER   (secret)  e.g. murari
 *   ADMIN_PASS   (secret)  e.g. murari123
 *   REPO         (plain)   e.g. Murariplayer/MurariPlayer
 *   BRANCH       (plain)   main
 *   ALLOW_ORIGIN (plain)   https://murariplayer.github.io
 */

const MEDIA_EXT = /\.(mp4|webm|ogv|m4v|mov|mp3|m4a|ogg|wav|flac|opus|jpg|jpeg|png|webp)$/i;
const PLAYLIST = 'media/playlist.json';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'authorization,content-type',
      'Access-Control-Max-Age': '86400'
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (!env.GH_TOKEN || !env.REPO || !env.ADMIN_USER || !env.ADMIN_PASS) {
      return json({ message: 'Worker is missing GH_TOKEN, REPO, ADMIN_USER or ADMIN_PASS.' }, 500);
    }
    if (!authorized(request, env)) return json({ message: 'Wrong username or password.' }, 401);

    const url = new URL(request.url);
    const branch = env.BRANCH || 'main';

    try {
      if (url.pathname === '/login') return json({ ok: true });

      if (url.pathname === '/sha') {
        const path = url.searchParams.get('path') || '';
        if (!allowedPath(path)) return json({ message: 'Path not allowed.' }, 400);
        const res = await gh(env, `contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
        if (res.status === 404) return json({ sha: null });
        const body = await res.json();
        return json({ sha: body.sha || null });
      }

      if (url.pathname === '/list') {
        const dir = url.searchParams.get('dir') || '';
        if (!/^[A-Za-z0-9._/-]*$/.test(dir)) return json({ message: 'Bad directory.' }, 400);
        const res = await gh(env, `contents/${encodePath(dir)}?ref=${encodeURIComponent(branch)}`);
        if (res.status === 404) return json([]);
        return json(await res.json(), res.status);
      }

      if (url.pathname === '/put' && request.method === 'POST') {
        const { path, content, message } = await request.json();
        if (!allowedPath(path)) return json({ message: 'Only assets/ and the playlist can be written.' }, 400);
        if (typeof content !== 'string' || !content) return json({ message: 'Missing file content.' }, 400);

        const shaRes = await gh(env, `contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
        const sha = shaRes.status === 404 ? null : (await shaRes.json()).sha;

        const body = { message: message || `Update ${path}`, content, branch };
        if (sha) body.sha = sha;

        const res = await gh(env, `contents/${encodePath(path)}`, {
          method: 'PUT',
          body: JSON.stringify(body)
        });
        return json(await res.json(), res.status);
      }

      return json({ message: 'Not found.' }, 404);
    } catch (e) {
      return json({ message: 'Proxy error: ' + e.message }, 500);
    }
  }
};

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPO}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'murari-player-proxy'
    }
  });
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/* Writes are limited to media files and thumbnails under assets/, plus the playlist. */
function allowedPath(path) {
  if (typeof path !== 'string' || !path || path.includes('..') || path.startsWith('/')) return false;
  if (path === PLAYLIST) return true;
  return /^assets\/[A-Za-z0-9._/-]+$/.test(path) && MEDIA_EXT.test(path);
}

function authorized(request, env) {
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), env.ADMIN_USER) && safeEqual(decoded.slice(i + 1), env.ADMIN_PASS);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

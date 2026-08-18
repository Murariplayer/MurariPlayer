# Murari Player

A static, dependency-free music/video player for GitHub Pages. Plain HTML + CSS + vanilla JavaScript — no frameworks, no build step.

## Add your files

1. Drop your video/audio files into `media/` or `assets/` (subfolders are fine).
2. Regenerate the playlist manifest:

   ```bash
   node tools/build-playlist.js
   ```

3. Commit and push. That's it.

Re-running the generator **keeps any `title`/`artist` you edited by hand** in `media/playlist.json` and only adds/removes entries for files that changed.

GitHub Pages can't list a directory, so `media/playlist.json` is the source of truth for the playlist. You can also edit it by hand:

```json
[
  { "src": "assets/song.mp4", "title": "Song Name", "artist": "Someone", "poster": "assets/thumbs/song.jpg" },
  "assets/another.mp3"
]
```

Supported extensions in the generator: `.mp4 .webm .ogv .m4v .mov .mp3 .m4a .ogg .wav .flac .opus`
(browsers play best with **mp4/H.264**, **webm**, **mp3**, **m4a**).

## Dashboard

Open `admin.html` (or the ⚙ button in the player) and sign in — username `murari`, password `murari123`. Sign-in and the GitHub token are both remembered on that device (**Keep me signed in**), so you paste the token once; use **Sign out** or **forget** to clear them.

> This login is a **soft gate**, not security: `admin.js` is public, so anyone determined can bypass it. Only the salted SHA-256 hashes are stored, never the plaintext. Real protection comes from the GitHub token, which lives only in your browser — without it nobody can change the repo.

To change the credentials, replace the hashes in `admin.js` with the output of:

```bash
node -e "const c=require('crypto');const s='murari-player-v1';for(const v of ['newuser','newpass'])console.log(v, c.createHash('sha256').update(s+':'+v).digest('hex'))"
```

The dashboard lets you:

- **Upload videos** — pick files or drag them onto the drop zone. Each file is committed to `assets/`, then the wizard asks for the track name and thumbnail frame, and the playlist is saved automatically.

- Rename tracks, set an artist/subtitle, reorder, add or remove entries
- **Scan repo for new videos** — finds files in `media/` and `assets/` that aren't in the playlist yet, then walks you through each one: pick the thumbnail frame with a slider and type the track name
- **Missing thumbnails** — runs the same wizard over any track that has no thumbnail
- **Capture** — grabs a frame from a single video without the wizard
- **Download playlist.json** — export and upload it yourself
- **Save to GitHub** — commits `playlist.json` (and any new thumbnails) straight to the repo, then waits until the live site serves the change

Saving needs a GitHub token pasted into the dashboard: a fine-grained PAT with **Contents: Read and write** on this repo, or a classic token with `repo` scope. It is kept in your browser only (optionally in `localStorage`) and sent only to `api.github.com` — never commit it to the repo. To avoid tokens entirely, see **Token-free uploads** below.

## Token-free uploads (recommended for sharing)

Deploy `tools/worker.js` as a **Cloudflare Worker** so the GitHub token lives on the server instead of in the browser. Anyone you share the login with can then upload videos without touching GitHub.

1. Create a fine-grained PAT: **Contents: Read and write**, this repository only.
2. dash.cloudflare.com → Workers & Pages → **Create → Worker** → deploy the starter, then **Edit code** and paste `tools/worker.js`.
3. Settings → **Variables and Secrets** — add:

   | Name | Type | Value |
   | --- | --- | --- |
   | `GH_TOKEN` | Secret | your PAT |
   | `ADMIN_USER` | Secret | `murari` |
   | `ADMIN_PASS` | Secret | `murari123` |
   | `REPO` | Text | `Owner/Repo` |
   | `BRANCH` | Text | `main` |
   | `ALLOW_ORIGIN` | Text | `https://<account>.github.io` |

4. Put the Worker URL in `config.js`:

   ```js
   window.MURARI_CONFIG = { proxy: 'https://your-worker.workers.dev' };
   ```

Now the dashboard's repository/token panel disappears: signing in *is* the authorisation, checked server-side by the Worker. The Worker only ever writes to `assets/` and `media/playlist.json`, so a leaked login can't touch the site's code. Change the password by updating `ADMIN_PASS` (and the hashes in `admin.js`, which still guard the UI when no proxy is configured).

## Run locally

Open `index.html` directly and the `fetch()` of `playlist.json` will be blocked by CORS, so use a tiny server:

```bash
npx serve .
# or
python -m http.server 8080
```

## Deploy to GitHub Pages

Push the repo, then **Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`**.
`.nojekyll` is included so files/folders starting with `_` are served correctly.

> GitHub repos have a soft limit of ~1 GB and a 100 MB per-file cap (the dashboard refuses anything larger). For large libraries, host the media elsewhere and put absolute URLs in `playlist.json`.

## Features

Playlist with search, shuffle, repeat, seek bar, volume/mute, keyboard shortcuts, OS media keys (Media Session API), auto-advance, and remembered volume/last track via `localStorage`.

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Previous / next |
| `↑` / `↓` | Volume |
| `M` | Mute |
| `S` | Shuffle |
| `R` | Repeat |
| `F` | Fullscreen |

## Layout

```
index.html            player markup
admin.html            dashboard markup
config.js             public settings (proxy URL)
style.css             player styles
admin.css             dashboard styles
app.js                player logic
admin.js              dashboard logic
media/playlist.json   the playlist manifest
assets/               videos + thumbs/
tools/build-playlist.js   regenerates the manifest from media/ and assets/
tools/worker.js           Cloudflare Worker for token-free uploads
```

#!/usr/bin/env node
/*
 * Scans media/ and writes media/playlist.json.
 * Usage:  node tools/build-playlist.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Folders scanned for playable files, relative to the repo root.
const SCAN_DIRS = ['media', 'assets'];
const OUT = path.join(ROOT, 'media', 'playlist.json');

const EXT = new Set(['.mp4', '.webm', '.ogv', '.m4v', '.mov', '.mp3', '.m4a', '.ogg', '.wav', '.flac', '.opus']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

function title(file) {
  return path.basename(file, path.extname(file)).replace(/[_-]+/g, ' ').trim();
}

const found = SCAN_DIRS
  .map((d) => path.join(ROOT, d))
  .filter((d) => fs.existsSync(d))
  .flatMap((d) => walk(d));

if (!found.length) {
  console.error('No playable files found in: ' + SCAN_DIRS.join(', '));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// Keep any titles/artists that were edited by hand in the existing manifest.
let existing = new Map();
if (fs.existsSync(OUT)) {
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (Array.isArray(prev)) {
      for (const t of prev) if (t && typeof t === 'object' && t.src) existing.set(t.src, t);
    }
  } catch { /* malformed manifest -> rebuild from scratch */ }
}

const tracks = found
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  .map((file) => {
    const src = path.relative(ROOT, file).split(path.sep).map(encodeURIComponent).join('/');
    const prev = existing.get(src);
    const track = { src, title: (prev && prev.title) || title(file) };
    if (prev && prev.artist) track.artist = prev.artist;
    if (prev && prev.poster) track.poster = prev.poster;
    return track;
  });

fs.writeFileSync(OUT, JSON.stringify(tracks, null, 2) + '\n');
console.log(`Wrote ${tracks.length} track(s) to ${path.relative(ROOT, OUT)}`);

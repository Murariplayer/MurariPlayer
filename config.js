/*
 * Public settings for the dashboard — no secrets belong in this file.
 *
 * proxy: URL of your upload Worker (see tools/worker.js). When it is set, the
 *        dashboard signs in against the Worker and never handles a GitHub token,
 *        so a non-technical person can upload videos with just the login.
 *        Leave it empty to fall back to pasting a token yourself.
 */
window.MURARI_CONFIG = {
  proxy: 'https://murariupload.murariplayer.workers.dev'
};

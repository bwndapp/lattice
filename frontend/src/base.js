/** Where this page is mounted, decided in the browser: '' live, '/preview' for the draft,
 *  '/multiplayer' for a branch hosted beside them to try out.
 *
 *  bwnd-publish copies the draft build to the live site unchanged, so one build must work
 *  at both paths (index.html sets a matching <base href> for the asset URLs).
 *
 *  The multiplayer mount is a tryout, not an environment. Two things make it odd, and both
 *  are on purpose:
 *
 *  · it is entered at /multiplayer.html, a real file, because the server serves a folder's
 *    index only for the two mounts it knows about — everything else falls through to the
 *    live page. Its assets still live in /multiplayer/, which is what BASE points at.
 *  · it talks to the DRAFT's api and database (API_ROOT), because that's where the routes
 *    it needs are and where the tracks being worked on live. */
const mount = /^\/(preview|multiplayer)(\/|$|\.html)/.exec(window.location.pathname)
export const BASE = mount ? `/${mount[1]}` : ''
export const API_ROOT = BASE === '/multiplayer' ? '/preview/api' : `${BASE}/api`
/** A link to this app: the page itself, not the folder it keeps its assets in. */
export const HOME = BASE === '/multiplayer' ? '/multiplayer.html' : `${BASE}/`

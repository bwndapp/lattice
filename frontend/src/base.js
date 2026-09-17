/** Where this page is mounted, decided in the browser: '' live, '/preview' for the draft,
 *  '/multiplayer' for a branch served beside them to try out (src/api/multiplayer.py).
 *
 *  bwnd-publish copies the draft build to the live site unchanged, so one build must work
 *  at both paths (index.html sets a matching <base href> for the asset URLs).
 *
 *  The multiplayer mount is a tryout, not an environment: it talks to the DRAFT's api and
 *  database, because that's where the routes it needs are and where the tracks being
 *  worked on live. API_ROOT is the only place the two differ. */
const mount = /^\/(preview|multiplayer)(\/|$)/.exec(window.location.pathname)
export const BASE = mount ? `/${mount[1]}` : ''
export const API_ROOT = BASE === '/multiplayer' ? '/preview/api' : `${BASE}/api`

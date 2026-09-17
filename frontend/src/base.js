/** Where this page is mounted, decided in the browser: '' live, '/preview' for the draft,
 *  '/multiplayer' for a branch served beside them to try out (src/api/multiplayer.py).
 *
 *  bwnd-publish copies the draft build to the live site unchanged, so one build must work
 *  at both paths (index.html sets a matching <base href> for the asset URLs).
 *
 *  The multiplayer mount is a tryout, not an environment. It works on the DRAFT's tracks
 *  and database (API_ROOT), because that's the work in progress — but its room comes from
 *  the branch itself (COLLAB_ROOT), so trying a branch out never puts a file of its own in
 *  the folder the draft and live sites share. */
/** Everywhere this app is served from other than the live site itself. */
export const MOUNTS = ['/preview', '/multiplayer']
const at = (path, m) => path === m || path.startsWith(`${m}/`)
export const BASE = MOUNTS.find((m) => at(window.location.pathname, m)) ?? ''
/** Whether a path belongs to some other mount than the one this page was served from. */
export const elsewhere = (path) => (BASE ? !at(path, BASE) : MOUNTS.some((m) => at(path, m)))
export const API_ROOT = BASE === '/multiplayer' ? '/preview/api' : `${BASE}/api`
/** The room lives with the branch, not with the draft: a branch serves its own (src/api/multiplayer.py). */
export const COLLAB_ROOT = BASE === '/multiplayer' ? '/multiplayer/api/collab' : `${API_ROOT}/collab`

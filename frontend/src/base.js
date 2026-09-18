/** Where this page is mounted, decided in the browser: '/preview' for the draft, '' live.
 *  bwnd-publish copies the draft build to the live site unchanged, so one build must
 *  work at both paths (index.html sets a matching <base href> for the asset URLs). */
/** Everywhere this app is served from other than the live site itself. */
export const MOUNTS = ['/preview']
const at = (path, m) => path === m || path.startsWith(`${m}/`)
export const BASE = MOUNTS.find((m) => at(window.location.pathname, m)) ?? ''
/** Whether a path belongs to some other mount than the one this page was served from. */
export const elsewhere = (path) => (BASE ? !at(path, BASE) : MOUNTS.some((m) => at(path, m)))
export const API_ROOT = `${BASE}/api`
/** The room is an ordinary route now, beside the others (src/api/collab.py). */
export const COLLAB_ROOT = `${API_ROOT}/collab`

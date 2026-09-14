/** Where this page is mounted, decided in the browser: '/preview' for the draft, '' live.
 *  bwnd-publish copies the draft build to the live site unchanged, so one build must
 *  work at both paths (index.html sets a matching <base href> for the asset URLs). */
export const BASE = /^\/preview(\/|$)/.test(window.location.pathname) ? '/preview' : ''

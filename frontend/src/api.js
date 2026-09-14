import { authFetch } from './bwnd'
import { BASE } from './base'

/** JSON call to this app's API. Throws Error(message) on a non-2xx answer. */
export async function api(path, { method = 'GET', body } = {}) {
  const r = await authFetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await r.json() } catch { /* empty body */ }
  if (!r.ok) {
    const err = new Error(data?.error || `request failed (${r.status})`)
    err.status = r.status
    throw err
  }
  return data
}

/** Local, per-track unsaved edits ("new" = the scratch pad at /). */
const draftKey = (id) => `strudel:draft:${id || 'new'}`
export function readDraft(id) {
  try { return localStorage.getItem(draftKey(id)) } catch { return null }
}
export function writeDraft(id, code) {
  try { localStorage.setItem(draftKey(id), code) } catch { /* storage unavailable */ }
}
export function clearDraft(id) {
  try { localStorage.removeItem(draftKey(id)) } catch { /* storage unavailable */ }
}

export function timeAgo(seconds) {
  const s = Math.max(0, Date.now() / 1000 - seconds)
  if (s < 60) return 'just now'
  const steps = [[60, 'm'], [3600, 'h'], [86400, 'd'], [604800, 'w'], [2629800, 'mo'], [31557600, 'y']]
  let label = ''
  for (const [size, unit] of steps) if (s >= size) label = `${Math.floor(s / size)}${unit}`
  return `${label} ago`
}

/** Public link for a track (live: /t/id, draft: /preview/t/id). */
export function trackUrl(id) {
  return `${window.location.origin}${BASE}/t/${id}`
}

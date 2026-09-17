import { authFetch } from './bwnd'
import { BASE, HOME } from './base'

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

/**
 * Local, per-track unsaved edits ("new" = the scratch pad at /). The draft site at
 * /preview/ and the live site share this browser storage (same origin) but not their
 * tracks (separate databases), so each keeps its own drafts. A track's draft remembers
 * which saved version it was edited from: once that track has been saved again since
 * (here or anywhere else), the saved version wins over the older draft.
 */
const draftKey = (id) => `strudel:${BASE ? `${BASE.slice(1)}:` : ''}draft:${id || 'new'}`
export function readDraft(id, savedAt = null) {
  let raw = null
  try { raw = localStorage.getItem(draftKey(id)) } catch { return null }
  if (raw == null) return null
  if (!raw.startsWith('{"lattice-draft":1')) return savedAt == null ? raw : null // from before drafts knew their version
  try {
    const d = JSON.parse(raw)
    if (savedAt != null && (d.base ?? 0) < savedAt) return null
    return typeof d.code === 'string' ? d.code : null
  } catch { return null }
}
export function writeDraft(id, code, savedAt = null) {
  const value = savedAt == null ? code : JSON.stringify({ 'lattice-draft': 1, base: savedAt, code })
  try { localStorage.setItem(draftKey(id), value) } catch { /* storage unavailable */ }
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

/** Public link for a track (live: /t/id, draft: /preview/#/t/id). */
export function trackUrl(id) {
  return BASE ? `${window.location.origin}${HOME}#/t/${id}` : `${window.location.origin}/t/${id}`
}

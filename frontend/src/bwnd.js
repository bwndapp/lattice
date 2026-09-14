/**
 * bwnd sign-in for this app. One blue wind account for every app.
 *
 *   import { login, logout, useUser } from './bwnd'
 *   const { user, loading } = useUser()      // null when signed out
 *   <button onClick={() => login()}>Sign in</button>
 *
 * Standard OpenID Connect with PKCE against the platform issuer. This app is
 * already registered as a client (client id = the incubator id); the values
 * below are baked in at build time from the container's env. Tokens live in
 * sessionStorage for this tab. The access token says who the person is; send it as `Authorization: Bearer` to your own API and
 * verify it there with incubator_lib.sso_user().
 */
import { useEffect, useState } from 'react'
import { BASE } from './base'

const ISSUER = (import.meta.env.VITE_BWND_SSO_ISSUER || '').replace(/\/$/, '')
const CLIENT_ID = import.meta.env.VITE_BWND_SSO_CLIENT_ID || ''
const CALLBACK_PATH = '/auth/callback'
const KEY = 'bwnd_sso_tokens'
const PKCE_KEY = 'bwnd_sso_pkce'

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const rand = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)))
async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))) }
const decode = (jwt) => { try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) } catch { return null } }

function read() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null') } catch { return null } }
function write(t) { try { t ? sessionStorage.setItem(KEY, JSON.stringify(t)) : sessionStorage.removeItem(KEY) } catch { /* ignore */ } }

export function configured() { return !!(ISSUER && CLIENT_ID) }

/** Send the browser to the platform sign-in. Returns instantly when the user
 *  is already signed in to any blue wind app. `next` is where to land after. */
export async function login(next = window.location.pathname + window.location.search) {
  if (!configured()) throw new Error('bwnd SSO is not configured for this app')
  const verifier = rand(48)
  const state = rand(16)
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, next }))
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: window.location.origin + CALLBACK_PATH,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
  })
  window.location.assign(`${ISSUER}/authorize?${q}`)
}

/** Finish the redirect. Call once on the /auth/callback route; resolves to
 *  the path to navigate to. */
export async function handleCallback() {
  const q = new URLSearchParams(window.location.search)
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null')
  sessionStorage.removeItem(PKCE_KEY)
  if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'))
  if (!saved || q.get('state') !== saved.state) throw new Error('sign-in state mismatch')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: q.get('code') || '',
    redirect_uri: window.location.origin + CALLBACK_PATH,
    client_id: CLIENT_ID,
    code_verifier: saved.verifier,
  })
  // A network failure here is what a person sees when the issuer cannot be
  // reached (or refuses the origin); the browser's own "Failed to fetch" is
  // meaningless to them, so say what actually happened.
  let r
  try {
    r = await fetch(`${ISSUER}/token`, { method: 'POST', body })
  } catch {
    throw new Error("Couldn't reach blue wind to finish signing in. Check your connection and try again.")
  }
  if (!r.ok) {
    let why = ''
    try { why = (await r.json()).error_description || '' } catch { /* not JSON */ }
    throw new Error(why ? `Blue wind refused the sign-in: ${why}` : "Blue wind couldn't finish the sign-in. Try again.")
  }
  const t = await r.json()
  write({ ...t, obtained_at: Date.now() })
  return saved.next || '/'
}

async function refresh() {
  const t = read()
  if (!t?.refresh_token) return null
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: CLIENT_ID })
  let r
  try { r = await fetch(`${ISSUER}/token`, { method: 'POST', body }) } catch { return null }   // offline: keep the session
  if (!r.ok) { write(null); return null }
  const n = await r.json()
  write({ ...n, obtained_at: Date.now() })
  return n
}

/** A valid access token, refreshing when it is within a minute of expiry. */
export async function getToken() {
  const t = read()
  if (!t?.access_token) return null
  const claims = decode(t.access_token)
  if (claims?.exp && claims.exp * 1000 - Date.now() < 60_000) {
    const n = await refresh()
    return n?.access_token || null
  }
  return t.access_token
}

/** The signed-in user (id, email, name, role for platform staff), or null. */
export function currentUser() {
  const t = read()
  const c = t?.access_token ? decode(t.access_token) : null
  if (!c) return null
  return { id: c.sub, email: c.email, name: c.name, givenName: c.given_name, familyName: c.family_name, role: c.role }
}

/** Where THIS build's API lives: `/api` in the live build, `/preview/api` in
 *  the draft build (the draft has its own routes and its own database, see the
 *  box's CLAUDE.md). `apiUrl('/api/orders')` returns the right one; authFetch
 *  applies it for you. */
export const API_BASE = `${BASE}/api`
export function apiUrl(path) { return typeof path === 'string' && (path === '/api' || path.startsWith('/api/')) ? API_BASE + path.slice(4) : path }

/** fetch() with the bearer token attached. A 401 from your own API means the
 *  sign-in is gone (signed out elsewhere, or revoked by an admin): the local
 *  tokens are dropped so the UI stops claiming a user. */
export async function authFetch(url, opts = {}) {
  const tok = await getToken()
  const headers = { ...(opts.headers || {}) }
  if (tok) headers.Authorization = `Bearer ${tok}`
  const r = await fetch(apiUrl(url), { ...opts, headers })
  if (r.status === 401 && tok) { write(null); notify() }
  return r
}

/** Ask the issuer whether this sign-in is still alive. Resolves to the user
 *  or null, and clears local tokens when the answer is no. Cheap; called on
 *  load, when the tab comes back into view, and once a minute. */
export async function checkSession() {
  const tok = await getToken()
  if (!tok) return null
  try {
    const r = await fetch(`${ISSUER}/userinfo`, { headers: { Authorization: `Bearer ${tok}` } })
    if (r.status === 401) { write(null); notify(); return null }
  } catch { /* offline: keep what we have */ }
  return currentUser()
}

const listeners = new Set()
function notify() { listeners.forEach((fn) => { try { fn() } catch { /* ignore */ } }) }

export function logout(next = '/') {
  write(null)
  if (!configured()) { window.location.assign(next); return }
  const q = new URLSearchParams({ client_id: CLIENT_ID, post_logout_redirect_uri: window.location.origin + next })
  window.location.assign(`${ISSUER}/logout?${q}`)
}

/** React hook: { user, loading, login, logout }. Re-checks the sign-in with
 *  the issuer on load, when the tab is shown again, and every minute, so a
 *  sign-out elsewhere (or an admin's "sign out everywhere") shows here within
 *  a minute instead of when the token happens to expire. */
export function useUser() {
  const [user, setUser] = useState(() => currentUser())
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    const sync = () => { if (alive) setUser(currentUser()) }
    listeners.add(sync)
    checkSession().then(() => { if (alive) { setUser(currentUser()); setLoading(false) } })
    const onShow = () => { if (document.visibilityState === 'visible') checkSession().then(sync) }
    document.addEventListener('visibilitychange', onShow)
    const timer = setInterval(() => checkSession().then(sync), 60_000)
    return () => { alive = false; listeners.delete(sync); document.removeEventListener('visibilitychange', onShow); clearInterval(timer) }
  }, [])
  return { user, loading, login, logout }
}

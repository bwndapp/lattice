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
 * localStorage, so the sign-in survives new tabs and coming back later (the refresh
 * token keeps it going); a first visit also signs in silently when the person is
 * already signed in to blue wind. The access token says who the person is; send it as `Authorization: Bearer` to your own API and
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

const SILENT_KEY = 'bwnd_sso_silent_tried'
const SCOPE = 'openid profile email offline_access'

function read() {
  try {
    const kept = localStorage.getItem(KEY)
    if (kept) return JSON.parse(kept)
    // sign-ins from before tokens were kept across tabs
    const old = sessionStorage.getItem(KEY)
    if (old) { localStorage.setItem(KEY, old); sessionStorage.removeItem(KEY); return JSON.parse(old) }
  } catch { /* storage unavailable */ }
  return null
}
function write(t) { try { t ? localStorage.setItem(KEY, JSON.stringify(t)) : localStorage.removeItem(KEY) } catch { /* ignore */ } }

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
    scope: SCOPE,
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: 'S256',
  })
  window.location.assign(`${ISSUER}/authorize?${q}`)
}

/** Finish the redirect. Call once on the /auth/callback route; resolves to
 *  the path to navigate to. */
export async function handleCallback() {
  // a silent sign-in lands here inside a hidden frame; the page that opened it takes the code
  if (window.top !== window) return new Promise(() => {})
  const q = new URLSearchParams(window.location.search)
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || 'null')
  sessionStorage.removeItem(PKCE_KEY)
  if (q.get('error')) throw new Error(q.get('error_description') || q.get('error'))
  if (!saved || q.get('state') !== saved.state) throw new Error('sign-in state mismatch')
  write(await exchange(q.get('code') || '', saved.verifier))
  return saved.next || '/'
}

/** Trade an authorization code for tokens. */
async function exchange(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: window.location.origin + CALLBACK_PATH,
    client_id: CLIENT_ID,
    code_verifier: verifier,
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
  return { ...t, obtained_at: Date.now() }
}

/**
 * Sign in without a click when the person is already signed in to blue wind: the
 * authorize page runs with prompt=none in a hidden frame and comes straight back to
 * our callback with a code (or login_required). Same site as the issuer, so its
 * session cookie goes along. Resolves to the user, or null. Tried once per tab.
 */
export function silentLogin({ timeout = 6000 } = {}) {
  if (!configured() || read()?.access_token || window.top !== window) return Promise.resolve(currentUser())
  try {
    if (sessionStorage.getItem(SILENT_KEY)) return Promise.resolve(null)
    sessionStorage.setItem(SILENT_KEY, '1')
  } catch { /* storage unavailable: try anyway */ }
  return new Promise((resolve) => {
    const verifier = rand(48)
    const state = rand(16)
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    let done = false
    let poll = null
    let timer = null
    const finish = (user) => {
      if (done) return
      done = true
      clearInterval(poll)
      clearTimeout(timer)
      frame.remove()
      resolve(user)
    }
    poll = setInterval(async () => {
      let href
      try { href = frame.contentWindow.location.href } catch { return } // still on the issuer
      if (!href.startsWith(window.location.origin + CALLBACK_PATH)) return
      clearInterval(poll)
      try { frame.contentWindow.stop() } catch { /* ignore */ }
      const q = new URL(href).searchParams
      if (q.get('state') !== state || !q.get('code')) return finish(null) // login_required: not signed in
      try {
        write(await exchange(q.get('code'), verifier))
        notify()
        finish(currentUser())
      } catch {
        finish(null)
      }
    }, 50)
    timer = setTimeout(() => finish(null), timeout)
    sha256(verifier).then((challenge) => {
      const q = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: window.location.origin + CALLBACK_PATH,
        response_type: 'code',
        scope: SCOPE,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'none',
      })
      frame.src = `${ISSUER}/authorize?${q}`
      document.body.appendChild(frame)
    })
  })
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
    checkSession()
      .then((u) => u ?? silentLogin())
      .then(() => { if (alive) { setUser(currentUser()); setLoading(false) } })
    // signing in or out in another tab
    const onStorage = (e) => { if (e.key === KEY) sync() }
    window.addEventListener('storage', onStorage)
    const onShow = () => { if (document.visibilityState === 'visible') checkSession().then(sync) }
    document.addEventListener('visibilitychange', onShow)
    const timer = setInterval(() => checkSession().then(sync), 60_000)
    return () => { alive = false; listeners.delete(sync); window.removeEventListener('storage', onStorage); document.removeEventListener('visibilitychange', onShow); clearInterval(timer) }
  }, [])
  return { user, loading, login, logout }
}

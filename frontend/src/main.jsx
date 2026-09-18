import React from 'react'
import ReactDOM from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, HashRouter, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom'
import App from './App.jsx'
import { handleCallback } from './bwnd'
import { BASE, elsewhere } from './base'
import './index.css'

/*
 * Sign-in may only come back to an https address, so a page opened over http can't start
 * one — the sign-in page turns it away with "bad redirect" before you ever see it. Move
 * to https first, before anything reads the address it's on.
 */
if (window.location.protocol === 'http:' && !/^(localhost$|127\.|0\.0\.0\.0$|\[)/.test(window.location.hostname)) {
  window.location.replace(window.location.href.replace(/^http:/, 'https:'))
}

// Where bwnd sign-in lands after the user authenticates. Keep this route.
function AuthCallback() {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const ran = useRef(false)
  useEffect(() => {
    if (ran.current) return // the code can only be exchanged once
    ran.current = true
    handleCallback()
      .then((next) => {
        // Sign-in always returns to /auth/callback on the live site; `next` may belong to
        // another mount — the draft under /preview/ — which this router (basename '')
        // can't reach, so the browser has to go there itself.
        if (elsewhere(next)) window.location.replace(next)
        else navigate(next.slice(BASE.length) || '/', { replace: true })
      })
      .catch((e) => setError(e.message))
  }, [navigate])
  return (
    <main className="page">
      {error ? <p>Sign-in failed: {error}. <Link className="link" to="/">Home</Link></p> : <p>Signing you in…</p>}
    </main>
  )
}

// The preview's server only serves /preview/ itself (a reload of /preview/t/abc is a 404),
// so the draft keeps its routes after a # (/preview/#/t/abc). Live has real paths.
const Router = BASE ? HashRouter : BrowserRouter

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Router {...(BASE ? {} : { basename: BASE })}>
      <Routes>
        {/* One layout route so the editor (and whatever is playing) survives navigation. */}
        <Route element={<App />}>
          <Route path="/" element={null} />
          <Route path="/t/:id" element={null} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
      </Routes>
    </Router>
  </React.StrictMode>,
)

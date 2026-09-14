import React from 'react'
import ReactDOM from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { BrowserRouter, Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom'
import App from './App.jsx'
import { handleCallback } from './bwnd'
import './index.css'

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
        // Sign-in always returns to /auth/callback on the live build; `next` may be a
        // draft page under /preview/, which this router (basename '') can't reach.
        const base = import.meta.env.BASE_URL.replace(/\/$/, '')
        const inThisBuild = base ? next.startsWith(`${base}/`) : !next.startsWith('/preview')
        if (!inThisBuild) window.location.replace(next)
        else navigate(next.slice(base.length) || '/', { replace: true })
      })
      .catch((e) => setError(e.message))
  }, [navigate])
  return (
    <main className="page">
      {error ? <p>Sign-in failed: {error}. <Link className="link" to="/">Home</Link></p> : <p>Signing you in…</p>}
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Routes>
        {/* One layout route so the editor (and whatever is playing) survives navigation. */}
        <Route element={<App />}>
          <Route path="/" element={null} />
          <Route path="/t/:id" element={null} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)

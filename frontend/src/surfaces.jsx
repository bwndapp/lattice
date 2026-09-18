/**
 * Everyone's pointer, everywhere in the app — not only on the three surfaces that have a
 * coordinate system of their own.
 *
 * The patch canvas, the timeline lanes and the piano roll each report their pointer in
 * their own units (flow x/y, bars and lanes, bars and notes), because those have to follow
 * pan, zoom and scroll to land in the same place at the other end. Everywhere else — the
 * header, the browser, the dock, the code editor, a dialog — there is nothing to follow,
 * and until now there was nothing at all: someone reaching for save simply stopped
 * existing, which reads as a bug rather than as a boundary.
 *
 * So every other region says where it is by name, and a pointer inside it travels as a
 * fraction of that region's box:
 *
 *   <header data-surface="header">   this region reports itself, by that name
 *   <div data-surface-own>           this subtree reports for itself; hands off
 *
 * A fraction rather than pixels, because the person at the other end has a different
 * window: 0.42 across the header is the same button at any width, and 340px is not.
 *
 * The two markers compose, because the nearest one wins. The patch panel is marked own —
 * react flow reports the canvas — while the toolbar sitting on top of it is a named
 * surface, so a cursor crossing from the canvas to the flow switch stays in sight the
 * whole way.
 *
 *   watchPointer()   one listener for the whole app; returns a function that removes it
 *   <AppCursors />   draws everyone whose surface is one of the named ones
 *
 * The room knows none of this. `where` has always been an opaque name and x/y opaque
 * numbers (collab.py), so the protocol doesn't change at all.
 */
import { useEffect, useState } from 'react'
import { pointerAt, pointerGone, usePeers } from './collab.js'
import { PeerDot } from './PeerCursors.jsx'

const EITHER = '[data-surface],[data-surface-own]'

/** The named region a pointer is in, or null when it belongs to one that speaks for itself. */
function surfaceOf(target) {
  if (!(target instanceof Element)) return null
  const el = target.closest(EITHER)
  return !el || el.hasAttribute('data-surface-own') ? null : el
}

/** Follow the pointer across the whole app. Call once; nothing goes out while alone. */
export function watchPointer() {
  const move = (e) => {
    const el = surfaceOf(e.target)
    if (!el) return // a surface that reports itself, or somewhere unmarked
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) return
    pointerAt(el.dataset.surface, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  }
  // the pointer leaving the window altogether is the one departure nothing else notices
  const out = (e) => { if (!e.relatedTarget) pointerGone() }
  document.addEventListener('pointermove', move, { passive: true })
  document.addEventListener('pointerout', out, { passive: true })
  return () => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerout', out)
  }
}

/**
 * Everyone whose pointer is in a named region, drawn over the app in one fixed layer.
 *
 * A surface this window doesn't have open — someone in the piano roll while we're on the
 * patch — simply isn't found, and nothing is drawn for them. The surfaces that report in
 * their own units aren't found either, because they draw their own cursors in place.
 */
export function AppCursors() {
  const peers = usePeers()
  const [, again] = useState(0)
  // a region can move without any pointer moving: a scroll, a resize, a panel opening
  useEffect(() => {
    const nudge = () => again((n) => n + 1)
    window.addEventListener('resize', nudge)
    window.addEventListener('scroll', nudge, true)
    return () => {
      window.removeEventListener('resize', nudge)
      window.removeEventListener('scroll', nudge, true)
    }
  }, [])

  const shown = []
  for (const p of peers) {
    if (!p.at?.where) continue
    const el = document.querySelector(`[data-surface="${CSS.escape(p.at.where)}"]`)
    if (!el) continue
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    shown.push({ p, left: r.left + p.at.x * r.width, top: r.top + p.at.y * r.height })
  }
  if (!shown.length) return null
  return (
    <div className="app-cursors" aria-hidden>
      {shown.map(({ p, left, top }) => <PeerDot key={p.id} peer={p} left={left} top={top} />)}
    </div>
  )
}

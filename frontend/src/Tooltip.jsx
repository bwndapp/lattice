import { useEffect, useRef, useState } from 'react'
import './Tooltip.css'

const DELAY = 340 // ms of hovering before it says anything
const GAP = 8 // px between the thing and its tip

/**
 * One tooltip for the whole app. Anything can ask for one by carrying `data-tip="…"` —
 * no state, no wrapper component, nothing to import where it's used. Mounted once by
 * App; a single listener watches for hovering and focusing.
 *
 * It's here so a control can explain itself when you ask instead of a paragraph of hint
 * text sitting next to it forever.
 */
export default function Tooltip() {
  const [tip, setTip] = useState(null) // { text, x, y, above }
  const timer = useRef(0)
  const box = useRef(null)

  useEffect(() => {
    let host = null
    const hide = () => { clearTimeout(timer.current); host = null; setTip(null) }
    const place = (el, text) => {
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom
      const above = below < 90 && r.top > 90
      setTip({ text, x: Math.round(r.left + r.width / 2), y: Math.round(above ? r.top - GAP : r.bottom + GAP), above })
    }
    const over = (e) => {
      if (e.pointerType === 'touch') return
      const el = e.target.closest?.('[data-tip]')
      if (el === host) return
      clearTimeout(timer.current)
      host = el
      if (!el) return setTip(null)
      const text = el.getAttribute('data-tip')
      if (!text) return setTip(null)
      // once one is up the rest come straight away, the way a menu bar behaves
      timer.current = setTimeout(() => place(el, text), DELAY)
    }
    const focus = (e) => {
      const el = e.target.closest?.('[data-tip]')
      if (!el || !el.matches(':focus-visible')) return
      host = el
      place(el, el.getAttribute('data-tip'))
    }
    window.addEventListener('pointerover', over, true)
    window.addEventListener('pointerdown', hide, true)
    window.addEventListener('focusin', focus, true)
    window.addEventListener('focusout', hide, true)
    window.addEventListener('keydown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      clearTimeout(timer.current)
      window.removeEventListener('pointerover', over, true)
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('focusin', focus, true)
      window.removeEventListener('focusout', hide, true)
      window.removeEventListener('keydown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // kept on screen: a tip near the right edge slides back rather than running off it
  useEffect(() => {
    const el = box.current
    if (!el || !tip) return
    const r = el.getBoundingClientRect()
    const over = r.right - (window.innerWidth - 8)
    const under = 8 - r.left
    const shift = over > 0 ? -over : under > 0 ? under : 0
    el.style.setProperty('--shift', `${Math.round(shift)}px`)
  }, [tip])

  if (!tip) return null
  return (
    <div
      ref={box}
      className={`tip ${tip.above ? 'above' : ''}`}
      role="tooltip"
      style={{ left: tip.x, top: tip.y }}
    >{tip.text}</div>
  )
}

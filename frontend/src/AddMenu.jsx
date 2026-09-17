import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './AddMenu.css'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Right-click on the patch, or Shift + A: an add menu at the pointer. Groups open into their items
 * (hover, click or arrow right); typing searches everything at once. Enter or a click
 * adds the item where you right-clicked. Esc, a click outside or scrolling closes it.
 *
 * `items` and `score` come from the add pane, so both always offer the same things; where the
 * menu was opened (`context`) narrows them to what can go there.
 */
export default function AddMenu({ x, y, items, groups, score, onPick, onClose, context = null }) {
  const ref = useRef(null)
  const searchRef = useRef(null)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState(null) // open group key
  const [cursor, setCursor] = useState({ col: 'groups', index: 0 })
  const [pos, setPos] = useState({ left: x, top: y })

  const recent = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('strudel:palette:recent')) ?? [] } catch { return [] }
  }, [])
  const inGroup = (key) => (key === 'recent'
    ? recent.map((id) => items.find((it) => it.id === id)).filter(Boolean)
    : items.filter((it) => it.group === key))
  const shownGroups = groups.filter(([key]) => inGroup(key).length)

  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const results = tokens.length
    ? items.map((it) => ({ it, s: score(it, tokens) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).map((r) => r.it)
    : null
  const openItems = group ? inGroup(group) : []

  useEffect(() => { searchRef.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => setCursor(results ? { col: 'results', index: 0 } : { col: 'groups', index: 0 }), [query]) // eslint-disable-line react-hooks/exhaustive-deps

  // keep the menu (and its flyout) on screen
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: clamp(x, 8, window.innerWidth - r.width - 8), top: clamp(y, 8, window.innerHeight - r.height - 8) })
  }, [x, y, group, query])

  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onWheel = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('wheel', onWheel, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  useEffect(() => {
    ref.current?.querySelector('.am-row.cursor')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, group])

  const pick = (item) => {
    try {
      localStorage.setItem('strudel:palette:recent', JSON.stringify([item.id, ...recent.filter((id) => id !== item.id)].slice(0, 6)))
    } catch { /* storage unavailable */ }
    onPick(item)
    onClose()
  }

  const onKey = (e) => {
    e.stopPropagation() // keep Delete, space and friends away from the canvas and transport
    const col = cursor.col
    const list = col === 'results' ? results ?? [] : col === 'items' ? openItems : shownGroups
    if (e.key === 'Escape') { e.preventDefault(); return group && col === 'items' ? (setGroup(null), setCursor({ col: 'groups', index: shownGroups.findIndex(([k]) => k === group) })) : onClose() }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const index = list.length ? (cursor.index + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length : 0
      setCursor({ col, index })
      if (col === 'groups' && shownGroups[index]) setGroup(shownGroups[index][0])
      return
    }
    if (e.key === 'ArrowRight' && col === 'groups' && !results) {
      e.preventDefault()
      const key = shownGroups[cursor.index]?.[0]
      if (key) { setGroup(key); setCursor({ col: 'items', index: 0 }) }
      return
    }
    if (e.key === 'ArrowLeft' && col === 'items') {
      e.preventDefault()
      setCursor({ col: 'groups', index: Math.max(0, shownGroups.findIndex(([k]) => k === group)) })
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (col === 'groups') {
        const key = shownGroups[cursor.index]?.[0]
        if (key) { setGroup(key); setCursor({ col: 'items', index: 0 }) }
      } else if (list[cursor.index]) pick(list[cursor.index])
    }
  }

  // a plain function, not a component: rows must keep their DOM node while the cursor moves
  const row = (item, index, col) => (
    <button
      key={item.id}
      type="button"
      role="menuitem"
      className={`am-row am-${item.group} ${cursor.col === col && cursor.index === index ? 'cursor' : ''}`}
      title={item.blurb}
      onPointerEnter={() => setCursor((c) => (c.col === col && c.index === index ? c : { col, index }))}
      onClick={() => pick(item)}
    >
      <span className="am-label">{item.label}</span>
      <span className="am-blurb">{item.blurb}</span>
    </button>
  )

  return (
    <div
      ref={ref}
      className="add-menu"
      style={pos}
      role="menu"
      aria-label="Add a node"
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="am-main">
        <div className="am-head">
          <span className="am-title">add{context === 'wire' ? ' into this wire' : context === 'after' ? ' onto this wire' : context === 'before' ? ' into this input' : ''}<kbd className="am-kbd">shift A</kbd></span>
          <input
            ref={searchRef}
            className="node-input am-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search"
            aria-label="Search nodes and instruments"
            spellCheck={false}
          />
        </div>
        {results ? (
          <div className="am-list" role="group" aria-label="Results">
            {results.length
              ? results.slice(0, 40).map((item, i) => row(item, i, 'results'))
              : <p className="am-empty">Nothing matches “{query.trim()}”.</p>}
          </div>
        ) : (
          <div className="am-list" role="group" aria-label="Groups">
            {shownGroups.map(([key, label], i) => (
              <button
                key={key}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={group === key}
                className={`am-row am-group ${group === key ? 'open' : ''} ${cursor.col === 'groups' && cursor.index === i ? 'cursor' : ''}`}
                onPointerEnter={() => { setGroup(key); setCursor({ col: 'groups', index: i }) }}
                onClick={() => { setGroup(key); setCursor({ col: 'items', index: 0 }) }}
              >
                <span className="am-label">{label}</span>
                <span className="am-count">{inGroup(key).length} ›</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!results && group && (
        <div className="am-flyout am-list" role="menu" aria-label={shownGroups.find(([k]) => k === group)?.[1]}>
          {openItems.map((item, i) => row(item, i, 'items'))}
        </div>
      )}
    </div>
  )
}

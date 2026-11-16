import { useEffect, useMemo, useRef, useState } from 'react'
import './AddMenu.css'

// each kind of thing wears a tile of its own, the way a launcher shows apps by their icons
const KIND = {
  recent: { glyph: '◷', ink: 'var(--muted)' },
  source: { glyph: '●', ink: 'var(--acid)' },
  instruments: { glyph: '♪', ink: '#b9c96a' },
  machine: { glyph: '⁂', ink: '#ffd23f' },
  transform: { glyph: '↻', ink: '#9fb4ff' },
  effect: { glyph: '∿', ink: '#86d8cc' },
  combine: { glyph: '⊕', ink: '#c8a2ff' },
  output: { glyph: '▶', ink: '#ff8fa3' },
}
const kindOf = (group) => KIND[group] ?? { glyph: '◆', ink: 'var(--muted)' }
const RECENT_KEY = 'strudel:palette:recent'

const Tile = ({ group, big = false }) => {
  const k = kindOf(group)
  return <span className={`am-tile ${big ? 'big' : ''}`} style={{ '--tile': k.ink }} aria-hidden>{k.glyph}</span>
}

/**
 * The add picker: right-click on the patch, Shift + A or Ctrl + Space. A launcher in the
 * middle of the screen, the way a Mac's search is: type and everything that matches comes
 * up, the best match first and the rest by kind, with what the highlighted one does beside
 * the list. Not typing, the kinds are tabs along the top (← → or Tab), recent first.
 * Enter or a click adds it where the picker was opened from. Esc or a click outside closes it.
 *
 * `items` and `score` come from the add pane, so both always offer the same things; where the
 * picker was opened (`context`) narrows them to what can go there. `hint` says where the pick
 * will be wired (Shift + A with a node selected, or the wires the knife crossed).
 */
export default function AddMenu({ items, groups, score, onPick, onClose, context = null, hint = null }) {
  const ref = useRef(null)
  const searchRef = useRef(null)
  const listRef = useRef(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const recent = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) ?? [] } catch { return [] }
  }, [])
  const inGroup = (key) => (key === 'recent'
    ? recent.map((id) => items.find((it) => it.id === id)).filter(Boolean)
    : items.filter((it) => it.group === key && !it.hidden)) // hidden ones: search only
  const tabs = groups.filter(([key]) => inGroup(key).length)
  const [tab, setTab] = useState(() => tabs[0]?.[0] ?? null)

  // what the list shows, as rows: { item } or { head } — headings are skipped by the cursor
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const rows = useMemo(() => {
    if (tokens.length) {
      const hits = items.map((it) => ({ it, s: score(it, tokens) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).map((r) => r.it).slice(0, 60)
      if (!hits.length) return []
      // the best one on its own, then the rest by kind, kinds in the order their best came up
      const out = [{ head: 'top hit' }, { item: hits[0] }]
      const order = []
      for (const it of hits.slice(1)) if (!order.includes(it.group)) order.push(it.group)
      const label = Object.fromEntries(groups)
      for (const g of order) {
        out.push({ head: label[g] ?? g })
        for (const it of hits.slice(1)) if (it.group === g) out.push({ item: it })
      }
      return out
    }
    const list = tab ? inGroup(tab) : []
    return list.flatMap((it, i) => (tab !== 'recent' && it.catLabel && it.catLabel !== list[i - 1]?.catLabel
      ? [{ head: it.catLabel }, { item: it }]
      : [{ item: it }]))
  }, [query, tab, items]) // eslint-disable-line react-hooks/exhaustive-deps
  const picks = rows.filter((r) => r.item).map((r) => r.item)
  const current = picks[Math.min(cursor, picks.length - 1)] ?? null

  useEffect(() => { searchRef.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => setCursor(0), [query, tab])
  useEffect(() => { listRef.current?.querySelector('.am-row.cursor')?.scrollIntoView({ block: 'nearest' }) }, [cursor, rows])

  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const pick = (item) => {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify([item.id, ...recent.filter((id) => id !== item.id)].slice(0, 8)))
    } catch { /* storage unavailable */ }
    onPick(item)
    onClose()
  }
  const stepTab = (d) => {
    if (!tabs.length) return
    const i = tabs.findIndex(([k]) => k === tab)
    setTab(tabs[(i + d + tabs.length) % tabs.length][0])
  }

  const onKey = (e) => {
    e.stopPropagation() // keep Delete, space and friends away from the canvas and transport
    if (e.key === 'Escape' || (e.code === 'Space' && e.ctrlKey)) { e.preventDefault(); return onClose() }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = picks.length
      if (n) setCursor((c) => (Math.min(c, n - 1) + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
      return
    }
    if (!tokens.length && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); return stepTab(e.key === 'ArrowRight' ? 1 : -1) }
    if (e.key === 'Tab') { e.preventDefault(); if (tokens.length) setQuery(''); return stepTab(e.shiftKey ? -1 : 1) }
    if (e.key === 'Enter') { e.preventDefault(); if (current) pick(current) }
  }

  const where = context === 'wire' ? 'into this wire' : context === 'after' ? 'onto this wire' : context === 'before' ? 'into this input' : context === 'knife' ? 'inline' : null
  const groupLabel = Object.fromEntries(groups)
  let index = -1

  return (
    <div className="am-scrim">
      <div
        ref={ref}
        className="add-menu"
        role="dialog"
        aria-label="Add a node"
        onKeyDown={onKey}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="am-search-row">
          <svg className="am-glass" viewBox="0 0 20 20" aria-hidden><circle cx="8.5" cy="8.5" r="5.5" /><path d="M13 13l4.5 4.5" /></svg>
          <input
            ref={searchRef}
            className="am-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={where ? `Add ${where}…` : 'Add anything…'}
            aria-label="Search nodes and instruments"
            aria-controls="am-list"
            spellCheck={false}
            autoComplete="off"
          />
          {where && <span className="am-where">{where}</span>}
        </div>
        {hint && <div className="am-hint">{hint}</div>}

        {!tokens.length && tabs.length > 0 && (
          <div className="am-tabs" role="tablist" aria-label="Kinds">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={`am-tab ${tab === key ? 'on' : ''}`}
                style={{ '--tile': kindOf(key).ink }}
                onPointerDown={(e) => e.preventDefault()} // the search box keeps the keys
                onClick={() => setTab(key)}
              >
                <span className="am-tab-glyph" aria-hidden>{kindOf(key).glyph}</span>
                {label}
                <span className="am-tab-count">{inGroup(key).length}</span>
              </button>
            ))}
          </div>
        )}

        <div className="am-body">
          <div id="am-list" ref={listRef} className="am-list" role="listbox" aria-label="Results">
            {rows.length === 0 && <p className="am-empty">Nothing matches “{query.trim()}”.</p>}
            {rows.map((r, i) => {
              if (r.head) return <div key={`h${i}`} className="am-head" role="presentation">{r.head}</div>
              index += 1
              const at = index
              const item = r.item
              return (
                <button
                  key={`${item.id}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={current === item}
                  className={`am-row ${current === item ? 'cursor' : ''}`}
                  onPointerDown={(e) => e.preventDefault()}
                  onPointerMove={() => { if (cursor !== at) setCursor(at) }}
                  onClick={() => pick(item)}
                >
                  <Tile group={item.group} />
                  <span className="am-label">{item.label}</span>
                  <span className="am-kind">{item.catLabel ?? groupLabel[item.group] ?? ''}</span>
                </button>
              )
            })}
          </div>
          {current && (
            <aside className="am-preview" aria-live="polite">
              <Tile group={current.group} big />
              <h3 className="am-preview-name">{current.label}</h3>
              <p className="am-preview-kind">{[groupLabel[current.group], current.catLabel].filter(Boolean).join(' · ')}</p>
              {current.blurb && <p className="am-preview-blurb">{current.blurb}</p>}
              <p className="am-preview-go"><kbd>↵</kbd> add{where ? ` ${where}` : ''}</p>
            </aside>
          )}
        </div>

        <footer className="am-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          {!tokens.length && <span><kbd>←</kbd><kbd>→</kbd> kind</span>}
          <span><kbd>↵</kbd> add</span>
          <span><kbd>esc</kbd> close</span>
          <span className="am-foot-open"><kbd>ctrl</kbd><kbd>space</kbd> · <kbd>shift</kbd><kbd>A</kbd> · right-click</span>
        </footer>
      </div>
    </div>
  )
}

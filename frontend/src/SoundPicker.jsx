import { useEffect, useMemo, useRef, useState } from 'react'
import { onSoundsChange, previewSound, soundCatalog } from './audio'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/**
 * Browse every loaded sound and pick one. Clicking a sound plays it and puts it on the
 * channel straight away; Enter or a click outside closes. Drum channels browse kits and
 * samples; synth channels browse synths, instruments and (pitched) samples.
 */
export default function SoundPicker({ kind, sound, bank, anchor, onPick, onClose }) {
  const ref = useRef(null)
  const [catalog, setCatalog] = useState(() => soundCatalog())
  useEffect(() => onSoundsChange(() => setCatalog(soundCatalog())), [])

  const tabs = kind === 'drum' ? ['kits', 'samples'] : ['synths', 'instruments', 'samples']
  const [tab, setTab] = useState(kind === 'drum' ? (bank ? 'kits' : 'samples') : 'synths')
  const [query, setQuery] = useState('')
  const [kit, setKit] = useState(() => (bank ? String(bank).toLowerCase() : null))
  const baseSound = String(sound ?? '').split(':')[0].toLowerCase()

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose() }
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } } // the Esc is ours, not the dock's
    window.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const q = query.trim().toLowerCase()
  const match = (s) => !q || s.includes(q)
  const kits = useMemo(() => catalog.kits.filter((k) => match(k.bank) || k.sounds.some((s) => match(s.key))), [catalog, q])
  const currentKit = kits.find((k) => k.bank === kit) ?? kits.find((k) => k.bank === 'rolandtr909') ?? kits[0]
  const list = tab === 'kits' ? (currentKit?.sounds ?? []).filter((s) => !q || match(s.key) || match(currentKit.bank))
    : (catalog[tab] ?? []).filter((s) => match(s.key))

  const choose = (item) => {
    const pick = tab === 'kits' ? { sound: item.key, bank: currentKit.bank } : { sound: item.key, bank: '' }
    previewSound({ s: pick.sound, bank: pick.bank || undefined, note: kind === 'synth' ? 48 : undefined })
    onPick(pick)
  }

  const left = clamp(anchor.x, 12, window.innerWidth - 540)
  const top = clamp(anchor.y + 8, 12, window.innerHeight - 440)
  const loading = !catalog.kits.length && !catalog.samples.length

  return (
    <div className="sound-picker" ref={ref} role="dialog" aria-label="Choose a sound" style={{ left, top }}>
      <div className="sp-head">
        <input
          className="ch-input sp-search"
          autoFocus
          placeholder="search sounds"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (list[0]) choose(list[0])
              else if (q) onPick({ sound: q.replace(/[^\w:.#-]/g, ''), bank: kind === 'drum' ? bank : '' })
              onClose()
            }
          }}
          aria-label="Search sounds"
        />
        <span className="seg">
          {tabs.map((t) => <button key={t} className={`btn ${tab === t ? 'on' : ''}`} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}
        </span>
        <button className="btn ghost" onClick={onClose}>done</button>
      </div>
      {loading ? (
        <p className="sp-empty">Sounds are still loading…</p>
      ) : (
        <div className={`sp-body ${tab === 'kits' ? 'with-kits' : ''}`}>
          {tab === 'kits' && (
            <ul className="sp-list sp-kits" aria-label="Drum kits">
              {kits.map((k) => (
                <li key={k.bank}>
                  <button className={`sp-item ${currentKit?.bank === k.bank ? 'on' : ''}`} onClick={() => setKit(k.bank)}>
                    {k.bank} <span className="sp-count">{k.sounds.length}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <ul className="sp-list" aria-label="Sounds">
            {list.length === 0 && <li className="sp-empty">Nothing matches{q ? ` “${q}”` : ''}.</li>}
            {list.slice(0, 400).map((item) => {
              const selected = item.key === baseSound && (tab !== 'kits' || String(bank).toLowerCase() === currentKit?.bank)
              return (
                <li key={item.key}>
                  <button className={`sp-item ${selected ? 'on' : ''}`} onClick={() => choose(item)} title="Click to hear it and use it">
                    {item.key}{item.count > 1 && <span className="sp-count">{item.count}</span>}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

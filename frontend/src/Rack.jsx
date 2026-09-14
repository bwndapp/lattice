import { useEffect, useRef, useState } from 'react'
import {
  BANKS, DRUM_SOUNDS, INSTRUMENTS, INSTRUMENT_MIME, SYNTH_SOUNDS,
  instrumentChannel, makeChannel, makePattern, midiToNote, newId, noteToMidi, songLength, stepCount,
} from './project'

const mod = (a, n) => ((a % n) + n) % n
const BAR_CHOICES = [1, 2, 3, 4, 6, 8, 12, 16]

/** A text field that applies its value on Enter or blur, not per keystroke (half-typed
 *  notes and effects would otherwise regenerate broken code while you type). */
function CommitInput({ value, onCommit, ...props }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  const commit = () => { if (text !== value) onCommit(text) }
  return (
    <input
      {...props}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); e.currentTarget.blur() }
        if (e.key === 'Escape') { setText(value); e.currentTarget.blur() }
      }}
    />
  )
}

/** Resize a step array when a pattern's bars or steps-per-bar change. */
function resample(steps, from, to) {
  const out = Array.from({ length: to.bars * to.stepsPerBar }, () => null)
  const ratio = from.stepsPerBar / to.stepsPerBar
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio
    if (!Number.isInteger(src)) continue
    // new bars beyond the old length repeat the existing ones
    out[i] = steps[src % Math.max(1, steps.length)] ?? null
  }
  return out
}

/** Change a pattern's bars / steps-per-bar, keeping its steps. Mutates `pat`. */
export function reshapePattern(pat, patch) {
  const from = { bars: pat.bars, stepsPerBar: pat.stepsPerBar }
  const to = { ...from, ...patch }
  for (const c of pat.channels) {
    if (c.kind === 'code') continue
    c.steps = resample(c.steps, from, to).map((v) => (c.kind === 'synth' ? v || null : v ? 1 : 0))
  }
  Object.assign(pat, patch)
}

/** Which step of `pattern` is sounding at song position `pos`, or -1. */
function stepAt(project, pattern, pos, mode) {
  const n = stepCount(pattern)
  if (mode === 'pattern') return Math.floor(mod(pos, pattern.bars) * pattern.stepsPerBar) % n
  const song = songLength(project)
  const songPos = mod(pos, song)
  for (const track of project.tracks) {
    if (track.mute) continue
    for (const clip of track.clips) {
      if (clip.pattern !== pattern.id || songPos < clip.bar || songPos >= clip.bar + clip.bars) continue
      return Math.floor(mod(songPos - clip.bar, pattern.bars) * pattern.stepsPerBar) % n
    }
  }
  return -1
}

/** Instrument chips: click to add, or drag onto a clip, a pattern or the rack. */
export function InstrumentChips({ onPick, className = '' }) {
  return (
    <div className={`instruments ${className}`} role="group" aria-label="Instruments">
      {INSTRUMENTS.map((inst) => (
        <button
          key={inst.key}
          className={`chip chip-${inst.kind}`}
          draggable
          title={`Add ${inst.label} · or drag it onto a clip`}
          onDragStart={(e) => {
            e.dataTransfer.setData(INSTRUMENT_MIME, inst.key)
            e.dataTransfer.setData('text/plain', inst.label)
            e.dataTransfer.effectAllowed = 'copy'
          }}
          onClick={() => onPick(inst.key)}
        >{inst.label}</button>
      ))}
    </div>
  )
}

/**
 * The channels of one pattern with their step grids. Used by the rack and by the
 * pattern editor that pops up on the playlist. Instruments can be dropped onto it.
 */
export function PatternChannels({ project, pattern, onUpdateProject, transport, started, playMode, compact = false }) {
  const gridsRef = useRef(null)
  const paintRef = useRef(null) // value being painted while the pointer is down
  const [dropping, setDropping] = useState(false)

  const update = (fn) => onUpdateProject((p) => {
    const target = p.patterns.find((x) => x.id === pattern.id)
    if (target) fn(target, p)
  })
  const updateChannel = (id, fn) => update((pat) => {
    const ch = pat.channels.find((c) => c.id === id)
    if (ch) fn(ch, pat)
  })
  const addInstrument = (key) => update((pat) => { pat.channels.push(instrumentChannel(key, pat)) })
  const setStep = (ch, i, value) => updateChannel(ch.id, (c) => {
    c.steps[i] = value ? (c.kind === 'synth' ? (c.steps[i] || c.note || 'c3') : 1) : c.kind === 'synth' ? null : 0
  })
  const transpose = (channelId, i, by) => updateChannel(channelId, (c) => {
    if (c.kind === 'synth' && c.steps[i]) c.steps[i] = midiToNote(noteToMidi(c.steps[i]) + by)
  })

  // live step cursor
  useEffect(() => {
    const grid = gridsRef.current
    const show = () => grid?.style.setProperty('--now', started ? stepAt(project, pattern, transport.position(), playMode) : -1)
    show()
    if (!started) return
    let frame
    const tick = () => { show(); frame = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [project, pattern, started, transport, playMode])

  // scroll over a synth step to change its note (non-passive so the page doesn't scroll)
  useEffect(() => {
    const grid = gridsRef.current
    if (!grid) return
    const onWheel = (e) => {
      const btn = e.target.closest?.('.step.on[data-synth]')
      if (!btn) return
      e.preventDefault()
      transpose(btn.dataset.channel, Number(btn.dataset.index), e.deltaY < 0 ? 1 : -1)
    }
    grid.addEventListener('wheel', onWheel, { passive: false })
    return () => grid.removeEventListener('wheel', onWheel)
  })

  useEffect(() => {
    const up = () => { paintRef.current = null }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  const n = stepCount(pattern)
  const stepsPerBeat = Math.max(1, Math.round(pattern.stepsPerBar / project.beats))

  return (
    <div
      className={`rack-body ${compact ? 'compact' : ''} ${dropping ? 'dropping' : ''}`}
      ref={gridsRef}
      style={{ '--n': n, '--spb': stepsPerBeat }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(INSTRUMENT_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropping(false) }}
      onDrop={(e) => {
        setDropping(false)
        const key = e.dataTransfer.getData(INSTRUMENT_MIME)
        if (!key) return
        e.preventDefault()
        addInstrument(key)
      }}
    >
      {pattern.channels.length === 0 && (
        <p className="rack-hint">Empty pattern. Add instruments below, or drag them in, then click steps to make them play.</p>
      )}
      {pattern.channels.map((ch) => (
        <div key={ch.id} className={`ch ${ch.mute ? 'muted' : ''}`}>
          <button
            className={`led mute ${ch.mute ? 'on' : ''}`}
            aria-pressed={ch.mute}
            aria-label={`${ch.mute ? 'Unmute' : 'Mute'} ${ch.name}`}
            onClick={() => updateChannel(ch.id, (c) => { c.mute = !c.mute })}
          >m</button>
          <input className="ch-name" value={ch.name} maxLength={40} aria-label="Channel name" onChange={(e) => { const v = e.target.value; updateChannel(ch.id, (c) => { c.name = v }) }} />

          <div className="ch-sound">
            {ch.kind === 'code' ? (
              <span className="ch-kind">code</span>
            ) : (
              <>
                <CommitInput
                  className="ch-input"
                  list={ch.kind === 'synth' ? 'synth-sounds' : 'drum-sounds'}
                  value={ch.sound}
                  aria-label="Sound"
                  onCommit={(v) => updateChannel(ch.id, (c) => { c.sound = v })}
                />
                {ch.kind === 'drum' ? (
                  <select className="ch-input" value={ch.bank} aria-label="Drum machine" onChange={(e) => { const v = e.target.value; updateChannel(ch.id, (c) => { c.bank = v }) }}>
                    {BANKS.map((b) => <option key={b} value={b}>{b || 'default kit'}</option>)}
                  </select>
                ) : (
                  <CommitInput
                    className="ch-input ch-note"
                    value={ch.note}
                    aria-label="Note for new steps"
                    title="Note for new steps, e.g. c3 or eb2"
                    onCommit={(v) => updateChannel(ch.id, (c) => { c.note = v })}
                  />
                )}
              </>
            )}
          </div>

          {ch.kind === 'code' ? (
            <CommitInput
              className="ch-code"
              value={ch.code}
              spellCheck={false}
              aria-label="Strudel code for this channel"
              title="Any Strudel pattern · Enter to apply"
              onCommit={(v) => updateChannel(ch.id, (c) => { c.code = v })}
            />
          ) : (
            <div className="steps" role="group" aria-label={`${ch.name} steps`}>
              {Array.from({ length: n }, (_, i) => {
                const v = ch.steps[i]
                const on = !!v
                const beatGroup = Math.floor(i / stepsPerBeat) % 2
                return (
                  <button
                    key={i}
                    className={`step ${on ? 'on' : ''} ${beatGroup ? 'alt' : ''} ${i % pattern.stepsPerBar === 0 ? 'bar-start' : ''}`}
                    aria-pressed={on}
                    aria-label={`step ${i + 1}${ch.kind === 'synth' && on ? `, ${v}` : ''}`}
                    data-channel={ch.id}
                    data-index={i}
                    data-synth={ch.kind === 'synth' ? '' : undefined}
                    title={ch.kind === 'synth' ? (on ? `${v} · scroll or arrow keys to change` : 'click to add a note') : undefined}
                    onPointerDown={(e) => {
                      if (e.button === 2) { setStep(ch, i, false); paintRef.current = false; return }
                      if (e.button !== 0) return
                      paintRef.current = !on
                      setStep(ch, i, !on)
                    }}
                    onPointerEnter={(e) => { if (paintRef.current !== null && e.buttons) setStep(ch, i, paintRef.current) }}
                    onContextMenu={(e) => e.preventDefault()}
                    onClick={(e) => { if (e.detail === 0) setStep(ch, i, !on) /* keyboard */ }}
                    onKeyDown={(e) => {
                      if (ch.kind !== 'synth' || !on) return
                      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        e.preventDefault()
                        transpose(ch.id, i, (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1))
                      }
                    }}
                  >{ch.kind === 'synth' && on ? <span className="step-note">{v}</span> : null}</button>
                )
              })}
              <span className="step-cursor" aria-hidden />
            </div>
          )}

          <div className="ch-more">
            <label className="ch-gain" title="Volume">
              <span className="syn">vol</span>
              <input type="range" min="0" max="1.5" step="0.05" value={ch.gain} aria-label="Volume" onChange={(e) => { const v = Number(e.target.value); updateChannel(ch.id, (c) => { c.gain = v }) }} />
            </label>
            {!compact && (
              <CommitInput
                className="ch-input ch-fx"
                value={ch.fx}
                placeholder=".room(.3)"
                spellCheck={false}
                aria-label="Effects, as Strudel code"
                title="Effects, as Strudel code, e.g. .room(.3).lpf(800) · Enter to apply"
                onCommit={(v) => updateChannel(ch.id, (c) => { c.fx = v })}
              />
            )}
            {!compact && (
              <button className="btn ghost ch-btn" title="Duplicate channel" aria-label={`Duplicate ${ch.name}`} onClick={() => update((pat) => {
                const i = pat.channels.findIndex((c) => c.id === ch.id)
                pat.channels.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(pat.channels[i])), id: newId(), name: `${ch.name} 2`.slice(0, 40) })
              })}>dup</button>
            )}
            <button className="btn ghost danger ch-btn" title="Remove instrument" aria-label={`Remove ${ch.name}`} onClick={() => update((pat) => { pat.channels = pat.channels.filter((c) => c.id !== ch.id) })}>del</button>
          </div>
        </div>
      ))}
      <div className="rack-add">
        <span className="syn">add</span>
        <InstrumentChips onPick={addInstrument} />
      </div>
    </div>
  )
}

/** The channel rack: pick a pattern, shape it, edit its channels. */
export default function Rack({ project, currentPatternId, onSelectPattern, onUpdateProject, transport, started, playMode, onPlayMode }) {
  const pattern = project.patterns.find((p) => p.id === currentPatternId) ?? project.patterns[0]

  const newPattern = () => onUpdateProject((p) => {
    const np = makePattern(`pattern ${p.patterns.length + 1}`)
    p.patterns.push(np)
    onSelectPattern(np.id)
  })

  if (!pattern) {
    return (
      <section className="rack" aria-label="Channel rack">
        <div className="rack-empty">
          <p>No patterns yet. Drag across a track in the playlist to draw one, or start one here.</p>
          <button className="btn primary" onClick={() => onUpdateProject((p) => { const np = makePattern('pattern 1', { channels: [makeChannel('drum')] }); p.patterns.push(np); onSelectPattern(np.id) })}>+ new pattern</button>
        </div>
      </section>
    )
  }

  const update = (fn) => onUpdateProject((p) => {
    const target = p.patterns.find((x) => x.id === pattern.id)
    if (target) fn(target, p)
  })
  const clonePattern = () => onUpdateProject((p) => {
    const src = p.patterns.find((x) => x.id === pattern.id)
    const copy = JSON.parse(JSON.stringify(src))
    copy.id = newId()
    copy.name = `${src.name} copy`.slice(0, 40)
    copy.channels.forEach((c) => { c.id = newId() })
    p.patterns.push(copy)
    onSelectPattern(copy.id)
  })
  const deletePattern = () => {
    const uses = project.tracks.reduce((sum, t) => sum + t.clips.filter((c) => c.pattern === pattern.id).length, 0)
    if (!window.confirm(`Delete pattern “${pattern.name}”${uses ? ` and its ${uses} clip${uses === 1 ? '' : 's'} in the playlist` : ''}?`)) return
    onUpdateProject((p) => {
      p.patterns = p.patterns.filter((x) => x.id !== pattern.id)
      p.tracks.forEach((t) => { t.clips = t.clips.filter((c) => c.pattern !== pattern.id) })
      onSelectPattern(p.patterns[0]?.id ?? null)
    })
  }

  return (
    <section className="rack" aria-label="Channel rack">
      <div className="rack-head">
        <span className="playlist-title">rack</span>
        <label className="rack-field">
          <span className="syn">pattern</span>
          <select className="select" value={pattern.id} onChange={(e) => onSelectPattern(e.target.value)} aria-label="Pattern">
            {project.patterns.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <input
          className="title-input rack-name"
          value={pattern.name}
          maxLength={40}
          aria-label="Pattern name"
          onChange={(e) => { const name = e.target.value; update((pat) => { pat.name = name }) }}
        />
        <label className="rack-field">
          <span className="syn">bars</span>
          <select className="select" value={pattern.bars} onChange={(e) => update((pat) => reshapePattern(pat, { bars: Number(e.target.value) }))} aria-label="Bars in this pattern">
            {BAR_CHOICES.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <label className="rack-field">
          <span className="syn">steps/bar</span>
          <select className="select" value={pattern.stepsPerBar} onChange={(e) => update((pat) => reshapePattern(pat, { stepsPerBar: Number(e.target.value) }))} aria-label="Steps per bar">
            {[8, 12, 16, 24, 32].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <span className="rack-actions">
          <button className="btn" onClick={newPattern}>+ pattern</button>
          <button className="btn" onClick={clonePattern}>clone</button>
          <button className="btn ghost danger" onClick={deletePattern}>delete</button>
        </span>
        <button
          className={`btn mode-pattern ${playMode === 'pattern' ? 'on' : ''}`}
          aria-pressed={playMode === 'pattern'}
          onClick={() => onPlayMode(playMode === 'pattern' ? 'song' : 'pattern')}
          title="Loop just this pattern instead of the whole song"
        >{playMode === 'pattern' ? 'looping this pattern' : 'loop this pattern'}</button>
      </div>

      <PatternChannels
        project={project}
        pattern={pattern}
        onUpdateProject={onUpdateProject}
        transport={transport}
        started={started}
        playMode={playMode}
      />
    </section>
  )
}

/** Shared datalists for the sound fields (render once per page). */
export function SoundLists() {
  return (
    <>
      <datalist id="drum-sounds">{DRUM_SOUNDS.map((s) => <option key={s} value={s} />)}</datalist>
      <datalist id="synth-sounds">{SYNTH_SOUNDS.map((s) => <option key={s} value={s} />)}</datalist>
    </>
  )
}

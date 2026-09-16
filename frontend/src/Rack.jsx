import { useEffect, useRef, useState } from 'react'
import {
  INSTRUMENTS, INSTRUMENT_MIME, PARAMS,
  instrumentChannel, midiToNote, newId, paramValue, paramsFor, stepCount,
} from './project'
import { previewInPatch } from './audio'
import Knob from './Knob.jsx'
import { channelTarget } from './automation.js'
import SoundPicker from './SoundPicker.jsx'
import { useRollDock } from './rollDock.js'

const mod = (a, n) => ((a % n) + n) % n
const GAIN = PARAMS.find((p) => p.key === 'gain')

/** A text field that applies its value on Enter or blur, not per keystroke. */
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

/** Which step of `pattern` is sounding at position `pos` (patterns loop from bar 1), or -1. */
export function stepAt(project, pattern, pos) {
  return Math.floor(exactStepAt(project, pattern, pos)) % stepCount(pattern)
}

/** Where playback is inside the pattern, in steps and fractions of one (for a smooth playhead). */
export function exactStepAt(project, pattern, pos) {
  return mod(pos, pattern.bars) * pattern.stepsPerBar
}

/** Instrument chips: click to add, or drag onto a pattern. */
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

/** A thumbnail of a synth channel's notes; click it to open the piano roll. */
function MiniRoll({ channel, total, open, onToggle }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#151513'
    ctx.fillRect(0, 0, w, h)
    const acid = getComputedStyle(document.documentElement).getPropertyValue('--acid').trim() || '#e4ff1a'
    if (!channel.notes.length) {
      ctx.fillStyle = '#7d7d76'
      ctx.font = '10px "Martian Mono", ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      ctx.fillText('empty · click to write notes', 8, h / 2)
      return
    }
    const pitches = channel.notes.map((x) => x.n)
    const lo = Math.min(...pitches) - 1
    const hi = Math.max(...pitches) + 1
    const rowH = Math.max(2, (h - 4) / Math.max(hi - lo + 1, 6))
    ctx.fillStyle = acid
    for (const x of channel.notes) ctx.fillRect((x.s / total) * w + 1, 2 + (hi - x.n) * rowH, Math.max(2, (x.l / total) * w - 2), Math.max(2, rowH - 1))
  }, [channel.notes, total, open])
  return (
    <button className={`mini-roll ${open ? 'open' : ''}`} onClick={onToggle} aria-expanded={open} title={open ? 'Close the piano roll' : 'Open the piano roll'}>
      <canvas ref={ref} aria-hidden />
    </button>
  )
}

/**
 * The instruments of one pattern: sound, knobs, and steps (drums) or a piano roll
 * (synths). Used by the pattern editor pop-up. Instruments can
 * be dropped onto it.
 */
export function PatternChannels({ project, pattern, onUpdateProject, transport, started, playMode, compact = false }) {
  const gridsRef = useRef(null)
  const paintRef = useRef(null) // value being painted while the pointer is down
  const [dropping, setDropping] = useState(false)
  const [picker, setPicker] = useState(null) // { channelId, x, y }
  const [openFx, setOpenFx] = useState(() => new Set())
  const dock = useRollDock() // the piano roll lives along the bottom of the app

  const toggle = (setter, id) => setter((s) => { const next = new Set(s); next.has(id) ? next.delete(id) : next.add(id); return next })
  const update = (fn) => onUpdateProject((p) => {
    const target = p.patterns.find((x) => x.id === pattern.id)
    if (target) fn(target, p)
  })
  const updateChannel = (id, fn) => update((pat) => {
    const ch = pat.channels.find((c) => c.id === id)
    if (ch) fn(ch, pat)
  })
  const setParam = (id, key, value) => updateChannel(id, (c) => { c.params = { ...c.params, [key]: value } })
  const addInstrument = (key) => {
    const ch = instrumentChannel(key, pattern)
    update((pat) => { pat.channels.push({ ...ch, name: instrumentChannel(key, pat).name }) })
    if (ch.kind === 'synth') dock?.open(pattern.id, ch.id, 'notes')
    if (!started) previewInPatch(project, pattern.id, ch)
  }
  const setStep = (ch, i, value) => {
    updateChannel(ch.id, (c) => { c.steps[i] = value ? 1 : 0 })
    if (value && !started) previewInPatch(project, pattern.id, ch)
  }

  const cursorRef = useRef(() => -1)
  cursorRef.current = () => (started ? stepAt(project, pattern, transport.position(), playMode) : -1)
  // the piano roll's playhead glides like the timeline's, so it isn't stuck to whole steps
  const exactRef = useRef(() => -1)
  // also while stopped: the playhead sits at the cue, as the timeline's does
  exactRef.current = () => exactStepAt(project, pattern, transport.position())

  // live step cursor for the drum grids
  useEffect(() => {
    const grid = gridsRef.current
    const show = () => grid?.style.setProperty('--now', cursorRef.current())
    show()
    if (!started) return
    let frame
    const tick = () => { show(); frame = requestAnimationFrame(tick) }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [project, pattern, started, transport, playMode])

  useEffect(() => {
    const up = () => { paintRef.current = null }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  }, [])

  const n = stepCount(pattern)
  const stepsPerBeat = Math.max(1, Math.round(pattern.stepsPerBar / project.beats))
  const pickerChannel = picker && pattern.channels.find((c) => c.id === picker.channelId)

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
        <p className="rack-hint">Empty pattern. Add instruments below (or drag them in), then click steps or write notes.</p>
      )}
      {pattern.channels.map((ch) => {
        const fxOpen = openFx.has(ch.id)
        const rollOpen = ch.kind === 'synth' && dock?.at?.tab === 'notes' && dock?.at?.patternId === pattern.id && dock?.at?.channelId === ch.id
        const tweaked = paramsFor(ch.kind).filter((d) => d.key !== 'gain' && paramValue(ch, d.key) !== d.def).length + (ch.fx?.trim() ? 1 : 0)
        return (
          <div key={ch.id} className={`ch ${ch.mute ? 'muted' : ''} ch-${ch.kind}`}>
            <button
              className={`led mute ${ch.mute ? 'on' : ''}`}
              aria-pressed={ch.mute}
              aria-label={`${ch.mute ? 'Unmute' : 'Mute'} ${ch.name}`}
              onClick={() => updateChannel(ch.id, (c) => { c.mute = !c.mute })}
            >m</button>
            <input className="ch-name" value={ch.name} maxLength={40} aria-label="Instrument name" onChange={(e) => { const v = e.target.value; updateChannel(ch.id, (c) => { c.name = v }) }} />

            <div className="ch-sound">
              {ch.kind === 'code' ? (
                <span className="ch-kind">code</span>
              ) : (
                <>
                  <button
                    className="sound-btn"
                    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setPicker({ channelId: ch.id, x: r.left, y: r.bottom }) }}
                    title="Choose a sound"
                  >
                    <span className="sound-name">{ch.sound}</span>
                    {ch.kind === 'drum' && ch.bank && <span className="sound-bank">{ch.bank}</span>}
                    <span aria-hidden className="sound-caret">▾</span>
                  </button>
                  <button className="btn ghost ch-btn" onClick={() => previewInPatch(project, pattern.id, ch)} title="Hear it" aria-label={`Hear ${ch.name}`}>hear</button>
                </>
              )}
            </div>

            {ch.kind === 'code' ? (
              <CommitInput
                className="ch-code"
                value={ch.code}
                spellCheck={false}
                aria-label="Strudel code for this instrument"
                title="Any Strudel pattern · Enter to apply"
                onCommit={(v) => updateChannel(ch.id, (c) => { c.code = v })}
              />
            ) : ch.kind === 'synth' ? (
              <MiniRoll channel={ch} total={n} open={rollOpen} onToggle={() => (rollOpen ? dock?.close() : dock?.open(pattern.id, ch.id, 'notes'))} />
            ) : (
              <div className="steps" role="group" aria-label={`${ch.name} steps`}>
                {Array.from({ length: n }, (_, i) => {
                  const on = !!ch.steps[i]
                  const beatGroup = Math.floor(i / stepsPerBeat) % 2
                  return (
                    <button
                      key={i}
                      className={`step ${on ? 'on' : ''} ${beatGroup ? 'alt' : ''} ${i % pattern.stepsPerBar === 0 ? 'bar-start' : ''}`}
                      aria-pressed={on}
                      aria-label={`step ${i + 1}`}
                      onPointerDown={(e) => {
                        if (e.button === 2) { setStep(ch, i, false); paintRef.current = false; return }
                        if (e.button !== 0) return
                        paintRef.current = !on
                        setStep(ch, i, !on)
                      }}
                      onPointerEnter={(e) => { if (paintRef.current !== null && e.buttons) setStep(ch, i, paintRef.current) }}
                      onContextMenu={(e) => e.preventDefault()}
                      onClick={(e) => { if (e.detail === 0) setStep(ch, i, !on) /* keyboard */ }}
                    />
                  )
                })}
                <span className="step-cursor" aria-hidden />
              </div>
            )}

            <div className="ch-more">
              <Knob def={GAIN} value={paramValue(ch, 'gain')} onChange={(v) => setParam(ch.id, 'gain', v)} target={channelTarget(pattern.id, ch.id, 'gain')} />
              <button className={`btn ch-btn ${fxOpen ? 'on' : ''}`} aria-expanded={fxOpen} onClick={() => toggle(setOpenFx, ch.id)} title="Sound settings">
                fx{tweaked ? ` ${tweaked}` : ''}
              </button>
              {ch.kind === 'synth' && (
                <button className={`btn ch-btn ${rollOpen ? 'on' : ''}`} aria-expanded={rollOpen} onClick={() => (rollOpen ? dock?.close() : dock?.open(pattern.id, ch.id, 'notes'))} title="Piano roll, along the bottom of the app">notes</button>
              )}
              {!compact && (
                <button className="btn ghost ch-btn" title="Duplicate" aria-label={`Duplicate ${ch.name}`} onClick={() => update((pat) => {
                  const i = pat.channels.findIndex((c) => c.id === ch.id)
                  pat.channels.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(pat.channels[i])), id: newId(), name: `${ch.name} 2`.slice(0, 40) })
                })}>dup</button>
              )}
              <button className="btn ghost danger ch-btn" title="Remove instrument" aria-label={`Remove ${ch.name}`} onClick={() => update((pat) => { pat.channels = pat.channels.filter((c) => c.id !== ch.id) })}>del</button>
            </div>

            {fxOpen && (
              <div className="ch-fxpanel">
                {paramsFor(ch.kind).filter((d) => d.key !== 'gain').map((def) => (
                  <Knob key={def.key} def={def} value={paramValue(ch, def.key)} onChange={(v) => setParam(ch.id, def.key, v)} target={channelTarget(pattern.id, ch.id, def.key)} />
                ))}
                <label className="ch-advanced">
                  <span className="syn">more, as code</span>
                  <CommitInput
                    className="ch-input ch-fx"
                    value={ch.fx}
                    placeholder=".vowel('a')"
                    spellCheck={false}
                    aria-label="Extra effects as Strudel code"
                    title="Anything the knobs don't cover, as Strudel code · Enter to apply"
                    onCommit={(v) => updateChannel(ch.id, (c) => { c.fx = v })}
                  />
                </label>
              </div>
            )}

          </div>
        )
      })}
      <div className="rack-add">
        <span className="syn">add</span>
        <InstrumentChips onPick={addInstrument} />
      </div>
      {pickerChannel && (
        <SoundPicker
          kind={pickerChannel.kind}
          sound={pickerChannel.sound}
          bank={pickerChannel.bank}
          anchor={picker}
          onPick={({ sound, bank }) => updateChannel(pickerChannel.id, (c) => { c.sound = sound; if (c.kind === 'drum') c.bank = bank })}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}

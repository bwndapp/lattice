import { useEffect, useRef } from 'react'
import { keyNote } from './keyboard.js'
import { holdInPatch } from './audio'

/**
 * The computer keyboard as a piano, wherever you are in the app: the dock uses it for the
 * instrument whose notes are open, and the patch for a pattern node holding a single
 * instrument. A note lasts while its key is down; - and = move an octave.
 *
 * Only one of these should be armed at a time, or a key would play twice. `onHeld` hears
 * the MIDI notes down right now, as a Set, whenever that changes, so the roll can light them.
 */
export function useTypingKeys({ enabled, project, pattern, channel, octave, onOctave, onHeld }) {
  const at = useRef(null)
  at.current = { project, pattern, channel, octave, onOctave, onHeld }

  useEffect(() => {
    if (!enabled || !pattern || !channel) return undefined
    const down = new Map() // key code → { note, release }
    const tell = () => at.current.onHeld?.(new Set([...down.values()].map((d) => d.note)))
    const letGo = () => {
      if (!down.size) return
      for (const d of down.values()) d.release()
      down.clear()
      tell()
    }
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // wherever you type text, the letters are text
      if (e.target.closest?.('input:not([type=range]), textarea, select, [contenteditable="true"], [contenteditable=""], .synth-window')) return
      const now = at.current
      const hit = keyNote(e.key, now.octave)
      if (!hit) return
      e.preventDefault()
      e.stopPropagation() // the letters belong to the keyboard while it's armed
      if (hit.octave) return now.onOctave(Math.min(8, Math.max(0, now.octave + hit.octave)))
      if (e.repeat || down.has(e.code)) return
      down.set(e.code, { note: hit.note, release: holdInPatch(now.project, now.pattern.id, now.channel, { note: hit.note }) })
      tell()
    }
    const onUp = (e) => { const d = down.get(e.code); if (d) { d.release(); down.delete(e.code); tell() } }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', letGo)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', letGo)
      letGo()
    }
  }, [enabled, pattern?.id, channel?.id]) // eslint-disable-line react-hooks/exhaustive-deps
}

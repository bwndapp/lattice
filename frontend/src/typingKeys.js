import { useEffect, useRef } from 'react'
import { keyNote } from './keyboard.js'
import { holdInPatch } from './audio'

/**
 * The computer keyboard as a piano, wherever you are in the app: the dock uses it for the
 * instrument whose notes are open, and the patch for a pattern node holding a single
 * instrument. A note lasts while its key is down; - and = move an octave.
 *
 * Only one of these should be armed at a time, or a key would play twice.
 */
export function useTypingKeys({ enabled, project, pattern, channel, octave, onOctave }) {
  const at = useRef(null)
  at.current = { project, pattern, channel, octave, onOctave }

  useEffect(() => {
    if (!enabled || !pattern || !channel) return undefined
    const down = new Map() // key code → let go of its note
    const letGo = () => { for (const release of down.values()) release(); down.clear() }
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // wherever you type text, the letters are text
      if (e.target.closest?.('input:not([type=range]), textarea, select, [contenteditable="true"], .synth-window')) return
      const now = at.current
      const hit = keyNote(e.key, now.octave)
      if (!hit) return
      e.preventDefault()
      e.stopPropagation() // the letters belong to the keyboard while it's armed
      if (hit.octave) return now.onOctave(Math.min(8, Math.max(0, now.octave + hit.octave)))
      if (e.repeat || down.has(e.code)) return
      down.set(e.code, holdInPatch(now.project, now.pattern.id, now.channel, { note: hit.note }))
    }
    const onUp = (e) => { const release = down.get(e.code); if (release) { release(); down.delete(e.code) } }
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

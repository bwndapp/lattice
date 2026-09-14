import { getAudioContext, soundMap, superdough } from '@strudel/webaudio'
import { paramValue, paramsFor } from './project'

/**
 * Everything Strudel has loaded, grouped for browsing: drum kits (bank → sounds),
 * single samples, synths and soundfont instruments. Kits that are only aliases of
 * another kit (tr909 → rolandtr909) are folded into the longer name.
 */
export function soundCatalog() {
  const dict = soundMap.get()
  const kits = new Map()
  const samples = []
  const synths = []
  const instruments = []
  for (const [key, entry] of Object.entries(dict)) {
    const data = entry?.data ?? {}
    const count = Array.isArray(data.samples) ? data.samples.length : data.samples ? Object.keys(data.samples).length : 1
    if (data.type === 'synth') synths.push({ key, count: 1 })
    else if (data.type === 'soundfont') instruments.push({ key, count: data.fonts?.length ?? 1 })
    else if (data.type === 'sample') {
      const cut = key.indexOf('_')
      if (cut > 0) {
        const bank = key.slice(0, cut)
        if (!kits.has(bank)) kits.set(bank, [])
        kits.get(bank).push({ key: key.slice(cut + 1), count, entry })
      } else samples.push({ key, count })
    }
  }
  // fold alias kits: same sound objects under a shorter name
  const byName = [...kits.entries()].sort((a, b) => b[0].length - a[0].length)
  const kept = []
  for (const [bank, sounds] of byName) {
    if (sounds.length < 2) continue
    const alias = kept.find((k) => k.sounds[0] && sounds.some((s) => k.sounds.some((t) => t.key === s.key && t.entry === s.entry)))
    if (alias) continue
    kept.push({ bank, sounds })
  }
  const clean = (list) => list.map(({ key, count }) => ({ key, count })).sort((a, b) => a.key.localeCompare(b.key))
  return {
    kits: kept.map(({ bank, sounds }) => ({ bank, sounds: clean(sounds) })).sort((a, b) => a.bank.localeCompare(b.bank)),
    samples: clean(samples),
    synths: clean(synths),
    instruments: clean(instruments),
  }
}

/** Call `fn` whenever the loaded sounds change (samples arrive after page load). */
export function onSoundsChange(fn) {
  return soundMap.listen(fn)
}

const PREVIEW_KEYS = { lpf: 'cutoff', lpq: 'resonance', hpf: 'hcutoff' }

/** Play one hit of a channel's sound right now, with its knob settings. */
export function previewChannel(ch, { note, n } = {}) {
  if (!ch || ch.kind === 'code') return
  const value = { s: ch.sound }
  if (ch.kind === 'drum' && ch.bank) value.bank = ch.bank
  if (ch.kind === 'synth') value.note = note ?? 48
  const [sound, variation] = String(ch.sound).split(':')
  value.s = sound
  if (n !== undefined || variation !== undefined) value.n = Number(n ?? variation)
  for (const def of paramsFor(ch.kind)) {
    const v = paramValue(ch, def.key)
    if (v === def.def) continue
    if (def.key === 'crush') value.crush = Math.round(16 - v * 14)
    else value[PREVIEW_KEYS[def.key] ?? def.key] = v
  }
  play(value, ch.kind === 'synth' ? 0.4 : 0.25)
}

/** Play a raw sound (for the sound browser). */
export function previewSound({ s, bank, n, note }) {
  const value = { s }
  if (bank) value.bank = bank
  if (n !== undefined) value.n = n
  if (note !== undefined) value.note = note
  play(value, note !== undefined ? 0.5 : 0.3)
}

function play(value, duration) {
  try {
    const ac = getAudioContext()
    if (ac.state !== 'running') ac.resume()
    Promise.resolve(superdough(value, ac.currentTime + 0.03, duration)).catch(() => {})
  } catch { /* audio not ready yet */ }
}

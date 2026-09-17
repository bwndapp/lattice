import { NODE_TYPES } from './graph'

/**
 * What changed between two saves of a track, in musical terms.
 *
 * A track is structured data, not a recording, so a save can be compared to the one before
 * it the way code can — except the answer is "a reverb went on the chords" rather than a
 * page of altered characters. That's the whole reason for keeping every save: history you
 * can read.
 */

const label = (node, project) => {
  if (!node) return 'something'
  if (node.data?.name) return node.data.name
  if (node.type === 'pattern') return project?.patterns?.find((p) => p.id === node.data?.patternId)?.name ?? 'a pattern'
  return NODE_TYPES[node.type]?.label ?? node.type
}

const byId = (list) => new Map((list ?? []).map((x) => [x.id, x]))
const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Steps or notes that differ between two instruments. */
function channelChanges(before, after) {
  const out = []
  if (before.sound !== after.sound) out.push(`${after.name} is now ${after.sound}`)
  if (before.kind === 'drum' && after.kind === 'drum') {
    const on = (s) => (s ?? []).reduce((n, v) => n + (v ? 1 : 0), 0)
    const was = on(before.steps)
    const now = on(after.steps)
    if (was !== now) out.push(`${after.name}: ${count(Math.abs(now - was), 'step')} ${now > was ? 'added' : 'taken out'}`)
    else if (JSON.stringify(before.steps) !== JSON.stringify(after.steps)) out.push(`${after.name}: steps moved`)
  }
  if (after.kind === 'synth') {
    const was = before.notes?.length ?? 0
    const now = after.notes?.length ?? 0
    if (was !== now) out.push(`${after.name}: ${count(Math.abs(now - was), 'note')} ${now > was ? 'added' : 'taken out'}`)
    else if (JSON.stringify(before.notes) !== JSON.stringify(after.notes)) out.push(`${after.name}: notes moved`)
  }
  for (const key of Object.keys({ ...before.params, ...after.params })) {
    const a = before.params?.[key]
    const b = after.params?.[key]
    if (a !== b) out.push(`${after.name} ${key} ${round(a) ?? 'default'} → ${round(b) ?? 'default'}`)
  }
  return out
}

/** Every change from one project to the next, most telling first. */
export function changesBetween(before, after) {
  if (!before || !after) return []
  const out = []

  if (before.bpm !== after.bpm) out.push(`tempo ${before.bpm} → ${after.bpm}`)
  if (before.beats !== after.beats) out.push(`${before.beats} → ${after.beats} beats a bar`)

  // ── the patch ──
  const wasNodes = byId(before.nodes)
  const nowNodes = byId(after.nodes)
  for (const n of after.nodes ?? []) {
    if (n.type === 'output' || wasNodes.has(n.id)) continue
    out.push(`added ${label(n, after)}`)
  }
  for (const n of before.nodes ?? []) {
    if (n.type === 'output' || nowNodes.has(n.id)) continue
    out.push(`removed ${label(n, before)}`)
  }
  for (const n of after.nodes ?? []) {
    const was = wasNodes.get(n.id)
    if (!was || was.type !== n.type) continue
    for (const key of Object.keys({ ...was.data, ...n.data })) {
      if (key === 'chain' || key === 'name') continue
      const a = was.data?.[key]
      const b = n.data?.[key]
      if (a === b || typeof a === 'object' || typeof b === 'object') continue
      out.push(`${label(n, after)} ${key} ${round(a)} → ${round(b)}`)
    }
  }
  const wire = (e) => `${e.source}>${e.sourceHandle ?? 'out'}>${e.target}>${e.targetHandle}`
  const wasWires = new Set((before.edges ?? []).map(wire))
  const nowWires = new Set((after.edges ?? []).map(wire))
  const wiredUp = (after.edges ?? []).filter((e) => !wasWires.has(wire(e)))
  const unwired = (before.edges ?? []).filter((e) => !nowWires.has(wire(e)))
  for (const e of wiredUp) out.push(`wired ${label(byId(after.nodes).get(e.source), after)} into ${label(byId(after.nodes).get(e.target), after)}`)
  for (const e of unwired) out.push(`unwired ${label(byId(before.nodes).get(e.source), before)} from ${label(byId(before.nodes).get(e.target), before)}`)

  // ── the parts ──
  const wasPats = byId(before.patterns)
  const nowPats = byId(after.patterns)
  for (const p of after.patterns ?? []) if (!wasPats.has(p.id)) out.push(`new part "${p.name}"`)
  for (const p of before.patterns ?? []) if (!nowPats.has(p.id)) out.push(`deleted part "${p.name}"`)
  for (const p of after.patterns ?? []) {
    const was = wasPats.get(p.id)
    if (!was) continue
    if (was.name !== p.name) out.push(`"${was.name}" renamed "${p.name}"`)
    if (was.bars !== p.bars) out.push(`"${p.name}" ${was.bars} → ${p.bars} bars`)
    if (was.stepsPerBar !== p.stepsPerBar) out.push(`"${p.name}" ${was.stepsPerBar} → ${p.stepsPerBar} steps a bar`)
    const wasCh = byId(was.channels)
    const nowCh = byId(p.channels)
    for (const c of p.channels) if (!wasCh.has(c.id)) out.push(`"${p.name}": added ${c.name}`)
    for (const c of was.channels) if (!nowCh.has(c.id)) out.push(`"${p.name}": removed ${c.name}`)
    for (const c of p.channels) {
      const before2 = wasCh.get(c.id)
      if (before2) out.push(...channelChanges(before2, c))
    }
  }

  // ── the timeline ──
  const wasSong = before.song ?? { clips: [] }
  const nowSong = after.song ?? { clips: [] }
  if (!!wasSong.on !== !!nowSong.on) out.push(nowSong.on ? 'song turned on' : 'song turned off')
  const wasClips = byId(wasSong.clips)
  const nowClips = byId(nowSong.clips)
  const added = (nowSong.clips ?? []).filter((c) => !wasClips.has(c.id)).length
  const gone = (wasSong.clips ?? []).filter((c) => !nowClips.has(c.id)).length
  const moved = (nowSong.clips ?? []).filter((c) => {
    const w = wasClips.get(c.id)
    return w && (w.start !== c.start || w.lane !== c.lane || w.len !== c.len)
  }).length
  if (added) out.push(`${count(added, 'clip')} on the timeline`)
  if (gone) out.push(`${count(gone, 'clip')} taken off the timeline`)
  if (moved) out.push(`${count(moved, 'clip')} moved`)
  const autos = (nowSong.autos ?? []).length - (wasSong.autos ?? []).length
  if (autos > 0) out.push(`${count(autos, 'automation')} added`)
  if (autos < 0) out.push(`${count(-autos, 'automation')} removed`)

  return out
}

/** The same changes as one line, for a list: the first few, then how many more. */
export function summarise(changes, most = 3) {
  if (!changes.length) return 'no changes'
  const head = changes.slice(0, most).join(' · ')
  return changes.length > most ? `${head} · +${changes.length - most} more` : head
}

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
/**
 * A number as you'd read it: enough figures to tell two values apart, and no more. Knobs
 * hold far more precision than anyone turns them by, so a move of a thousandth would
 * otherwise print as "0.01 → 0.01" and take up a line saying nothing.
 */
const round = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v
  if (Math.abs(v) >= 100) return Math.round(v)
  return Number(v.toPrecision(3))
}
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Knobs that differ between two objects of settings, named by their owner. */
function knobChanges(who, before, after, skip = []) {
  const out = []
  for (const key of Object.keys({ ...before, ...after })) {
    if (skip.includes(key)) continue
    const a = before?.[key]
    const b = after?.[key]
    if (a === b || typeof a === 'object' || typeof b === 'object') continue
    // moved by less than it's worth saying: not a change anyone made on purpose
    if (round(a) === round(b)) continue
    out.push(`${who} ${key} ${round(a) ?? 'default'} → ${round(b) ?? 'default'}`)
  }
  return out
}

/** Steps, notes, sound and settings that differ between two instruments. */
function channelChanges(before, after) {
  const out = []
  if (before.name !== after.name) out.push(`"${before.name}" renamed "${after.name}"`)
  if (before.sound !== after.sound) out.push(`${after.name} is now ${after.sound}`)
  if (before.bank !== after.bank) out.push(`${after.name} kit ${before.bank || 'none'} → ${after.bank || 'none'}`)
  if (!!before.mute !== !!after.mute) out.push(`${after.name} ${after.mute ? 'muted' : 'unmuted'}`)
  if ((before.fx ?? '') !== (after.fx ?? '')) out.push(`${after.name} extra code ${after.fx ? 'changed' : 'cleared'}`)
  if (before.engine?.type !== after.engine?.type) out.push(`${after.name} instrument ${before.engine?.type ?? 'sample'} → ${after.engine?.type ?? 'sample'}`)
  else out.push(...knobChanges(after.name, before.engine?.data, after.engine?.data))
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
  out.push(...knobChanges(after.name, before.params, after.params))
  return out
}

/** What one node holds that isn't a plain number: an fx rack's units, mutes, ports. */
function dataChanges(name, was, now) {
  const out = []
  const chainWas = byId(was?.chain)
  const chainNow = byId(now?.chain)
  for (const u of now?.chain ?? []) if (!chainWas.has(u.id)) out.push(`${name}: added ${NODE_TYPES[u.type]?.label ?? u.type}`)
  for (const u of was?.chain ?? []) if (!chainNow.has(u.id)) out.push(`${name}: removed ${NODE_TYPES[u.type]?.label ?? u.type}`)
  for (const u of now?.chain ?? []) {
    const before = chainWas.get(u.id)
    if (!before) continue
    const label2 = `${name} ${NODE_TYPES[u.type]?.label ?? u.type}`
    if (!!before.on !== !!u.on) out.push(`${label2} ${u.on ? 'switched on' : 'bypassed'}`)
    out.push(...knobChanges(label2, before.data, u.data))
  }
  const order = (c) => (c ?? []).map((u) => u.id).join(',')
  if (order(was?.chain) !== order(now?.chain) && (was?.chain ?? []).length === (now?.chain ?? []).length && (now?.chain ?? []).length > 1) {
    out.push(`${name}: effects reordered`)
  }
  const lanes = (m) => Object.keys(m ?? {}).filter((k) => m[k]).sort().join(',')
  if (lanes(was?.muted) !== lanes(now?.muted)) out.push(`${name}: what's muted changed`)
  if ((was?.solo ?? null) !== (now?.solo ?? null)) out.push(now?.solo ? `${name}: one thing soloed` : `${name}: solo cleared`)
  if (lanes(was?.offMain) !== lanes(now?.offMain)) out.push(`${name}: which instruments leave the main out changed`)
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
    if ((was.data?.name ?? '') !== (n.data?.name ?? '')) out.push(`${label(was, before)} renamed ${label(n, after)}`)
    out.push(...knobChanges(label(n, after), was.data, n.data, ['name']))
    out.push(...dataChanges(label(n, after), was.data, n.data))
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
  for (const c of nowSong.clips ?? []) {
    const w = wasClips.get(c.id)
    if (w && w.src !== c.src) out.push('a clip now plays something else')
  }
  if ((wasSong.snap ?? 'bar') !== (nowSong.snap ?? 'bar')) out.push(`clips snap to the ${nowSong.snap ?? 'bar'}`)

  // rows, and the colours parts are drawn in
  const rows = (s2) => (s2.lanes ?? []).map((l) => `${l.name ?? ''}:${l.mute ? 'm' : ''}`).join('|')
  if (rows(wasSong) !== rows(nowSong)) out.push('timeline rows renamed or muted')
  const colours = (s2) => JSON.stringify(s2.colors ?? {})
  if (colours(wasSong) !== colours(nowSong)) out.push('a part changed colour')

  // automation: how many, and whether a curve was drawn on
  const wasAutos = byId(wasSong.autos)
  const nowAutos = byId(nowSong.autos)
  for (const a of nowSong.autos ?? []) if (!wasAutos.has(a.id)) out.push(`automated ${a.name ?? a.target}`)
  for (const a of wasSong.autos ?? []) if (!nowAutos.has(a.id)) out.push(`stopped automating ${a.name ?? a.target}`)
  for (const a of nowSong.autos ?? []) {
    const w = wasAutos.get(a.id)
    if (!w) continue
    if (w.target !== a.target) out.push(`an automation now moves ${a.name ?? a.target}`)
    else if (w.bars !== a.bars) out.push(`${a.name ?? a.target} automation ${w.bars} → ${a.bars} bars`)
    else if (JSON.stringify(w.points) !== JSON.stringify(a.points)) out.push(`${a.name ?? a.target} curve redrawn`)
  }

  if ((before.prelude ?? '') !== (after.prelude ?? '')) out.push('hand-written setup code changed')

  return out
}

/** The same changes as one line, for a list: the first few, then how many more. */
export function summarise(changes, most = 3) {
  if (!changes.length) return 'no changes'
  const head = changes.slice(0, most).join(' · ')
  return changes.length > most ? `${head} · +${changes.length - most} more` : head
}

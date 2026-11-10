import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { BANKS } from '../../project.js'
import { MOVES, N, RINGS, STEP_OF, STICKERS, faces, inverse, isSolved, paint, scrambleMoves, twist } from './model.js'
import './cube.css'

const SOUNDS = ['bd', 'sd', 'hh', 'oh', 'cp', 'rim', 'lt', 'mt', 'ht', 'cr', 'rd', 'cb', 'sh', 'perc', 'tb']
const ROW_NAMES = ['top', 'upper', 'lower', 'bottom']
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
const C = (N - 1) / 2 // a cubie's index → its centre, centred on the cube

// stickers: what's played is bright; the caps (not played) are the same, dimmed
const INK = {
  ring: [new THREE.Color('#2b2b2b'), new THREE.Color('#9c9c9c'), new THREE.Color('#f2f2f2')],
  cap: [new THREE.Color('#222222'), new THREE.Color('#5a5a5a'), new THREE.Color('#8a8a8a')],
}
const PLAYHEAD = new THREE.Color('#e0a33c')

/**
 * The cube's window: the puzzle in 3D, and the four drums it plays underneath.
 * Drag a sticker to twist its layer, click one to paint it, drag the space around the cube
 * to turn it over. Everything shown follows the saved state, so an undo, a peer's twist or a
 * scramble animates the same way your own twist does.
 */
export default function CubePanel({ state, change, position, playing }) {
  const host = useRef(null)
  const view = useRef(null) // the three.js side, made once
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    const el = host.current
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100)
    camera.position.set(0, 0, 14)
    scene.add(new THREE.HemisphereLight('#ffffff', '#303030', 1.6))
    const key = new THREE.DirectionalLight('#ffffff', 1.4)
    key.position.set(-4, 6, 8) // one light, from the top left, as the rest of the app is lit
    scene.add(key)

    const cube = new THREE.Group()
    cube.rotation.set(0.5, -0.65, 0)
    scene.add(cube)

    // bodies: one per outer cubie, all alike, so after a turn they can snap back unseen
    const bodyGeo = new THREE.BoxGeometry(0.96, 0.96, 0.96)
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#161616', roughness: 0.85 })
    const bodies = []
    for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) for (let z = 0; z < N; z++) {
      if (![x, y, z].some((v) => v === 0 || v === N - 1)) continue
      const m = new THREE.Mesh(bodyGeo, bodyMat)
      m.position.set(x - C, y - C, z - C)
      m.userData = { pos: [x, y, z], home: m.position.clone(), turn: m.quaternion.clone() }
      cube.add(m)
      bodies.push(m)
    }
    // stickers: one per place on the surface, coloured by whatever sits there now
    const stickerGeo = new THREE.PlaneGeometry(0.8, 0.8)
    const stickers = STICKERS.map((s, slot) => {
      const mat = new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.55, emissive: '#000000' })
      const m = new THREE.Mesh(stickerGeo, mat)
      const n = new THREE.Vector3(...s.n)
      m.position.set(s.pos[0] - C, s.pos[1] - C, s.pos[2] - C).addScaledVector(n, 0.485)
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n)
      m.userData = { slot, pos: s.pos, home: m.position.clone(), turn: m.quaternion.clone() }
      cube.add(m)
      return m
    })

    // ── what's shown: the saved twists, caught up one turn at a time ──
    let shown = [...stateRef.current.moves]
    let anim = null // { move, objs, pivot, t0, ms }
    const queue = []
    const recolour = () => {
      const f = faces({ painted: stateRef.current.painted, moves: shown })
      for (const m of stickers) {
        const ring = STEP_OF.has(m.userData.slot)
        m.material.color.copy((ring ? INK.ring : INK.cap)[f[m.userData.slot]])
        m.userData.value = f[m.userData.slot]
      }
    }
    const sync = () => {
      const want = stateRef.current.moves
      const pending = [...shown, ...queue]
      const prefix = (a, b) => a.length <= b.length && a.every((m, i) => m === b[i])
      if (prefix(pending, want)) queue.push(...want.slice(pending.length))
      else if (!anim && want.length === shown.length - 1 && prefix(want, shown)) queue.push({ undo: shown[shown.length - 1] })
      else if (!anim) { queue.length = 0; shown = [...want] } // solved, loaded, or too different: jump
      recolour()
    }
    const startNext = (now) => {
      const next = queue.shift()
      if (!next) return
      const name = typeof next === 'string' ? next : inverse(next.undo)
      const mv = MOVES[name]
      const pivot = new THREE.Group()
      cube.add(pivot)
      const objs = [...bodies, ...stickers].filter((o) => o.userData.pos[mv.axis] === mv.layer)
      for (const o of objs) pivot.attach(o)
      // a backlog (a scramble) runs quick; one twist takes its time
      anim = { name, undo: typeof next !== 'string', objs, pivot, t0: now, ms: queue.length > 2 ? 70 : 170 }
    }
    const finish = () => {
      const { name, undo, objs, pivot } = anim
      for (const o of objs) {
        cube.add(o)
        o.position.copy(o.userData.home)
        o.quaternion.copy(o.userData.turn)
      }
      cube.remove(pivot)
      if (undo) shown.pop()
      else shown.push(name)
      anim = null
      recolour()
    }
    view.current = { sync }
    recolour()

    // ── pointer: twist, paint, turn ──
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    let press = null
    const hitAt = (e) => {
      const r = renderer.domElement.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      return ray.intersectObjects(stickers, false)[0]?.object ?? null
    }
    const toScreen = (v) => {
      const p = cube.localToWorld(v.clone()).project(camera)
      const r = renderer.domElement.getBoundingClientRect()
      return new THREE.Vector2((p.x + 1) * r.width / 2, (1 - p.y) * r.height / 2)
    }
    /** Which layer a drag across `slot` turns, and which way. */
    const twistFor = (slot, drag) => {
      const s = STICKERS[slot]
      const at = new THREE.Vector3(s.pos[0] - C, s.pos[1] - C, s.pos[2] - C).addScaledVector(new THREE.Vector3(...s.n), 0.5)
      let best = null
      for (let axis = 0; axis < 3; axis++) {
        if (s.n[axis] !== 0) continue
        // where a quarter turn about this axis would carry the sticker, on screen
        const along = new THREE.Vector3().crossVectors(AXES[axis], at).normalize().multiplyScalar(0.4)
        const d = toScreen(at.clone().add(along)).sub(toScreen(at))
        if (d.lengthSq() < 1e-6) continue
        const score = drag.dot(d.normalize())
        if (!best || Math.abs(score) > Math.abs(best.score)) best = { axis, score }
      }
      if (!best) return null
      return `${'xyz'[best.axis]}${s.pos[best.axis]}${best.score > 0 ? '+' : '-'}`
    }
    const canvas = renderer.domElement
    const onDown = (e) => {
      if (e.button !== 0) return
      canvas.setPointerCapture(e.pointerId)
      const hit = hitAt(e)
      press = { x: e.clientX, y: e.clientY, slot: hit?.userData.slot ?? null, done: false, lastX: e.clientX, lastY: e.clientY }
    }
    const onMove = (e) => {
      if (!press) return
      const drag = new THREE.Vector2(e.clientX - press.x, e.clientY - press.y)
      if (press.slot == null) {
        // turning the whole cube over
        const dx = e.clientX - press.lastX
        const dy = e.clientY - press.lastY
        press.lastX = e.clientX; press.lastY = e.clientY
        const q = new THREE.Quaternion()
        q.setFromAxisAngle(AXES[1], dx * 0.01); cube.quaternion.premultiply(q)
        q.setFromAxisAngle(AXES[0], dy * 0.01); cube.quaternion.premultiply(q)
        return
      }
      if (press.done || drag.length() < 12) return
      press.done = true
      const name = twistFor(press.slot, drag)
      if (name) change((st) => twist(st, name))
    }
    const onUp = () => {
      if (press && press.slot != null && !press.done) {
        // a click, not a drag: paint what's showing there (once the cube has caught up)
        const slot = press.slot
        if (!anim && !queue.length) change((st) => paint(st, slot))
      }
      press = null
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)

    // ── size, and the frame loop ──
    const fit = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      renderer.setSize(w, h, false)
      camera.aspect = w / Math.max(1, h)
      camera.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    fit()
    let raf = 0
    const frame = (now) => {
      raf = requestAnimationFrame(frame)
      if (!anim && queue.length) startNext(now)
      if (anim) {
        const k = Math.min(1, (now - anim.t0) / anim.ms)
        const ease = 1 - (1 - k) ** 3
        const mv = MOVES[anim.name]
        anim.pivot.quaternion.setFromAxisAngle(AXES[mv.axis], ease * mv.dir * Math.PI / 2)
        if (k >= 1) finish()
      }
      // the step playing now lights up round every ring
      const step = view.current.playing?.() ? Math.floor(((view.current.position?.() ?? 0) % 1 + 1) % 1 * 16) : -1
      for (const m of stickers) {
        const at = STEP_OF.get(m.userData.slot)
        const on = !anim && at && at[1] === step
        m.material.emissive.copy(on ? PLAYHEAD : INK.ring[0]).multiplyScalar(on ? (m.userData.value ? 0.55 : 0.25) : 0)
      }
      renderer.render(scene, camera)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      bodyGeo.dispose(); bodyMat.dispose(); stickerGeo.dispose()
      for (const m of stickers) m.material.dispose()
      renderer.dispose()
      canvas.remove()
      view.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // the saved state moved: the cube catches up
  useEffect(() => { view.current?.sync() }, [state])
  useEffect(() => { if (view.current) Object.assign(view.current, { position, playing }) })

  const shown = useMemo(() => faces(state), [state])
  const setRow = (r, patch) => change((st) => ({ ...st, rows: st.rows.map((row, i) => (i === r ? { ...row, ...patch } : row)) }))

  return (
    <div className="cube-panel">
      <div className="cube-stage" ref={host} title="Drag a sticker to twist its layer · click one to paint it · drag around the cube to turn it" />
      <div className="cube-side">
        <div className="cube-actions">
          <button type="button" className="btn primary" onClick={() => change((st) => scrambleMoves(24).reduce(twist, st))} title="24 random twists: the same hits, somewhere new">scramble</button>
          <button type="button" className="btn" disabled={!state.moves.length} onClick={() => change((st) => ({ ...st, moves: st.moves.slice(0, -1) }))} title="Undo the last twist">untwist</button>
          <button type="button" className="btn" disabled={isSolved(state)} onClick={() => change((st) => ({ ...st, moves: [] }))} title="Every twist undone: back to what you painted">solve</button>
          <span className="cube-count meta">{state.moves.length ? `${state.moves.length} twist${state.moves.length === 1 ? '' : 's'} from solved` : 'solved'}</span>
        </div>
        <label className="cube-kit">
          <span className="meta">kit</span>
          <select className="select" value={state.bank} onChange={(e) => change((st) => ({ ...st, bank: e.target.value }))}>
            {(BANKS.includes(state.bank) ? BANKS : [state.bank, ...BANKS]).map((b) => <option key={b} value={b}>{b || 'default sounds'}</option>)}
          </select>
        </label>
        <ol className="cube-rows">
          {RINGS.map((ring, r) => (
            <li key={r} className={`cube-row ${state.rows[r].mute ? 'muted' : ''}`}>
              <span className="cube-row-name meta">{ROW_NAMES[r]}</span>
              <select className="select" value={state.rows[r].sound} onChange={(e) => setRow(r, { sound: e.target.value })} aria-label={`${ROW_NAMES[r]} layer's sound`}>
                {(SOUNDS.includes(state.rows[r].sound) ? SOUNDS : [state.rows[r].sound, ...SOUNDS]).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button type="button" className={`led mute ${state.rows[r].mute ? 'on' : ''}`} aria-pressed={state.rows[r].mute} onClick={() => setRow(r, { mute: !state.rows[r].mute })} title="Mute this layer">m</button>
              <span className="cube-steps">
                {ring.map((slot, s) => (
                  <button
                    key={s}
                    type="button"
                    className={`cube-step v${shown[slot]} ${s % 4 === 0 ? 'beat' : ''}`}
                    onClick={() => change((st) => paint(st, slot))}
                    aria-label={`${ROW_NAMES[r]} step ${s + 1}`}
                    title="Click: rest → hit → accent"
                  />
                ))}
              </span>
            </li>
          ))}
        </ol>
        <p className="cube-hint meta">Each layer's ring of stickers is one bar. Twist sideways to shift a drum; twist up or down to trade hits between drums and the caps.</p>
      </div>
    </div>
  )
}

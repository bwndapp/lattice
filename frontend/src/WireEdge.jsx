import { useEffect, useRef, useState } from 'react'
import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react'

/** Fired by a wire's + button; the patch canvas opens its add menu there. */
export const ADD_INTO_WIRE = 'lattice:add-into-wire'

const STIFF = 0.16 // how hard the wire pulls back to where it wants to hang
const DAMP = 0.78 // how quickly the swing dies down
const REST = 0.15 // below this it's near enough still to stop drawing

/** How far a wire hangs at rest: the longer the span, the more rope there is in it. */
function slackOf(sourceX, sourceY, targetX, targetY) {
  const run = Math.abs(targetX - sourceX)
  const back = Math.max(0, sourceX - targetX) // one doubling back has further to hang
  return Math.min(130, 12 + run * 0.17 + back * 0.4)
}

/**
 * The weight in a wire. It hangs a little rather than being drawn taut, and when a node
 * moves it swings and settles instead of snapping to its new shape — one spring per wire,
 * on the sag alone, running only while it's actually moving.
 *
 * It's the look of a patch bay, and it costs a number per wire per frame while you drag.
 */
function useSag(sourceX, sourceY, targetX, targetY) {
  const [sag, setSag] = useState(() => slackOf(sourceX, sourceY, targetX, targetY))
  const spring = useRef({ y: null, v: 0, frame: 0, x: 0, ty: 0 })

  useEffect(() => {
    const s = spring.current
    const want = slackOf(sourceX, sourceY, targetX, targetY)
    if (s.y === null) { s.y = want; setSag(want); return undefined }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { s.y = want; setSag(want); return undefined }
    // an end that just moved gives the rope a shove, so a quick drag whips it
    const moved = Math.hypot(targetX - s.x, targetY - s.ty)
    s.x = targetX
    s.ty = targetY
    s.v += Math.min(9, moved * 0.22)
    if (s.frame) return undefined
    const step = () => {
      const now = spring.current
      const to = slackOf(sourceX, sourceY, targetX, targetY)
      now.v = (now.v + (to - now.y) * STIFF) * DAMP
      now.y += now.v
      if (Math.abs(now.v) < REST && Math.abs(to - now.y) < REST) {
        now.y = to
        now.v = 0
        now.frame = 0
        setSag(to)
        return
      }
      setSag(now.y)
      now.frame = requestAnimationFrame(step)
    }
    s.frame = requestAnimationFrame(step)
    return undefined
  }, [sourceX, sourceY, targetX, targetY])

  useEffect(() => () => cancelAnimationFrame(spring.current.frame), [])
  return sag
}

const BACK = 40 // a wire whose end is less than this right of its start runs back round

/**
 * A wire's path, and where its middle is (for the +). Forwards it's an S that leaves its
 * port sideways and arrives sideways, with the sag (if any) pulling its middle down: two
 * curves through a low middle, as one curve bent enough to hang tips both ends off at an
 * angle. Backwards (into a node to its left) it doesn't loop through everything between:
 * it turns down out of its port, runs back underneath along one level, and turns up into
 * the input — the way you'd dress a cable round a rack.
 */
function wirePath(sx, sy, tx, ty, sag) {
  if (tx < sx + BACK) {
    const r = 46
    const low = Math.max(sy, ty) + 64 + sag * 0.5
    const path = `M${sx},${sy} C${sx + r},${sy} ${sx + r},${low} ${sx},${low} L${tx},${low} C${tx - r},${low} ${tx - r},${ty} ${tx},${ty}`
    return { path, midX: (sx + tx) / 2, midY: low }
  }
  const midX = (sx + tx) / 2
  const midY = (sy + ty) / 2 + sag
  const reach = Math.max(34, (tx - sx) * 0.28)
  const path = `M${sx},${sy} C${sx + reach},${sy} ${midX - reach},${midY} ${midX},${midY}`
    + ` C${midX + reach},${midY} ${tx - reach},${ty} ${tx},${ty}`
  return { path, midX, midY }
}

/**
 * A wire, taut unless the slack says otherwise. Its + (add a node into it) only shows while
 * the pointer is on the wire or it's selected, so a busy patch isn't covered in circles.
 */
export function WireEdge({ id, sourceX, sourceY, targetX, targetY, data, style, markerEnd, interactionWidth, selected }) {
  const pull = data?.tension ?? 0
  const sag = useSag(sourceX, sourceY, targetX, targetY) * pull
  const { path, midX, midY } = wirePath(sourceX, sourceY, targetX, targetY, sag)
  // hovering: on the wire, or on its + (a moment's grace to get from one to the other)
  const [hover, setHover] = useState(false)
  const leave = useRef(0)
  const enter = () => { clearTimeout(leave.current); setHover(true) }
  const exit = () => { clearTimeout(leave.current); leave.current = setTimeout(() => setHover(false), 220) }
  useEffect(() => () => clearTimeout(leave.current), [])
  const length = Math.hypot(targetX - sourceX, targetY - sourceY)
  const small = length < 90
  const lift = length < 36 ? 17 : 0 // no room between the dots: sit just above the wire instead
  return (
    <>
      {/* a wire is three strokes of the same line: a dark casing, the coloured body that
          carries the click, and a thin bright thread down the middle of it */}
      <path className="wire-casing" d={path} style={style} />
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <path className="wire-sheen" d={path} style={style} />
      <path className="wire-hover" d={path} onPointerEnter={enter} onPointerLeave={exit} />
      {!data?.closed && <EdgeLabelRenderer>
        <button
          type="button"
          className={`wire-add nodrag nopan ${small ? 'small' : ''} ${hover || selected ? 'shown' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY - lift}px)` }}
          title="Add a node into this wire"
          aria-label="Add a node into this wire"
          onPointerEnter={enter}
          onPointerLeave={exit}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            const r = e.currentTarget.getBoundingClientRect()
            window.dispatchEvent(new CustomEvent(ADD_INTO_WIRE, { detail: { edgeId: id, x: r.left + r.width / 2, y: r.top + r.height / 2 } }))
          }}
        >+</button>
      </EdgeLabelRenderer>}
    </>
  )
}

export const EDGE_TYPES = { wire: WireEdge }

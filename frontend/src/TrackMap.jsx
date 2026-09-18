/**
 * A track's arrangement, small: every clip where it sits, in the colour it has on the
 * timeline. It comes from the listing itself (see `_shape` in src/api/tracks.py), so a page
 * of cards is a page of pictures of actual music — this song and no other — without
 * loading a single track's code.
 */
export default function TrackMap({ shape }) {
  const clips = shape?.c ?? []
  if (!clips.length) {
    return (
      <div className="b-map none" aria-hidden>
        <span>{shape ? 'nothing on the timeline yet' : 'written as code'}</span>
      </div>
    )
  }
  const bars = Math.max(shape.bars || 0, 4)
  // three lanes minimum, so a track with one part doesn't fill the whole panel with a slab
  const lanes = Math.max(shape.lanes || 1, 3)
  const marks = []
  for (let b = 4; b < bars; b += 4) marks.push(b)
  return (
    <svg className="b-map" viewBox={`0 0 ${bars} ${lanes}`} preserveAspectRatio="none" aria-hidden>
      {marks.map((b) => <line key={b} className="b-map-bar" x1={b} x2={b} y1="0" y2={lanes} vectorEffect="non-scaling-stroke" />)}
      {clips.map(([lane, start, len, colour, auto], i) => (
        <rect
          key={i}
          className={auto ? 'b-map-auto' : 'b-map-clip'}
          x={start}
          y={lane + (auto ? 0.42 : 0.14)}
          width={len}
          height={auto ? 0.16 : 0.72}
          fill={shape.p[colour] || '#e4ff1a'}
        />
      ))}
    </svg>
  )
}

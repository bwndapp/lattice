import { useEffect, useMemo, useRef, useState } from 'react'
import { createFace } from './vendor/bbot.js'
import { applyFx } from './vendor/bbot-fx.js'
import { botLook, botOf, botStyle, colorOf } from './bot.js'
import { usePresence } from './collab.js'

/** One person's face, self-contained: their hash and colour, drawn (bot.js). */
export default function BotFace({ bot, color, expression = 'content', className, style }) {
  const box = useRef(null)
  const look = useMemo(() => botLook(bot, color), [bot, color])
  useEffect(() => {
    const f = createFace(box.current, { expression, track: false, idle: true, pupils: look.pupils, mouth: look.mouth })
    const svg = box.current.querySelector('svg')
    if (svg) try { applyFx(svg, look.fx) } catch { /* a finish is never worth a blank face */ }
    return () => f.destroy() // or it keeps its slot in the shared animation loop
  }, [look, expression])
  return <span className={className} style={{ ...botStyle(look), ...style }} ref={box} aria-hidden />
}

/**
 * The signed-in person's own face, the one they wear in the peer tray. The hash is worked
 * out from their account, so no room is needed; the colour is the room's when it has given
 * one, and otherwise their own from the same palette, so it doesn't flicker on joining.
 */
export function MyFace({ user, className }) {
  const [bot, setBot] = useState(null)
  const me = usePresence()
  useEffect(() => {
    let live = true
    setBot(null)
    if (user?.id) botOf(user.id).then((b) => { if (live) setBot(b) }, () => {})
    return () => { live = false }
  }, [user?.id])
  if (!bot) return <span className={className} aria-hidden />
  const color = me?.bot === bot && me.color ? me.color : colorOf(bot)
  return <BotFace bot={bot} color={color} className={className} />
}

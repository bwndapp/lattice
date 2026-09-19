import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import SynthWindow from './SynthWindow.jsx'
import CodeWindow from '../CodeWindow.jsx'
import { openSynths, subscribeSynths } from './windows.js'

/** Every open window, once, at the top of the app. */
export default function SynthWindows({ project, onUpdateProject }) {
  const windows = useSyncExternalStore(subscribeSynths, openSynths)
  if (!project || !windows.length) return null
  const front = Math.max(...windows.map((w) => w.z))
  return createPortal(
    windows.map((w) => (w.kind === 'code' ? (
      <CodeWindow
        key={w.id}
        window={w}
        project={project}
        order={windows.filter((x) => x.z < w.z).length}
        front={w.z === front}
        onUpdateProject={onUpdateProject}
      />
    ) : (
      <SynthWindow
        key={w.id}
        project={project}
        patternId={w.patternId}
        channelId={w.channelId}
        order={windows.filter((x) => x.z < w.z).length}
        front={w.z === front}
        onUpdateProject={onUpdateProject}
      />
    ))),
    document.body,
  )
}

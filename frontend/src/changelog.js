/**
 * What's changed, newest first.
 *
 * It ships with the app rather than coming from a server, so a browser that has the new
 * build has the news that goes with it — there's nothing to get out of step. Anything
 * newer than the last entry someone has seen is shown once, when they open lattice.
 *
 * Write for whoever uses it: what they can now do, in their words, not what was changed in
 * the code. One line per thing; leave out anything they'd never notice.
 */
export const NEWS = [
  {
    id: '2026-09-19',
    title: 'Distortion, one octave, and engines that stay in time',
    items: [
      'A **distortion** node: five pedals (overdrive, crunch, rat, fuzz, octave), with a tighten knob that keeps the bass out of the clipping and a mix for parallel drive.',
      'One **octave** for the whole app, shown in the top bar next to the meter. The roll, the patch and an instrument window all move the same number.',
      'Typing plays the instrument you\'re working on even when you\'ve selected its **effects** — its rack, its bus, whatever it runs into.',
      'An engine\'s tempo-synced LFOs now follow the **song** rather than a clock of their own, so they hold their place when you seek or loop.',
      'Dragging anywhere no longer selects the text under your pointer.',
    ],
  },
  {
    id: '2026-09-18',
    title: 'Tracks have a history you can hear',
    items: [
      'Every track has a **page**: what it is, where it came from, and every save it has been through.',
      '**Hear this** plays any save as it stood; **branch from here** takes that save into a track of your own, hanging off the line where you left.',
      'Branches say they\'re branches, and point back at the track they came from.',
      'Cards in the browser **draw their own arrangement**, so a page of tracks looks like the music rather than a list of names.',
      'The browser drops in over what you were doing and puts you back exactly where you were when you leave.',
    ],
  },
  {
    id: '2026-09-17',
    title: 'The timeline, with more give',
    items: [
      'A white outline shows where a clip will land while you drag it, and the clip itself goes faint so you can see the spot.',
      'Alt frees the grid; the roll and the sequencer take triplets and dotted divisions.',
      'The canvas slides between the timeline and the patch instead of cutting.',
    ],
  },
]

export const LATEST = NEWS[0]?.id ?? ''
export const SEEN_KEY = 'lattice:news-seen'

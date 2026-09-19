/**
 * What's changed, newest first.
 *
 * It ships with the app rather than coming from a server, so a browser that has the new
 * build has the news that goes with it — there's nothing to get out of step. Anything
 * newer than the last entry someone has seen is shown once, when they open lattice.
 *
 * **Features only.** What someone can now do with lattice that they couldn't before, in
 * their words. Nothing from behind the scenes — no infrastructure, no refactors, no
 * publishing or storage work, no fixes for things nobody noticed. If a line doesn't change
 * what a person can do or hear, it doesn't belong in here.
 */
export const NEWS = [
  {
    id: '2026-09-19',
    title: 'Distortion, one octave, and engines that stay in time',
    items: [
      'A **distortion** node: five pedals (overdrive, crunch, rat, fuzz, octave), with a tighten knob that keeps the bass out of the clipping and a mix for parallel drive.',
      'One **octave** for the whole app, shown in the top bar next to the meter. The roll, the patch and an instrument window all move the same number.',
      'Typing plays the instrument you\'re working on even when you\'ve selected its **effects** — its rack, its bus, whatever it runs into.',
      'An engine\'s tempo-synced LFOs follow the **song** now, so a sweep holds its place when you seek or loop.',
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
    ],
  },
  {
    id: '2026-09-17',
    title: 'The timeline, with more give',
    items: [
      'A white outline shows where a clip will land while you drag it, and the clip itself goes faint so you can see the spot.',
      'Alt frees the grid, and the roll and the sequencer take **triplets** and dotted divisions.',
    ],
  },
]

export const LATEST = NEWS[0]?.id ?? ''
export const SEEN_KEY = 'lattice:news-seen'

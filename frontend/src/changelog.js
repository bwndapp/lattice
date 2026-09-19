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
 *
 * A line is a line, not a sentence: name the thing in **bold**, say what it does in a few
 * words, stop. Someone reads this standing up, deciding whether to go and try something.
 *
 * `id` orders the entries and is what a browser remembers having seen, so it only ever
 * grows: two on the same day are `2026-09-19` and `2026-09-19-2`. `date` is what's shown.
 */
export const NEWS = [
  {
    id: '2026-09-19-2',
    date: '2026-09-19',
    title: 'What’s new, when it’s new',
    items: [
      'This — what has changed since you were last here, once, as you arrive',
      'The **file menu** keeps it, with everything older underneath',
    ],
  },
  {
    id: '2026-09-19',
    date: '2026-09-19',
    title: 'Distortion, one octave, engines in time',
    items: [
      '**Distortion** — five pedals: overdrive, crunch, rat, fuzz, octave',
      '**Tighten** keeps the bass out of the clipping · **mix** for parallel drive',
      'One **octave** for the whole app, in the top bar',
      'Typing plays the instrument whose **effects** you\'re on',
      'Synced **LFOs** follow the song, so a sweep keeps its place when you seek',
    ],
  },
  {
    id: '2026-09-18',
    date: '2026-09-18',
    title: 'Tracks have a history you can hear',
    items: [
      'Every track has a **page** of its own',
      '**Hear this** — any save, as it stood',
      '**Branch from here** — that save, as a track of yours',
      'Branches say they\'re branches, and point back',
      'Cards **draw their arrangement**, so the list looks like music',
    ],
  },
  {
    id: '2026-09-17',
    date: '2026-09-17',
    title: 'The timeline, with more give',
    items: [
      'A white **outline** shows where a clip will land',
      '**Alt** frees the grid',
      '**Triplets** and dotted divisions in the roll and the sequencer',
    ],
  },
]

export const LATEST = NEWS[0]?.id ?? ''
export const SEEN_KEY = 'lattice:news-seen'

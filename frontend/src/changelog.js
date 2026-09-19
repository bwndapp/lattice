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
 * Each entry is a release with a number. Numbering starts at 0.1.0, the first release with
 * this list in it; the three before it are numbered back from there, since they happened
 * whether or not anyone was counting. While lattice is 0.x: the middle number moves when
 * there's something new to use, the last one when something already there got better.
 *
 * `id` orders the entries and is what a browser remembers having seen, so it only ever
 * grows: two on the same day are `2026-09-19` and `2026-09-19-2`. `date` is what's shown.
 * The version is for people to say out loud; the id is for the machine.
 */
export const NEWS = [
  {
    id: '2026-09-19-3',
    date: '2026-09-19',
    version: '0.2.0',
    title: 'Pitch, frequency shift, and ducking a group',
    items: [
      '**Pitch** — semitones up or down with the tempo left alone',
      'Its **window** knob: short follows a sound closely and burbles, long is smooth and smears',
      '**Freq shift** — every partial moved by the same hertz, so a note stops being a note',
      'A little of it shimmers and beats · a lot of it makes bells',
      '**Spread** moves the two sides by different amounts, for a swirl',
      'A **sidechain** ducks as many sounds as you wire into it, all pumping together',
      'Clips whose part has left the patch say so, instead of sitting there silent',
      '**Off the patch** in the add pane — put a deleted part back with a click, clips and all',
    ],
  },
  {
    id: '2026-09-19-2',
    date: '2026-09-19',
    version: '0.1.1',
    title: 'What’s new, when it’s new',
    items: [
      'This — what has changed since you were last here, once, as you arrive',
      'The **file menu** keeps it, with everything older underneath',
    ],
  },
  {
    id: '2026-09-19',
    date: '2026-09-19',
    version: '0.1.0',
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
    version: '0.0.9',
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
    version: '0.0.8',
    title: 'The timeline, with more give',
    items: [
      'A white **outline** shows where a clip will land',
      '**Alt** frees the grid',
      '**Triplets** and dotted divisions in the roll and the sequencer',
    ],
  },
]

export const LATEST = NEWS[0]?.id ?? ''
/** What this build of lattice is called. */
export const VERSION = NEWS[0]?.version ?? '0.1.0'
export const SEEN_KEY = 'lattice:news-seen'

# lattice

A node-patch studio for [Strudel](https://strudel.cc). Wire beats, synths and effects
together as nodes, arrange the parts on a timeline, and hear the patch play live in the
browser. Everything you build is a project: one JSON header that the whole app reads and
writes, and that generates the Strudel code underneath.

Live at **[lattice.bwnd.app](https://lattice.bwnd.app)**.

## What's here

| | |
|---|---|
| `frontend/` | the app — React, Vite, React Flow for the patch canvas |
| `frontend/src/project.js` | the data model and the code generator; the format everything else agrees on |
| `frontend/src/graph.js` | node types, what each one is worth in audio, and how the patch becomes code |
| `frontend/src/stereo.js` | bus inserts (filters, drive, comp, lo-fi worklet) as real stereo units |
| `frontend/src/Timeline.jsx` | the arrangement: clips, lanes, automation, the playhead |
| `frontend/src/Browser.jsx` | the catalogue: cards that draw their own arrangement |
| `frontend/src/TrackPage.jsx` | a track's history — every save, what changed at it, who branched off where |
| `src/api/` | FastAPI routes: tracks, saved versions, likes, and the collaboration relay |
| `tools/` | seeding a catalogue for a test environment, and copying live data over it |
| `test/` | the collaboration relay's tests |

## The ideas worth knowing

**A project is one line.** `// @project {…}` at the top of the code holds patterns, nodes,
edges and the song. The UI edits that; the code under it is generated, never the source of
truth. Opening a track regenerates its code from the header, so a track saved by an older
build still plays.

**Effects are bus inserts, not per-voice parameters.** Strudel gives each voice its own
chain in a fixed order; lattice claims an orbit per route and mounts real stereo units on
it, so a chain of effects behaves the way it does in a DAW — in the order you wired it.

**A save is a fixed point.** History only grows: you don't rewind a track, you branch off
the save you want, and the branch records which save it left from. A public track's
history is public, so anyone can hear how it got where it is.

## Running it

```sh
cd frontend && npm install && npm run dev     # the app
```

The API is FastAPI, mounted under `/api`, and expects a SQLite database beside it. The
deployment this repo mirrors serves a draft build and a published one from the same box,
with separate databases for each.

## Licence

lattice is built on Strudel, which is free software under the
[GNU AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html), so lattice is
**AGPL-3.0-or-later** as well — see [LICENSE](LICENSE). That means the source of whatever
is running at lattice.bwnd.app is this repository, and anyone using it is free to read it,
change it and run their own.

Tracks people save with it are their own work; the licence covers the program, not the
music made with it.

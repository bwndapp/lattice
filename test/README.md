# Tests

No framework and no dependencies: everything runs with what's already installed.

**The document** — `node frontend/test/docsync.test.mjs` covers diffing a project edit,
applying it somewhere else and undoing it without touching anyone else's work.
`node frontend/test/three.test.mjs` puts three people through the same changes and checks
they all end up with one track. `node frontend/test/collab.client.test.mjs` drives the
client half of a room against a stubbed socket: seeding, adopting, noticing a gap, going
quiet when the connection drops.

**What you hear** — `node frontend/test/solo.test.mjs` checks that soloing a lane changes
what this browser plays and nothing else, while muting stays the track's own.

**The relay** — start it on a throwaway database and port, then run the suites against it:

    python3 test/relay_serve.py &
    python3 test/relay_presence_test.py   # cursors, selections, which view they're on,
                                          #   joining, leaving, who may open a track
    python3 test/relay_doc_test.py        # seeding, ops, a late arrival, who may edit,
                                          #   and a change aimed at something already gone
    python3 test/relay_play_test.py       # the clock, and where the playhead is going
    python3 test/relay_lock_test.py       # the owner letting others in, or working alone
    python3 test/relay_three_test.py      # three at once, and a cursor storm
    python3 test/relay_invite_test.py     # who may walk in, the invite key, and the live list
    pkill -f relay_serve.py

The harness stands in for the sign-in service: the token `owner` is the track's owner,
anything else is somebody else, and no token at all is a guest.

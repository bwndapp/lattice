#!/usr/bin/env python3
"""Fill the preview database with a busy catalogue: many tracks, many people, branches.

Live has half a dozen tracks, which tells you nothing about how the browser, the tree or
the search behave once there are dozens. This writes a made-up catalogue into
data-draft.db ONLY — live is never opened — so /preview/ looks like a going concern.

Every track is a real project: real step patterns, real notes, real wiring. They play, they
draw their own map on a card, and the diffs between their saves are real diffs. They span
genres so the list isn't ten versions of the same thing.

Seeded rows are owned by `seed:*` accounts, so running it again clears the old batch first
and nothing of anyone's is touched.

    ! python3 tools/seed-preview.py
"""
import json
import random
import sqlite3
import sys
import time
from pathlib import Path

DRAFT = Path(__file__).resolve().parent.parent / "data-draft.db"
DAY = 86400
NOW = int(time.time())
rand = random.Random(20260918)

# ── the people ────────────────────────────────────────────────────────────────
PEOPLE = [
    ("seed:nova", "nova kim"),
    ("seed:pltfrm", "PLTFRM"),
    ("seed:ridley", "ridley"),
    ("seed:kaito", "kaito"),
    ("seed:veil", "mx. veil"),
    ("seed:brut", "BRUTALIST"),
    ("seed:sable", "sable"),
    ("seed:oyster", "oyster boy"),
]

# ── building a project ────────────────────────────────────────────────────────
SPB = 16  # steps per bar


def ids(n=8):
    return "".join(rand.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(n))


def hits(bars, at, every=None):
    """A step list: `at` are the sixteenths inside a bar that fire, repeated every bar."""
    row = [0] * (bars * SPB)
    for bar in range(bars):
        for s in at:
            row[bar * SPB + s] = 1
    if every:  # an extra hit that only lands on some bars: [(bar, step), …]
        for bar, s in every:
            if bar < bars:
                row[bar * SPB + s] = 1
    return row


def drum(name, sound, bank, steps, params=None, fx=""):
    return {"id": ids(10), "kind": "drum", "name": name, "mute": False,
            "params": params or {}, "fx": fx, "sound": sound, "bank": bank, "steps": steps}


def synth(name, sound, notes, params=None, fx="", note="c4"):
    return {"id": ids(10), "kind": "synth", "name": name, "mute": False,
            "params": params or {}, "fx": fx, "sound": sound, "note": note,
            "notes": [{"s": s, "l": l, "n": n} for s, l, n in notes]}


def riff(pattern, bars, root, scale, step=2, length=None):
    """Notes from a shape of scale degrees: (step index, degree or None for a rest)."""
    out = []
    for i, deg in enumerate(pattern):
        if deg is None:
            continue
        s = i * step
        if s >= bars * SPB:
            break
        out.append((s, length or step, root + scale[deg % len(scale)] + 12 * (deg // len(scale))))
    return out


MINOR = [0, 2, 3, 5, 7, 8, 10]
DORIAN = [0, 2, 3, 5, 7, 9, 10]
PENTA = [0, 3, 5, 7, 10]


def chord(at, root, degrees, length, scale=MINOR):
    return [(at, length, root + scale[d % len(scale)] + 12 * (d // len(scale))) for d in degrees]


# ── the genres ────────────────────────────────────────────────────────────────
def techno(bars=2):
    return dict(
        bpm=134, tag="techno",
        parts=[
            ("drums", bars, [
                drum("kick", "bd", "rolandtr909", hits(bars, [0, 4, 8, 12]), {"gain": 1.4, "shape": 0.6}),
                drum("clap", "cp", "rolandtr909", hits(bars, [4, 12]), {"gain": 0.9, "room": 0.2}),
                drum("hat", "hh", "rolandtr909", hits(bars, [2, 6, 10, 14]), {"gain": 0.55}),
                drum("ride", "oh", "rolandtr909", hits(bars, [14]), {"gain": 0.4}),
            ]),
            ("rumble", 2, [synth("sub", "sine", riff([0, None, 0, 0, None, 0, 7, None] * 4, 2, 29, MINOR, 2, 1.8),
                                 {"gain": 1.1, "cutoff": 160}, ".decay(.5).sustain(.2)", "f1")]),
            ("stab", 4, [synth("stab", "sawtooth", chord(0, 65, [0, 2, 4], 3) + chord(24, 65, [0, 2, 5], 3),
                               {"gain": 0.7, "room": 0.3}, ".decay(.2).sustain(0).cutoff(1200)", "f4")]),
        ],
        fx=[("saturator", {"drive": 2.4, "character": "warm"}), ("clipper", {"push": 0.35, "ceiling": 0.92})],
    )


def dnb(bars=2):
    return dict(
        bpm=174, tag="drum & bass",
        parts=[
            ("break", bars, [
                drum("kick", "bd", "rolandtr808", hits(bars, [0, 10]), {"gain": 1.3}),
                drum("snare", "sd", "rolandtr808", hits(bars, [4, 12], [(1, 14)]), {"gain": 1.1, "room": 0.18}),
                drum("hat", "hh", "rolandtr909", hits(bars, [2, 6, 7, 10, 14, 15]), {"gain": 0.4}),
            ]),
            ("reese", 2, [synth("reese", "sawtooth", riff([0, 0, None, 5, None, 3, None, None] * 4, 2, 29, MINOR, 2, 3),
                                {"gain": 1.0, "cutoff": 420}, ".decay(.9).sustain(.6).detune(.3)", "f1")]),
            ("pad", 4, [synth("pad", "triangle", chord(0, 65, [0, 2, 4, 6], 32) + chord(32, 63, [0, 2, 4], 32),
                              {"gain": 0.5, "room": 0.6}, ".attack(.6).sustain(.8)", "f4")]),
        ],
        fx=[("eq3", {"low": -1.5, "high": 1.5}), ("reverb", {"mix": 0.22, "size": 3.4})],
    )


def house(bars=2):
    return dict(
        bpm=124, tag="deep house",
        parts=[
            ("drums", bars, [
                drum("kick", "bd", "rolandtr909", hits(bars, [0, 4, 8, 12]), {"gain": 1.25}),
                drum("clap", "cp", "rolandtr707", hits(bars, [4, 12]), {"gain": 0.8, "room": 0.28}),
                drum("open", "oh", "rolandtr909", hits(bars, [2, 6, 10, 14]), {"gain": 0.5}),
                drum("shake", "hh", "rolandtr707", hits(bars, [1, 3, 5, 7, 9, 11, 13, 15]), {"gain": 0.22}),
            ]),
            ("keys", 4, [synth("rhodes", "gm_epiano1",
                               chord(0, 60, [0, 2, 4, 6], 12) + chord(16, 58, [0, 2, 4, 6], 12)
                               + chord(32, 63, [0, 2, 4], 12) + chord(48, 60, [0, 2, 4, 6], 14),
                               {"gain": 0.8, "room": 0.35}, ".attack(.02).sustain(.7)", "c4")]),
            ("bass", 2, [synth("bass", "sine", riff([0, None, 0, 4, None, 0, None, 2] * 4, 2, 36, DORIAN, 2, 1.6),
                               {"gain": 1.0}, ".decay(.3).sustain(.1)", "c2")]),
        ],
        fx=[("filter", {"cutoff": 8000}), ("saturator", {"drive": 1.4, "character": "tape"})],
    )


def ambient(bars=4):
    return dict(
        bpm=68, tag="ambient",
        parts=[
            ("drift", 4, [synth("pad", "triangle",
                                chord(0, 57, [0, 2, 4], 48) + chord(48, 60, [0, 3, 5], 32) + chord(80, 55, [0, 2, 6], 48),
                                {"gain": 0.6, "room": 0.9}, ".attack(2).release(4).sustain(.9)", "a3")]),
            ("bells", 4, [synth("bell", "gm_music_box", riff([0, None, None, 4, None, 6, None, None, 2] * 3, 4, 72, PENTA, 8, 6),
                                {"gain": 0.45, "room": 0.7, "delay": 0.4}, ".decay(2).sustain(0)", "c5")]),
            ("pulse", 2, [drum("tick", "hh", "rolandtr808", hits(2, [0, 8]), {"gain": 0.18, "room": 0.5})]),
        ],
        fx=[("reverb", {"mix": 0.55, "size": 7.5, "tone": 0.4}), ("eq3", {"low": -2})],
    )


def boombap(bars=2):
    return dict(
        bpm=88, tag="hip hop",
        parts=[
            ("break", bars, [
                drum("kick", "bd", "rolandtr808", hits(bars, [0, 7, 10]), {"gain": 1.3, "shape": 0.3}),
                drum("snare", "sd", "rolandtr808", hits(bars, [4, 12]), {"gain": 1.0, "room": 0.22}),
                drum("hat", "hh", "rolandtr808", hits(bars, [0, 3, 4, 6, 8, 11, 12, 14]), {"gain": 0.35}),
            ]),
            ("keys", 4, [synth("rhodes", "gm_epiano1",
                               chord(0, 57, [0, 2, 4, 6], 14) + chord(16, 62, [0, 2, 4], 14)
                               + chord(32, 60, [0, 2, 5], 14) + chord(48, 55, [0, 2, 4, 6], 14),
                               {"gain": 0.75, "room": 0.4}, ".attack(.01).sustain(.6)", "a3")]),
            ("upright", 2, [synth("bass", "gm_acoustic_bass", riff([0, None, None, 4, None, 2, None, None] * 4, 2, 33, MINOR, 2, 2.4),
                                  {"gain": 1.0}, ".decay(.4).sustain(.2)", "a1")]),
        ],
        fx=[("lofi", {"bits": 11, "rate": 0.5}), ("eq3", {"high": -2, "low": 1.5})],
    )


def trance(bars=2):
    return dict(
        bpm=138, tag="trance",
        parts=[
            ("drums", bars, [
                drum("kick", "bd", "rolandtr909", hits(bars, [0, 4, 8, 12]), {"gain": 1.35}),
                drum("open", "oh", "rolandtr909", hits(bars, [2, 6, 10, 14]), {"gain": 0.55}),
                drum("clap", "cp", "rolandtr909", hits(bars, [12]), {"gain": 0.8}),
            ]),
            ("roll", 2, [synth("bass", "sawtooth", riff([0] * 32, 2, 33, MINOR, 1, 0.8),
                               {"gain": 0.95, "cutoff": 300}, ".decay(.12).sustain(0)", "a1")]),
            ("arp", 4, [synth("arp", "sawtooth", riff([0, 2, 4, 6, 4, 2, 7, 4] * 8, 4, 69, MINOR, 2, 1.5),
                              {"gain": 0.6, "room": 0.45, "delay": 0.3}, ".decay(.25).sustain(.1).cutoff(3000)", "a4")]),
        ],
        fx=[("reverb", {"mix": 0.3, "size": 4.5}), ("saturator", {"drive": 1.8})],
    )


def dubtechno(bars=4):
    return dict(
        bpm=120, tag="dub techno",
        parts=[
            ("drums", 2, [
                drum("kick", "bd", "rolandtr909", hits(2, [0, 4, 8, 12]), {"gain": 1.2, "shape": 0.4}),
                drum("hat", "hh", "rolandtr909", hits(2, [2, 6, 10, 14]), {"gain": 0.3}),
                drum("rim", "rim", "rolandtr808", hits(2, [], [(1, 6)]), {"gain": 0.5, "room": 0.4}),
            ]),
            ("chord", 4, [synth("stab", "sawtooth",
                                chord(6, 60, [0, 2, 4], 2) + chord(22, 60, [0, 2, 4], 2)
                                + chord(38, 58, [0, 2, 4], 2) + chord(54, 58, [0, 2, 4], 2),
                                {"gain": 0.55, "room": 0.8, "delay": 0.55},
                                ".decay(.35).sustain(0).cutoff(900)", "c4")]),
            ("sub", 2, [synth("sub", "sine", riff([0, None, None, None, 5, None, None, None] * 4, 2, 29, MINOR, 2, 3.5),
                              {"gain": 1.05}, ".decay(.8).sustain(.4)", "f1")]),
        ],
        fx=[("delay", {"mix": 0.5, "time": "1/8 dotted", "feedback": 0.6, "mode": "ping-pong"}),
            ("reverb", {"mix": 0.35, "size": 5})],
    )


def breaks(bars=2):
    return dict(
        bpm=142, tag="breakbeat",
        parts=[
            ("break", bars, [
                drum("kick", "bd", "rolandtr808", hits(bars, [0, 6, 10]), {"gain": 1.3}),
                drum("snare", "sd", "rolandtr909", hits(bars, [4, 12], [(1, 15)]), {"gain": 1.05}),
                drum("hat", "hh", "rolandtr909", hits(bars, [2, 3, 6, 8, 11, 14]), {"gain": 0.4}),
            ]),
            ("bass", 2, [synth("bass", "square", riff([0, None, 5, None, 3, None, 0, None] * 4, 2, 33, MINOR, 2, 1.6),
                               {"gain": 0.95, "cutoff": 700}, ".decay(.25).sustain(.1)", "a1")]),
            ("lead", 4, [synth("lead", "gm_lead_2_sawtooth", riff([0, 4, 2, None, 5, None, 4, 2] * 4, 4, 69, PENTA, 4, 3),
                               {"gain": 0.6, "room": 0.4}, ".decay(.4).sustain(.2)", "a4")]),
        ],
        fx=[("saturator", {"drive": 2.1}), ("eq3", {"low": 1.5, "high": 1})],
    )


def footwork(bars=2):
    return dict(
        bpm=160, tag="footwork",
        parts=[
            ("drums", bars, [
                drum("kick", "bd", "rolandtr808", hits(bars, [0, 3, 6, 9, 12]), {"gain": 1.3}),
                drum("clap", "cp", "rolandtr808", hits(bars, [8]), {"gain": 0.9}),
                drum("rim", "rim", "rolandtr808", hits(bars, [2, 5, 11, 14]), {"gain": 0.5}),
            ]),
            ("sub", 2, [synth("sub", "sine", riff([0, None, None, 0, None, None, 3, None] * 4, 2, 29, PENTA, 2, 2.6),
                              {"gain": 1.1}, ".decay(.6).sustain(.3)", "f1")]),
            ("vox", 4, [synth("chop", "gm_choir_aahs", riff([0, 2, None, 4, None, 2, 0, None] * 4, 4, 72, PENTA, 4, 2),
                              {"gain": 0.5, "room": 0.3}, ".decay(.3).sustain(.1)", "c5")]),
        ],
        fx=[("clipper", {"push": 0.45}), ("filter", {"cutoff": 9000})],
    )


def lofi(bars=2):
    return dict(
        bpm=82, tag="lo-fi",
        parts=[
            ("drums", bars, [
                drum("kick", "bd", "rolandtr707", hits(bars, [0, 9]), {"gain": 1.1, "shape": 0.2}),
                drum("snare", "sd", "rolandtr707", hits(bars, [4, 12]), {"gain": 0.85, "room": 0.3}),
                drum("hat", "hh", "rolandtr707", hits(bars, [2, 6, 10, 14]), {"gain": 0.28}),
            ]),
            ("keys", 4, [synth("piano", "gm_epiano2",
                               chord(0, 60, [0, 2, 4, 6], 15) + chord(16, 57, [0, 2, 4, 6], 15)
                               + chord(32, 62, [0, 2, 4], 15) + chord(48, 59, [0, 2, 4, 6], 15),
                               {"gain": 0.7, "room": 0.45}, ".attack(.02).sustain(.7)", "c4")]),
            ("bass", 2, [synth("bass", "gm_acoustic_bass", riff([0, None, None, None, 4, None, 2, None] * 4, 2, 36, DORIAN, 2, 2.8),
                               {"gain": 0.95}, ".decay(.5).sustain(.3)", "c2")]),
        ],
        fx=[("lofi", {"bits": 9, "rate": 0.35}), ("eq3", {"high": -3.5}), ("saturator", {"drive": 1.3, "character": "tape"})],
    )


GENRES = [techno, dnb, house, ambient, boombap, trance, dubtechno, breaks, footwork, lofi]

TITLES = {
    "techno": ["CONCRETE SUNRISE", "TUNNEL 7", "hard floor", "NIGHT SHIFT", "grey area"],
    "drum & bass": ["ROLLER", "steel city", "HALF LIGHT", "amen for the road"],
    "deep house": ["late shift", "COASTLINE", "sunday morning dub", "marble"],
    "ambient": ["slow weather", "GLASS FIELDS", "two hours of light", "tide table"],
    "hip hop": ["dusty tape", "CORNER STORE", "88 keys", "brown paper"],
    "trance": ["ALTITUDE", "long way up", "SIGNAL FIRE", "vapour trail"],
    "dub techno": ["BASIC CHANNEL 3AM", "chain of echoes", "grey rain", "MAURITIUS"],
    "breakbeat": ["bad weather", "SKATE PARK", "cut up", "FUNK SOUL"],
    "footwork": ["JUKE IT", "battle ready", "160 forever", "TEKLIFE"],
    "lo-fi": ["rain on the window", "STUDY HALL", "cassette warmth", "sleepy"],
}


def build(genre_fn, seed_bars=2, drop=0):
    """A whole project: patterns, a patch that wires them up, and an arrangement."""
    g = genre_fn()
    patterns, nodes, edges, clips, colors = [], [], [], [], {}
    out_id = "out"
    nodes.append({"id": out_id, "type": "output", "x": 900, "y": 0, "data": {"muted": {}, "solo": None}})
    rack_id = "fxrack" + ids(5)
    nodes.append({"id": rack_id, "type": "fxrack", "x": 520, "y": 0, "data": {
        "chain": [{"id": "fx" + ids(6), "type": t, "on": True, "data": d} for t, d in g["fx"]]}})
    edges.append({"id": f"e_{rack_id}_{out_id}", "source": rack_id, "target": out_id, "targetHandle": "in-1"})

    palette = ["#e4ff1a", "#86d8cc", "#c8a2ff", "#ffb347", "#ff8fa3", "#9fb4ff", "#b9c96a"]
    keep = g["parts"][: len(g["parts"]) - drop]
    for i, (name, bars, channels) in enumerate(keep):
        pid = ids(9)
        patterns.append({"id": pid, "name": name, "bars": bars, "stepsPerBar": SPB, "channels": channels})
        colors[f"pattern:{pid}"] = palette[i % len(palette)]
        node_id = "pattern" + ids(5)
        nodes.append({"id": node_id, "type": "pattern", "x": 80, "y": i * 170 - 170, "data": {"patternId": pid, "offMain": {}}})
        edges.append({"id": f"e_{node_id}_{rack_id}", "source": node_id, "target": rack_id, "targetHandle": "in"})
        # an arrangement: each part comes in later than the one before and runs to the end
        start = [0, 8, 16, 24][i % 4]
        span = 32 - start
        clips.append({"id": "c" + ids(9), "src": f"pattern:{pid}", "lane": i, "start": start, "len": span})
        if i == 0 and start == 0:  # the drums drop out for a bar before the last eight
            clips[-1]["len"] = 23
            clips.append({"id": "c" + ids(9), "src": f"pattern:{pid}", "lane": i, "start": 24, "len": 8})

    return {
        "v": 3, "bpm": g["bpm"], "beats": 4,
        "patterns": patterns, "nodes": nodes, "edges": edges,
        "song": {"on": True, "snap": "bar", "clips": clips, "autos": [], "colors": colors},
    }, g["tag"]


def code_of(project):
    return "// @project " + json.dumps(project, separators=(",", ":")) + "\n// made for the preview catalogue\n"


def earlier(project, stage):
    """The same track a few saves back: fewer parts on the timeline, a rougher tempo."""
    p = json.loads(json.dumps(project))
    p["bpm"] = project["bpm"] + (2 if stage == 0 else 1 if stage == 1 else 0)
    keep = len(p["patterns"]) - (2 if stage == 0 else 1 if stage == 1 else 0)
    keep = max(1, keep)
    alive = {f"pattern:{x['id']}" for x in p["patterns"][:keep]}
    p["song"]["clips"] = [c for c in p["song"]["clips"] if c["src"] in alive]
    for c in p["song"]["clips"]:
        c["len"] = max(4, round(c["len"] * (0.5 if stage == 0 else 0.75 if stage == 1 else 1)))
    return p


def main():
    if not DRAFT.exists():
        sys.exit(f"no preview database at {DRAFT} — open /preview/ once so it gets made")
    conn = sqlite3.connect(str(DRAFT))
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    old = [r["id"] for r in cur.execute("SELECT id FROM tracks WHERE owner_sub LIKE 'seed:%'")]
    if old:
        marks = ",".join("?" * len(old))
        cur.execute(f"DELETE FROM track_versions WHERE track_id IN ({marks})", old)
        cur.execute(f"DELETE FROM likes WHERE track_id IN ({marks})", old)
        cur.execute(f"DELETE FROM tracks WHERE id IN ({marks})", old)
        print(f"cleared {len(old)} tracks from the last batch")

    made = []  # (id, owner_sub, project, created_at, updated_at, version_times)
    order = [(fn, t) for fn in GENRES for t in range(3)]
    rand.shuffle(order)
    for n, (fn, variant) in enumerate(order):
        project, tag = build(fn, drop=variant % 2)
        sub, author = PEOPLE[n % len(PEOPLE)]
        title = TITLES[tag][variant % len(TITLES[tag])]
        if variant >= len(TITLES[tag]):
            title = f"{title} {variant + 1}"
        made_at = NOW - rand.randint(3, 45) * DAY
        saves = sorted(rand.sample(range(0, 40), rand.randint(2, 4)))
        times = [made_at + s * (DAY // 2) for s in saves]
        updated = times[-1]
        track_id = "sd" + ids(6)
        cur.execute(
            "INSERT INTO tracks (id, owner_sub, author, author_id, title, code, visibility, forked_from,"
            " forked_at, likes, plays, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (track_id, sub, author, "", title, code_of(project), "public", None, made_at,
             rand.randint(0, 34), rand.randint(2, 480), made_at, updated))
        for i, at in enumerate(times):
            stage = i if i < 2 else 2
            body = project if i == len(times) - 1 else earlier(project, stage)
            cur.execute("INSERT INTO track_versions (track_id, title, code, saved_at) VALUES (?,?,?,?)",
                        (track_id, title, code_of(body), at))
        made.append((track_id, sub, project, title, times))

    # ── branches: someone takes a track at one of its saves and goes elsewhere ──
    branches = 0
    for parent_id, parent_sub, project, title, times in rand.sample(made, 12):
        for _ in range(rand.randint(1, 2)):
            sub, author = rand.choice([p for p in PEOPLE if p[0] != parent_sub])
            at = rand.choice(times)  # the save they left from
            child = json.loads(json.dumps(project))
            child["bpm"] = project["bpm"] + rand.choice([-6, -4, 4, 6, 8])
            for c in child["song"]["clips"]:  # they moved things around
                c["start"] = max(0, c["start"] + rand.choice([-8, 0, 0, 8]))
            made_at = at + rand.randint(1, 20) * DAY
            if made_at > NOW:
                made_at = NOW - DAY
            kid = "sd" + ids(6)
            kid_title = f"{title} ({rand.choice(['edit', 'rework', 'vip', 'remix', 'slowed'])})"[:80]
            cur.execute(
                "INSERT INTO tracks (id, owner_sub, author, author_id, title, code, visibility, forked_from,"
                " forked_at, likes, plays, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (kid, sub, author, "", kid_title, code_of(child), "public", parent_id, at,
                 rand.randint(0, 12), rand.randint(1, 160), made_at, made_at + rand.randint(0, 6) * DAY))
            cur.execute("INSERT INTO track_versions (track_id, title, code, saved_at) VALUES (?,?,?,?)",
                        (kid, kid_title, code_of(child), made_at))
            branches += 1

    conn.commit()
    n = cur.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
    v = cur.execute("SELECT COUNT(*) FROM track_versions").fetchone()[0]
    conn.close()
    print(f"seeded {len(made)} tracks and {branches} branches across {len(GENRES)} genres")
    print(f"preview now holds {n} tracks and {v} saves")
    print("live (data.db) was not opened")


if __name__ == "__main__":
    main()

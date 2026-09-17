"""Working on a track together: who else is here, where they are, and the track itself.

One websocket per open track, mounted at /api/collab/{track_id} (draft:
/preview/api/collab/{track_id}). The server is a relay with one memory: while at least one
person is in a room it holds that track's project and the order changes happened in.
Nothing is written to the database — saving a track is still the person's own decision,
and an empty room forgets everything, so an abandoned session can never come back to life
and overwrite what was saved.

Messages are JSON text frames.

  presence (anyone who can open the track)
    → {"t":"hello","token":"<sso access token>","name":"..."}   first frame, always
    → {"t":"at","where":"graph","x":120,"y":40}                 the pointer moved
    → {"t":"sel","where":"graph","ids":["n1","n2"]}             what they have selected
    ← {"t":"me","id":3,"color":"#e8b","edit":true}              who the server thinks you are
    ← {"t":"here","peers":[...]} · {"t":"join"|"at"|"sel"|"gone", ...}

  the track itself (anyone signed in — see _may_edit)
    ← {"t":"seed"}                       you're first in: send what you have
    → {"t":"doc","doc":{...}}            here it is
    ← {"t":"doc","doc":{...},"v":12}     what the room already has, for a late arrival
    → {"t":"ops","ops":[...],"h":"5f2a"} what I just changed, and my fingerprint after it
    ← {"t":"ops","id":3,"ops":[...],"v":13,"h":"5f2a"}
    → {"t":"sync"}                       I'm lost, send me the whole thing

  playing in time (also editors only)
    → {"t":"time","c":<the client's clock>}        ← {"t":"time","c":...,"s":<the server's>}
    → {"t":"play","on":true,"pos":12.5,"cps":0.58} ← {"t":"play","id":3,...,"at":<server ms>}

Ops are the ones frontend/src/docsync.js makes, applied here by _docsync.py under the same
rules, so every copy ends up the same. `v` counts changes: a client that sees a gap asks
for the whole track rather than guessing what it missed.

Coordinates are the surface's own, not pixels: the patch canvas sends flow x/y, the
timeline sends bars and rows, the piano roll sends bars and midi notes. Whoever draws the
cursor converts, so it lands in the same place at any zoom or scroll.

A private track only lets its owner in; anyone who can open a track can be present on it,
signed in or not. Changing one needs a sign-in, nothing more: a shared link is an
invitation to work on it together. Saving is still the owner's alone, so nothing anyone
does in a room can overwrite the version they keep.
"""
import asyncio
import json
import time

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from incubator_lib import current_env, db, sso_user, use_env

# The server imports a route file by path, not as part of a package, and the draft and live
# copies must not share one module: load our own helper explicitly, named for this file.
import importlib.util as _imp
import pathlib as _pl
_spec = _imp.spec_from_file_location(f"_docsync_{__name__}", _pl.Path(__file__).with_name("_docsync.py"))
_docsync = _imp.module_from_spec(_spec)
_spec.loader.exec_module(_docsync)
apply_ops = _docsync.apply_ops

router = APIRouter()

MAX_PEERS = 24          # a room bigger than this isn't a jam, it's a broadcast
MAX_MSG = 4096          # a cursor message is ~80 bytes; anything huge is a mistake
MAX_DOC = 2_000_000     # a whole project, which is JSON and compresses well over the wire
MAX_OPS = 200_000       # one edit's worth of changes
RATE = 60               # messages a second per peer, beyond which we stop listening
COLORS = ["#6cc9ff", "#ff8fb1", "#8de88d", "#ffcf6b", "#c79bff", "#5ee0cf", "#ff9e6b", "#a8b6ff"]


class Peer:
    __slots__ = ("id", "ws", "name", "color", "at", "sel", "sub", "edit")

    def __init__(self, pid, ws, name, color, sub, edit):
        self.id = pid
        self.ws = ws
        self.name = name
        self.color = color
        self.sub = sub
        self.edit = edit
        self.at = None
        self.sel = None

    def public(self):
        return {"id": self.id, "name": self.name, "color": self.color, "at": self.at, "sel": self.sel, "edit": self.edit}


class Room:
    """Everyone on one track, and the track as they have it. Rooms live only as long as
    someone is in them: the database is still only written by saving."""

    def __init__(self):
        self.peers = {}
        self.next_id = 1
        self.doc = None      # the project, once somebody has sent theirs
        self.version = 0     # how many changes have been applied

    def color_for(self):
        taken = {p.color for p in self.peers.values()}
        for c in COLORS:
            if c not in taken:
                return c
        return COLORS[len(self.peers) % len(COLORS)]

    async def send(self, peer, msg):
        try:
            await peer.ws.send_text(msg)
        except Exception:
            pass  # a dropped connection is cleaned up by its own task

    async def tell_others(self, sender_id, payload):
        msg = json.dumps(payload)
        await asyncio.gather(*(self.send(p, msg) for p in list(self.peers.values()) if p.id != sender_id))

    async def tell_editors(self, sender_id, payload):
        msg = json.dumps(payload)
        await asyncio.gather(*(self.send(p, msg) for p in list(self.peers.values()) if p.id != sender_id and p.edit))


_rooms: dict[str, Room] = {}


def _env_of(ws):
    """Draft or live, from the path. The server's middleware only does this for http, so a
    websocket has to say for itself which database it belongs to — without this, the draft
    page's room would look its track up in the live site's tracks and never find it."""
    path = ws.scope.get("path", "") or ""
    return "draft" if path.startswith("/preview/") else "live"


def _track(track_id, env):
    try:
        with use_env(env):
            return db().execute("SELECT owner_sub, visibility FROM tracks WHERE id = ?", (track_id,)).fetchone()
    except Exception:
        return None


def _may_open(row, user):
    """Anyone can be present on a public or unlisted track; private is the owner's."""
    if not row:
        return False
    return row["visibility"] != "private" or (user and user.get("sub") == row["owner_sub"])


def _may_edit(row, user):
    """Who may change the track live: anyone signed in who can open it.

    Working on a track together is the point, and a link is how people get to one. Being
    signed in is the whole gate — a name to put on a cursor and an account behind the
    change — while saving stays the owner's alone (see tracks.py), so a session can be
    shared without anyone being able to overwrite what the owner has kept. Someone who
    isn't signed in watches: cursors, no changes, and never a copy of the document."""
    return bool(row and user and _may_open(row, user))


def _clean_name(raw, user):
    name = (user or {}).get("given_name") or (user or {}).get("name") or (raw or "")
    name = " ".join(str(name).split())[:24]
    return name or "guest"


@router.websocket("/{track_id}")
async def collab(ws: WebSocket, track_id: str):
    await ws.accept()
    peer = None
    room = None
    try:
        hello = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=10))
        if hello.get("t") != "hello":
            await ws.close(code=4000)
            return
        # verifying a token calls the issuer, so keep it off the event loop
        token = str(hello.get("token") or "")[:4096]
        user = await asyncio.to_thread(sso_user, token) if token else None
        row = await asyncio.to_thread(_track, track_id, _env_of(ws))
        if not row:
            await ws.close(code=4004)
            return
        if not _may_open(row, user):
            await ws.close(code=4003)
            return
        room_key = f"{_env_of(ws)}:{track_id}"
        room = _rooms.setdefault(room_key, Room())
        if len(room.peers) >= MAX_PEERS:
            await ws.close(code=4008)
            return
        edit = _may_edit(row, user)
        peer = Peer(room.next_id, ws, _clean_name(hello.get("name"), user), room.color_for(), (user or {}).get("sub"), edit)
        room.next_id += 1
        await ws.send_text(json.dumps({"t": "me", "id": peer.id, "color": peer.color, "name": peer.name, "edit": edit}))
        await ws.send_text(json.dumps({"t": "here", "peers": [p.public() for p in room.peers.values()]}))
        await room.tell_others(peer.id, {"t": "join", "peer": peer.public()})
        room.peers[peer.id] = peer
        if edit:
            # the room's copy if there is one, otherwise this is the session and we want theirs
            if room.doc is None:
                await ws.send_text(json.dumps({"t": "seed"}))
            else:
                await ws.send_text(json.dumps({"t": "doc", "doc": room.doc, "v": room.version}))

        window, count = time.monotonic(), 0
        while True:
            raw = await ws.receive_text()
            now = time.monotonic()
            if now - window > 1:
                window, count = now, 0
            count += 1
            big = len(raw) > MAX_MSG
            if count > RATE or len(raw) > MAX_DOC:
                continue  # too much, too fast: drop it rather than pass it on
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            kind = msg.get("t")
            if big and kind not in ("doc", "ops"):
                continue  # only the track itself has any business being large
            if kind == "at":
                peer.at = None if msg.get("where") is None else {"where": msg.get("where"), "x": msg.get("x"), "y": msg.get("y")}
                await room.tell_others(peer.id, {"t": "at", "id": peer.id, **(peer.at or {"where": None})})
            elif kind == "sel":
                ids = [str(i)[:40] for i in (msg.get("ids") or [])][:60]
                peer.sel = {"where": msg.get("where"), "ids": ids} if ids else None
                await room.tell_others(peer.id, {"t": "sel", "id": peer.id, "where": msg.get("where"), "ids": ids})
            elif kind == "doc" and peer.edit:
                # the first editor in seeds the room; after that the room's copy is the one
                doc = msg.get("doc")
                if room.doc is None and isinstance(doc, dict):
                    room.doc = doc
                    room.version = 1
                    await ws.send_text(json.dumps({"t": "ack", "v": room.version}))
                    await room.tell_editors(peer.id, {"t": "doc", "doc": room.doc, "v": room.version})
            elif kind == "ops" and peer.edit:
                ops = msg.get("ops")
                if room.doc is None or not isinstance(ops, list) or not ops or len(raw) > MAX_OPS:
                    continue
                if apply_ops(room.doc, ops) == 0:
                    continue
                room.version += 1
                # the sender counts changes too, so it can tell a gap from its own edit
                await ws.send_text(json.dumps({"t": "ack", "v": room.version}))
                await room.tell_editors(peer.id, {"t": "ops", "id": peer.id, "ops": ops, "v": room.version, "h": msg.get("h")})
            elif kind == "sync" and peer.edit:
                if room.doc is not None:
                    await ws.send_text(json.dumps({"t": "doc", "doc": room.doc, "v": room.version}))
            elif kind == "time":
                # what time the server makes it, so a follower can work out the offset
                # between its clock and everyone else's (the round trip is measured there)
                await ws.send_text(json.dumps({"t": "time", "c": msg.get("c"), "s": time.time() * 1000}))
            elif kind == "play" and peer.edit:
                # where the song is, and when: whoever hits play says so, everyone else lines up
                await room.tell_editors(peer.id, {
                    "t": "play",
                    "id": peer.id,
                    "on": bool(msg.get("on")),
                    "pos": msg.get("pos"),
                    "cps": msg.get("cps"),
                    "at": time.time() * 1000,  # stamped here, so it needs no clock of its own
                })
            elif kind == "ping":
                await ws.send_text('{"t":"pong"}')
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError):
        pass
    except Exception:
        pass
    finally:
        if room is not None and peer is not None:
            room.peers.pop(peer.id, None)
            await room.tell_others(peer.id, {"t": "gone", "id": peer.id})
            if not room.peers:
                _rooms.pop(room_key, None)  # nobody left: the room forgets, the saved track stands
        try:
            await ws.close()
        except Exception:
            pass


@router.get("/{track_id}/who")
async def who(request: Request, track_id: str):
    """Who's on a track right now, for a page that isn't holding a socket open."""
    room = _rooms.get(f"{current_env()}:{track_id}")
    return {"peers": [{"name": p.name, "color": p.color} for p in (room.peers.values() if room else [])]}

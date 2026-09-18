"""Working on a track together: who else is here, where they are, and the track itself.

One websocket per open track, mounted at /api/collab/{track_id} (draft:
/preview/api/collab/{track_id}). The server is a relay with one memory: while at least one
person is in a room it holds that track's project and the order changes happened in.
Nothing is written to the database — saving a track is still the person's own decision,
and an empty room forgets everything, so an abandoned session can never come back to life
and overwrite what was saved.

Messages are JSON text frames.

  presence (anyone who can open the track)
    → {"t":"hello","token":"<sso access token>","name":"...","join":"<invite key>"}
    → {"t":"at","where":"graph","x":120,"y":40}                 the pointer moved
    → {"t":"sel","where":"graph","ids":["n1","n2"]}             what they have selected
    → {"t":"view","v":"song"}                                   which view they're on
    ← {"t":"me","id":3,"color":"#e8b","bot":"9f3a...","edit":true}   who the server thinks you are
       (`bot` is a stable hash of the account: every face they wear is drawn from it)
    ← {"t":"here","peers":[...]} · {"t":"join"|"at"|"sel"|"view"|"gone", ...}

  the track itself (everyone present receives it; only the signed in may send — see _may_edit)
    ← {"t":"seed"}                       you're first in, and may edit: send what you have
    → {"t":"doc","doc":{...}}            here it is
    ← {"t":"doc","doc":{...},"v":12}     what the room already has, for a late arrival
    → {"t":"ops","ops":[...],"h":"5f2a"} what I just changed, and my fingerprint after it
    ← {"t":"ops","id":3,"ops":[...],"v":13,"h":"5f2a"}   to everyone, the sender included
    ← {"t":"nope","v":13}                none of it landed here; stop waiting for it
    → {"t":"sync"}                       I'm lost, send me the whole thing
    → {"t":"same","v":13,"h":"5f2a"}     this is what I have, when it's all gone quiet
    ← {"t":"same","id":3,"v":13,"h":"5f2a"}

  the owner deciding who may walk in at all
    → {"t":"jam","mode":"invite","roll":true}   owner only; `roll` mints a fresh key
    ← {"t":"jam","mode":"invite","key":"..."}   the key, to the owner alone

  the owner deciding whether anyone else may join in
    → {"t":"lock","on":false}             owner only; remembered on the track
    ← {"t":"role","edit":false,"open":false}   what you may do now
    ← {"t":"open","on":false}                  what the track is set to now

  playing in time (also editors only)
    → {"t":"time","c":<the client's clock>}        ← {"t":"time","c":...,"s":<the server's>}
    → {"t":"play","on":true,"pos":12.5,"cps":0.58} ← {"t":"play","id":3,...,"at":<server ms>}
    The room keeps the last of these and hands it to anyone arriving while it plays, so
    joining in the middle sounds like joining in the middle.

Ops are the ones frontend/src/docsync.js makes, applied here by _docsync.py under the same
rules, so every copy ends up the same. `v` counts changes: a client that sees a gap asks
for the whole track rather than guessing what it missed.

Coordinates are the surface's own, not pixels: the patch canvas sends flow x/y, the
timeline sends bars and rows, the piano roll sends bars and midi notes. Whoever draws the
cursor converts, so it lands in the same place at any zoom or scroll.

A private track lets its owner in, and anyone holding an invite link the owner made for it;
anyone who can open a public or unlisted track can be present on it, signed in or not. Changing one needs a sign-in, nothing more: a shared link is an
invitation to work on it together. Saving is still the owner's alone, so nothing anyone
does in a room can overwrite the version they keep.

Someone who isn't signed in watches, and watching is read-only rather than blind: they get
the room's copy of the track, the edits as they land and the playhead as it moves, and they
can send none of it. The room's copy includes work nobody has saved yet, which is the point
— a room is people working on something before it's finished — so a track whose progress
shouldn't be on show to a link-holder wants to be private, where nobody else gets in at
all.
"""
import asyncio
import hashlib
import json
import secrets
import time

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from incubator_lib import db, sso_user, use_env

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
# Two budgets, not one. A pointer moving at 60 frames a second would otherwise use up a
# shared allowance and take an edit down with it — and a dropped cursor is nothing, while a
# dropped edit is two people looking at different tracks and not being told.
CURSORS = 45            # cursor and selection messages a second, beyond which they're dropped
EDITS = 30              # everything else: far more than a person can do, so it means trouble
COLORS = ["#6cc9ff", "#ff8fb1", "#8de88d", "#ffcf6b", "#c79bff", "#5ee0cf", "#ff9e6b", "#a8b6ff"]


class Peer:
    __slots__ = ("id", "ws", "name", "color", "at", "sel", "sub", "edit", "view", "bot")

    def __init__(self, pid, ws, name, color, sub, edit, bot):
        self.id = pid
        self.ws = ws
        self.name = name
        self.color = color
        self.bot = bot
        self.sub = sub
        self.edit = edit
        self.at = None
        self.sel = None
        self.view = None  # which of the app's views they're looking at

    def public(self):
        return {"id": self.id, "name": self.name, "color": self.color, "bot": self.bot,
                "at": self.at, "sel": self.sel, "edit": self.edit, "view": self.view}


class Room:
    """Everyone on one track, and the track as they have it. Rooms live only as long as
    someone is in them: the database is still only written by saving."""

    def __init__(self):
        self.peers = {}
        self.next_id = 1
        self.doc = None      # the project, once somebody has sent theirs
        self.version = 0     # how many changes have been applied
        self.play = None     # the last thing said about the transport, stamped when it was said
        self.open = True     # whether anyone but the owner may change it (the owner's call)
        self.jam = "open"    # whether anyone may walk in, or only with an invite

    def color_for(self, bot):
        """Their own colour, unless somebody in this room already has it.

        The point of deriving it from who they are is that a person looks the same wherever
        you run into them. The point of moving aside on a clash is that two faces in one
        room have to be told apart, and that matters more for the few seconds it applies."""
        taken = {p.color for p in self.peers.values()}
        start = int(bot[:4], 16) % len(COLORS)
        for i in range(len(COLORS)):
            c = COLORS[(start + i) % len(COLORS)]
            if c not in taken:
                return c
        return COLORS[start]

    async def send(self, peer, msg):
        try:
            await peer.ws.send_text(msg)
        except Exception:
            pass  # a dropped connection is cleaned up by its own task

    async def tell_others(self, sender_id, payload):
        msg = json.dumps(payload)
        await asyncio.gather(*(self.send(p, msg) for p in list(self.peers.values()) if p.id != sender_id))

    async def tell_editors(self, sender_id, payload):
        """Everyone who may edit, except `sender_id` — pass None to include them."""
        msg = json.dumps(payload)
        await asyncio.gather(*(self.send(p, msg) for p in list(self.peers.values()) if p.id != sender_id and p.edit))


_rooms: dict[str, Room] = {}


def _env_of(scope_or_ws):
    """Draft or live, from the path. The server's middleware only does this for http, so a
    websocket has to say for itself which database it belongs to — without this, the draft
    page's room would look its track up in the live site's tracks and never find it.

    The http side reads it the same way, so a room and the page asking about it agree."""
    path = getattr(scope_or_ws, "scope", {}).get("path", "") or ""
    return "draft" if path.startswith("/preview/") else "live"


_ready = set()


def _ensure(env):
    """The columns this branch adds, made sure of once per database.

    A route carries the schema it needs. Nothing else in src/api knows these columns exist,
    and a room that can't read them is a room that doesn't work, so this is the file that
    has to be sure of them.
    """
    if env in _ready:
        return
    _ready.add(env)
    try:
        with use_env(env):
            conn = db()
            if "tracks" not in {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
                _ready.discard(env)  # no table yet: worth asking again later
                return
            cols = {r[1] for r in conn.execute("PRAGMA table_info(tracks)")}
            for name, spec in (
                ("collab", "INTEGER NOT NULL DEFAULT 1"),   # may anyone else change it
                ("jam", "TEXT NOT NULL DEFAULT 'open'"),    # may anyone else walk in
                ("jam_key", "TEXT"),                        # ...or only with this in the link
            ):
                if name not in cols:
                    conn.execute(f"ALTER TABLE tracks ADD COLUMN {name} {spec}")
            conn.commit()
    except Exception:
        _ready.discard(env)  # try again on the next connection rather than never


def _track(track_id, env):
    _ensure(env)
    try:
        with use_env(env):
            conn = db()
            try:
                return conn.execute("SELECT owner_sub, visibility, collab, jam, jam_key FROM tracks WHERE id = ?", (track_id,)).fetchone()
            except Exception:
                # a database that predates the columns: the track is open to others and to drop-ins
                return conn.execute("SELECT owner_sub, visibility FROM tracks WHERE id = ?", (track_id,)).fetchone()
    except Exception:
        return None


def _set_collab(track_id, env, on):
    """Remember the owner's answer, so it holds after everyone has gone home."""
    try:
        with use_env(env):
            conn = db()
            conn.execute("UPDATE tracks SET collab = ? WHERE id = ?", (1 if on else 0, track_id))
            conn.commit()
    except Exception:
        pass  # the room still obeys it; it just won't outlive the room


def _col(row, name, fallback=None):
    """A column that may not exist yet, on a database that predates it."""
    try:
        return row[name] if row and name in row.keys() else fallback
    except Exception:
        return fallback


def _set_jam(track_id, env, mode, key):
    """Remember whether the session takes drop-ins, and the key that gets you in if not."""
    try:
        with use_env(env):
            conn = db()
            conn.execute("UPDATE tracks SET jam = ?, jam_key = ? WHERE id = ?", (mode, key, track_id))
            conn.commit()
    except Exception:
        pass


def _may_join(row, user, key):
    """Whether they may be in the room at all.

    The owner always. After that it turns on how the session is set, not on who can read the
    track:

      · takes drop-ins — anyone who can open the track can be in it
      · invite-only    — the key, and nothing but the key

    The key is enough on its own, whatever the track's visibility. That is what makes an
    invitation an invitation: it works on a track nobody else can even open, which is
    precisely the track you most want to invite somebody into. The owner minted that link
    and handed it over, so holding it is the consent; rolling the key takes it back.

    Which means a private track is shared by shutting the session rather than opening it —
    "anyone" is nobody when nobody else can open the track, and the invite link is the only
    door there has ever been. That door asks for a name: an invitation into work nobody else
    can see goes to a person, not to whoever ends up holding the link."""
    if not row:
        return False
    if _is_owner(row, user):
        return True
    if _col(row, "jam", "open") == "invite":
        want = _col(row, "jam_key")
        if not (want and secrets.compare_digest(str(key or ""), str(want))):
            return False
        # An invitation into work nobody else can see is to a person, not to whoever ends up
        # holding the link. Signing in is how the owner knows who is in there with them —
        # and somebody who isn't signed in couldn't edit anyway, so all the anonymous seat
        # offers is a nameless watcher in a private session, which is not what was meant.
        return bool(user) or _col(row, "visibility") != "private"
    return _may_open(row, user)


def _may_open(row, user):
    """Anyone can be present on a public or unlisted track; private is the owner's."""
    if not row:
        return False
    return row["visibility"] != "private" or (user and user.get("sub") == row["owner_sub"])


def _is_owner(row, user):
    return bool(row and user and user.get("sub") == row["owner_sub"])


def _may_edit(row, user, open_to_others):
    """Who may change the track live: its owner always, and anyone else signed in while
    the owner leaves it open.

    Working on a track together is the point, and a link is how people get to one, so a
    track starts out open. Being signed in is then the whole gate — a name to put on a
    cursor and an account behind the change — while saving stays the owner's alone (see
    tracks.py), so a session can be shared without anyone overwriting what the owner has
    kept. Someone who isn't signed in watches: cursors, no changes, and never a copy of
    the document."""
    if _is_owner(row, user):
        return True
    # everyone this is asked about is already through the door (see _may_join), so what's
    # left is whether they're signed in and whether the owner has left the track open. An
    # invited guest on a private track is here because they were asked: let them work.
    return bool(row and user and open_to_others)


def _bot_of(user, name, pid):
    """A short, stable name for someone's face.

    Everything about how a person is drawn comes off this — their colour, the finish on
    their head, whether they have pupils — so the same person is recognisably themselves in
    the tray, on a browse card, in any room, on any day. It's a hash of the account rather
    than the account itself, because how someone looks is not a reason to hand their id to
    everyone else in the room.

    Somebody not signed in has no identity to be stable about, so theirs is stable for the
    visit and no longer. That is the honest answer for an anonymous person, and it still
    tells two of them apart."""
    seed = f"sub:{user['sub']}" if user and user.get("sub") else f"guest:{name}:{pid}"
    return hashlib.sha256(seed.encode()).hexdigest()[:12]


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
        if not _may_join(row, user, hello.get("join")):
            await ws.close(code=4003)
            return
        jam_mode = _col(row, "jam", "open")
        jam_key = _col(row, "jam_key")
        room_key = f"{_env_of(ws)}:{track_id}"
        room = _rooms.setdefault(room_key, Room())
        if len(room.peers) >= MAX_PEERS:
            await ws.close(code=4008)
            return
        room.jam = jam_mode  # the browse list asks the room, so keep it current
        if not room.peers:
            room.open = bool(row["collab"]) if "collab" in row.keys() else True
        edit = _may_edit(row, user, room.open)
        name = _clean_name(hello.get("name"), user)
        bot = _bot_of(user, name, room.next_id)
        peer = Peer(room.next_id, ws, name, room.color_for(bot), (user or {}).get("sub"), edit, bot)
        room.next_id += 1
        await ws.send_text(json.dumps({
            "t": "me", "id": peer.id, "color": peer.color, "name": peer.name, "bot": peer.bot,
            "edit": edit, "owner": _is_owner(row, user), "open": room.open,
            # only the owner is told the key, because only the owner hands it out
            "jam": jam_mode, "key": jam_key if (jam_mode == "invite" and _is_owner(row, user)) else None,
        }))
        await ws.send_text(json.dumps({"t": "here", "peers": [p.public() for p in room.peers.values()]}))
        await room.tell_others(peer.id, {"t": "join", "peer": peer.public()})
        room.peers[peer.id] = peer
        # The track as the room has it, to everyone who may open it. Watching is read-only,
        # not blind and deaf: a watcher sees the edits land and hears the room play, and what
        # they can't do is send any of either. Only someone who may edit can hand a room its
        # first copy, so an empty room asks them alone.
        if room.doc is None:
            if edit:
                await ws.send_text(json.dumps({"t": "seed"}))
        else:
            await ws.send_text(json.dumps({"t": "doc", "doc": room.doc, "v": room.version}))
            # and what the room is playing, if it is. The stamp on it is this server's, so
            # however long ago it was said a newcomer can work out where the song has got
            # to by now — otherwise they sit in silence until someone's hand next touches
            # the transport, which is not what being in the room sounds like. Nothing is
            # sent for a room that's stopped: there is no music to join, and moving
            # somebody's playhead when nobody is playing is a worse surprise than silence.
            if room.play and room.play.get("on"):
                await ws.send_text(json.dumps(room.play))

        window, moves, edits = time.monotonic(), 0, 0
        while True:
            raw = await ws.receive_text()
            now = time.monotonic()
            if now - window > 1:
                window, moves, edits = now, 0, 0
            if len(raw) > MAX_DOC:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            kind = msg.get("t")
            if kind in ("at", "sel", "view"):
                moves += 1
                if moves > CURSORS or len(raw) > MAX_MSG:
                    continue  # a cursor is disposable: the next one is along in a moment
            else:
                edits += 1
                if edits > EDITS:
                    # never drop a change quietly: being behind and not knowing it is the
                    # one failure that leaves two people working on different tracks
                    await ws.send_text('{"t":"behind"}')
                    continue
                if len(raw) > MAX_MSG and kind not in ("doc", "ops"):
                    continue  # only the track itself has any business being large
            if kind == "at":
                peer.at = None if msg.get("where") is None else {"where": msg.get("where"), "x": msg.get("x"), "y": msg.get("y")}
                await room.tell_others(peer.id, {"t": "at", "id": peer.id, **(peer.at or {"where": None})})
            elif kind == "view":
                # which view they're on, so someone working on another one reads as present
                # rather than simply gone: their cursor lives on a surface you can't see
                peer.view = (str(msg.get("v") or "")[:24] or None)
                await room.tell_others(peer.id, {"t": "view", "id": peer.id, "v": peer.view})
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
                    await room.tell_others(peer.id, {"t": "doc", "doc": room.doc, "v": room.version})
            elif kind == "ops" and peer.edit:
                ops = msg.get("ops")
                if not isinstance(ops, list) or not ops or len(raw) > MAX_OPS:
                    continue
                if room.doc is None:
                    # they think they're sharing and the room is holding nothing: ask for
                    # the track rather than let the change fall down the gap between them
                    await ws.send_text('{"t":"seed"}')
                    continue
                if apply_ops(room.doc, ops) == 0:
                    # Nothing of it landed: a clip someone else had already deleted, say,
                    # which is an ordinary collision rather than an error. But the sender is
                    # waiting to hear this change come back the way every other one does,
                    # and one that never comes back leaves it counting a change as still in
                    # flight for the rest of the session — which is exactly what stops it
                    # comparing notes with the room, and so stops it ever finding out it has
                    # drifted. A change we can't place still gets an answer.
                    await ws.send_text(json.dumps({"t": "nope", "v": room.version}))
                    continue
                room.version += 1
                # Back to everyone, the sender included. Two people turning the same knob
                # each apply their own first, so without hearing their own change come back
                # in its place they would settle on different values — the one who went
                # last locally would be the only one not to see themselves win. Everybody
                # applying the same changes in the same order is what makes them agree.
                await room.tell_others(None, {"t": "ops", "id": peer.id, "ops": ops, "v": room.version, "h": msg.get("h")})
            elif kind == "same" and peer.edit:
                # a quiet moment: everyone says what they think they have, and anyone whose
                # copy doesn't match at the same version asks for the whole track. Two
                # people adding something at the same instant can end up with the same
                # things in a different order, and this is what settles it.
                await room.tell_editors(peer.id, {"t": "same", "id": peer.id, "v": msg.get("v"), "h": msg.get("h")})
            elif kind == "sync":
                # a watcher keeps a copy too, so a watcher has to be able to recover one
                if room.doc is not None:
                    await ws.send_text(json.dumps({"t": "doc", "doc": room.doc, "v": room.version}))
            elif kind == "time":
                # what time the server makes it, so a follower can work out the offset
                # between its clock and everyone else's (the round trip is measured there)
                await ws.send_text(json.dumps({"t": "time", "c": msg.get("c"), "s": time.time() * 1000}))
            elif kind == "play" and peer.edit:
                # where the song is, and when: whoever hits play says so, everyone else lines up
                said = {
                    "t": "play",
                    "id": peer.id,
                    "on": bool(msg.get("on")),
                    "pos": msg.get("pos"),
                    "cps": msg.get("cps"),
                    "at": time.time() * 1000,  # stamped here, so it needs no clock of its own
                }
                room.play = said  # the room is the thing that's playing, so the room holds it
                await room.tell_others(peer.id, said)
            elif kind == "lock":
                # only the owner, and everyone finds out at once: someone who has just
                # lost the right stops being sent changes, and stops being able to send any
                if not _is_owner(row, user):
                    continue
                room.open = bool(msg.get("on"))
                await asyncio.to_thread(_set_collab, track_id, _env_of(ws), room.open)
                for other in list(room.peers.values()):
                    was = other.edit
                    other.edit = _may_edit(row, {"sub": other.sub} if other.sub else None, room.open)
                    if other.edit != was:
                        # what they may do changes; what they can see doesn't, because
                        # everyone in the room has the track either way
                        await room.send(other, json.dumps({"t": "role", "edit": other.edit, "open": room.open}))
                await room.tell_others(peer.id, {"t": "open", "on": room.open})
            elif kind == "jam":
                # the owner deciding whether anyone may walk in, or only with a link that
                # carries the key. Rolling it stops every link handed out before now; people
                # already in the room stay, because throwing them out mid-session would only
                # make them reconnect in a loop against a door that has changed locks.
                if not _is_owner(row, user):
                    continue
                jam_mode = "invite" if msg.get("mode") == "invite" else "open"
                if jam_mode == "invite" and (msg.get("roll") or not jam_key):
                    jam_key = secrets.token_urlsafe(9)
                room.jam = jam_mode
                await asyncio.to_thread(_set_jam, track_id, _env_of(ws), jam_mode, jam_key)
                await ws.send_text(json.dumps({
                    "t": "jam", "mode": jam_mode, "key": jam_key if jam_mode == "invite" else None,
                }))
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


@router.get("/live")
async def live(request: Request):
    """Every track somebody is working on right now, and who's on it.

    For the browse list, which wants to say a track is alive without holding a socket open
    to each one. Only sessions that take drop-ins are listed: an invite-only room is a room
    nobody is being pointed at, so saying it's busy would point at it."""
    here = f"{_env_of(request)}:"
    out = {}
    for key, room in list(_rooms.items()):
        if not key.startswith(here) or room.jam != "open" or not room.peers:
            continue
        out[key[len(here):]] = [{"name": p.name, "color": p.color, "bot": p.bot} for p in list(room.peers.values())[:8]]
    return {"tracks": out}


@router.get("/{track_id}/who")
async def who(request: Request, track_id: str):
    """Who's on a track right now, for a page that isn't holding a socket open."""
    room = _rooms.get(f"{_env_of(request)}:{track_id}")
    return {"peers": [{"name": p.name, "color": p.color, "bot": p.bot} for p in (room.peers.values() if room else [])]}

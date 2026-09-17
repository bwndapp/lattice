"""Serve a branch of the app at /multiplayer/, alongside the live site and /preview/.

The platform serves exactly two directories: public/ at / and webapp/ at /preview/. This
adds a third, from multiplayer/ at the workspace root, the same way the server itself does
it — a static mount placed ahead of the SPA catch-all, plus the bare-path redirect so
/multiplayer loads with the trailing slash its relative asset URLs need.

It is scaffolding for trying a branch out, not a third environment: the app served here
uses /preview's api and database (see frontend/src/base.js). Delete this file and the
directory and everything is exactly as it was.

Why it reaches for the app object: a route file only gets to mount things under
/api/<its name>, and a whole app needs a path of its own. The lookup is by the
platform's own /_routes endpoint, so it either finds the running server or does nothing.
"""
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.routing import Mount, Route

router = APIRouter()

DIR = Path("/incubators/incu-strudel/multiplayer")
MOUNT = "/multiplayer"
NAME = "multiplayer"


class FreshStatic(StaticFiles):
    """Never cached: this is a branch being worked on, and a frozen asset at the edge is
    a bug report about something already fixed."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        return response


def _running_app():
    """The FastAPI app actually serving this box, found by a route only it defines."""
    import sys

    for module in list(sys.modules.values()):
        app = getattr(module, "app", None)
        routes = getattr(getattr(app, "router", None), "routes", None)
        if routes and any(getattr(r, "path", "") == "/_routes" for r in routes):
            return app
    return None


def _mount():
    """Put the directory on the path, replacing an earlier mount of ours if there is one."""
    app = _running_app()
    if app is None or not DIR.is_dir():
        return False
    app.router.routes = [r for r in app.router.routes if getattr(r, "name", "") not in (NAME, f"{NAME}-slash")]
    app.router.routes.insert(0, Mount(MOUNT, app=FreshStatic(directory=str(DIR), html=True), name=NAME))
    app.router.routes.insert(0, Route(
        MOUNT,
        lambda request: RedirectResponse(url=f"{MOUNT}/", status_code=307),
        name=f"{NAME}-slash",
    ))
    return True


MOUNTED = False
try:
    MOUNTED = _mount()
except Exception:
    MOUNTED = False  # the branch preview is never worth breaking the server for


@router.get("")
async def status():
    """Whether the branch is being served, and when it was last built."""
    index = DIR / "index.html"
    return {
        "mounted": MOUNTED,
        "at": f"{MOUNT}/",
        "built": int(index.stat().st_mtime) if index.exists() else None,
        "now": int(time.time()),
    }

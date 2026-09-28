"""Renaming a track and tagging it: who may, what's kept, and finding tracks by tag.

Runs in-process against a throwaway database that starts in the old shape (no tags), so it
also checks the column is added without losing anything: python3 test/tracks_tags_test.py
"""
import importlib.util
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, '/opt/incubator')
import incubator_lib

path = os.path.join(tempfile.mkdtemp(), 'tags.db')
old = sqlite3.connect(path)
old.executescript("""
CREATE TABLE tracks (id TEXT PRIMARY KEY, owner_sub TEXT NOT NULL, author TEXT NOT NULL, title TEXT NOT NULL,
  code TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', forked_from TEXT,
  likes INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
INSERT INTO tracks VALUES ('old', 'someone', 'ana', 'from before', 's("bd")', 'public', NULL, 0, 0, 1, 1);
""")
old.commit()
old.close()


def connect():
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    return c


SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src', 'api', 'tracks.py')
spec = importlib.util.spec_from_file_location('tracks_test', SRC)
tracks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tracks)
tracks.db = connect
tracks.db_path = lambda: path
_people = {'owner': {'sub': 'someone', 'given_name': 'ana'}, 'friend': {'sub': 'other', 'given_name': 'bo'}}
tracks.sso_user = lambda request: _people.get((request.headers.get('authorization') or '').removeprefix('Bearer '))

from fastapi import FastAPI
from fastapi.testclient import TestClient

app = FastAPI()
app.include_router(tracks.router, prefix='/api/tracks')
http = TestClient(app)
as_ = lambda who: {'Authorization': f'Bearer {who}'}
fails = []


def ok(name, cond, extra=''):
    print(('ok   ' if cond else 'FAIL ') + name + (f' — {extra}' if not cond else ''))
    if not cond:
        fails.append(name)


r = http.get('/api/tracks/old').json()
ok('an old track survives the upgrade, with no tags', r.get('title') == 'from before' and r.get('tags') == [], r)

r = http.put('/api/tracks/old', json={'title': '  Night Bus  '}, headers=as_('owner')).json()
ok('the owner renames it, trimmed', r.get('title') == 'Night Bus', r)
ok('a rename is not a new save', r.get('updated_at') == 1 and r.get('code') == 's("bd")', r)

r = http.put('/api/tracks/old', json={'tags': ['#DnB', 'dnb', ' Liquid  Funk ', 'a_b!c', '', 'x' * 40]}, headers=as_('owner')).json()
ok('tags are cleaned and deduped', r.get('tags') == ['dnb', 'liquid funk', 'abc', 'x' * 24], r.get('tags'))
r = http.put('/api/tracks/old', json={'tags': [f't{i}' for i in range(20)]}, headers=as_('owner')).json()
ok('no more than eight tags', len(r.get('tags', [])) == 8, r.get('tags'))
http.put('/api/tracks/old', json={'tags': ['dnb', 'liquid funk']}, headers=as_('owner'))

r = http.put('/api/tracks/old', json={'title': 'mine now', 'tags': ['spam']}, headers=as_('friend'))
ok("someone else can't rename or tag it", r.status_code == 403, r.status_code)
r = http.put('/api/tracks/old', json={'tags': ['x']})
ok('nobody signed in can\'t either', r.status_code == 401, r.status_code)
r = http.put('/api/tracks/old', json={'tags': 'dnb'}, headers=as_('owner'))
ok('tags must be a list', r.status_code == 400, r.status_code)
ok('still named and tagged by its owner', http.get('/api/tracks/old').json().get('title') == 'Night Bus')

names = lambda q: [t['title'] for t in http.get(f'/api/tracks?{q}').json()['tracks']]
ok('filter by tag', names('tag=dnb') == ['Night Bus'], names('tag=dnb'))
ok('the filter takes a # and capitals', names('tag=%23DNB') == ['Night Bus'])
ok('a tag filter matches whole tags', names('tag=dn') == [], names('tag=dn'))
ok('search finds tags too', names('q=liquid') == ['Night Bus'], names('q=liquid'))
ok('search still finds titles', names('q=night') == ['Night Bus'])
ok('popular tags', [t['tag'] for t in http.get('/api/tracks/tags?q=li').json()['tags']] == ['liquid funk'])

r = http.post('/api/tracks', json={'title': 'new', 'code': 'x', 'visibility': 'public', 'tags': ['House']}, headers=as_('owner')).json()
ok('a new track can start with tags', r.get('tags') == ['house'], r)

print('\n' + ('all good' if not fails else f'{len(fails)} failed'))
sys.exit(1 if fails else 0)

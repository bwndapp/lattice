#!/usr/bin/env node
/**
 * The track corpus (frontend/test/corpus.test.mjs): every public track, as a fixture, with
 * the code the app makes from it today.
 *
 *   node tools/golden/export-tracks.mjs            re-snapshot the code of the fixtures here
 *   node tools/golden/export-tracks.mjs --fetch    fetch the tracks again first: public ones
 *                                                  in data-draft.db, and the live site's
 *                                                  public ones from GET /api/tracks
 *
 * Read-only: the draft database is opened read-only and the live site is only asked for
 * what anyone can see. Private and unlisted tracks are never exported.
 */
import fs from 'node:fs'
import path from 'node:path'
import { bundle, FRONTEND } from '../../frontend/test/lib/bundle.mjs'

const ROOT = path.join(FRONTEND, '..')
const DIR = path.join(FRONTEND, 'test', 'fixtures', 'tracks')
const API = process.env.LATTICE_API ?? 'http://localhost:3000/api/tracks'
const file = (source, id) => path.join(DIR, `${source}-${id.replace(/\W/g, '_')}.json`)

async function fetchAll() {
  const found = []
  // the draft site's own tracks
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(ROOT, 'data-draft.db'), { readOnly: true })
  for (const r of db.prepare("SELECT id, title, code FROM tracks WHERE visibility = 'public' ORDER BY created_at").all()) {
    found.push({ source: 'draft', id: r.id, title: r.title, code: r.code })
  }
  db.close()
  // the live site's public tracks, a page at a time
  for (let offset = 0; ; offset += 100) {
    const page = await (await fetch(`${API}?limit=100&offset=${offset}`)).json()
    for (const t of page.tracks ?? []) {
      const full = await (await fetch(`${API}/${encodeURIComponent(t.id)}`)).json()
      if (full.visibility !== 'public') continue
      found.push({ source: 'live', id: full.id, title: full.title, code: full.code })
    }
    if (!page.more) break
  }
  fs.mkdirSync(DIR, { recursive: true })
  for (const t of found) fs.writeFileSync(file(t.source, t.id), JSON.stringify(t, null, 1) + '\n')
  console.log(`fetched ${found.length} tracks`)
}

if (process.argv.includes('--fetch')) await fetchAll()

const m = await bundle({ 'project.js': ['parseProject', 'generateCode'] }, 'corpus')
for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const t = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'))
  const project = m.parseProject(t.code)
  t.generated = project ? m.generateCode(project) : null
  fs.writeFileSync(path.join(DIR, name), JSON.stringify(t, null, 1) + '\n')
  console.log(`${name}: ${project ? 'a patch' : 'plain code'}`)
}

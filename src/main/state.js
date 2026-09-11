'use strict'

const fs = require('fs/promises')
const path = require('path')
// userDataDir() rather than electron's app directly: it follows a dev run's moved userData, and it
// survives plain `node` (build/check-sources.js builds a whole snapshot without Electron).
const { userDataDir } = require('./config')

// Acknowledge / snooze / pin live here and NOWHERE in the vault. The cost of that choice is
// recorded: this state is lost on a reinstall and is invisible to any agent that has not been
// taught to read it.
//
// SB (2026-08-03): `done` is the exception that proves it. Marking done is the one action that
// DOES reach the vault — a receipt under .inbox/ for a pending item, a struck line in
// Open Backlogs.md for a backlog one, both written by index.js before this file is touched. The
// entry kept here is only the local echo, so the board updates in the same frame rather than
// waiting for the next file watch.

const FILE = () => path.join(userDataDir(), 'board-state.json')
const EMPTY = { acked: {}, snoozed: {}, pinned: {}, done: {} }

let cache = null

async function load () {
  if (cache) return cache
  try {
    cache = { ...EMPTY, ...JSON.parse(await fs.readFile(FILE(), 'utf8')) }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Corrupt state is backed up beside itself rather than silently discarded.
      try { await fs.rename(FILE(), FILE() + '.corrupt-' + Date.now()) } catch {}
      cache = { ...EMPTY, corrupt: true }
      return cache
    }
    cache = { ...EMPTY }
  }
  return cache
}

async function save () {
  await fs.mkdir(path.dirname(FILE()), { recursive: true })
  await fs.writeFile(FILE(), JSON.stringify(cache, null, 2), 'utf8')
}

async function apply (action, id) {
  const s = await load()
  if (action === 'ack') s.acked[id] = Date.now()
  else if (action === 'snooze') s.snoozed[id] = Date.now() + 4 * 60 * 60 * 1000
  else if (action === 'pin') { if (s.pinned[id]) delete s.pinned[id]; else s.pinned[id] = Date.now() }
  // SB: `done` hides through `acked`, so view() needs no change.
  else if (action === 'done') { s.done[id] = Date.now(); s.acked[id] = Date.now() }
  else if (action === 'clear') { delete s.acked[id]; delete s.snoozed[id]; delete s.pinned[id]; delete s.done[id] }
  await save()
  return s
}

// Returns a filter view, never mutating the snapshot's own items.
async function view () {
  const s = await load()
  const now = Date.now()
  const hidden = new Set(Object.keys(s.acked))
  for (const [id, until] of Object.entries(s.snoozed)) {
    if (until > now) hidden.add(id)
  }
  return { hidden, pinned: new Set(Object.keys(s.pinned)), corrupt: !!s.corrupt }
}

module.exports = { load, apply, view }

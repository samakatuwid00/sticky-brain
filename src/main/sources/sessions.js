'use strict'

const fs = require('fs/promises')
const path = require('path')
const { paths } = require('../config')
const hermes = require('./hermes')
const runtime = require('../hermes-runtime')
const api = require('../hermes-api')

// The LIVE list is every agent session on the machine, not only Claude Code's.
//
// Claude Code: a session file named <pid>.json written by Claude Code itself. Verified shape:
// { pid, sessionId, cwd, startedAt, updatedAt, version, kind, entrypoint, name, status }
//
// `status` is read off a running install (2.1.220) and is NOT documented in the local docs
// mirror as far as this project checked. Treating it as a contract is inference; it can change
// in a point release. `alive()` is what the board actually trusts.
//
// Hermes Agent: a SQLite store, read by sources/hermes.js — different location, different shape
// and no pid at all, so it is a separate reader whose rows are normalised onto the same fields
// here. It is folded into THIS source rather than added as a fifth one because the board's
// footer counts four sources, and because "the sessions source is broken" and "Hermes is not
// installed" are not the same statement.

function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return err.code === 'EPERM'
  }
}

function projectFor (cwd, registry) {
  if (!cwd) return null
  const lower = cwd.toLowerCase()
  for (const entry of registry) {
    if (entry.path && lower.startsWith(entry.path.toLowerCase())) return entry.name
  }
  return null
}

async function loadRegistry () {
  try {
    const raw = await fs.readFile(paths.projects, 'utf8')
    const parsed = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : parsed.projects || []
    return list.filter(p => p && p.path)
  } catch {
    return []
  }
}

async function readClaude (registry) {
  let names
  try {
    names = await fs.readdir(paths.sessions)
  } catch (err) {
    return { ok: false, path: paths.sessions, error: err.code || 'unreadable', items: [] }
  }

  const items = []
  let unparsed = 0

  for (const name of names) {
    if (!name.endsWith('.json')) continue
    let raw
    try {
      raw = await fs.readFile(path.join(paths.sessions, name), 'utf8')
    } catch { unparsed++; continue }

    let s
    try { s = JSON.parse(raw) } catch { unparsed++; continue }
    if (!s || typeof s.pid !== 'number') { unparsed++; continue }

    const running = alive(s.pid)
    items.push({
      id: s.sessionId || String(s.pid),
      // SB: which agent a row came from. The renderer draws it as a badge, and revealSession
      // branches on it — only a Claude Code row has a pid to walk up to a terminal window.
      agent: 'claude',
      pid: s.pid,
      // SB: sessionId travels beside `id` because `id` falls back to the pid when the file has
      // no sessionId, and the redirect handler must be able to tell those two apart.
      sessionId: s.sessionId || null,
      name: s.name || String(s.pid),
      cwd: s.cwd || '',
      project: projectFor(s.cwd, registry),
      startedAt: s.startedAt || null,
      updatedAt: s.updatedAt || null,
      version: s.version || null,
      // The file's own word is only believed while the process is alive.
      status: running ? (s.status === 'busy' ? 'busy' : 'idle') : 'stale'
    })
  }

  return { ok: true, path: paths.sessions, items, unparsed }
}

/* ---- SB: the Hermes live filter ---- */

// A Hermes row used to be called live purely because state.db had heard from it within two hours.
// Measured, that made the LIVE list a scrollback: fourteen rows, of which none was running, and
// clicking any of them reached the "hermes records no pid" dead end. state.db is an ARCHIVE — a
// row in it is evidence that a session existed, never that it exists.
//
// So liveness is now decided against the machine, and a row is live only on EVIDENCE:
//
//   'process'  processes.json maps the session id to a pid that answers process.kill(pid, 0).
//              Hard evidence, and it also hands the row a pid — which is what turns "no pid
//              records" from an apology into a window the board can focus.
//   'api'      the local backend was reachable AND authorised AND said so itself. Strongest of
//              the three, and normally unavailable: the backend's session token is minted into
//              its own environment and Sticky Brain cannot read it (see hermes-api.js).
//   'recent'   the session spoke within LIVE_MS and a process of the right kind is running.
//              This is INFERENCE and is labelled as such: it is what keeps the session you are
//              typing in right now on the board, since a plain chat launches no subprocess and
//              therefore leaves no trace in processes.json.
//
// Everything else is 'saved' — real, openable history, and explicitly not a claim that anything
// is running. Nothing is dropped: a saved row still opens, it just opens in the Hermes Desktop App
// rather than pretending to have a terminal.
const LIVE_MS = 90 * 1000

// Saved rows sort below every live one, but the widget is 360px wide and the archive is unbounded,
// so the tail is cut here rather than allowed to push the live list off the bottom. The count of
// what was cut travels with the source so the board can say so instead of quietly shortening.
const MAX_SAVED = 4

function ownerRunning (origin, procs) {
  // `source` in state.db is 'desktop' for a session belonging to the Hermes Desktop App and 'cli'
  // for one belonging to a `hermes chat`. An unrecognised origin gets the weaker any-Hermes test
  // rather than being assumed dead.
  if (origin === 'desktop') return procs.desktop
  if (origin === 'cli') return procs.agent
  return procs.desktop || procs.agent
}

async function hermesEvidence () {
  // Every one of these is cached inside its own module and none of them is on the 5s poll's
  // critical path more than once a cache period. They are gathered together so one slow answer
  // does not serialise behind another.
  const [pids, desktop, agent, backend] = await Promise.all([
    Promise.resolve().then(() => runtime.sessionPids()).catch(() => new Map()),
    runtime.desktopRunning().catch(() => false),
    runtime.agentRunning().catch(() => false),
    api.read().catch(() => ({ ok: false, authorized: false, items: [] }))
  ])
  const active = new Set()
  if (backend && backend.ok && backend.authorized) {
    for (const row of backend.items || []) if (row.active === true) active.add(row.id)
  }
  return { pids, procs: { desktop, agent }, active, backend }
}

function noEvidence () {
  return { pids: new Map(), procs: { desktop: false, agent: false }, active: new Set(), backend: null }
}

function classify (row, ev, now) {
  // The store's own word about an ended session is final — nothing else needs consulting.
  if (row.endedAt) return { status: 'saved', liveBy: null, pid: null }

  const pid = ev.pids.get(row.sessionId) || null
  if (pid) {
    return { status: (now - (row.updatedAt || 0)) <= LIVE_MS ? 'busy' : 'idle', liveBy: 'process', pid }
  }
  if (ev.active.has(row.sessionId)) {
    return { status: (now - (row.updatedAt || 0)) <= LIVE_MS ? 'busy' : 'idle', liveBy: 'api', pid: null }
  }
  if (row.updatedAt && (now - row.updatedAt) <= LIVE_MS && ownerRunning(row.origin, ev.procs)) {
    return { status: 'busy', liveBy: 'recent', pid: null }
  }
  return { status: 'saved', liveBy: null, pid: null }
}

async function read () {
  const registry = await loadRegistry()
  // Hermes is read alongside, never in series — its reader shells out, and 150ms of Python must
  // not be added to the latency of a source that is only reading small JSON files.
  const [claude, hx] = await Promise.all([readClaude(registry), hermes.read()])

  // A broken Claude Code sessions directory still fails the source, exactly as before: that is
  // the board's primary agent and its absence is a real fault, not an empty list. A directory
  // that does not exist at all is different — Claude Code is not installed — and is reported
  // as `installed: false` instead.
  const claudeMissing = claude.ok === false && claude.error === 'ENOENT'
  if (claude.ok === false && !claudeMissing) {
    return { ...claude, hermes: { ok: hx.ok !== false, error: hx.error || null, count: hx.items.length } }
  }

  // SB: the live filter. Evidence is gathered once per read, not once per row. Without Hermes
  // there is nothing to grade, so none of its process sweeps are spawned.
  const ev = hx.installed === false ? noEvidence() : await hermesEvidence()
  const now = Date.now()
  const graded = (hx.items || []).map(x => {
    const verdict = classify(x, ev, now)
    return {
      ...x,
      project: projectFor(x.cwd, registry),
      status: verdict.status,
      // SB: a real pid where one exists, so revealSession can focus the window instead of
      // reporting that Hermes keeps no pids. Still null for most rows, and honestly so.
      pid: verdict.pid,
      // SB: WHY this row is on the board. 'recent' is inference and the renderer says so.
      liveBy: verdict.liveBy
    }
  })

  const hermesLive = graded.filter(x => x.status !== 'saved')
  const hermesSaved = graded.filter(x => x.status === 'saved')
  const hermesItems = [...hermesLive, ...hermesSaved.slice(0, MAX_SAVED)]
  const items = [...(claudeMissing ? [] : claude.items), ...hermesItems]

  // Status first, as before. Then Claude Code ahead of Hermes at equal status — not favouritism:
  // a Claude Code row's liveness is verified against a real pid, a Hermes row's is inferred from
  // how recently it last spoke, and the stronger claim belongs higher. Without this tie-break the
  // one genuinely-running Claude session was measured being pushed off a five-row widget by four
  // idle Hermes rows. Recency decides the rest; Claude Code writes no `updatedAt`, so it falls
  // back to `startedAt` rather than sorting as if it were from 1970.
  //
  // SB: 'saved' sorts below both, and above only 'stale'. A saved Hermes session is history that
  // still opens; a stale Claude Code row is a file left behind by a process that died.
  const rank = { busy: 0, idle: 1, saved: 2, stale: 3 }
  const agentRank = x => (x.agent === 'hermes' ? 1 : 0)
  items.sort((a, b) =>
    (rank[a.status] - rank[b.status]) ||
    (agentRank(a) - agentRank(b)) ||
    ((b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0)))

  return {
    ok: true,
    // Neither agent on this machine: the board says "not detected" rather than "broken".
    installed: !claudeMissing || hx.installed !== false,
    claude: { installed: !claudeMissing },
    path: paths.sessions,
    items,
    unparsed: claude.unparsed || 0,
    // Hermes being missing or unreadable is reported beside the source rather than as the
    // source's own failure — the LIVE list is still truthful about Claude Code either way.
    hermes: {
      ok: hx.ok !== false,
      installed: hx.installed !== false,
      path: hx.path,
      error: hx.error || null,
      count: hermesItems.length,
      // SB: the live filter, shown rather than performed silently. `live` is how many rows carried
      // real evidence, `saved` how much archive was found, `hidden` how much of that archive was
      // cut to keep the widget readable — a shortened list that says it was shortened.
      live: hermesLive.length,
      saved: hermesSaved.length,
      hidden: Math.max(0, hermesSaved.length - MAX_SAVED),
      // Whether the local backend could be consulted at all. 'unauthorized' is a real answer and
      // is not the same fact as 'offline'.
      backend: ev.backend && ev.backend.ok
        ? (ev.backend.authorized ? 'ok' : 'unauthorized')
        : 'offline'
    }
  }
}

module.exports = { read }

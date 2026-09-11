'use strict'

/* The source registry. Every place the board reads from is an ADAPTER registered here, and the
   snapshot, the LIVE list and the session-click handler consume the registry rather than naming
   the adapters one by one — so a new agent plugs in by registering, without touching core.

   Adapter = {
     key       unique id. For an agent it is also the `agent` field on every row it returns, which
               is how a clicked row finds its way back to the adapter that can open it.
     kind      'agent' — its rows are live sessions and go to the LIVE list
               'data'  — inbox / backlog / evidence files with their own bespoke shapes
     label     human name ('Claude Code')
     badge?    two-letter LIVE badge (agents; derived from label if absent)
     hint      what would provide this source, for the "not set up" line
     rank?     agent sort tie-break at equal status, lower first (default 50)
     detect()  -> { installed, path }   sync and cheap: a stat, never a spawn
     read()    -> Promise<{ ok, installed?, path, error?, items?, unparsed?, ... }>
               agent rows: { id, agent: key, name, status: busy|idle|saved|stale, cwd, pid?,
                             sessionId?, startedAt?, updatedAt?, version? }
     open(row) -> hint the main process acts on, e.g.
               { action: 'focus-pid', pid, cwd, fallback: 'folder' | 'hermes-desktop' }
               { action: 'hermes-desktop', sessionId }
               { action: 'file', path }
               or null when the row cannot be opened
   }

   The registry never lets an adapter fail the board: a throwing detect() reads as not installed,
   a throwing read() as `{ ok: false, error }`. */

const REQUIRED = ['detect', 'read', 'open']
const KINDS = ['agent', 'data']

const adapters = new Map()

function register (adapter) {
  if (!adapter || typeof adapter.key !== 'string' || !adapter.key) {
    throw new Error('source adapter needs a string key')
  }
  if (!KINDS.includes(adapter.kind)) {
    throw new Error('source adapter ' + adapter.key + ': kind must be one of ' + KINDS.join(', '))
  }
  for (const fn of REQUIRED) {
    if (typeof adapter[fn] !== 'function') throw new Error('source adapter ' + adapter.key + ' has no ' + fn + '()')
  }
  if (adapters.has(adapter.key)) throw new Error('source adapter ' + adapter.key + ' is already registered')
  adapters.set(adapter.key, adapter)
  return adapter
}

// Registration order, which is also the order the board lists sources in.
function list (kind) {
  const all = [...adapters.values()]
  return kind ? all.filter(a => a.kind === kind) : all
}

function get (key) {
  return adapters.get(key) || null
}

function detect (adapter) {
  try {
    const d = adapter.detect() || {}
    return { installed: d.installed === true, path: d.path || null }
  } catch (err) {
    return { installed: false, path: null, error: String(err && err.message ? err.message : err) }
  }
}

async function read (adapter) {
  let r
  try {
    r = await adapter.read()
  } catch (err) {
    r = { ok: false, error: String(err && err.message ? err.message : err) }
  }
  r = r && typeof r === 'object' ? r : { ok: false, error: 'adapter returned nothing' }
  return { ...r, items: Array.isArray(r.items) ? r.items : [] }
}

// The open hint for a row, from the adapter that produced it. null for a row no adapter claims.
function openHint (row) {
  const adapter = row && get(row.agent || 'claude')
  if (!adapter) return null
  try { return adapter.open(row) || null } catch { return null }
}

function badgeFor (adapter) {
  if (adapter.badge) return adapter.badge
  return String(adapter.label || adapter.key).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '??'
}

// Built-ins, in board order. Agents first: the LIVE list sorts ties by `rank`, not by this order.
register(require('./claude-code'))
register(require('./hermes'))
register(require('./inbox'))
register(require('./backlogs'))
register(require('./evidence'))

module.exports = { register, list, get, detect, read, openHint, badgeFor }

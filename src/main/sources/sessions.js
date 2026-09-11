'use strict'

const registry = require('./index')
const projects = require('./projects')
const config = require('../config')

// The LIVE list is every agent session on the machine: the rows of every `kind: 'agent'` adapter
// in the registry, merged and sorted. Nothing here names an agent — a new one plugs in by
// registering (see sources/index.js).
//
// An agent whose detector reports it missing is never read, so a machine without Hermes spawns no
// Python and no process sweeps. It is reported `installed: false`, never as an error.

// Status first. 'saved' sorts below live rows and above only 'stale': a saved Hermes session is
// history that still opens; a stale Claude Code row is a file left behind by a process that died.
const STATUS_RANK = { busy: 0, idle: 1, saved: 2, stale: 3 }

async function readAgent (adapter) {
  // Switched off in first-run setup (config.json `agents`): not detected, not read, not counted.
  if (!config.agentEnabled(adapter.key)) return { ok: true, installed: false, disabled: true, path: null, error: null, items: [] }
  const d = registry.detect(adapter)
  if (!d.installed) return { ok: true, installed: false, path: d.path, error: d.error || null, items: [] }
  return registry.read(adapter)
}

async function read () {
  const agents = registry.list('agent')
  // Agents are read alongside, never in series — Hermes shells out, and 150ms of Python must not
  // be added to the latency of an agent that is only reading small JSON files.
  const [projectList, results] = await Promise.all([
    projects.load(),
    Promise.all(agents.map(readAgent))
  ])

  const byAgent = {}
  const items = []
  let unparsed = 0

  agents.forEach((adapter, n) => {
    const r = results[n]
    const installed = r.installed !== false
    const ok = r.ok !== false
    const rows = installed && ok ? r.items : []
    byAgent[adapter.key] = {
      key: adapter.key,
      label: adapter.label || adapter.key,
      badge: registry.badgeFor(adapter),
      hint: adapter.hint || null,
      installed,
      ok,
      disabled: r.disabled === true,
      path: r.path || null,
      error: r.error || null,
      count: rows.length,
      // Adapter-specific accounting (Hermes: live / saved / hidden / backend).
      ...(r.meta || {})
    }
    unparsed += r.unparsed || 0
    for (const row of rows) {
      items.push({
        ...row,
        // Always the adapter's key, whatever the row said: it is how a click finds its adapter.
        agent: adapter.key,
        project: row.project || projects.projectFor(row.cwd, projectList)
      })
    }
  })

  // Then the adapter's rank at equal status — not favouritism: a Claude Code row's liveness is
  // verified against a real pid, a Hermes row's partly inferred, and the stronger claim belongs
  // higher. Without this tie-break the one genuinely-running Claude session was measured being
  // pushed off a five-row widget by four idle Hermes rows. Recency decides the rest; Claude Code
  // writes no `updatedAt`, so it falls back to `startedAt` rather than sorting as if from 1970.
  const rankOf = key => {
    const a = registry.get(key)
    return a && Number.isFinite(a.rank) ? a.rank : 50
  }
  items.sort((a, b) =>
    ((STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)) ||
    (rankOf(a.agent) - rankOf(b.agent)) ||
    ((b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0)))

  const detected = agents.filter(a => byAgent[a.key].installed)
  const failed = detected.filter(a => !byAgent[a.key].ok)
  // The source as a whole is down only when every agent the machine has is unreadable. One broken
  // agent beside a working one is reported per agent (byAgent) and drawn as its own line, so the
  // LIVE list stays truthful about the others.
  const down = detected.length > 0 && failed.length === detected.length
  const first = down ? byAgent[failed[0].key] : (byAgent[(detected[0] || agents[0] || {}).key] || {})

  return {
    ok: !down,
    // Neither agent on this machine: the board says "not detected" rather than "broken".
    installed: detected.length > 0,
    path: first.path || null,
    error: down ? first.error || 'unreadable' : null,
    items,
    unparsed,
    byAgent,
    // Compatibility with the pre-registry snapshot shape.
    claude: byAgent.claude ? { installed: byAgent.claude.installed } : null,
    hermes: byAgent.hermes || null
  }
}

module.exports = { read }

'use strict'

const registry = require('./sources')
const sessions = require('./sources/sessions')
const state = require('./state')

// One BoardSnapshot merged from the registered sources (see sources/index.js), with board-state
// applied. A source that fails keeps its own `ok: false` and its path — the renderer draws a tile
// for it. It must never collapse into "nothing pending", which is the failure this whole design is
// aimed at.
//
// The agent adapters are merged into ONE source, `sessions` — the LIVE list — with each agent's own
// health under `live.byAgent`. The data adapters are one source each.

// Transport caps only. How many are actually DRAWN is a density decision and belongs to the
// renderer — compact promises roughly twice the items at the same width, which a fixed cap here
// would quietly break. Totals travel alongside so the hidden count is always computable.
//
// SB: raised for the overview modal, which promises "all of them" and can only keep that promise
// with the items actually in the payload. Still capped — the board is a glance, not a mirror of
// the file — and the totals beside them stay authoritative, so a truncated list is still counted
// honestly. Worst case is a few hundred short rows over IPC every 5s, which measured flat.
const MAX_GROUPS = 24
const MAX_ITEMS_PER_GROUP = 50
const MAX_PENDING = 50

function sessionsHint () {
  const names = registry.list('agent').map(a => a.hint || a.label || a.key)
  return 'live sessions come from ' + (names.join(' or ') || 'an agent adapter')
}

async function build () {
  const data = registry.list('data')
  const [s, v, ...dataResults] = await Promise.all([
    sessions.read(), state.view(), ...data.map(a => registry.read(a))
  ])
  const byKey = {}
  data.forEach((a, n) => { byKey[a.key] = dataResults[n] })
  const i = byKey.inbox || { ok: true, items: [] }
  const b = byKey.backlogs || { ok: true, groups: [] }
  const e = byKey.evidence || { ok: true, byProject: {} }

  const live = (s.items || []).map(x => ({
    ...x,
    repo: x.project && e.byProject ? e.byProject[x.project] || null : null
  }))

  const pendingAll = (i.items || []).filter(x => !v.hidden.has(x.id))
  const pendingSorted = [
    ...pendingAll.filter(x => v.pinned.has(x.id)),
    ...pendingAll.filter(x => !v.pinned.has(x.id))
  ].map(x => ({ ...x, pinned: v.pinned.has(x.id) }))

  const groupsAll = (b.groups || []).map(g => {
    const items = g.items.filter(x => !v.hidden.has(x.id)).map(x => ({ ...x, pinned: v.pinned.has(x.id) }))
    const sorted = [...items.filter(x => x.pinned), ...items.filter(x => !x.pinned)]
    return { heading: g.heading, total: sorted.length, items: sorted }
  }).filter(g => g.total > 0)

  const backlogTotal = groupsAll.reduce((n, g) => n + g.total, 0)
  const sentGroups = groupsAll.slice(0, MAX_GROUPS).map(g => ({
    heading: g.heading,
    total: g.total,
    items: g.items.slice(0, MAX_ITEMS_PER_GROUP)
  }))

  // `installed: false` is a tool the user simply does not have — not counted, not drawn in red.
  // `hint` names what would provide the source, for the tile that stands in for it.
  const source = (key, r, hint) => ({
    key, ok: r.ok !== false, installed: r.installed !== false, path: r.path, error: r.error || null, hint
  })
  const sources = [
    source('sessions', s, sessionsHint()),
    ...data.map(a => source(a.key, byKey[a.key], a.hint || a.label))
  ]
  const detected = sources.filter(x => x.installed)

  const knownTotal = live.length + pendingSorted.length + backlogTotal

  return {
    at: Date.now(),
    sources,
    okCount: detected.filter(x => x.ok).length,
    detectedCount: detected.length,
    stateCorrupt: v.corrupt,
    live: {
      items: live,
      busy: live.filter(x => x.status === 'busy').length,
      // Per agent adapter: label, badge, installed, ok, error, count — "not installed" and
      // "unreadable" are different facts, and neither one may be shown as "no sessions".
      byAgent: s.byAgent || {},
      // SB: kept for the pre-registry shape; the same object as byAgent.hermes.
      hermes: s.hermes || null
    },
    // SB: receipts are mark-done records filtered out of `items` by inbox.js — carried so the
    // PENDING header can show them rather than letting them vanish silently.
    pending: {
      items: pendingSorted.slice(0, MAX_PENDING),
      total: pendingSorted.length,
      receipts: i.receipts || 0,
      // SB: round 3 · per-folder truth behind the summed `receipts` — .inbox/ (cron's) and
      // .board-inbox/ (the board's own, see sources/inbox.js).
      byFolder: i.byFolder || null
    },
    backlog: {
      groups: sentGroups,
      groupCount: groupsAll.length,
      total: backlogTotal,
      closed: b.closed || 0
    },
    counts: { known: knownTotal },
    unparsed: {
      sessions: s.unparsed || 0, inbox: i.unparsed || 0, backlogs: b.unparsed || 0
    }
  }
}

module.exports = { build }

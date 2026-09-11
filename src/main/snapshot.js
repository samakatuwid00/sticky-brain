'use strict'

const sessions = require('./sources/sessions')
const inbox = require('./sources/inbox')
const backlogs = require('./sources/backlogs')
const evidence = require('./sources/evidence')
const state = require('./state')

// One BoardSnapshot merged from the four sources, with board-state applied. A source that fails
// keeps its own `ok: false` and its path — the renderer draws a tile for it. It must never
// collapse into "nothing pending", which is the failure this whole design is aimed at.

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

async function build () {
  const [s, i, b, e, v] = await Promise.all([
    sessions.read(), inbox.read(), backlogs.read(), evidence.read(), state.view()
  ])

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

  const sources = [
    { key: 'sessions', ok: s.ok !== false, path: s.path, error: s.error || null },
    { key: 'inbox', ok: i.ok !== false, path: i.path, error: i.error || null },
    { key: 'backlogs', ok: b.ok !== false, path: b.path, error: b.error || null },
    { key: 'evidence', ok: e.ok !== false, path: e.path, error: e.error || null }
  ]

  const knownTotal = live.length + pendingSorted.length + backlogTotal

  return {
    at: Date.now(),
    sources,
    okCount: sources.filter(x => x.ok).length,
    stateCorrupt: v.corrupt,
    live: {
      items: live,
      busy: live.filter(x => x.status === 'busy').length,
      // SB: Hermes rides inside the sessions source rather than being a fifth one, so its own
      // health travels here — "hermes is not installed" and "hermes is unreadable" are different
      // facts, and neither one may be shown as "no sessions".
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

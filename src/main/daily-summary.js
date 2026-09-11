'use strict'

const { Notification, powerMonitor } = require('electron')
const snapshot = require('./snapshot')
const { toastBoard } = require('./board-toast')

/* SB: round 2 · Feature 3 · the end-of-day line.

   Once a day at 18:00 local: one native notification, "3 pending, 1 session busy". A minute tick
   rather than a single long setTimeout — a laptop asleep at 18:00 does not fire a timer that was
   due while it slept, and the tick (plus powerMonitor's resume) catches up on waking.

   Tracked in memory only, as asked. The cost of that is handled deliberately: a board STARTED
   after today's 18:00 counts today as already said, so a restart in the evening does not repeat
   the summary. Catch-up after sleep stops at 22:00 — a "your day" line at midnight is noise.

   STICKY_BRAIN_SUMMARY_AT=HH:MM moves the moment, which is how it is tested without waiting. */

const TICK_MS = 60 * 1000
const CATCH_UP_MIN = 4 * 60
const STALE_PENDING_MS = 3 * 24 * 60 * 60 * 1000

let opts = { board: () => null, open: () => {} }
let firedOn = null
let last = null         // held so the notification is not collected before it is clicked

function target () {
  const m = /^(\d{1,2}):(\d{2})$/.exec(process.env.STICKY_BRAIN_SUMMARY_AT || '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : 18 * 60
}

const dayKey = d => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
const minuteOf = d => d.getHours() * 60 + d.getMinutes()
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many)

function line (snap) {
  const parts = [snap.pending.total + ' pending', plural(snap.live.busy, 'session', 'sessions') + ' busy']
  const stale = (snap.pending.items || []).filter(p => p.createdAt && p.createdAt < Date.now() - STALE_PENDING_MS).length
  if (stale) parts.push(stale + ' waiting 3+ days')
  const down = snap.sources.filter(s => !s.ok).length
  if (down) parts.push(plural(down, 'source', 'sources') + ' down')
  return parts.join(', ')
}

async function check () {
  const now = new Date()
  const m = minuteOf(now) - target()
  if (m < 0 || m >= CATCH_UP_MIN) return
  const key = dayKey(now)
  if (firedOn === key) return
  // Claimed before the await: a slow snapshot must not let the next tick fire a second one.
  firedOn = key

  let text
  try { text = line(await snapshot.build()) } catch (err) {
    console.error('[daily-summary] snapshot failed:', err && err.message)
    return
  }

  const fallback = () => toastBoard(opts.board, 'end of day — ' + text)
  if (!Notification.isSupported()) { fallback(); return }
  last = new Notification({ title: 'Sticky Brain — end of day', body: text })
  last.on('click', () => opts.open())
  // Windows raises `failed` when it refuses a toast (focus assist, notifications off for the app).
  last.on('failed', (_e, err) => { console.error('[daily-summary] notification failed:', err); fallback() })
  last.show()
}

function start (o) {
  opts = { ...opts, ...o }
  if (minuteOf(new Date()) >= target()) firedOn = dayKey(new Date())
  setInterval(check, TICK_MS)
  powerMonitor.on('resume', check)
}

module.exports = { start, line }

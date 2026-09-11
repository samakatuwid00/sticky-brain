'use strict'

/* Niko's reading of the board, as pure functions of one snapshot — no DOM, no timers — so the pet
   (niko-pet.js) and build/check-sources.js run the same code. A plain script in the page
   (window.NikoMood), a module under Node. */

;(function (root) {
  /* SB: round 2 · Feature 2 · a pending item this old has been waiting long enough to be forgotten,
     which is the exact failure the board exists to prevent. Read from snap.pending.items, which
     already excludes acked and snoozed records — so snoozing a stale one is how you quiet him.
     The list is capped at 50 in transit (snapshot.js); past that the count is a floor. */
  const STALE_PENDING_MS = 3 * 24 * 60 * 60 * 1000

  function stalePending (snap, now) {
    if (!snap || !snap.pending || !snap.pending.items) return 0
    const cutoff = (now || Date.now()) - STALE_PENDING_MS
    return snap.pending.items.filter(p => p.createdAt && p.createdAt < cutoff).length
  }

  // SB: Phase 3 · one agent unreadable while the LIVE source as a whole is up — a broken adapter
  // beside working ones. The board still tells the truth about the others, so this is concern, not
  // alarm. When every agent is down the sessions source itself fails, which is `error`, and is
  // deliberately not counted here too.
  function brokenAgents (snap) {
    if (!snap || !snap.live || !snap.live.byAgent) return []
    const live = (snap.sources || []).find(s => s.key === 'sessions')
    if (live && live.ok === false) return []
    return Object.values(snap.live.byAgent).filter(a => a && a.installed && a.ok === false)
  }

  function moodOf (snap, now) {
    if (!snap) return 'idle'
    if (snap.sources.some(s => !s.ok)) return 'error'
    if (snap.live.busy > 0) return 'busy'
    // Below busy for the same reason as `worried`: while a session works, the owner is mid-task.
    if (brokenAgents(snap).length) return 'concerned'
    // SB: round 2 · Feature 2 · below busy on purpose: while a session is working the owner is
    // mid-task, and the nudge lands when they come up for air. Above plain waiting, which it is a
    // sharper version of.
    if (stalePending(snap, now) > 0) return 'worried'
    if (snap.pending.total > 0) return 'waiting'
    return 'idle'
  }

  const api = { STALE_PENDING_MS, stalePending, brokenAgents, moodOf }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.NikoMood = api
})(typeof window !== 'undefined' ? window : globalThis)

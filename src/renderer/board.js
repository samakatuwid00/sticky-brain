'use strict'

/* Renders one BoardSnapshot. Never touches the filesystem — everything arrives over `window.board`. */

const body = document.getElementById('body')
const fSources = document.getElementById('f-sources')
const fAge = document.getElementById('f-age')
const fOf = document.getElementById('f-of')

let snap = null
let focusIndex = -1
// SB: fullscreen is owned by the main process — this only mirrors what the window reports.
let fullscreen = false
// SB: Feature 1 · so is niko-only mode. While it is on there is no board on screen at all — the
// window is 128x92 of pet — so the board's own keys and re-renders stand down.
let nikoOnly = false

// Compact promises roughly twice the items at the same width — so the display caps live here,
// with the density, not in the process that reads the files.
// SB: fullscreen is a third density in everything but name: the same board with room for more of
// it, so it gets its own caps rather than borrowing compact's.
// SB: LIVE gained a cap when Hermes joined it. One machine only ever had a couple of Claude Code
// sessions, so the list could be drawn whole; Hermes routinely has more, and an uncapped LIVE
// section pushed PENDING off the bottom of the widget entirely.
const LIMITS = {
  default: { live: 5, pending: 3, groups: 3, perGroup: 3 },
  compact: { live: 9, pending: 6, groups: 6, perGroup: 6 },
  full: { live: 12, pending: 8, groups: 6, perGroup: 8 },
  fullCompact: { live: 20, pending: 14, groups: 10, perGroup: 12 }
}
function limits () {
  const compact = document.documentElement.dataset.density === 'compact'
  if (fullscreen) return compact ? LIMITS.fullCompact : LIMITS.full
  return compact ? LIMITS.compact : LIMITS.default
}

// SB: a fourth column is only offered when there is genuinely width for it; below that the
// backlog stays in one and the grid folds down (board.css).
const backlogColumns = () => (fullscreen && window.innerWidth >= 1500 ? 2 : 1)

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function rel (ms) {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return s + 's'
  const m = Math.round(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ' + (m % 60) + 'm'
  const d = Math.floor(h / 24)
  return d + 'd ' + (h % 24) + 'h'
}

function drift (ms) {
  if (!ms) return ''
  const s = Math.round((Date.now() - ms) / 1000)
  return s < 60 ? '·' + s + 's' : '·' + Math.round(s / 60) + 'm'
}

function abs (ms) {
  return ms ? new Date(ms).toLocaleString() : 'unknown'
}

const srcPath = key => {
  const s = snap && snap.sources.find(x => x.key === key)
  return s ? s.path : null
}

/* ---- SB: toast — the only feedback for work that finishes in another window ---- */
const toastEl = document.getElementById('toast')
let toastTimer = null
function toast (msg, bad, ms) {
  if (!toastEl) return
  toastEl.textContent = msg
  toastEl.className = bad ? 'bad' : ''
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.className = 'hidden' }, ms || 2600)
}

/* ---- SB: the two outbound actions ---- */
// SB: every outcome the main process can report gets its own words. A Hermes row now has two more
// of them — 'desktop' (its conversation was opened in the Hermes Desktop App) and
// 'desktop-launched' (the app was not running, so it was started) — because a saved session no
// longer answers a click by opening a scratchpad folder.
const SESSION_MODE = {
  window: s => 'focused ' + s.name,
  folder: s => 'no window — opened ' + (s.cwd || 'folder'),
  desktop: () => 'opened in the Hermes Desktop App',
  'desktop-launched': () => 'starting the Hermes Desktop App…'
}

async function openSession (s) {
  const r = await window.board.revealSession({
    agent: s.agent || 'claude', pid: s.pid, cwd: s.cwd, sessionId: s.sessionId || null
  })
  // SB: "opened its folder" used to be the answer to a dead session, a hidden terminal and a
  // broken helper alike. The main process now names which of those happened, so the board can too.
  if (r && r.ok) toast((SESSION_MODE[r.mode] || SESSION_MODE.folder)(s))
  else if (r && r.mode === 'ended') toast('session ended — ' + s.name + ' is no longer running', true)
  else if (r && r.mode === 'unsupported') toast(r.error || 'not supported on this OS', true)
  else toast('could not reach ' + s.name + (r && r.error ? ' — ' + r.error : ''), true)
}

// SB: a task no longer leaves the board by itself — it goes to the clipboard and the owner pastes it
// wherever the work is going to happen. The text is the same one the hermes chat used to be seeded
// with: title, then follow-ups / unresolved, then the file it came from. (`openTaskChat` is still
// on the bridge; nothing here calls it.)
function taskText (info) {
  return [info.title, info.content, info.sourceFile ? 'Source: ' + info.sourceFile : null]
    .filter(Boolean).join('\n\n')
}

async function copyTask (info) {
  try {
    await navigator.clipboard.writeText(taskText(info))
    toast('copied to clipboard')
  } catch (err) {
    toast('could not copy — ' + ((err && err.message) || 'clipboard unavailable'), true)
  }
}

// SB: `done` is the only action that can fail — it writes to the vault. A row that vanished
// without the file agreeing would be a lie, so a failure toasts and the board is left alone.
async function act (key, id) {
  const r = await window.board.act(key, id)
  if (r && r.ok === false) toast(r.error || 'could not mark it done', true)
}

// Enter on a focused row does the same thing a click does — the openers hang off the node so the
// key handler does not have to re-derive which item it is looking at.
function clickable (node, fn) {
  node._sbOpen = fn
  node.onclick = e => { e.stopPropagation(); fn() }
  return node
}

function pendingTask (p) {
  const parts = []
  if (p.followUps) parts.push('Follow-ups: ' + p.followUps)
  if (p.unresolved) parts.push('Unresolved: ' + p.unresolved)
  return { title: p.task, content: parts.join('\n'), sourceFile: p.file || srcPath('inbox') }
}

function backlogTask (it, heading) {
  return {
    title: it.text,
    content: heading ? 'From the "' + heading + '" heading of Open Backlogs.' : '',
    sourceFile: srcPath('backlogs')
  }
}

function section (label, count, note) {
  const s = el('div', 'sec')
  s.append(el('span', 'label', label))
  if (count != null) s.append(el('span', 'count', String(count)))
  if (note) s.append(el('span', 'note', note))
  s.append(el('span', 'rule'))
  return s
}

function unavailable (src) {
  const t = el('div', 'tile')
  const head = el('div', 'head')
  head.append(el('span', 'warn', 'source unavailable'))
  head.append(el('span', 'age', src.error || 'unreadable'))
  t.append(head)
  t.append(el('div', 'path', src.path))
  const acts = el('div', 'acts')
  const retry = el('button', null, 'r retry')
  retry.onclick = () => window.board.refresh()
  const reveal = el('button', null, 'o reveal file')
  reveal.onclick = () => window.board.reveal(src.path)
  acts.append(retry, reveal)
  t.append(acts)
  return t
}

// A source this machine simply does not have: one quiet line saying what would provide it, not
// the red tile a broken source gets.
function notSetUp (src) {
  const t = el('div', 'repo', 'not set up — ' + (src.hint || src.key))
  t.title = src.path || ''
  return t
}

// SB: two agents share this list now, so every row says which one it is. A two-letter badge with
// the full name on hover, not a colour — the same "shape + word, never hue alone" rule the status
// marker follows, and the widget is 360px wide, so the name still has to be the longest thing.
const AGENTS = {
  claude: { badge: 'CC', full: 'Claude Code' },
  hermes: { badge: 'HM', full: 'Hermes Agent' }
}

// SB: WHY a Hermes row is being called live, in the row's own tooltip. The board used to infer
// liveness from recency alone and say so in one fixed sentence; there are now three different
// grounds for it and they are not equally strong, so each one names itself.
const LIVE_BY = {
  process: 'live — hermes has a running process registered against this session',
  api: 'live — the local hermes backend reports this session as active',
  recent: 'live — INFERRED: it spoke seconds ago and a hermes process is running'
}

// SB: Phase 2 · an agent this file has never heard of still gets a badge and a name — from the
// adapter that produced it, carried in snap.live.byAgent — so a new adapter needs no renderer edit.
function agentInfo (key) {
  key = key || 'claude'
  if (AGENTS[key]) return AGENTS[key]
  const a = snap && snap.live.byAgent && snap.live.byAgent[key]
  return { badge: (a && a.badge) || key.slice(0, 2).toUpperCase(), full: (a && a.label) || key }
}

function sessionRow (s) {
  const agent = agentInfo(s.agent)
  const hermes = s.agent === 'hermes'
  // SB: 'saved' is Hermes history — real and openable, and explicitly not a claim that anything is
  // running. It is dimmed like a stale row without borrowing stale's "the process died" meaning.
  const row = el('div', 'row' + (s.status === 'stale' ? ' stale' : '') + (s.status === 'saved' ? ' saved' : ''))
  row.tabIndex = 0
  row.title = `${agent.full} · ${s.status} — started ${abs(s.startedAt)}` +
    (hermes ? `\nmodel ${s.version || 'unknown'} · ${s.messageCount || 0} messages, ${s.toolCallCount || 0} tool calls` +
      `\n${s.status === 'saved'
        ? 'saved history — no running process is registered against it'
        : (LIVE_BY[s.liveBy] || 'live')}` +
      `\nsession ${s.sessionId} · resume it with: hermes chat --resume ${s.sessionId}`
      : ` · pid ${s.pid}`) +
    `${s.status === 'stale' ? ' (gone)' : ''} · updated ${rel(s.updatedAt)} ago` +
    (hermes
      ? (s.pid ? '\nclick to focus its window' : '\nclick to open it in the Hermes Desktop App')
      : '\nclick to focus its terminal')

  const st = el('span', 'st ' + s.status, s.status === 'stale' ? '×' : '')
  row.append(st)
  const badge = el('span', 'ag ' + (s.agent || 'claude'), agent.badge)
  badge.title = agent.full
  row.append(badge)
  row.append(el('span', 'nm', s.name))
  row.append(el('span', 'cwd', '· ' + (s.project || '~')))
  row.append(el('span', 'el', rel(s.startedAt)))
  row.append(el('span', 'drift',
    s.status === 'stale' ? 'gone' : s.status === 'saved' ? 'saved' : drift(s.updatedAt)))
  return clickable(row, () => openSession(s))
}

function slip (p) {
  const card = el('div', 'slip' + (p.pinned ? ' pinned' : ''))
  card.tabIndex = 0
  card.dataset.id = p.id
  card.append(el('span', 'fold-a'), el('span', 'fold-b'))

  const meta = el('div', 'meta')
  meta.append(el('span', 'over', 'PEND · ' + p.project.toUpperCase()))
  const age = el('span', 'age', rel(p.createdAt))
  age.title = 'created ' + (p.createdLocal || 'unknown')
  meta.append(age)
  card.append(meta)

  // SB: round 2 · the task is clamped to two lines in CSS; the whole of it rides on the tooltip.
  const task = el('div', 'task', p.task)
  task.title = p.task
  card.append(task)

  if (p.followUps) {
    const line = el('div', 'line')
    line.append(el('span', 'g', '↳'), el('span', null, p.followUps))
    line.title = p.followUps
    card.append(line)
  }
  if (p.unresolved) {
    const line = el('div', 'line')
    line.append(el('span', 'g q', '?'), el('span', null, p.unresolved))
    line.title = p.unresolved
    card.append(line)
  }

  const copy = () => copyTask(pendingTask(p))
  card.append(actions(p.id, copy))
  return clickable(card, copy)
}

// SB: `done` leads, because it is the one that ends the item.
function actions (id, copy) {
  const acts = el('div', 'acts')
  for (const [key, label] of [['done', 'x done'], ['ack', 'a ack'], ['snooze', 's snooze'], ['pin', 'p pin']]) {
    const b = el('button', null, label)
    b.onclick = e => { e.stopPropagation(); act(key, id) }
    acts.append(b)
  }
  acts.append(copyButton('c copy', copy))
  return acts
}

function copyButton (label, copy) {
  const b = el('button', 'cp', label)
  b.title = 'Copy the task, its notes and its source path'
  b.onclick = e => { e.stopPropagation(); copy() }
  return b
}

function backlogItem (it, heading) {
  const row = el('div', 'item' + (it.pinned ? ' pinned' : ''))
  row.tabIndex = 0
  row.dataset.id = it.id
  row.title = it.text + '\nclick or c to copy it · x marks it done'
  row.append(el('span', 'mark'))
  row.append(el('span', 'txt', it.text))
  const copy = () => copyTask(backlogTask(it, heading))
  row.append(copyButton('copy', copy))
  return clickable(row, copy)
}

/* ---- SB: LIVE is an apps list — Task Manager's Processes sidebar, not one row per session ----
   Sessions fold under the app they belong to (the project, else the agent's own name). Saved and
   stale rows are not running, so they share one Archive group at the bottom. Open/closed lives in
   memory only: apps start open, the Archive starts folded. */
const ARCHIVE = 'archive'
const liveOpen = new Map()

function appName (s) {
  return s.project || agentInfo(s.agent).full || 'unfiled'
}

// The source already sorts busy-then-recent with saved and stale last, so first appearance is the
// right group order and each group's rows keep that order too.
function liveGroups (items) {
  const apps = new Map()
  const archive = { key: ARCHIVE, name: 'Archive', archive: true, items: [] }
  for (const s of items) {
    if (s.status === 'saved' || s.status === 'stale') { archive.items.push(s); continue }
    const key = 'app:' + appName(s)
    if (!apps.has(key)) apps.set(key, { key, name: appName(s), archive: false, items: [] })
    apps.get(key).items.push(s)
  }
  const out = [...apps.values()]
  if (archive.items.length) out.push(archive)
  return out
}

function appHead (g, open) {
  const busy = g.items.filter(s => s.status === 'busy').length
  const head = el('div', 'app' + (g.archive ? ' archive' : ''))
  head.tabIndex = 0
  head.dataset.group = g.key
  head.setAttribute('role', 'button')
  head.setAttribute('aria-expanded', String(open))
  head.title = (g.archive ? 'saved and stale sessions — nothing here is running' : g.name) +
    '\nclick or ↵ to ' + (open ? 'fold' : 'unfold')
  head.append(el('span', 'caret', open ? '▾' : '▸'))
  head.append(el('span', 'h', g.name))
  head.append(el('span', 'n', g.items.length + (busy ? ' · ' + busy + ' busy' : '')))
  return clickable(head, () => toggleGroup(g.key, open))
}

// A re-render replaces every node, so the header that was toggled gets its focus back by key.
function toggleGroup (key, open) {
  liveOpen.set(key, !open)
  render()
  const again = body.querySelector('[data-group="' + CSS.escape(key) + '"]')
  if (again) { again.focus(); focusIndex = focusables().indexOf(again) }
}

// SB: `…` no longer throws the owner at a 4000-line Markdown file. It opens the overview.
function moreButton (text, ctx, cls) {
  const wrap = el('div', 'more' + (cls ? ' ' + cls : ''))
  const b = el('button', null, text)
  b.onclick = e => { e.stopPropagation(); openModal(ctx) }
  wrap.append(b)
  return wrap
}

/* ---- SB: fullscreen puts the three sections side by side; the widget keeps them stacked ---- */
function layout () {
  body.textContent = ''
  if (!fullscreen) return { live: body, pending: body, backlog: [body] }
  const grid = el('div', 'cols')
  const live = el('div', 'col')
  const pending = el('div', 'col')
  const backlog = []
  for (let i = 0; i < backlogColumns(); i++) backlog.push(el('div', 'col'))
  grid.append(live, pending, ...backlog)
  body.append(grid)
  return { live, pending, backlog }
}

/* ---- SB: Phase 3 · first-run setup card ----
   Asked for once when the page loads, drawn above LIVE, and gone for good after save or skip. The
   board renders underneath exactly as it would without it — the card is never a gate. Choices wait
   in `setupDraft` so the 15s re-render does not undo a ticked box. */
let setupInfo = null
const setupDraft = { agents: {} }

function setupCard () {
  const s = setupInfo
  const t = el('div', 'tile setup')
  const head = el('div', 'head')
  head.append(el('span', 'warn', 'first run'), el('span', 'age', 'saved to config.json — edit it any time'))
  t.append(head)

  const where = s.mode === 'vault' ? 'vault · ' + s.vault : 'data · ' + (setupDraft.dataDir || s.dataDir)
  t.append(el('div', 'path', where))

  for (const a of s.agents) {
    const row = el('label', 'agent')
    const box = el('input')
    box.type = 'checkbox'
    box.checked = a.key in setupDraft.agents ? setupDraft.agents[a.key] : a.enabled
    box.onchange = () => { setupDraft.agents[a.key] = box.checked }
    row.append(box, el('span', null, a.label), el('span', 'dim', a.installed ? 'found' : 'not found'))
    row.title = a.path || ''
    t.append(row)
  }

  const acts = el('div', 'acts')
  if (s.mode !== 'vault') {
    const move = el('button', null, 'change folder…')
    move.onclick = async () => {
      const dir = await window.board.setupChooseDataDir()
      if (dir) { setupDraft.dataDir = dir; render() }
    }
    acts.append(move)
  }
  const save = el('button', null, 'save')
  save.onclick = async () => {
    const r = await window.board.setupSave(setupDraft)
    if (!r || !r.ok) { toast((r && r.error) || 'could not save setup', true); return }
    setupInfo = null
    toast('saved to ' + r.state.configFile)
    render()
  }
  const skip = el('button', null, 'skip')
  skip.onclick = async () => { await window.board.setupSkip(); setupInfo = null; render() }
  acts.append(save, skip)
  t.append(acts)
  return t
}

function render () {
  if (!snap) {
    body.textContent = ''
    for (let i = 0; i < 6; i++) body.append(el('div', 'skel'))
    return
  }

  const col = layout()
  if (setupInfo) col.live.append(setupCard())
  const bad = snap.sources.filter(s => !s.ok)
  const src = k => snap.sources.find(s => s.key === k)
  const cap = limits()
  let shown = 0

  // --- LIVE ---
  col.live.append(section('LIVE', snap.live.items.length, snap.live.busy ? snap.live.busy + ' busy' : null))
  if (!src('sessions').ok) {
    col.live.append(unavailable(src('sessions')))
  } else if (src('sessions').installed === false) {
    col.live.append(notSetUp(src('sessions')))
  } else {
    // The cap is per open group now: rows arrive sorted busy-then-recent, so it still drops the
    // least interesting ones. A folded group draws nothing and counts nothing toward `shown`.
    for (const g of liveGroups(snap.live.items)) {
      const open = liveOpen.has(g.key) ? liveOpen.get(g.key) : !g.archive
      col.live.append(appHead(g, open))
      if (!open) continue
      const rows = g.items.slice(0, cap.live)
      shown += rows.length
      for (const s of rows) {
        col.live.append(sessionRow(s))
        if (s.repo) {
          const chip = el('div', 'repo' + (s.repo.flagged ? ' flag' : ''),
            `[${s.repo.branch}${s.repo.dirty ? ' *' + s.repo.dirty : ''}]`)
          col.live.append(chip)
        }
      }
      const hidden = g.items.length - rows.length
      if (hidden > 0) col.live.append(el('div', 'repo', '+ ' + hidden + ' more sessions'))
    }
    // SB: every agent is read inside the sessions source, so one agent's failure would otherwise be
    // invisible — the list would simply be short, which is the one thing this board must never do.
    // An agent merely not being installed says nothing and prints nothing.
    for (const a of Object.values(snap.live.byAgent || {})) {
      if (!a.installed || a.ok) continue
      const t = el('div', 'repo flag', a.label + ' sessions unreadable — ' + (a.error || 'unknown'))
      t.title = a.path || ''
      col.live.append(t)
    }
  }

  // --- PENDING ---
  // SB: receipts are visible rather than merely absent — mark-done records are filtered out of
  // the pending list, so the count that left has to be named somewhere.
  col.pending.append(section('PENDING', src('inbox').ok ? snap.pending.total : null,
    snap.pending.receipts ? snap.pending.receipts + ' done' : null))
  if (!src('inbox').ok) {
    col.pending.append(unavailable(src('inbox')))
  } else {
    const pend = snap.pending.items.slice(0, cap.pending)
    shown += pend.length
    for (const p of pend) col.pending.append(slip(p))
    const pendHidden = snap.pending.total - pend.length
    if (pendHidden > 0) {
      col.pending.append(moreButton('+ ' + pendHidden + ' more pending ›', { kind: 'pending' }))
    }
  }

  // --- BACKLOG ---
  col.backlog[0].append(section('BACKLOG', src('backlogs').ok ? snap.backlog.total : null))
  for (let i = 1; i < col.backlog.length; i++) col.backlog[i].append(section('BACKLOG ⋯', null))
  if (!src('backlogs').ok) {
    col.backlog[0].append(unavailable(src('backlogs')))
  } else if (src('backlogs').installed === false) {
    col.backlog[0].append(notSetUp(src('backlogs')))
  } else {
    const groups = snap.backlog.groups.slice(0, cap.groups)
    let accountedFor = 0
    groups.forEach((g, gi) => {
      // Round-robin so a long first heading does not leave the second column empty.
      const into = col.backlog[gi % col.backlog.length]
      const head = el('div', 'grp')
      head.append(el('span', 'h', g.heading))
      head.append(el('span', 'n', String(g.total)))
      into.append(head)

      const items = g.items.slice(0, cap.perGroup)
      shown += items.length
      accountedFor += g.total
      for (const it of items) into.append(backlogItem(it, g.heading))

      const hidden = g.total - items.length
      if (hidden > 0) {
        into.append(moreButton('+ ' + hidden + ' more ›', { kind: 'group', heading: g.heading }))
      }
    })
    const restItems = snap.backlog.total - accountedFor
    const restGroups = snap.backlog.groupCount - groups.length
    if (restItems > 0) {
      col.backlog[0].append(moreButton(
        `+ ${restItems} more in ${restGroups} headings ›`, { kind: 'backlog' }, 'top'))
    }
  }

  // --- empty: sources fine, counts genuinely zero ---
  if (!bad.length && snap.counts.known === 0) {
    const e = el('div', 'empty')
    e.append(el('div', 'big', 'board clear'))
    e.append(el('div', 'sub', 'nothing live, pending or backlogged'))
    body.append(e)
  }

  // --- footer ---
  // Sources the machine does not have are left out of the count, and named on hover instead.
  const missing = snap.sources.filter(s => s.installed === false)
  fSources.textContent = `${snap.okCount}/${snap.detectedCount ?? snap.sources.length} sources ok`
  fSources.className = bad.length ? 'bad' : 'ok'
  fSources.title = missing.map(s => s.key + ' not set up — ' + (s.hint || s.path)).join('\n')
  fAge.textContent = '· ' + rel(snap.at)
  fOf.textContent = `${shown} of ${snap.counts.known}`

  if (snap.stateCorrupt) {
    const t = el('div', 'tile')
    t.append(el('span', 'warn', 'board state was unreadable'))
    t.append(el('div', 'path', 'It was backed up beside itself and started empty. Acks and pins are gone.'))
    body.prepend(t)
  }

  if (modalCtx) fillModal()

  window.nikoPet && window.nikoPet.observe(snap)
}

/* ================= SB: Feature 4 · overview modal =================
   Everything in one category, in the app, with a preview — the `…` used to open the raw file,
   which is the moment the board stopped being the thing you look at. */

const modal = document.getElementById('overview-modal')
const modalTitle = document.getElementById('modal-title')
const modalCount = document.getElementById('modal-count')
const modalSearch = document.getElementById('modal-search')
const modalList = document.getElementById('modal-list')
const modalPreview = document.getElementById('modal-preview')
const modalReveal = document.getElementById('modal-reveal')

let modalCtx = null     // { kind: 'pending' | 'group' | 'backlog', heading? }
let modalRows = []      // the filtered rows currently drawn
let modalSel = -1

// The snapshot carries transport caps of its own (snapshot.js), so "all" means all of what the
// board was given — the header count stays the source's real total, which can be larger.
function collect (ctx) {
  if (!snap) return { rows: [], total: 0, title: '' }
  if (ctx.kind === 'pending') {
    return {
      title: 'PENDING',
      total: snap.pending.total,
      rows: snap.pending.items.map(p => ({
        id: p.id, kind: 'pending', tag: p.project.toUpperCase(), text: p.task,
        age: rel(p.createdAt), pinned: p.pinned, item: p
      }))
    }
  }
  const groups = ctx.kind === 'group'
    ? snap.backlog.groups.filter(g => g.heading === ctx.heading)
    : snap.backlog.groups
  const rows = []
  for (const g of groups) {
    for (const it of g.items) {
      rows.push({ id: it.id, kind: 'backlog', tag: g.heading, text: it.text, pinned: it.pinned, item: it, heading: g.heading })
    }
  }
  return {
    title: ctx.kind === 'group' ? ctx.heading : 'BACKLOG',
    total: ctx.kind === 'group' ? (groups[0] ? groups[0].total : rows.length) : snap.backlog.total,
    rows
  }
}

function previewFor (row) {
  modalPreview.textContent = ''
  if (!row) {
    modalPreview.append(el('div', 'ph', 'Select an item to preview it.'))
    return
  }
  modalPreview.append(el('div', 'p-head', row.tag))
  modalPreview.append(el('div', 'p-title', row.text))

  if (row.kind === 'pending') {
    const p = row.item
    if (p.followUps) {
      const line = el('div', 'p-line')
      line.append(el('span', 'g', '↳'), el('span', null, p.followUps))
      modalPreview.append(line)
    }
    if (p.unresolved) {
      const line = el('div', 'p-line')
      line.append(el('span', 'g q', '?'), el('span', null, p.unresolved))
      modalPreview.append(line)
    }
    const when = el('div', 'p-line')
    when.append(el('span', 'g', '·'), el('span', null, 'captured ' + (p.createdLocal || 'unknown')))
    modalPreview.append(when)
  }

  const info = row.kind === 'pending' ? pendingTask(row.item) : backlogTask(row.item, row.heading)
  modalPreview.append(el('div', 'p-path', info.sourceFile || ''))

  const acts = el('div', 'p-acts')
  const copy = el('button', null, '↵ copy')
  copy.onclick = () => copyTask(info)
  acts.append(copy)
  // SB: `done` applies to both kinds now; ack/snooze/pin stay pending-only.
  const doneBtn = el('button', null, 'x done')
  doneBtn.onclick = () => act('done', row.id)
  acts.append(doneBtn)
  if (row.kind === 'pending') {
    for (const [key, label] of [['ack', 'ack'], ['snooze', 'snooze'], ['pin', 'pin']]) {
      const b = el('button', null, label)
      b.onclick = () => act(key, row.id)
      acts.append(b)
    }
  }
  modalPreview.append(acts)
}

function select (i) {
  modalSel = Math.max(-1, Math.min(modalRows.length - 1, i))
  for (const node of modalList.children) node.classList.remove('on')
  const node = modalList.children[modalSel]
  if (node) { node.classList.add('on'); node.scrollIntoView({ block: 'nearest' }) }
  previewFor(modalRows[modalSel] || null)
}

function fillModal () {
  if (!modalCtx) return
  const got = collect(modalCtx)
  const q = modalSearch.value.trim().toLowerCase()
  const keptId = modalRows[modalSel] ? modalRows[modalSel].id : null

  modalRows = q
    ? got.rows.filter(r => (r.text + ' ' + r.tag).toLowerCase().includes(q))
    : got.rows

  modalTitle.textContent = got.title
  modalCount.textContent = q
    ? modalRows.length + ' / ' + got.total
    : String(Math.max(got.total, modalRows.length))

  modalList.textContent = ''
  if (!modalRows.length) {
    modalList.append(el('div', 'm-empty', q ? 'nothing matches “' + modalSearch.value.trim() + '”' : 'nothing here'))
    modalSel = -1
    previewFor(null)
    return
  }

  modalRows.forEach((r, i) => {
    const node = el('div', 'm-row' + (r.pinned ? ' pinned' : ''))
    node.tabIndex = -1
    node.title = r.text
    node.append(el('span', 'm-tag', r.tag))
    node.append(el('span', 'm-txt', r.text))
    if (r.age) node.append(el('span', 'm-age', r.age))
    node.onmouseenter = () => select(i)
    node.onclick = () => {
      // First click previews, a second on the same row copies it — nothing lands on the clipboard
      // by accident.
      if (modalSel === i) copyTask(r.kind === 'pending' ? pendingTask(r.item) : backlogTask(r.item, r.heading))
      else select(i)
    }
    modalList.append(node)
  })

  const back = modalRows.findIndex(r => r.id === keptId)
  select(back >= 0 ? back : 0)
}

function openModal (ctx) {
  modalCtx = ctx
  modalSearch.value = ''
  modalSel = -1
  modal.classList.remove('hidden')
  fillModal()
  modalSearch.focus()
}

function closeModal () {
  modalCtx = null
  modalRows = []
  modalSel = -1
  modal.classList.add('hidden')
}

modalSearch.oninput = fillModal
document.getElementById('modal-close').onclick = closeModal
modal.querySelector('.modal-backdrop').onclick = closeModal
modalReveal.onclick = () => {
  if (!modalCtx) return
  window.board.reveal(modalCtx.kind === 'pending' ? srcPath('inbox') : srcPath('backlogs'))
}

/* ---- keyboard: ↑↓ traversal, x/a/s/p on the focused item ---- */
function focusables () {
  return Array.from(body.querySelectorAll('[tabindex="0"]'))
}

document.addEventListener('keydown', e => {
  // SB: the modal owns the keyboard while it is up, or ↑↓ would walk the board behind it.
  if (modalCtx) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      select(modalSel + (e.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const r = modalRows[modalSel]
      if (r) copyTask(r.kind === 'pending' ? pendingTask(r.item) : backlogTask(r.item, r.heading))
      return
    }
    // SB: the overview is where a run of items actually gets cleared, so `x` works here too.
    // The search box owns the keyboard while it has focus — typing "x" into a filter must never
    // write to the vault, so the letter is only a shortcut outside an input.
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')
    if (e.key === 'x' && !typing) {
      e.preventDefault()
      const r = modalRows[modalSel]
      if (r) act('done', r.id)
      return
    }
    return
  }

  // SB: Feature 1 · in niko-only mode the board is not on screen. Esc and Enter bring it back —
  // the pet can be dragged behind another window and the keyboard should not be a dead end — and
  // every other shortcut would act on a board nobody can see.
  if (nikoOnly) {
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); window.board.restoreFromNiko() }
    return
  }

  // SB: never read a letter as a shortcut while something is being typed into.
  const tag = e.target && e.target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return

  const list = focusables()
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    focusIndex = Math.max(0, Math.min(list.length - 1, focusIndex + (e.key === 'ArrowDown' ? 1 : -1)))
    list[focusIndex] && list[focusIndex].focus()
    return
  }
  if (e.key === 'Escape' && fullscreen) { toggleFullscreen(); return }
  if (e.key === 'd') { toggleDensity(); return }
  if (e.key === 't') { toggleTheme(); return }
  if (e.key === 'f') { toggleFullscreen(); return }
  if (e.key === 'r') { window.board.refresh(); return }

  const active = document.activeElement
  if (e.key === 'Enter' && active && active._sbOpen) { e.preventDefault(); active._sbOpen(); return }

  const id = active && active.dataset ? active.dataset.id : null
  if (!id) return
  // SB: `x` is free; `d` is toggleDensity and stays that way. Only task cards carry an id, and a
  // task card's opener is its copy, so `c` is the same as ↵ on one.
  if (e.key === 'c' && active._sbOpen) active._sbOpen()
  if (e.key === 'x') act('done', id)
  if (e.key === 'a') act('ack', id)
  if (e.key === 's') act('snooze', id)
  if (e.key === 'p') act('pin', id)
})

function toggleDensity () {
  const r = document.documentElement
  r.dataset.density = r.dataset.density === 'compact' ? 'default' : 'compact'
  // Density decides how many items are drawn, so it must re-render, not only restyle.
  render()
  window.nikoPet && window.nikoPet.resize()
}
function toggleTheme () {
  const r = document.documentElement
  r.dataset.theme = r.dataset.theme === 'light' ? 'dark' : 'light'
  window.nikoPet && window.nikoPet.retheme()
}

/* ---- SB: Feature 5 · fullscreen ---- */
const kFull = document.getElementById('k-full')

// The window is the authority: it can leave fullscreen on its own (Esc, the OS), and the resize
// fallback in the main process may land somewhere the button did not ask for.
function applyFullscreen (on) {
  if (fullscreen === !!on) return
  fullscreen = !!on
  document.body.classList.toggle('fullscreen', fullscreen)
  kFull.textContent = fullscreen ? '⤡' : '⤢'
  kFull.title = fullscreen ? 'Leave fullscreen (f / esc)' : 'Fullscreen dashboard (f)'
  render()
  window.nikoPet && window.nikoPet.resize()
}

async function toggleFullscreen () {
  applyFullscreen(await window.board.toggleFullscreen())
}

document.getElementById('k-density').onclick = toggleDensity
document.getElementById('k-theme').onclick = toggleTheme
kFull.onclick = toggleFullscreen
document.getElementById('k-close').onclick = () => window.board.close()

window.board.onFullscreen(applyFullscreen)

/* ---- SB: Feature 1 · niko-only mode ----
   The main process owns the mode (the tray and the pet's own menu can both enter and leave it),
   so this only follows it. The pet is told separately rather than reading the body class, because
   he also has to re-measure the rail he is standing in. */
window.board.onNikoOnly(on => {
  nikoOnly = !!on
  window.nikoPet && window.nikoPet.setNikoOnly(nikoOnly)
  // Coming back, the board may be several snapshots out of date — it was not drawn while it was
  // off screen. Going away, nothing needs drawing.
  if (!nikoOnly && snap) render()
})

// SB: snapshots keep arriving in niko-only mode and must keep reaching the pet — his mood IS the
// board while the board is hidden — but the DOM behind him is not worth rebuilding.
window.board.onSnapshot(s => {
  snap = s
  if (nikoOnly) { window.nikoPet && window.nikoPet.observe(s); return }
  render()
})
// SB: round 2 · notices from the main process (quick-capture, the end-of-day fallback). Held
// longer than an action's toast — nothing on the board prompted them. In niko-only mode the toast
// is hidden with the board, so he says it instead.
window.board.onToast(t => {
  if (!t.msg) return
  if (nikoOnly && window.nikoPet) window.nikoPet.say(t.msg, 6000)
  else toast(t.msg, t.bad, 6000)
})
window.board.onFatal(msg => {
  body.textContent = ''
  const t = el('div', 'tile')
  t.append(el('span', 'warn', 'board failed to build'))
  t.append(el('div', 'path', msg))
  body.append(t)
})

// SB: crossing the fourth-column threshold changes the DOM, not only the styling.
let resizeTimer = null
window.addEventListener('resize', () => {
  if (!fullscreen) return
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { if (snap) render() }, 160)
})

// Relative times go stale on their own; re-render on a slow tick without refetching.
// SB: not while the board is a pet — there is nothing on screen for the ages to be stale on.
setInterval(() => { if (snap && !nikoOnly) render() }, 15000)
window.boardRender = render
render()

// A failed or missing setup answer only means no card.
if (window.board.setupState) {
  window.board.setupState()
    .then(s => { if (s && s.firstRun) { setupInfo = s; if (snap && !nikoOnly) render() } })
    .catch(() => {})
}

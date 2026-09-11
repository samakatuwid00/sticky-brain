'use strict'

const fs = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')
const config = require('../config')
const { paths } = config

// One Markdown file per pending capture, written by .automation/sb-inbox.ps1. Fixed frontmatter
// (type: sb-inbox, createdLocal, status: pending) and fixed `## ` sections. `done/` and
// `archive-*/` are directories and are skipped by the .md filter below.
//
// SB: round 3 · TWO folders, same format, different owners:
//   .inbox/        (paths.inbox)      — the vault's. The consolidate cron folds every record here
//                                       into the wiki and moves it to .inbox/done/. Mirrored as-is.
//   .board-inbox/  (paths.boardInbox) — the board's. Quick-capture writes here; the cron never
//                                       looks; only the board's mark-done retires a record.
// Ids carry the folder — `inbox:<file>` vs `binbox:<file>` — so two records with the same name
// in different folders can never collide, and index.js can tell which folder to retire from.

const SECTIONS = {
  'Task': 'task',
  'Project': 'project',
  'Notes used': 'notesUsed',
  'Files touched': 'files',
  'Decisions': 'decisions',
  'Follow-ups': 'followUps',
  'Unresolved questions': 'unresolved'
}

function parse (text) {
  // SB: sb-inbox.ps1 writes with Windows PowerShell 5.1's `-Encoding utf8`, which prepends a BOM.
  // Left in, `^---` never matched and every record's createdLocal came back null — no age on any
  // slip, and nothing for the stale nudge to measure.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  const out = { createdLocal: null }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const m = fm[1].match(/^createdLocal:\s*(.+)$/m)
    if (m) out.createdLocal = m[1].trim()
  }

  let key = null
  const buffer = {}
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^##\s+(.+?)\s*$/)
    if (head) { key = SECTIONS[head[1]] || null; continue }
    if (!key) continue
    const bullet = line.match(/^-\s+(.*)$/)
    if (bullet) (buffer[key] = buffer[key] || []).push(bullet[1].trim())
  }

  for (const field of Object.values(SECTIONS)) {
    const lines = (buffer[field] || []).filter(Boolean)
    out[field] = lines.join(' ')
  }
  return out
}

// SB: records whose task begins with this are RECEIPTS written by the board's own mark-done, not
// work waiting to be done. They stay in .inbox/ for /sb consolidate — they are simply not pending.
// Counted rather than dropped: a number that quietly disappears is the failure this board exists
// to prevent.
const DONE_PREFIX = 'Mark done: '

const FOLDERS = [
  { key: 'inbox', prefix: 'inbox:', dir: () => paths.inbox },
  { key: 'board', prefix: 'binbox:', dir: () => paths.boardInbox }
]

// Reads one folder. A missing folder is `{ ok: false }` with the error code; the caller decides
// what that means (fatal for .inbox/, merely "nothing captured yet" for .board-inbox/).
async function readFolder (folder) {
  const dir = folder.dir()
  let names
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    return { ok: false, path: dir, error: err.code || 'unreadable', items: [], unparsed: 0, receipts: 0 }
  }

  const items = []
  let unparsed = 0
  let receipts = 0

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue
    const file = path.join(dir, name)
    let text
    try { text = await fs.readFile(file, 'utf8') } catch { unparsed++; continue }

    const r = parse(text)
    if (!r.task) { unparsed++; continue }
    if (r.task.startsWith(DONE_PREFIX)) { receipts++; continue }

    items.push({
      id: folder.prefix + name,
      file,
      folder: folder.key,
      task: r.task,
      project: r.project || 'unfiled',
      createdLocal: r.createdLocal,
      createdAt: r.createdLocal ? Date.parse(r.createdLocal) : null,
      followUps: r.followUps || '',
      unresolved: r.unresolved || ''
    })
  }

  return { ok: true, path: dir, items, unparsed, receipts }
}

async function read () {
  // Local mode points both folders at one directory (see config.js); it is read once, not twice.
  const same = path.resolve(paths.inbox) === path.resolve(paths.boardInbox)
  const [vault, board] = await Promise.all([
    readFolder(FOLDERS[0]),
    same
      ? { ok: true, path: paths.boardInbox, items: [], unparsed: 0, receipts: 0 }
      : readFolder(FOLDERS[1])
  ])

  // SB: .inbox/ unreadable is still the source being down — the board has always said so.
  // .board-inbox/ not existing yet is not an error: it appears on the first quick-capture.
  // A local inbox folder that is simply not there yet is the same case: nothing captured so far.
  if (!vault.ok && vault.error === 'ENOENT' && config.mode() === 'local') {
    return { ok: true, path: vault.path, boardPath: board.path, items: [], unparsed: 0, receipts: 0, byFolder: null }
  }
  if (!vault.ok) return { ...vault, boardPath: board.path, byFolder: { inbox: vault, board } }

  const items = vault.items.concat(board.ok ? board.items : [])
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return {
    ok: true,
    path: vault.path,
    boardPath: board.path,
    items,
    unparsed: vault.unparsed + board.unparsed,
    // Receipts are summed for the PENDING header and kept per folder underneath, so a count that
    // says "3 done" can always be traced to the folder those three receipts sit in.
    receipts: vault.receipts + board.receipts,
    byFolder: {
      inbox: { ok: vault.ok, path: vault.path, receipts: vault.receipts, unparsed: vault.unparsed, pending: vault.items.length },
      board: { ok: board.ok, path: board.path, error: board.error || null, receipts: board.receipts, unparsed: board.unparsed, pending: board.items.length }
    }
  }
}

// Registry adapter fields (see sources/index.js). In local mode the folder is created at start-up,
// so it counts as installed before anything has been captured into it.
function detect () {
  return { installed: config.mode() === 'local' || existsSync(paths.inbox), path: paths.inbox }
}

function open (row) {
  return { action: 'file', path: (row && row.file) || paths.inbox }
}

module.exports = {
  key: 'inbox',
  kind: 'data',
  label: 'Inbox',
  hint: 'pending records are Markdown files in this folder — Win+Shift+C writes one',
  detect,
  read,
  open,
  FOLDERS
}

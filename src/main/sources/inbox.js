'use strict'

const fs = require('fs/promises')
const path = require('path')
const { paths } = require('../config')

// One Markdown file per pending capture, written by .automation/sb-inbox.ps1. Fixed frontmatter
// (type: sb-inbox, createdLocal, status: pending) and fixed `## ` sections. `done/` and
// `archive-*/` are directories and are skipped by the .md filter below.

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

async function read () {
  let names
  try {
    names = await fs.readdir(paths.inbox)
  } catch (err) {
    return { ok: false, path: paths.inbox, error: err.code || 'unreadable', items: [] }
  }

  const items = []
  let unparsed = 0
  let receipts = 0

  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue
    const file = path.join(paths.inbox, name)
    let text
    try { text = await fs.readFile(file, 'utf8') } catch { unparsed++; continue }

    const r = parse(text)
    if (!r.task) { unparsed++; continue }
    if (r.task.startsWith(DONE_PREFIX)) { receipts++; continue }

    items.push({
      id: 'inbox:' + name,
      file,
      task: r.task,
      project: r.project || 'unfiled',
      createdLocal: r.createdLocal,
      createdAt: r.createdLocal ? Date.parse(r.createdLocal) : null,
      followUps: r.followUps || '',
      unresolved: r.unresolved || ''
    })
  }

  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return { ok: true, path: paths.inbox, items, unparsed, receipts }
}

module.exports = { read }

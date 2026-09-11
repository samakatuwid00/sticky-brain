'use strict'

const fs = require('fs')
const path = require('path')
const config = require('./config')

/* First-run seed for local mode (no vault configured).

   A stranger's first `npm start` should open onto a board that explains itself, not onto three
   empty sections. So the data folder gets a sample backlog and one pending record, written once
   and never again — a `.seeded` marker means deleting the samples keeps them deleted.

   Only files that live inside the data folder are ever written: a backlog or inbox the owner
   pointed somewhere else with an override is theirs, and is never created or touched here. */

const pad = n => String(n).padStart(2, '0')

const BACKLOG = `# Backlog

Sticky Brain reads this file. Each second-level heading is a group, and each bullet under it is
an open item. Strike an item through, or press x on it in the board, to close it.

## Getting started
- Press x on this line in the board to mark it done
- Press Win+Shift+C (Cmd+Shift+C on macOS) anywhere to capture a thought into the inbox
- Open this file from the tray menu (Open board state folder, then data) and add your own items

## Later
- Point Sticky Brain at your own backlog with config.json (see the README)
`

function inboxRecord (now, task, followUp) {
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
  const lines = [
    '---',
    'type: sb-inbox',
    'createdLocal: ' + local,
    'createdUtc: ' + now.toISOString(),
    'status: pending',
    '---',
    '',
    '## Task', '- ' + task, '',
    '## Project', '- sticky-brain', '',
    '## Follow-ups', '- ' + followUp
  ]
  return { stem: local.replace(':', ''), content: lines.join('\n') + '\n' }
}

const inside = (dir, p) => !!p && path.resolve(p).startsWith(path.resolve(dir) + path.sep)

function ensure () {
  if (config.mode() !== 'local') return { mode: 'vault', seeded: false }
  const dir = config.dataDir()
  const { paths } = config
  const marker = path.join(dir, '.seeded')

  try {
    if (inside(dir, paths.inbox)) fs.mkdirSync(paths.inbox, { recursive: true })
    if (fs.existsSync(marker)) return { mode: 'local', seeded: false, dir }

    if (inside(dir, paths.backlogs) && !fs.existsSync(paths.backlogs)) {
      fs.mkdirSync(path.dirname(paths.backlogs), { recursive: true })
      fs.writeFileSync(paths.backlogs, BACKLOG, 'utf8')
    }
    if (inside(dir, paths.inbox) && !fs.readdirSync(paths.inbox).some(n => n.endsWith('.md'))) {
      const r = inboxRecord(new Date(),
        'Welcome to Sticky Brain — press x on this slip to mark it done',
        'done moves this file into inbox/done/ — nothing is deleted')
      fs.writeFileSync(path.join(paths.inbox, r.stem + '-welcome.md'), r.content, 'utf8')
    }
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8')
    return { mode: 'local', seeded: true, dir }
  } catch (err) {
    // A failed seed only costs the samples; the sources still report what they find.
    console.error('[local-data] could not prepare ' + dir + ':', err.message)
    return { mode: 'local', seeded: false, dir, error: err.message }
  }
}

module.exports = { ensure }

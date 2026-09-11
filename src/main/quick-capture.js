'use strict'

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron')
const fs = require('fs/promises')
const path = require('path')
const { paths } = require('./config')
const { toastBoard } = require('./board-toast')

/* SB: round 2 · Feature 1 · global quick-capture.

   Win+Shift+C from anywhere opens a one-line input; Enter writes a pending record into the vault's
   .inbox/ and the board picks it up like any other. The record is written HERE, in Node, rather
   than by shelling out to .automation/sb-inbox.ps1: PowerShell takes about a second to start, and
   a capture box that lags behind the keystroke that opened it is one nobody keeps using. The
   format is that script's, field for field — filename stamp, frontmatter, the seven `## `
   sections, CRLF, the same mechanical redaction — so sources/inbox.js and /sb consolidate cannot
   tell the two writers apart.

   `#project` as the first word files it under that project; otherwise it is `unassigned`, which is
   sb-inbox.ps1's own default. */

const ACCELERATOR = 'Super+Shift+C'
const LABEL = 'Win+Shift+C'
const W = 480
const H = 52

let win = null
let opts = { board: () => null, refresh: () => {} }

// Ported from sb-inbox.ps1's Protect-Secret, same order and same replacements. A backstop, not a
// licence: a quick capture is exactly where a pasted token would otherwise land in the vault.
const SECRETS = [
  [/\b(sk-ant-[A-Za-z0-9_-]{8,})/gi, '[REDACTED:anthropic-key]'],
  [/\b(sk-[A-Za-z0-9]{20,})/gi, '[REDACTED:api-key]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/gi, '[REDACTED:github-token]'],
  [/\b(xox[abprs]-[A-Za-z0-9-]{10,})/gi, '[REDACTED:slack-token]'],
  [/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gi, '[REDACTED:jwt]'],
  [/\b(AKIA[0-9A-Z]{16})/gi, '[REDACTED:aws-key-id]'],
  [/\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s]*:[^\s]*@[^\s]+)/gi, '[REDACTED:connection-string]'],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]'],
  [/\b(BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY)/gi, '[REDACTED:private-key]'],
  [/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/gi, '[REDACTED:email]']
]

function redact (text) {
  let t = String(text || '')
  for (const [re, to] of SECRETS) t = t.replace(re, to)
  return t.replace(/[\r\n]+/g, ' ').trim()
}

const pad = n => String(n).padStart(2, '0')

function slugOf (task) {
  let slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length > 48) slug = slug.slice(0, 48).replace(/-+$/, '')
  return slug || 'task'
}

function record (task, project, now) {
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
    '## Project', '- ' + project, '',
    '## Notes used', '- none', '',
    '## Files touched', '- none', '',
    '## Decisions', '- captured with ' + LABEL + ' (Sticky Brain quick-capture)', '',
    '## Follow-ups', '- none', '',
    '## Unresolved questions', '- none'
  ]
  return { local, content: lines.join('\r\n') + '\r\n' }
}

async function write (raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!text) return { ok: false, error: 'nothing to capture' }
  const tag = /^#([A-Za-z0-9][\w.-]*)\s+(.+)$/.exec(text)
  const project = redact(tag ? tag[1] : 'unassigned')
  const task = redact(tag ? tag[2] : text)
  if (!task) return { ok: false, error: 'nothing to capture' }

  const now = new Date()
  const { local, content } = record(task, project, now)
  const stem = local.replace(':', '') + '-' + slugOf(task)

  try {
    await fs.mkdir(paths.inbox, { recursive: true })
    // `wx` fails on an existing file, so a same-minute collision gets a suffix rather than
    // overwriting a record nobody has consolidated yet — the script's rule, without its race.
    for (let n = 1; n <= 50; n++) {
      const file = path.join(paths.inbox, stem + (n === 1 ? '' : '-' + n) + '.md')
      try {
        await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' })
        return { ok: true, file, task, project }
      } catch (err) {
        if (err.code !== 'EEXIST') throw err
      }
    }
    return { ok: false, error: 'too many records this minute with that name' }
  } catch (err) {
    return { ok: false, error: 'could not write .inbox/ (' + (err.code || err.message) + ')' }
  }
}

function createWindow () {
  win = new BrowserWindow({
    width: W,
    height: H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  // Above the board, which floats at 'floating' — the capture box must never open behind it.
  win.setAlwaysOnTop(true, 'pop-up-menu')
  win.loadFile(path.join(__dirname, '..', 'renderer', 'capture.html'))
  // Clicking away hides it but keeps the draft; only Esc throws the text away.
  win.on('blur', hide)
  win.on('closed', () => { win = null })
}

function hide () {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide()
}

function open () {
  if (!win || win.isDestroyed()) createWindow()
  if (win.isVisible() && win.isFocused()) { hide(); return }
  // On the display the cursor is on, a third of the way down — where the eye already is.
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setBounds({
    x: workArea.x + Math.round((workArea.width - W) / 2),
    y: workArea.y + Math.round(workArea.height * 0.3),
    width: W,
    height: H
  })
  win.show()
  win.focus()
  win.webContents.send('capture:open')
}

function init (o) {
  opts = { ...opts, ...o }

  ipcMain.handle('capture:submit', async (e, text) => {
    // Only the capture window may write to the vault through this channel.
    if (!win || e.sender !== win.webContents) return { ok: false, error: 'not the capture window' }
    const r = await write(text)
    if (!r.ok) return r
    hide()
    opts.refresh()
    toastBoard(opts.board, 'captured to inbox — ' + r.task)
    return { ok: true }
  })
  ipcMain.on('capture:cancel', e => { if (win && e.sender === win.webContents) hide() })

  // Built now, hidden, so the first Win+Shift+C opens instantly instead of waiting on a page load.
  createWindow()

  let registered = false
  try { registered = globalShortcut.register(ACCELERATOR, open) } catch (err) {
    console.error('[quick-capture] register threw:', err && err.message)
  }
  if (!registered) {
    // Another app (or a second Sticky Brain) already owns it. Said out loud rather than failing
    // silently — a shortcut that does nothing reads as the whole feature being broken.
    console.error('[quick-capture] could not register ' + ACCELERATOR + ' — another app holds it')
    toastBoard(opts.board, LABEL + ' is taken by another app — quick-capture is off', true)
  }

  app.on('will-quit', () => globalShortcut.unregister(ACCELERATOR))
  return registered
}

module.exports = { init, open, write }

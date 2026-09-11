'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, screen } = require('electron')
const fs = require('fs')
const path = require('path')
// SB: `spawn` left with the terminal launcher — nothing in the main process opens a console any
// more. The one place that still spawns a detached child is hermes-runtime, starting the Desktop App.
const { execFile } = require('child_process')
const { paths, vaultDir } = require('./config')
const snapshot = require('./snapshot')
const state = require('./state')
// SB: Feature 6 · mark done reaches both sources directly — the receipt path re-reads .inbox/ so
// nothing is trusted from the renderer, and the backlog path strikes the line in place.
const inbox = require('./sources/inbox')
const backlogs = require('./sources/backlogs')
// SB: Hermes as running processes / a local backend, rather than as the SQLite archive
// sources/hermes.js reads. Both the session click and the task launch go through these.
const hermesRuntime = require('./hermes-runtime')
const hermesApi = require('./hermes-api')
// SB: round 2 · Win+Shift+C quick-capture and the 18:00 summary are self-contained modules.
const quickCapture = require('./quick-capture')
const dailySummary = require('./daily-summary')

// SB: a child process's exit handler may still write to console after the app's stdout/stderr
// pipe has closed (parent console gone, stream redirected then closed), and that write throws
// EPIPE. Uncaught inside an execFile callback it kills the whole main process and pops the
// "A JavaScript error occurred in the main process" dialog — which is what viewing a LIVE
// session did, via the hermes reader and the revealSession PowerShell callbacks. Swallow EPIPE;
// rethrow anything else so real stream errors still surface. Must be installed before anything
// spawns a child.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', err => { if (err && err.code === 'EPIPE') return; throw err })
}

let win = null
let tray = null
let watchers = []
let debounce = null
let pollTimer = null
// SB: bounds to come back to when fullscreen was faked with a resize rather than taken natively.
let preFullBounds = null

/* ---- SB: Feature 1 · niko-only mode ----
   The × no longer hides the board to the tray — it SHRINKS the window down to the pet, who stays
   on screen as a desktop pixel pet and is the way back in. The window is already frameless and
   transparent, so a 128x92 window shows nothing but the sprite: no chrome to hide, no second
   window to keep in sync with the first, and the same renderer keeps running, so his mood carries
   across the transition instead of restarting.

   128x92 rather than the sketched 120x80: the sprite is 13 cells (~62px) on a 64px rail, and the
   remaining ~28px is what the speech bubble needs to sit above him without being clipped by the
   window edge. A bubble that does not fit is the same as no bubble. */
const NIKO_W = 128
const NIKO_H = 92
const NIKO_MARGIN = 24
const MIN_W = 300
const MIN_H = 384

let nikoOnly = false
let preNikoBounds = null
// SB: window position at the moment a drag started. The renderer sends screen-space deltas, so
// the origin has to be remembered here — reading getPosition() per move accumulates rounding.
let dragOrigin = null

const TRAY_ICON = path.join(__dirname, '..', 'assets', 'tray.png')
const startHidden = process.argv.includes('--hidden')
const isDev = process.argv.includes('--dev')

// A dev run gets its OWN userData, and therefore its own single-instance lock and its own
// board-state.json. Without this, `npm start` while the installed copy is running just hands
// focus to the installed copy and exits — so your edits appear to do nothing. Must run before
// the lock is requested and before app ready.
if (isDev) {
  app.setPath('userData', app.getPath('userData') + ' (dev)')
  app.setAppUserModelId('com.deped.stickybrain.dev')
}

// Autostart plus a Start Menu click would otherwise run two boards over the same files.
// The second copy hands focus to the first and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    win.show()
    win.focus()
  })
}

function createWindow () {
  const { workArea } = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    width: 360,
    // 640 board + the 64px rail niko stands on, which sits above the frame.
    height: 704,
    x: workArea.x + workArea.width - 380,
    y: workArea.y + 20,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  // Started at login, it comes up in the tray only — the board is a thing you glance at,
  // not a thing that greets you.
  win.once('ready-to-show', () => { if (!startHidden) win.show() })
  // The first snapshot must be sent AFTER the renderer has registered its listener, or the
  // board sits on the loading skeleton forever with four healthy sources behind it.
  win.webContents.on('did-finish-load', () => {
    // SB: a reload (Ctrl+R in a dev run) rebuilds the renderer with the board laid out — the
    // window would still be pet-sized and the layout would not know it. The mode is re-sent so
    // the two never disagree.
    sendNikoOnly(nikoOnly)
    pushSnapshot()
  })
  win.on('closed', () => { win = null })

  // SB: the layout is a renderer decision, so the window tells it what actually happened rather
  // than the button assuming it. Covers Esc and any OS-side exit too.
  win.on('enter-full-screen', () => sendFullscreen(true))
  win.on('leave-full-screen', () => sendFullscreen(false))

  // A frameless window has no menu, so there is no built-in reload or devtools accelerator.
  // Dev runs only — the installed copy should not reopen devtools on a stray F12.
  if (isDev) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const key = (input.key || '').toLowerCase()
      if (input.control && key === 'r') { win.webContents.reloadIgnoringCache(); event.preventDefault() }
      if (key === 'f12') { win.webContents.toggleDevTools(); event.preventDefault() }
    })
  }
}

async function pushSnapshot () {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('board:snapshot', await snapshot.build())
  } catch (err) {
    win.webContents.send('board:fatal', String(err && err.message ? err.message : err))
  }
}

function schedule () {
  clearTimeout(debounce)
  debounce = setTimeout(pushSnapshot, 300)
}

// SB: "expanded" is either a real fullscreen or the resize fallback below — the renderer only
// cares which layout to draw, so both report as one boolean.
function isExpanded () {
  return !!win && (win.isFullScreen() || !!preFullBounds)
}

function sendFullscreen (on) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('board:fullscreen', on)
}

/* ---- SB: Feature 1 · shrink to the pet, and grow back ---- */

function sendNikoOnly (on) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('board:niko-only', on)
}

// Fullscreen and pet-sized are the two ends of the same axis, so one has to be left before the
// other is entered — and the resize fallback must be unwound too, or preFullBounds would later
// restore a full-screen rectangle over a window the owner shrank on purpose.
async function leaveExpanded () {
  if (!win || win.isDestroyed()) return
  if (win.isFullScreen()) {
    win.setFullScreen(false)
    await new Promise(r => setTimeout(r, 250))
    if (!win || win.isDestroyed()) return
  }
  if (preFullBounds) { win.setBounds(preFullBounds); preFullBounds = null }
  sendFullscreen(false)
}

async function enterNikoOnly () {
  if (!win || win.isDestroyed() || nikoOnly) return
  await leaveExpanded()
  if (!win || win.isDestroyed()) return

  preNikoBounds = win.getBounds()
  nikoOnly = true
  // The renderer is told FIRST: it hides the board and re-centres him in the narrower rail, so
  // the frame the resize lands on is already the pet layout rather than a clipped board.
  sendNikoOnly(true)

  // The board's minimum is far larger than the pet. setBounds clamps silently to the old minimum,
  // so without lowering it first the window simply stays board-sized and nothing looks wrong.
  win.setMinimumSize(NIKO_W, NIKO_H)
  const { workArea } = screen.getDisplayMatching(preNikoBounds)
  win.setBounds({
    x: workArea.x + workArea.width - NIKO_W - NIKO_MARGIN,
    y: workArea.y + workArea.height - NIKO_H - NIKO_MARGIN,
    width: NIKO_W,
    height: NIKO_H
  })
  // Resizability is dropped AFTER the bounds are taken — a non-resizable window on Windows can
  // refuse the size change that made it non-resizable in the first place.
  win.setResizable(false)
  win.setAlwaysOnTop(true, 'floating')
  if (!win.isVisible()) win.showInactive()
  buildTrayMenu()
}

// `show: false` is the hide-to-tray path: the board layout and its bounds are restored so that a
// later tray click gives back the board, but the window is not put on screen to do it.
function exitNikoOnly (opts) {
  if (!win || win.isDestroyed()) return
  const show = !opts || opts.show !== false
  if (nikoOnly) {
    nikoOnly = false
    sendNikoOnly(false)
    win.setResizable(true)
    win.setMinimumSize(MIN_W, MIN_H)
    if (preNikoBounds) win.setBounds(preNikoBounds)
    preNikoBounds = null
    buildTrayMenu()
  }
  if (show) { win.show(); win.focus() }
}

function hideToTray () {
  exitNikoOnly({ show: false })
  if (win && !win.isDestroyed()) win.hide()
}

function watch () {
  const targets = [paths.sessions, paths.inbox, paths.backlogs, paths.evidence]
  for (const target of targets) {
    try {
      // Missing targets are not watched — the snapshot reports them as unavailable instead.
      if (!fs.existsSync(target)) continue
      const w = fs.watch(target, { persistent: false }, schedule)
      w.on('error', () => {})
      watchers.push(w)
    } catch {}
  }
  // Sessions additionally poll: `status` flips inside an existing file, and a dead pid leaves
  // its file behind, so neither change is guaranteed to raise a watch event.
  pollTimer = setInterval(pushSnapshot, 5000)
}

function autostartEnabled () {
  return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin
}

// Autostart is on by default, but only ever decided ONCE. Without this marker there is no way to
// tell "never configured" from "the owner turned it off", and every launch would switch it back on.
function initAutostartOnce () {
  const marker = path.join(app.getPath('userData'), 'autostart-initialised')
  if (fs.existsSync(marker)) return
  try {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] })
    fs.mkdirSync(path.dirname(marker), { recursive: true })
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8')
  } catch {}
}

function setAutostart (on) {
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
  buildTrayMenu()
}

function buildTrayMenu () {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: toggleWindow },
    // SB: the third state the window can be in now has to be reachable from the tray too — the
    // pet can be dragged somewhere the owner cannot find, and the board can be on a display the
    // pet is not.
    { label: nikoOnly ? 'Open board' : 'Niko only', click: () => (nikoOnly ? exitNikoOnly() : enterNikoOnly()) },
    { label: 'Refresh now', click: pushSnapshot },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: autostartEnabled(),
      click: item => setAutostart(item.checked)
    },
    { label: 'Open board state folder', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]))
}

// SB: three states, not two. A tray click always means "give me the board" — coming back from the
// tray into a 128px pet, having asked for the app, would read as the app failing to open.
function toggleWindow () {
  if (!win) return
  if (!win.isVisible() || nikoOnly) { exitNikoOnly(); return }
  win.hide()
}

function createTray () {
  // An empty nativeImage gives an invisible tray entry — which, started hidden, leaves no way
  // to open the app at all. The icon is generated by build/make-icon.ps1 from the board's tokens.
  let icon = nativeImage.createFromPath(TRAY_ICON)
  if (icon.isEmpty()) icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip(isDev ? 'Sticky Brain (dev)' : 'Sticky Brain')
  buildTrayMenu()
  tray.on('click', toggleWindow)
}

// --shot=<file> renders one frame, writes it and quits. Verification affordance, not a feature.
const shotArg = process.argv.find(a => a.startsWith('--shot='))

app.whenReady().then(async () => {
  createWindow()
  // A dev run must never touch the Run key — that belongs to the installed copy.
  if (!shotArg) { if (!isDev) initAutostartOnce(); createTray() }
  watch()
  await pushSnapshot()
  // SB: round 2 hooks — skipped for --shot runs, which render one frame and quit.
  if (!shotArg) { quickCapture.init({ board: () => win, refresh: schedule }); dailySummary.start({ board: () => win, open: () => exitNikoOnly() }) }

  if (shotArg) {
    const out = shotArg.slice('--shot='.length)
    const arg = name => {
      const hit = process.argv.find(a => a.startsWith('--' + name + '='))
      return hit ? hit.slice(name.length + 3) : null
    }
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const theme = arg('theme')
        const density = arg('density')
        if (theme || density) {
          await win.webContents.executeJavaScript(
            `document.documentElement.dataset.theme=${JSON.stringify(theme || 'dark')};` +
            `document.documentElement.dataset.density=${JSON.stringify(density || 'default')};` +
            'window.boardRender && window.boardRender();' +
            'window.nikoPet && window.nikoPet.retheme();')
          // capturePage can hand back the frame from before the attribute flip.
          await new Promise(r => setTimeout(r, 400))
        }
        const img = await win.webContents.capturePage()
        fs.writeFileSync(out, img.toPNG())
        app.quit()
      }, 2500)
    })
  }
})

app.on('window-all-closed', () => app.quit())

ipcMain.handle('board:refresh', pushSnapshot)

ipcMain.handle('board:action', async (_e, { action, id }) => {
  // SB (2026-08-03): `done` is the one action with a vault side, and the vault write goes FIRST.
  // If it fails, nothing is hidden — a row that vanished off the board without the file agreeing
  // is the single worst outcome available here.
  if (action === 'done') {
    const r = await markDone(id)
    if (!r.ok) { await pushSnapshot(); return r }
    await state.apply('done', id)
    await pushSnapshot()
    return r
  }
  await state.apply(action, id)
  await pushSnapshot()
  return { ok: true }
})

ipcMain.handle('board:reveal', async (_e, target) => {
  const p = paths[target] || target
  await shell.openPath(path.dirname(p) === p ? p : path.dirname(p))
})

// SB: the titlebar × used to hide to tray. It now shrinks to the pet instead — same reasoning one
// step further: a board that vanishes on a stray click stops replacing the reminders, and a board
// that vanishes into a 16px tray icon is only a slower version of vanishing. Niko stays on screen,
// carries the mood the board was in, and is the way back. Quitting is still a tray/menu decision.
ipcMain.handle('board:close', () => enterNikoOnly())

// SB: Feature 1 · click (or double-click) the pet, get the board back.
ipcMain.handle('board:restoreFromNiko', () => exitNikoOnly())

// SB: Feature 2 · the pet's right-click menu. Built natively in the main process rather than as
// HTML in the renderer: a 128x92 transparent window has nowhere to draw a menu that is not
// clipped by its own edge, and a native popup is not bound by the window at all.
ipcMain.handle('board:nikoMenu', () => {
  if (!win || win.isDestroyed()) return
  Menu.buildFromTemplate([
    { label: 'Open board', click: () => exitNikoOnly() },
    { label: 'Hide to tray', click: hideToTray },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]).popup({ window: win })
})

ipcMain.handle('board:hideToTray', () => hideToTray())

/* ---- SB: Feature 2 · dragging the pet around the desktop ----

   `-webkit-app-region: drag` is the obvious way to move a frameless window and is the wrong one
   here: a drag region swallows the mouse events before the renderer sees them, so click,
   double-click and contextmenu on the same element all stop firing — and those are the pet's
   whole interaction surface. So the move is done by hand: the renderer reports screen-space
   deltas from where the press started, and the window is placed at origin + delta. */
ipcMain.on('board:nikoDragStart', () => {
  dragOrigin = win && !win.isDestroyed() ? win.getPosition() : null
})

ipcMain.on('board:nikoDragMove', (_e, d) => {
  if (!dragOrigin || !nikoOnly || !win || win.isDestroyed()) return
  const dx = Number(d && d.dx) || 0
  const dy = Number(d && d.dy) || 0
  win.setPosition(Math.round(dragOrigin[0] + dx), Math.round(dragOrigin[1] + dy))
})

ipcMain.on('board:nikoDragEnd', () => { dragOrigin = null })

/* ---- SB: Feature 1 · clicking a live session focuses the terminal it runs in ---- */

// The session file's pid is Claude Code's own process, and that process owns no window — the
// window belongs to its console host. So the pid is a starting point, not the answer: the script
// walks UP the parent chain looking for a window.
//
// The first version of this walked the chain reading `Process.MainWindowHandle`, and that is why
// clicking a session opened its folder instead of its terminal. MainWindowHandle only reports a
// top-level, *visible*, owner-less window of that exact process, and no link in a real Claude
// Code chain has one. Measured on this machine:
//
//   claude.exe 6840 -> powershell.exe 16644 -> WindowsTerminal.exe 12276 -> explorer.exe
//   MainWindowHandle:        0                     0                    0
//
// Windows Terminal reports 0 while genuinely owning the window (its tab hosts are
// CASCADIA_HOSTING_WINDOW_CLASS), so every chain fell through to 'NOWINDOW' and the folder
// fallback fired every single time. EnumWindows sees what MainWindowHandle refuses to.
//
// The second piece is ownership. The console-side link (powershell.exe here) owns a visible
// `PseudoConsoleWindow` whose GW_OWNER is the *specific terminal tab* the session runs in — so
// following the owner lands on the right tab rather than merely the right application.
//
// SetForegroundWindow alone is refused by Windows when the caller is not the foreground app,
// which the board never is. AttachThreadInput to the current foreground thread is what makes the
// call legal; without it the window only flashes in the taskbar. The result is then read back —
// the old code trusted the return value, which lies.
//
// SB: the interop block, the window-picking and the activation are now a shared prelude, because
// there is a second thing to focus: the Hermes Desktop App, which is reached by process NAME (a
// saved Hermes session has no pid of its own to walk up from). Only the way the candidate pids are
// found differs between the two, so only that part is written twice.
const FOCUS_PRELUDE = `
$ErrorActionPreference = 'Continue'
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SBWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);

  public static List<IntPtr> Windows(uint want) {
    var res = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == want) res.Add(h); return true; }, IntPtr.Zero);
    return res;
  }
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowTextW(h, s, 256); return s.ToString(); }
  public static string Klass(IntPtr h) { var s = new StringBuilder(256); GetClassNameW(h, s, 256); return s.ToString(); }
}
"@

function Emit ($status, $hwnd, $title, $detail) {
  $o = [ordered]@{ status = $status; hwnd = [string]$hwnd; title = $title; detail = $detail }
  Write-Output ('SBFOCUS ' + (ConvertTo-Json $o -Compress))
}

# Windows that are never the thing a person wants focused.
$skip = @('IME', 'MSCTFIME UI', 'OleDdeWndClass', 'tooltips_class32', 'Default IME')

# Best window across a list of pids. -StopAtFirst is the ancestor-chain rule: the NEAREST ancestor
# that owns any window is the right one, so the walk stops as soon as one does. Searching by
# process name wants the opposite — every candidate scored, best overall wins.
function Pick ($ids, $stopAtFirst) {
  $best = $null
  foreach ($id in $ids) {
    foreach ($h in [SBWin]::Windows([uint32]$id)) {
      $cls = [SBWin]::Klass($h)
      if ($skip -contains $cls) { continue }
      # GW_OWNER = 4. A PseudoConsoleWindow's owner is the terminal tab hosting this session.
      $owner = [SBWin]::GetWindow($h, 4)
      $t = if ($owner -ne [IntPtr]::Zero) { $owner } else { $h }
      $vis = [SBWin]::IsWindowVisible($t)
      $title = [SBWin]::Title($t)
      # Visible beats hidden, titled beats untitled, owner-resolved beats raw.
      $score = 0
      if (-not $vis) { $score += 4 }
      if ([string]::IsNullOrWhiteSpace($title)) { $score += 2 }
      if ($owner -eq [IntPtr]::Zero) { $score += 1 }
      if ($null -eq $best -or $score -lt $best.Score) {
        $best = [pscustomobject]@{ Handle = $t; Score = $score; Title = $title; Class = [SBWin]::Klass($t); Visible = $vis; Pid = $id }
      }
    }
    if ($stopAtFirst -and $null -ne $best) { break }
  }
  return $best
}

function Activate ($best) {
  $target = $best.Handle
  if ([SBWin]::IsIconic($target)) { [void][SBWin]::ShowWindow($target, 9) }
  elseif (-not $best.Visible) { [void][SBWin]::ShowWindow($target, 5); if (-not [SBWin]::IsWindowVisible($target)) { [void][SBWin]::ShowWindow($target, 9) } }
  else { [void][SBWin]::ShowWindow($target, 5) }

  $fg = [SBWin]::GetForegroundWindow()
  $a = [SBWin]::GetWindowThreadProcessId($fg, [IntPtr]::Zero)
  $b = [SBWin]::GetWindowThreadProcessId($target, [IntPtr]::Zero)
  if ($a -ne $b) { [void][SBWin]::AttachThreadInput($a, $b, $true) }
  [void][SBWin]::BringWindowToTop($target)
  [void][SBWin]::SetForegroundWindow($target)
  if ($a -ne $b) { [void][SBWin]::AttachThreadInput($a, $b, $false) }

  # SetForegroundWindow returns true while doing nothing, so the desktop is asked instead of trusted.
  Start-Sleep -Milliseconds 120
  $now = [SBWin]::GetForegroundWindow()
  $root = [SBWin]::GetAncestor($now, 2)
  if ($now -eq $target -or $root -eq $target) { Emit 'OK' $target $best.Title $best.Class; return }
  if (-not [SBWin]::IsWindowVisible($target)) {
    Emit 'HIDDEN' $target $best.Title ($best.Class + ' - window exists but the owning app keeps it hidden (minimised to the notification area?)')
    return
  }
  Emit 'NOFOCUS' $target $best.Title ($best.Class + ' - foreground refused; it now belongs to ' + $now)
}
`

function focusScript (pid) {
  return FOCUS_PRELUDE + `
if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) {
  Emit 'DEAD' 0 '' 'process is gone'
  exit 0
}

# One WMI sweep, not one per hop — eight Get-CimInstance -Filter calls cost most of a second.
$byPid = @{}
foreach ($p in Get-CimInstance Win32_Process) { $byPid[[int]$p.ProcessId] = $p }

$chain = @()
$cur = ${pid}
for ($i = 0; $i -lt 10 -and $cur -gt 0; $i++) {
  $p = $byPid[[int]$cur]
  if (-not $p) { break }
  # explorer owns the desktop window and svchost owns service windows. Walking into either means
  # the terminal was never found, and focusing the desktop looks like success while doing nothing.
  if ($p.Name -eq 'explorer.exe' -or $p.Name -eq 'svchost.exe') { break }
  $chain += [int]$cur
  $cur = [int]$p.ParentProcessId
}

$best = Pick $chain $true
if ($null -eq $best) {
  Emit 'NOWINDOW' 0 '' ('alive, no top-level window anywhere in the ancestor chain: ' + ($chain -join ' <- '))
  exit 0
}
Activate $best
`
}

// SB: the same activation, reached by process name instead of by pid. This is what a SAVED Hermes
// session clicks through to: it has no process of its own, so the thing to bring forward is the
// Hermes Desktop App itself.
//
// Name is enough to disambiguate for free. The desktop build and the CLI are both hermes.exe and
// tasklist cannot tell them apart (see hermes-runtime.js), but Pick scores visible titled windows
// best and the CLI owns none — so scoring every hermes.exe lands on the desktop window whenever
// there is one, without needing to know which pid it was.
function focusScriptByName (name) {
  return FOCUS_PRELUDE + `
$procs = @(Get-Process -Name '${name}' -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) {
  Emit 'DEAD' 0 '' 'no ${name} process is running'
  exit 0
}
$best = Pick @($procs | ForEach-Object { [int]$_.Id }) $false
if ($null -eq $best) {
  Emit 'NOWINDOW' 0 '' ('${name} is running but owns no top-level window')
  exit 0
}
Activate $best
`
}

// -EncodedCommand takes UTF-16LE base64, which sidesteps every layer of cmd/PowerShell quoting
// and is not subject to the machine's script execution policy. The pid is checked to be an
// integer first — it is the only value interpolated into the script.
function runFocus (script, subject) {
  return new Promise(resolve => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 12000 },
      (err, stdout, stderr) => {
        const out = String(stdout || '')
        const line = out.split(/\r?\n/).find(l => l.startsWith('SBFOCUS '))
        // The old code did `resolve(!err && /OK/.test(stdout))`, so a PowerShell that never ran,
        // a compile error in the Add-Type block and a genuine "no window" were one indistinct
        // false — and the folder fallback answered for all three. They are separated now, and
        // anything unexpected is printed rather than swallowed.
        if (!line) {
          console.error('[revealSession] focus script produced no result for', subject,
            '\n  exec error:', err ? (err.killed ? 'timed out' : err.message) : 'none',
            '\n  stdout:', out.trim() || '(empty)',
            '\n  stderr:', String(stderr || '').trim() || '(empty)')
          return resolve({ status: 'SCRIPTFAIL', detail: err ? String(err.message).split('\n')[0] : 'no output' })
        }
        let parsed
        try { parsed = JSON.parse(line.slice('SBFOCUS '.length)) } catch (e) {
          console.error('[revealSession] unparsable result:', line)
          return resolve({ status: 'SCRIPTFAIL', detail: 'unparsable result' })
        }
        if (parsed.status !== 'OK') {
          console.error('[revealSession]', subject, '->', parsed.status, '|', parsed.title || '(untitled)', '|', parsed.detail || '')
        }
        const trailing = String(stderr || '').trim()
        if (trailing) console.error('[revealSession] powershell stderr:', trailing)
        resolve(parsed)
      })
  })
}

function focusWindowByPid (pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ status: 'BADPID', detail: 'pid ' + pid })
  }
  return runFocus(focusScript(pid), 'pid ' + pid)
}

// SB: the name is the only value interpolated here, so it is restricted to what a Windows image
// name can actually be. Nothing user-supplied ever reaches it — the one caller passes a constant.
function focusWindowByName (name) {
  if (!/^[A-Za-z0-9_.-]+$/.test(String(name || ''))) {
    return Promise.resolve({ status: 'BADNAME', detail: String(name) })
  }
  return runFocus(focusScriptByName(name), name)
}

// SB: bring the Hermes Desktop App forward, starting it if it is not there. This is where a saved
// Hermes session and a task launch both end up — the plan's "focus the Hermes Desktop App window",
// with the launch as the answer to "there is no window yet" rather than a silent failure.
async function focusHermesDesktop () {
  // hermes.exe is the image for BOTH the desktop app and the CLI; focusWindowByName scores on
  // window ownership, which only the desktop build has.
  const name = hermesRuntime.DESKTOP_IMAGE.replace(/\.exe$/i, '')
  if (await hermesRuntime.desktopRunning()) {
    const r = await focusWindowByName(name)
    if (r.status === 'OK') return { ok: true, mode: 'desktop' }
    // Running but unfocusable is a different fact from not running, and is reported as itself
    // rather than being answered with a second copy of the app.
    if (r.status === 'HIDDEN' || r.status === 'NOFOCUS') {
      return {
        ok: false,
        mode: r.status.toLowerCase(),
        error: r.status === 'HIDDEN'
          ? 'the Hermes Desktop App is running but keeps its window hidden — restore it from the taskbar'
          : 'Windows refused to move focus to the Hermes Desktop App'
      }
    }
  }
  const started = await hermesRuntime.launchDesktop()
  if (started.ok) return { ok: true, mode: 'desktop-launched' }
  return { ok: false, mode: 'nodesktop', error: started.error || 'could not start the Hermes Desktop App' }
}

// process.kill(pid, 0) signals nothing and only asks "may I". EPERM means the process is there
// but owned by someone else — still alive.
function pidAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

ipcMain.handle('board:revealSession', async (_e, data) => {
  const info = data || {}
  const pid = Number(info.pid)

  // SB: a Hermes row used to end here with "hermes records no pid" and a folder — which was true
  // of the SQLite store but not of the machine. Two things changed:
  //
  //  * A genuinely running session may now ARRIVE with a pid. sources/sessions.js reads Hermes's
  //    own processes.json, which maps a session id to a real process, so the same ancestor-chain
  //    walk Claude Code uses applies to it unchanged.
  //  * A session with no live process is history, and history belongs in the app that can open it.
  //    The Hermes Desktop App is focused (started if need be) instead of the scratchpad folder —
  //    opening a temp directory was never an answer to "show me this conversation".
  if (info.agent === 'hermes') {
    if (pidAlive(pid)) {
      const r = await focusWindowByPid(pid)
      if (r.status === 'OK') return { ok: true, mode: 'window' }
      // Falls through to the desktop app: the session is real and running, so there is still
      // somewhere right to send the click even when its own window could not be reached.
    }

    const d = await focusHermesDesktop()
    if (d.ok) return { ok: true, mode: d.mode, sessionId: info.sessionId || null }
    return {
      ok: false,
      mode: d.mode,
      error: d.error + (info.sessionId ? ' — this session is saved as ' + info.sessionId : '')
    }
  }

  // A dead session has no terminal to focus, and opening its folder is a non-answer dressed up
  // as success. It is named for what it is instead.
  if (!pidAlive(pid)) {
    console.error('[revealSession] pid', pid, 'is not running — session ended')
    return { ok: false, mode: 'ended', error: 'session ended — pid ' + pid + ' is no longer running' }
  }

  const r = await focusWindowByPid(pid)
  if (r.status === 'OK') return { ok: true, mode: 'window' }

  // The folder is the answer to exactly one question: the process is alive and genuinely owns no
  // window (a hook, a headless run). Every other failure gets reported as itself.
  if (r.status === 'NOWINDOW') {
    if (info.cwd && fs.existsSync(info.cwd)) {
      await shell.openPath(info.cwd)
      return { ok: true, mode: 'folder' }
    }
    return { ok: false, mode: 'nowindow', error: 'running without a window, and its cwd is unreadable' }
  }

  const why = {
    HIDDEN: 'its terminal window is hidden — restore it from the taskbar or notification area',
    NOFOCUS: 'Windows refused to move focus to its terminal',
    SCRIPTFAIL: 'the focus helper failed: ' + (r.detail || 'unknown'),
    BADPID: 'the session file carries no usable pid',
    DEAD: 'session ended — the process is gone'
  }[r.status] || ('focus failed (' + r.status + ')')
  return { ok: false, mode: (r.status || 'error').toLowerCase(), error: why }
})

/* ---- SB: Feature 3 · clicking a task opens a Hermes chat about it ---- */

// `where.exe hermes` moved to hermes-runtime.js, which caches it — this is asked on every task
// click and the answer does not change between them.

function taskPrompt (info) {
  const lines = ['Task: ' + (info.title || 'untitled')]
  if (info.sourceFile) lines.push('Source: ' + info.sourceFile)
  if (info.content) lines.push('', 'Context:', info.content)
  return lines.join('\n')
}

// SB: clicking a task leaves a durable trace in the vault via the sanctioned inbox writer.
// Opening a chat is not completing a task, so it never edits Open Backlogs.md. Marking done
// (Feature 6, below) does — that is an owner keypress, not an agent's unasked write.
const SB_INBOX = path.join(vaultDir, '.automation', 'sb-inbox.ps1')
function recordInVault (info) {
  if (!fs.existsSync(SB_INBOX)) return
  // PowerShell paths need single quotes; escape any embedded single quote.
  const q = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"
  const ps = [
    '&', q(SB_INBOX),
    '-Task', q(info.title || 'untitled'),
    '-Project', q('sticky-brain'),
    '-FollowUps', q(info.content || 'opened from Sticky Brain'),
    '-NotesUsed', q('wiki/Sticky Brain — Feature Overhaul Proposal.md')
  ].join(' ')
  // Fire-and-forget; vault write must never block the chat open.
  execFile('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps],
    { windowsHide: true, timeout: 15000 },
    () => {})
}

/* ---- SB: Feature 6 · mark done ---- */

// SB: Feature 6 · mark done. Two item kinds, two durable paths, one keypress.
//
//   inbox:<file>.md  -> a receipt under .inbox/, written by the vault's own sb-inbox.ps1. The
//                       original record is NOT moved: .inbox/done/ means "already consolidated"
//                       and moving there from here would drop it out of the pipeline.
//   bl:<sha1>        -> the line in wiki/Open Backlogs.md is struck in place.
//
// The id carries its own kind, so nothing is trusted from the renderer — the main process
// re-reads the source and finds the item itself.
const DONE_PREFIX = 'Mark done: '
// SB: a backlog strike is durable in the file already; the receipt exists so the completion has a
// dated, greppable trace for /sb consolidate and the log. Set false to stop writing them.
const RECORD_BACKLOG_DONE = true

function runInbox (fields) {
  return new Promise(resolve => {
    if (!fs.existsSync(SB_INBOX)) return resolve({ ok: false, error: 'sb-inbox.ps1 not found' })
    const q = s => "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"
    const ps = ['&', q(SB_INBOX)]
    for (const [flag, value] of fields) ps.push(flag, q(value))
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', ps.join(' ')],
      { windowsHide: true, timeout: 15000 },
      err => resolve(err ? { ok: false, error: String(err.message).split('\n')[0] } : { ok: true }))
  })
}

async function markDone (id) {
  if (typeof id === 'string' && id.startsWith('bl:')) {
    const hit = await backlogs.markDone(id)
    if (!hit.ok) {
      return {
        ok: false,
        error: hit.error === 'not-found'
          ? 'that line is no longer in Open Backlogs.md — the file changed'
          : 'could not write Open Backlogs.md (' + hit.error + ')'
      }
    }
    if (RECORD_BACKLOG_DONE) {
      await runInbox([
        ['-Task', DONE_PREFIX + '[' + hit.heading + '] ' + hit.text],
        ['-Project', 'sticky-brain'],
        ['-Files', 'wiki/Open Backlogs.md'],
        ['-Decisions', 'struck in place from the board (line ' + hit.line + ')'],
        ['-NotesUsed', 'wiki/Sticky Brain — Mark Done Action Plan.md']
      ])
    }
    return { ok: true, kind: 'backlog', text: hit.text }
  }

  if (typeof id === 'string' && id.startsWith('inbox:')) {
    // SB: read the source rather than trusting a renderer-supplied title.
    const got = await inbox.read()
    const item = (got.items || []).find(x => x.id === id)
    if (!item) return { ok: false, error: 'that pending record is no longer in .inbox/' }
    const wrote = await runInbox([
      ['-Task', DONE_PREFIX + item.task],
      ['-Project', item.project || 'sticky-brain'],
      // SB: the file consolidate should retire. Named relative to the vault, as the vault names things.
      ['-Files', '.inbox/' + path.basename(item.file)],
      ['-Decisions', 'marked done from the Sticky Brain board'],
      ['-FollowUps', 'move the original record to .inbox/done/ at the next /sb consolidate'],
      ['-NotesUsed', 'wiki/Sticky Brain — Mark Done Action Plan.md']
    ])
    if (!wrote.ok) return { ok: false, error: 'could not write the vault receipt — ' + wrote.error }
    return { ok: true, kind: 'pending', text: item.task }
  }

  // SB: live sessions and anything else — there is nothing to mark done.
  return { ok: false, error: 'nothing to mark done on this item' }
}

// Verified against `hermes chat --help` on this machine: `-s/--skills` takes a comma-separated
// list and preloads them for the whole session. `obsidian-vault-memory` is the local skill over
// this vault; `obsidian` is the builtin note-taking one. Both are installed and enabled.
const HERMES_SKILL_LIST = ['obsidian-vault-memory', 'obsidian']
const HERMES_SKILLS = HERMES_SKILL_LIST.join(',')

// SB: the task launch, rebuilt around the plan's headline requirement — NO terminal window ever
// pops up. What is gone with it: the throwaway .ps1 launcher, the scratch folder it needed, and
// `cmd /c start`. That console existed for exactly one reason, that `hermes chat` is a
// prompt_toolkit REPL and cannot draw without one, and the answer is to stop opening a REPL.
//
// Three ways to submit, tried in order, none of which shows a window:
//
//  1. THE LOCAL BACKEND, as the plan specifies: POST /api/sessions carrying the prompt and the
//     two vault skills. Checked against the running install first — Hermes Agent 0.19.1 declares
//     GET only for that route, and every /api/ route is behind a session token the desktop shell
//     keeps in its backend's environment (see hermes-api.js). So on THIS machine the call declines
//     and step 2 answers. It stays because it is what the plan asks for, because a build that
//     grows the endpoint will then work with no further change, and because a decline is cheap.
//
//  2. `hermes chat -q <task> --skills …` RUN HEADLESS. `-q/--query` is the documented
//     non-interactive form (verified against `chat --help`) — it runs the task and prints the
//     answer rather than opening a prompt, so having no console is correct for it rather than
//     fatal to it, which is the whole difference from the piped-stdin attempt that failed before.
//     The run writes a real session into state.db with the task and both skills preloaded, which
//     is what makes it appear in the Hermes Desktop App and what a follow-up resumes.
//
//     The child is deliberately NOT detached: it is a normal execFile whose exit code and session
//     id are logged. It therefore dies if Sticky Brain quits mid-answer — acceptable for a tray
//     app that is running whenever the board is on screen, and the alternative is a run nobody can
//     see the outcome of.
//
//  3. No hermes at all: open the Hermes Desktop App, or failing that the source file, and say
//     plainly that the task was not submitted.
//
// In every submitting case the Hermes Desktop App is then brought forward — it is the window the
// answer appears in.
function submitHeadless (bin, prompt, cwd) {
  return new Promise(resolve => {
    let settled = false
    const done = v => { if (!settled) { settled = true; resolve(v) } }
    const child = execFile(bin, ['chat', '-q', prompt, '--skills', HERMES_SKILLS],
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          console.error('[openTaskChat] headless hermes run failed:', String(err.message).split('\n')[0])
        } else {
          // The banner `-q` prints on exit names the session, which is the id a follow-up resumes.
          const m = /--resume\s+([0-9A-Za-z_-]+)/.exec(String(stdout || ''))
          console.log('[openTaskChat] task answered' + (m ? ' — session ' + m[1] : ''))
        }
        // Only reached first if the process never started at all; otherwise the guard drops it.
        done({ ok: !err, error: err ? String(err.message).split('\n')[0] : null })
      })
    child.on('error', err => done({ ok: false, error: err.message }))
    // Resolved on START, not on completion — a task can take a minute to answer and the click
    // must not sit there waiting for it.
    child.on('spawn', () => done({ ok: true }))
  })
}

// SB: `hermes desktop` (alias `hermes gui`) was checked and takes no prompt, no query and no
// --skills — its only context flag is --cwd, and it rebuilds/relaunches the Electron app. So the
// desktop app still cannot be HANDED a task on its command line; it is where the answer is read,
// and the task reaches it through the backend or through a headless `-q` run writing state.db.
ipcMain.handle('board:openTaskChat', async (_e, data) => {
  const info = data || {}
  const prompt = taskPrompt(info)
  const cwd = info.sourceFile && fs.existsSync(path.dirname(info.sourceFile))
    ? path.dirname(info.sourceFile)
    : vaultDir

  // Durable vault record first (sanctioned path) — unchanged, and deliberately still before any
  // launcher runs, so the trace exists even if every one of them fails.
  recordInVault(info)

  // 1 · the local backend, as the plan specifies.
  const viaApi = await hermesApi.startTask({ prompt, skills: HERMES_SKILL_LIST, cwd })
  if (viaApi.ok) {
    const d = await focusHermesDesktop()
    return { ok: true, mode: 'api', submitted: true, focused: d.ok, note: d.ok ? null : d.error }
  }
  // 'offline' and 'unsupported' are expected states, not faults, and are not shouted about.
  if (viaApi.reason === 'unauthorized' || viaApi.reason === 'error') {
    console.error('[openTaskChat] hermes backend declined:', viaApi.reason, '—', viaApi.detail)
  }

  // 2 · headless `hermes chat -q`, which is what actually answers on this machine.
  const bin = await hermesRuntime.cliPath()
  if (bin) {
    const started = await submitHeadless(bin, prompt, cwd)
    if (started.ok) {
      const d = await focusHermesDesktop()
      return { ok: true, mode: 'hermes', submitted: true, focused: d.ok, note: d.ok ? null : d.error }
    }
    console.error('[openTaskChat] could not start hermes:', started.error || 'unknown')
  }

  // 3 · nothing could take the task. Open where it could be worked on, and say it was not sent.
  const desk = await focusHermesDesktop()
  if (desk.ok) {
    return {
      ok: true,
      mode: 'desktop',
      submitted: false,
      note: 'hermes could not take the task — the Desktop App is open for it'
    }
  }

  const file = info.sourceFile && fs.existsSync(info.sourceFile) ? info.sourceFile : null
  if (file) {
    const err = await shell.openPath(file)
    return err ? { ok: false, error: err } : { ok: true, mode: 'editor', submitted: false }
  }
  return {
    ok: false,
    error: bin
      ? 'hermes is installed but the task could not be started'
      : 'hermes is not on PATH and the Hermes Desktop App was not found'
  }
})

/* ---- SB: Feature 5 · floating widget <-> fullscreen dashboard ---- */

// A transparent frameless window does not reliably take native fullscreen on Windows, and when
// it refuses it does so silently. So the state is read back a beat later, and a refusal is met
// with a plain resize onto the display's work area — same result, no lie to the renderer.
ipcMain.handle('board:toggleFullscreen', async () => {
  if (!win) return false
  // SB: pet-sized and fullscreen are opposite ends of one axis. Growing straight from 128x92 to
  // the work area would leave preNikoBounds pointing at a rectangle the owner never chose.
  if (nikoOnly) exitNikoOnly()
  const on = !isExpanded()

  if (on) {
    preFullBounds = win.getBounds()
    win.setFullScreen(true)
    await new Promise(r => setTimeout(r, 250))
    if (!win || win.isDestroyed()) return false
    if (!win.isFullScreen()) {
      const display = screen.getDisplayMatching(preFullBounds)
      win.setBounds(display.workArea)
      sendFullscreen(true)
    } else {
      preFullBounds = null            // native fullscreen restores its own bounds on exit
    }
    return true
  }

  if (win.isFullScreen()) win.setFullScreen(false)
  if (preFullBounds) { win.setBounds(preFullBounds); preFullBounds = null; sendFullscreen(false) }
  return false
})

app.on('before-quit', () => {
  clearInterval(pollTimer)
  for (const w of watchers) { try { w.close() } catch {} }
  watchers = []
})

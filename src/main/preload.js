'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The renderer never touches fs. Everything it can do is on this surface.
contextBridge.exposeInMainWorld('board', {
  onSnapshot: fn => ipcRenderer.on('board:snapshot', (_e, snap) => fn(snap)),
  onFatal: fn => ipcRenderer.on('board:fatal', (_e, msg) => fn(msg)),
  refresh: () => ipcRenderer.invoke('board:refresh'),
  act: (action, id) => ipcRenderer.invoke('board:action', { action, id }),
  reveal: target => ipcRenderer.invoke('board:reveal', target),
  close: () => ipcRenderer.invoke('board:close'),

  // SB: focus the terminal window a live session is running in.
  revealSession: data => ipcRenderer.invoke('board:revealSession', data),
  // SB: open a fresh Hermes chat carrying one task's text, or the source file if hermes is absent.
  openTaskChat: data => ipcRenderer.invoke('board:openTaskChat', data),
  // SB: floating widget <-> fullscreen dashboard. Resolves to the state actually reached.
  toggleFullscreen: () => ipcRenderer.invoke('board:toggleFullscreen'),
  // SB: the window can also leave fullscreen without the button (Esc, the OS), so the renderer
  // follows the window rather than its own last guess.
  onFullscreen: fn => ipcRenderer.on('board:fullscreen', (_e, on) => fn(on)),

  /* ---- SB: Feature 1 & 2 · niko-only mode and the pet's own gestures ---- */

  // Grow the window back from the pet to the board. Safe to call when already a board — it
  // resolves to a show + focus, which is what a double-click on the rail pet should do anyway.
  restoreFromNiko: () => ipcRenderer.invoke('board:restoreFromNiko'),
  // Native context menu on the pet: open board / hide to tray / quit.
  nikoMenu: () => ipcRenderer.invoke('board:nikoMenu'),
  hideToTray: () => ipcRenderer.invoke('board:hideToTray'),
  // The mode is owned by the main process (the tray can enter and leave it too), so the renderer
  // follows it rather than tracking its own copy.
  onNikoOnly: fn => ipcRenderer.on('board:niko-only', (_e, on) => fn(on)),

  // Dragging the pet. `send`, not `invoke`: a move fires on every mousemove and nothing waits on
  // the answer — a round trip per frame would make him lag behind the cursor.
  nikoDragStart: () => ipcRenderer.send('board:nikoDragStart'),
  nikoDragMove: (dx, dy) => ipcRenderer.send('board:nikoDragMove', { dx, dy }),
  nikoDragEnd: () => ipcRenderer.send('board:nikoDragEnd'),

  // SB: round 2 · one-line notices from the main process — quick-capture could not take its
  // shortcut, a capture landed, or the end-of-day summary fell back from a native notification.
  onToast: fn => ipcRenderer.on('board:toast', (_e, t) => fn(t || {}))
})

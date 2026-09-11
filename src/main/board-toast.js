'use strict'

// SB: round 2 · one line on the board from the main process. Used by quick-capture (a shortcut
// that could not register) and the end-of-day summary (a notification Windows refused).
//
// The board is often not on screen when these happen — at login it starts in the tray — and a
// 2.6s toast into a hidden window is the same as saying nothing. So a hidden board gets the
// message the next time it is shown, and a board that is still loading gets it once it has.
function toastBoard (getWin, msg, bad) {
  const w = typeof getWin === 'function' ? getWin() : getWin
  if (!w || w.isDestroyed()) return
  const send = () => {
    if (w.isDestroyed()) return
    w.webContents.send('board:toast', { msg: String(msg), bad: !!bad })
  }
  const whenLoaded = () => (w.webContents.isLoading() ? w.webContents.once('did-finish-load', send) : send())
  if (!w.isVisible()) w.once('show', () => setTimeout(whenLoaded, 300))
  else whenLoaded()
}

module.exports = { toastBoard }

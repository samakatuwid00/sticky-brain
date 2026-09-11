'use strict'

/* SB: round 2 · Feature 1 · the quick-capture box. Everything it can do is on `window.capture`. */

const input = document.getElementById('text')
const state = document.getElementById('state')
let saving = false

function reset () {
  input.value = ''
  state.textContent = ''
  state.className = ''
}

document.getElementById('cap').addEventListener('submit', async e => {
  e.preventDefault()
  if (saving) return
  const text = input.value.trim()
  if (!text) { window.capture.cancel(); return }
  saving = true
  state.textContent = 'saving…'
  state.className = ''
  const r = await window.capture.submit(text)
  saving = false
  // On success the main process hides the window; on failure it stays up with the text intact,
  // so nothing typed is lost to a write that did not happen.
  if (r && r.ok) reset()
  else { state.textContent = (r && r.error) || 'could not save'; state.className = 'bad' }
})

input.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  e.preventDefault()
  reset()
  window.capture.cancel()
})

window.capture.onOpen(() => { input.focus(); input.select() })
window.addEventListener('focus', () => input.focus())
input.focus()

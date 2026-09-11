'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// SB: round 2 · the quick-capture window's whole surface. It can submit one line and go away.
contextBridge.exposeInMainWorld('capture', {
  submit: text => ipcRenderer.invoke('capture:submit', text),
  cancel: () => ipcRenderer.send('capture:cancel'),
  onOpen: fn => ipcRenderer.on('capture:open', () => fn())
})

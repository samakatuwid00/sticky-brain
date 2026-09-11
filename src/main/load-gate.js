'use strict'

// "Has this page finished its first load?" as something that can be awaited at any time after.
//
// A `once('did-finish-load')` registered after the load already finished never fires. That is how
// --shot hung: its listener went on only after the first snapshot was built, and whenever the page
// was quicker than the snapshot, the event had come and gone. Create the gate BEFORE loadFile.
function loadGate (webContents) {
  let loaded = false
  const done = new Promise(resolve => {
    webContents.once('did-finish-load', () => { loaded = true; resolve() })
  })
  return {
    get loaded () { return loaded },
    wait: () => done
  }
}

module.exports = { loadGate }

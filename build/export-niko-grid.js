#!/usr/bin/env node
// Export Niko's idle-pose grid as JSON (reuses vendor/niko.js as-is).
const path = require('path')
const N = require(path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'niko.js'))
const frame = N.ANIMATIONS.idle.frames[0]
const grid = N.compose(frame, { w: N.W + 4, h: 8, ground: 7, ox: 2, name: '' })
const out = []
for (const row of grid) {
  out.push(row.map(c => (c ? { ch: c.ch, k: c.k } : null)))
}
process.stdout.write(JSON.stringify({ W: N.W, grid: out }))

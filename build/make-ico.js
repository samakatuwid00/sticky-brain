'use strict'

/* Packs build/icon-<n>.png into build/icon.ico.
   ICO is a 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per image, then the payloads.
   Entries may hold PNG bytes verbatim, which is what every size here does. */

const fs = require('fs')
const path = require('path')

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const dir = __dirname

const images = SIZES.map(s => ({ size: s, data: fs.readFileSync(path.join(dir, `icon-${s}.png`)) }))

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)              // reserved
header.writeUInt16LE(1, 2)              // 1 = icon
header.writeUInt16LE(images.length, 4)

const entries = Buffer.alloc(16 * images.length)
let offset = header.length + entries.length

images.forEach((img, i) => {
  const at = i * 16
  // 256 is stored as 0 — the field is one byte.
  entries.writeUInt8(img.size >= 256 ? 0 : img.size, at)
  entries.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1)
  entries.writeUInt8(0, at + 2)         // palette count
  entries.writeUInt8(0, at + 3)         // reserved
  entries.writeUInt16LE(1, at + 4)      // colour planes
  entries.writeUInt16LE(32, at + 6)     // bits per pixel
  entries.writeUInt32LE(img.data.length, at + 8)
  entries.writeUInt32LE(offset, at + 12)
  offset += img.data.length
})

const out = path.join(dir, 'icon.ico')
fs.writeFileSync(out, Buffer.concat([header, entries, ...images.map(i => i.data)]))
console.log(`icon.ico: ${images.length} sizes, ${fs.statSync(out).size} bytes`)

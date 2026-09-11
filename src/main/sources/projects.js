'use strict'

const fs = require('fs/promises')
const { paths } = require('../config')

// projects.json maps a working directory to a project name: `[{ name, path }]` or
// `{ projects: [...] }`. Every agent adapter's rows are named through it by sessions.js, so an
// adapter only has to report a `cwd`.

async function load () {
  try {
    const parsed = JSON.parse(await fs.readFile(paths.projects, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : parsed.projects || []
    return list.filter(p => p && p.path)
  } catch {
    return []
  }
}

function projectFor (cwd, registry) {
  if (!cwd) return null
  const lower = cwd.toLowerCase()
  for (const entry of registry) {
    if (entry.path && lower.startsWith(entry.path.toLowerCase())) return entry.name
  }
  return null
}

module.exports = { load, projectFor }

# Sticky Brain

[![check](https://github.com/samakatuwid00/sticky-brain/actions/workflows/check.yml/badge.svg?branch=opensource)](https://github.com/samakatuwid00/sticky-brain/actions/workflows/check.yml)

An always-on-top board over your live coding-agent sessions, a pending inbox and a backlog.

```
npm install
npm run dev      # separate userData, safe beside an installed copy
npm start
```

## Data sources and configuration

Sticky Brain works with nothing configured. On first run it creates a data folder inside the
app's own data directory (`<userData>/data`, reachable from the tray menu via *Open board state
folder*) and seeds it with a sample backlog and one welcome record, once. Delete the samples and
they stay deleted.

| Source   | Default location                   | What it is                                           |
|----------|------------------------------------|------------------------------------------------------|
| sessions | `~/.claude/sessions`               | Claude Code sessions; Hermes Agent too, if installed |
| inbox    | `<userData>/data/inbox/`           | one Markdown file per pending record                 |
| backlog  | `<userData>/data/backlog.md`       | `## ` headings with `- ` bullets under them          |
| evidence | `<userData>/data/evidence.md`      | optional repo branch chips                           |

A source whose tool is not on the machine is reported as *not set up*, not as an error, and is
left out of the footer's source count.

Quick capture (`Win+Shift+C`, `Cmd+Shift+C` on macOS) writes a record into the inbox. Marking a
record done moves it into `inbox/done/`; nothing is deleted. Marking a backlog line done strikes
it through in place.

### Pointing it at your own files

Set an environment variable, or put the same key in `<userData>/config.json`. The environment wins
over `config.json`, which wins over the default. Relative paths in `config.json` resolve against
`<userData>`.

| Environment variable       | `config.json` key | Overrides                                  |
|----------------------------|-------------------|--------------------------------------------|
| `STICKY_BRAIN_VAULT`       | `vault`           | use a Second Brain vault layout (below)    |
| `STICKY_BRAIN_DATA`        | `dataDir`         | the local data folder                      |
| `STICKY_BRAIN_INBOX`       | `inbox`           | pending records folder                     |
| `STICKY_BRAIN_BOARD_INBOX` | `boardInbox`      | quick-capture folder                       |
| `STICKY_BRAIN_BACKLOGS`    | `backlogs`        | backlog Markdown file                      |
| `STICKY_BRAIN_EVIDENCE`    | `evidence`        | evidence Markdown file                     |
| `STICKY_BRAIN_PROJECTS`    | `projects`        | `projects.json` (session folder → project) |
| `STICKY_BRAIN_INBOX_HOOK`  | `inboxHook`       | receipt-writer script (Windows only)       |
| `STICKY_BRAIN_ADAPTERS`    | `adapters`        | agent adapters folder (`<userData>/adapters`) |
| —                          | `agents`          | `{ "hermes": false }` turns an agent off   |
| `STICKY_BRAIN_CLAUDE`      | —                 | Claude Code home (default `~/.claude`)     |
| `STICKY_BRAIN_HERMES`      | —                 | Hermes Agent home                          |

```json
{ "backlogs": "C:/Users/me/notes/todo.md" }
```

With `vault` set, the paths follow a Second Brain vault layout instead: `.inbox/`,
`.board-inbox/`, `wiki/Open Backlogs.md`, `wiki/Project Change Evidence.md` and
`.automation/projects.json`. If the vault has `.automation/sb-inbox.ps1`, mark-done writes a
receipt through it; without it, quick captures are still retired into `done/`, and vault `.inbox/`
records are left for the vault's own consolidate step.

### First run

On a machine with no `config.json`, a card at the top of the board shows where the data folder is
and which agents were found, each with a toggle. *save* writes the choices into `config.json`;
*skip* writes nothing. The board renders underneath either way, and the card never returns.

### Agent adapters

Every `*.js` file in the adapters folder (tray menu → *Open adapters folder*) is loaded at start-up
as an extra agent for the LIVE list. [`adapters/example-tmux.js`](adapters/example-tmux.js) is a
commented template; the full contract is at the top of
[`src/main/sources/index.js`](src/main/sources/index.js).

A file that fails to load, an adapter that throws, and a `read()` that takes longer than four
seconds each show as one "unreadable" line under LIVE; the rest of the board carries on. Adapters
run in the main process with full Node access, so only install ones you have read.

### Platform notes

Built and tested on Windows. Clicking a session focuses its terminal on Windows (Win32 through
PowerShell), on macOS (System Events through `osascript`; macOS asks for the Automation permission
on first use) and on Linux under X11 with `xdotool` installed. Wayland has no cross-app focus, so
there a click says so. The Hermes process sweeps and the receipt writer are Windows-only; the
board itself, the local data folder and quick capture are plain Node and Electron.

### Checks

```
npm run check    # node build/check-sources.js — fixtures, no dependencies needed
```

CI runs it, plus `node --check` over every source file, on Ubuntu and Windows.

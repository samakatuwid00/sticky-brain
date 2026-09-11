# Sticky Brain

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

### Platform notes

Built and tested on Windows. Focusing a session's terminal window, the Hermes process sweeps and
the receipt writer use PowerShell and are skipped elsewhere; the board itself, the local data
folder and quick capture are plain Node and Electron.

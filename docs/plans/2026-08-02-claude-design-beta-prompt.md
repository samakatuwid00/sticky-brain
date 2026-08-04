# Prompt — Claude Design Beta: Sticky Brain board mockup

Paste the fenced block below into Claude Design Beta. Everything above and below the fence is
notes for the author, not part of the prompt.

Author notes: the data shapes inside the prompt are real, read off disk 2026-08-02 — do not
replace them with invented fields. The one thing to edit per run is the **Variant** line at the
bottom; run it three times, once per variant, and compare.

---

```text
# Role

You are a senior product designer specializing in ambient, glanceable desktop utilities —
the class of interface that lives on top of other windows and must be readable in a half-second
side-glance, not studied. Design a high-fidelity mockup for the app described below.

# What I am building

"Sticky Brain": a frameless, always-on-top desktop widget (Electron, ~360×640 default, resizable,
drag-anywhere). It is a read-only board over four local data sources belonging to my Obsidian
vault and my Claude Code sessions. It exists so an AI agent stops interrupting me about open
issues — I glance at the board instead.

It answers three questions and nothing else:
1. What agent sessions are running right now, and in which project?
2. What is pending — unconsolidated notes with owed follow-ups?
3. What is backlogged — open items per project?

# The data, verbatim shapes

Group A — LIVE SESSIONS. One object per running agent session:
{"pid":18000,"sessionId":"bf7e71a3-fa3e-430d-bfb6-281445086da3","cwd":"C:\\Users\\deped",
 "startedAt":1785676663801,"version":"2.1.220","kind":"interactive","entrypoint":"cli",
 "name":"deped-fb","status":"busy","updatedAt":1785677107914}
Derived per card: project name (resolved from cwd), session name, status (busy / idle / stale),
elapsed time since startedAt, seconds since updatedAt.
Typical count on screen: 1–4. "stale" means the process is gone but the file remains.

Group B — PENDING. One per unconsolidated capture record. Fields:
  task (one line, e.g. "Push gate run: is it safe to push the Second Brain vault")
  project ("Second Brain")
  createdLocal ("2026-08-02T21:22")
  followUps (0–3 sentences, the owed work)
  unresolved (0–3 sentences, open questions)
Typical count: 1–12. Follow-ups and unresolved are the payload; task is the label.

Group C — BACKLOG. Flat items grouped by a heading string that names both a project and what
opened them. Real headings, use these in the mockup:
  "iRIMS-V — UI/UX fixes reported 2026-07-27"
  "iRIMS-V — diagnosed but unfixed"
  "eduleave — improvement backlog"
  "Opened by the 2026-07-31/08-01 console-list sessions"
  "schema_mapper — left open by the delivery build"
  "Portfolio — left open by the versatility revamp"
Items are prose bullets of 5–25 words, no ids, no priorities, no due dates. There are 18 such
headings and well over a hundred items total — the design must survive that without becoming a
wall. Assume the board shows a bounded slice, not everything.

Group D — REPO STATE. Per project: branch name, dirty file count, plus one or two flags like
"detached HEAD". Six registered projects: iRIMS-V, eduleave, IRIMS-V Library System,
Portfolio, schema_mapper, Eurasian Paradise Resort System.

# Hard requirements

- Sticky-note metaphor, but legible-first. Skeuomorphic warmth is welcome; illegible paper
  texture, low-contrast pencil type, and rotated text are not.
- Dark theme is the primary. Provide light as a second frame. The widget sits over code editors.
- Every card must carry its source. A user must be able to tell at a glance whether an item came
  from a live session, a pending record, or the backlog — by form, not only by color.
- Show empty, loading, and error states. The error state is
  "source unavailable — <path>", and it must be visibly different from an empty board.
  A board that renders empty when a file is missing is the specific failure I am designing against.
- Show the overflow case: what "+47 more" looks like, and where the count of hidden items lives.
  Silent truncation is not acceptable — the number must be on screen.
- Per-item affordances: acknowledge, snooze, pin. Acknowledged items leave the board.
  These are the only interactions. There is no editing, no adding, no deleting.
- Density control: a compact mode that fits roughly twice the items, at the same window width.
- Accessibility: WCAG AA contrast on all text including on the note fills; status must not be
  conveyed by hue alone; full keyboard traversal with a visible focus ring.

# Deliverables

1. Default state, dark, 360×640 — sessions, pending, and backlog all populated and visible
   together. This is the hero frame; it must prove the three questions are answerable in one look.
2. The same board, compact density.
3. Light theme, default density.
4. States frame: empty / loading / error / overflow, side by side.
5. Anatomy frame: one card of each type at 2×, annotated — spacing, type scale, what each
   affordance does, what the status indicator encodes.
6. Tokens: color ramp with contrast ratios stated, type scale, spacing scale, radii, elevation.

# Constraints on your output

- Real strings from the data above. No "Lorem", no "Task 1", no invented project names.
- Timestamps rendered relative ("2h 14m", "just now"), with the absolute value on hover — show
  both in the anatomy frame.
- No emoji as status indicators.
- No dashboard chrome: no charts, no KPI tiles, no progress rings, no gamification, no streaks.
- Assume no network. Nothing may imply sync, sharing, or an account.

# Before you design

State in three sentences: what a user must be able to read in the first half-second, what earns
its place second, and what you are deliberately pushing below the fold. Then design to that.

# Variant

Run this brief as: [ VARIANT ]
  A — literal sticky notes: paper fills, soft drop shadows, slight overlap, tape or pin motifs.
  B — terminal-adjacent: monospace, hairline rules, near-black surfaces, single accent hue.
  C — quiet native: system-native materials, translucency, restrained type, near-invisible chrome.
```

---

## How to use the three variants

Run A, B, C separately rather than asking for all three at once — a single generation blends them
and the comparison is lost. Judge on the hero frame only: whichever one answers *what is running /
what is pending / what is owed* fastest wins, regardless of which is prettiest.

## What to feed back on the second pass

Once a variant is chosen, re-prompt with the winning hero frame attached and ask only for:
the overflow treatment at 100+ backlog items, and the stale-session card. Those two are where this
board will actually fail, and they are the two a first pass always under-designs.

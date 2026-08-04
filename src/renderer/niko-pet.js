'use strict'

/* Niko on the rail. Movements come from the real engine (vendor/niko.js — the Node
   `niko-frames.js`, unmodified); this file is only the driver: the 2c board-event map and the
   2d perch rules.

   Note the engine's EVENTS table has no `awaiting` and no `approved` — those exist only in the
   installed PowerShell pet, which is a different program sharing the name. A blocked permission
   prompt therefore has no movement here, and the board says nothing about it.

   SB: he used to move only on a CHANGE, so a board that sat busy for an hour got the generic
   ambient loop — indistinguishable from a board with nothing running. What follows adds a
   sustained mood on top of the transitions: the ambient pool itself is chosen by the state the
   board is in now, not by what changed last.

   SB (Feature 2): he is now also something you can touch. Click, double-click, right-click, hover
   and drag all land on #niko-hit, a box this file keeps parked over the sprite. Three moods here
   are NOT board state — `curious`, `shy` and `excited` are reactions, and they are held for a few
   seconds and then handed back to whatever the snapshot says. `baseMood` is the board's answer,
   `mood` is what he is doing about it.

   Every name below was checked against the engine's own table: the movements that exist are
   idle blink look walk hop stretch wave turn dance think happy love celebrate eat sad error
   sleep poof vanish — nineteen. `tool`, `done`, `pet`, `snack` and `bye` are EVENT names, not
   movements; they resolve to walk / celebrate / love / eat / vanish. `type`, `panic`, `sweat`
   and `alert` do not exist in this engine at all and are not used. MOVE() drops anything that
   is not a real key rather than letting the player silently fall back to idle. */

;(function () {
  const RAIL = document.getElementById('niko-rail')
  const N = window.NikoPet
  if (!RAIL || !N) return

  // SB: the two elements the gestures and the bubble live on. Both are optional — an older
  // index.html without them leaves the pet exactly as he was.
  const HIT = document.getElementById('niko-hit')
  const BUBBLE = document.getElementById('niko-bubble')

  const H = 8              // rail rows; 6 sprite rows plus headroom for hop and fx
  const GROUND = 7         // feet on the frame edge
  const NIGHT = h => h >= 22 || h < 7
  const QUIET_MS = 3 * 60 * 1000

  // SB: sprite geometry in the rail, in px. The rail is 8px type on an 8px line, so a row IS 8px.
  // Used to park the hit box exactly over him rather than over the whole 64px strip.
  const CELL_H = 8
  const SPRITE_TOP = (GROUND - (N.ROWS - 1)) * CELL_H
  const SPRITE_H = N.ROWS * CELL_H

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  let cols = 60
  let x = 0                // sprite origin in cells
  let move = 'poof'
  let frame = 0
  let queue = ['wave']     // one queued move max, per the perch rules
  let timer = null
  let lastEvent = Date.now()
  let ambient = 0
  let cursor = { x: -999, y: -999 }
  let prev = null
  let word = null
  let mood = 'idle'
  let lastSnap = null

  // SB: Feature 1 · true while the window is shrunk to the pet. Owned by the main process; this
  // is only a mirror of what it last said.
  let nikoOnly = false

  /* ---- SB: moods · the state the board is IN, not the thing that just changed ----
     `waiting` is NOT a permission prompt. Nothing in the four sources reports one — see the note
     above — so it is defined here as the only wait the board can actually see: work parked in
     the inbox with no session running to move it. Naming it anything else would be a claim the
     data does not support.

     SB (Feature 2): the last three are reactions to a person, not readings of the board, and are
     never returned by moodOf(). They are entered by hand with a hold and expire back to
     `baseMood`. `excited` is the exception that has a board trigger too — pending dropping is a
     task being finished, which is the one board event worth being pleased about. */
  const MOODS = {
    error: { enter: ['error', 'sad'], ambient: ['sad', 'look', 'sad', 'idle'], word: 'source down' },
    busy: { enter: ['think', 'walk'], ambient: ['think', 'walk', 'look', 'think', 'blink', 'walk'], word: 'session busy' },
    waiting: { enter: ['love'], ambient: ['love', 'idle', 'eat', 'look', 'blink'], word: 'waiting on you' },
    idle: { enter: ['stretch'], ambient: ['idle', 'blink', 'stretch', 'idle', 'look', 'turn', 'idle'], word: 'quiet' },
    excited: { enter: ['celebrate', 'happy'], ambient: ['happy', 'hop', 'dance', 'celebrate', 'blink'], word: 'task done' },
    curious: { enter: ['look'], ambient: ['look', 'turn', 'blink', 'idle'], word: 'hm?' },
    shy: { enter: ['sad'], ambient: ['sad', 'blink', 'idle'], word: 'eep' }
  }

  /* SB: Feature 2 · what he says. One line, picked at random, shown in #niko-bubble. Kept as
     plain text: the sprite's own glyphs (♥ ♪ ✦ z) are the engine's job and are drawn INSIDE the
     13-cell grid, so the bubble never has to compete with them. */
  const SAYINGS = {
    idle: ['zZZ', '...', '♪'],
    busy: ['working on it!', 'hmm...', 'almost done!'],
    waiting: ['hey!', 'click me!', 'need something?'],
    error: ['oops!', 'something broke', 'check the sources'],
    excited: ['yay!', 'nice work!', 'task done!'],
    curious: ['hm?', 'oh — hi', '?'],
    shy: ['eep!', 'too close!', '...'],
    // Not moods: the two things a person does to him directly.
    hello: ['hi!', 'hello!', '♥', 'hey there'],
    pet: ['hehe', 'that tickles', 'more!', '♥♥']
  }

  const pick = list => list[Math.floor(Math.random() * list.length)]

  // The engine is the only authority on what exists. A name that is not in its table is dropped,
  // never played as idle — a silent fallback is how a wrong mapping survives unnoticed.
  const MOVE = names => (names || []).filter(m => !!N.ANIMATIONS[m])

  function moodOf (snap) {
    if (!snap) return 'idle'
    if (snap.sources.some(s => !s.ok)) return 'error'
    if (snap.live.busy > 0) return 'busy'
    if (snap.pending.total > 0) return 'waiting'
    return 'idle'
  }

  /* ---- SB: Feature 2 · reaction moods sit ON TOP of the board's mood for a few seconds ----
     baseMood is what moodOf() last returned; mood is what he is actually doing. holdUntil is when
     the reaction lapses. Nothing polls it on a timer — every place that reads the mood calls
     settle() first, so an expired hold costs nothing until it matters. */
  let baseMood = 'idle'
  let holdUntil = 0

  function settle () {
    if (holdUntil && Date.now() >= holdUntil) { holdUntil = 0; mood = baseMood }
  }

  function react (name, holdMs, sayKey) {
    if (!MOODS[name]) return
    mood = name
    holdUntil = holdMs ? Date.now() + holdMs : 0
    fire(MOODS[name].enter, MOODS[name].word)
    if (sayKey !== false) sayFor(sayKey || name)
  }

  function release () { holdUntil = 0; mood = baseMood }

  /* toHTML emits inline `style="color:…"`, which the page CSP blocks (style-src 'self', no
     unsafe-inline) — glyphs came out black. Rather than weaken the CSP for the pet, the three
     colour keys are swapped for classes and the palette stays in the stylesheet, which also
     makes him follow the theme for free.

     SB: the same CSP is why the bubble and the hit box are positioned through the CSSOM
     (element.style.left = …) rather than through a style attribute in the markup — CSP governs
     attributes the parser sees, not properties script sets. */
  const CLASS_OF = { '#nb': 'nb', '#na': 'na', '#nd': 'nd' }
  const MARKERS = { b: '#nb', a: '#na', d: '#nd' }

  function classify (html) {
    return html.replace(/<span style="color:(#n[bad])">/g, (_, k) => `<span class="${CLASS_OF[k]}">`)
  }

  function cellWidth () {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;visibility:hidden;font:700 8px/8px "JetBrains Mono",ui-monospace,Consolas,monospace;white-space:pre'
    probe.textContent = '0'.repeat(50)
    RAIL.append(probe)
    const w = probe.getBoundingClientRect().width / 50
    probe.remove()
    return w || 4.8
  }

  let cw = 4.8

  function measure () {
    cw = cellWidth()
    cols = Math.max(N.W + 4, Math.floor(RAIL.clientWidth / cw))
    // SB: the pet window is barely wider than he is, so he is re-centred rather than left wherever
    // the board-sized rail had walked him — off the right-hand edge, most of the time.
    if (nikoOnly) x = Math.max(0, Math.floor((cols - N.W) / 2))
    if (x === 0) x = Math.max(0, Math.floor((cols - N.W) / 2))
    x = Math.min(x, cols - N.W)
    placeHit()
  }

  /* ---- SB: Feature 2 · keep the hit box and the bubble parked over the sprite ----
     In niko-only mode both fall back to the stylesheet: the box becomes the whole window and the
     bubble centres on it, so the inline values from board mode have to be cleared, not overwritten
     — an inline `left` would beat the `left: 50%` rule. */
  function placeHit () {
    const left = x * cw
    const width = N.W * cw
    if (HIT) {
      if (nikoOnly) {
        HIT.style.left = ''
        HIT.style.top = ''
        HIT.style.width = ''
        HIT.style.height = ''
      } else {
        HIT.style.left = left + 'px'
        HIT.style.top = SPRITE_TOP + 'px'
        HIT.style.width = width + 'px'
        HIT.style.height = SPRITE_H + 'px'
      }
    }
    if (BUBBLE) BUBBLE.style.left = nikoOnly ? '' : (left + width / 2) + 'px'
  }

  /* ---- SB: Feature 2 · speech bubble ---- */
  let bubbleTimer = null

  function say (text, ms) {
    if (!BUBBLE || !text) return
    BUBBLE.textContent = text
    BUBBLE.classList.remove('hidden')
    placeHit()
    clearTimeout(bubbleTimer)
    bubbleTimer = setTimeout(() => BUBBLE.classList.add('hidden'), ms || 2400)
  }

  function sayFor (key) {
    const list = SAYINGS[key]
    if (list && list.length) say(pick(list))
  }

  function footerWord (name) {
    if (!word) {
      word = document.createElement('span')
      word.className = 'niko'
      const keys = document.querySelector('#footer .keys')
      keys ? keys.before(word) : document.getElementById('footer').append(word)
    }
    word.textContent = '· ' + name
  }

  function paint () {
    const anim = N.ANIMATIONS[move] || N.ANIMATIONS.idle
    const f = anim.frames[frame % anim.frames.length]
    // `name: ''` suppresses the NIKO tag — the rail is 8px type and the board owns the labels.
    const grid = N.compose(f, { w: cols, h: H, ground: GROUND, ox: x, name: '' })
    RAIL.innerHTML = classify(N.toHTML(grid, MARKERS))

    // never over text: cursor within 24px of the sprite box ghosts him and steps him aside.
    // SB: neither half applies in niko-only mode — there is no text to be over, the cursor is
    // always near him by definition, and stepping aside from a cursor that is trying to click
    // him is the opposite of what a desktop pet should do. Hovering him deliberately (`hovering`)
    // also stops the dodge in board mode, or he would walk out from under his own hit box.
    const left = x * cw
    const near = !nikoOnly && cursor.y < 80 && cursor.x > left - 24 && cursor.x < left + N.W * cw + 24
    RAIL.classList.toggle('ghost', near && !hovering)
    if (near && !hovering && !anim.once) x = (x + 3) % Math.max(1, cols - N.W)
    placeHit()
  }

  function step () {
    const anim = N.ANIMATIONS[move] || N.ANIMATIONS.idle
    paint()
    if (anim.step) x = Math.max(0, Math.min(cols - N.W, x + anim.step))
    frame++

    const done = frame >= anim.frames.length * (anim.once ? 1 : 2)
    if (done) {
      frame = 0
      if (queue.length) move = queue.shift()
      else if (anim.once) move = 'idle'         // every one-shot returns to idle
      else move = nextAmbient()
    }
    timer = setTimeout(step, 1000 / ((N.ANIMATIONS[move] || anim).fps || 2))
  }

  // SB: he mutters between movements, so the idle/busy/waiting lines are actually reachable —
  // they would otherwise only ever be seen in the one frame a mood is entered. Rate-limited and
  // silent at night; a pet that talks in his sleep is a pet you turn off.
  const CHATTER_GAP_MS = 20 * 1000
  let lastChatter = 0

  function maybeChatter () {
    if (reduced || NIGHT(new Date().getHours())) return
    const now = Date.now()
    if (now - lastChatter < CHATTER_GAP_MS) return
    if (Math.random() > 0.18) return
    lastChatter = now
    sayFor(mood)
  }

  function nextAmbient () {
    settle()
    const hour = new Date().getHours()
    if (NIGHT(hour)) return 'sleep'
    // SB: the quiet timeout only applies to a quiet board. A busy session or a failed source is
    // itself the reason he is moving, so it must not put him to sleep three minutes in.
    if ((mood === 'idle' || mood === 'waiting') && Date.now() - lastEvent > QUIET_MS) return 'sleep'
    maybeChatter()
    const pool = MOVE((MOODS[mood] || MOODS.idle).ambient)
    const list = pool.length ? pool : N.AMBIENT
    return list[ambient++ % list.length]
  }

  function fire (moves, name) {
    lastEvent = Date.now()
    footerWord(name)
    if (reduced) return                          // static idle; the word is the whole signal
    const real = MOVE(moves)
    if (!real.length) return
    // Night mode wakes only for error.
    // SB: and for a deliberate touch — someone clicking him at 2am gets an answer, or he reads
    // as broken. The gesture handlers pass 'petted', which is not a board event and never fires
    // on its own.
    if (NIGHT(new Date().getHours()) &&
        name !== 'source unavailable' && name !== 'source down' && name !== 'petted') return
    move = real[0]
    queue = real.slice(1, 2)
    frame = 0
    clearTimeout(timer)
    timer = setTimeout(step, 0)
  }

  /* ---- 2c · board event map ---- */
  function observe (snap) {
    lastSnap = snap
    const bad = snap.sources.filter(s => !s.ok).length
    const busy = snap.live.busy
    const stale = snap.live.items.filter(s => s.status === 'stale').length
    const pending = snap.pending.total
    const next = moodOf(snap)

    // A discrete change is the more specific thing to say, so it wins; the mood only speaks when
    // nothing changed but the board moved from one state to another.
    let spoke = false
    let excited = false
    if (prev) {
      spoke = true
      if (bad > prev.bad) { fire(['error', 'sad'], 'source unavailable'); sayFor('error') }
      else if (stale > prev.stale) fire(['look', 'sad'], 'session stale')
      else if (busy > prev.busy) fire(['think', 'walk'], 'session busy')
      else if (busy < prev.busy) fire(['celebrate', 'happy'], 'session finished')
      else if (pending > prev.pending) fire(['hop'], 'new pending slip')
      // SB: Feature 2 · pending dropping is a task being finished. That is the one board change
      // worth more than a single movement, so it takes the `excited` mood for twelve seconds
      // rather than one `happy` that is over before it is noticed.
      else if (pending < prev.pending) excited = true
      else if (!bad && busy === 0 && pending === 0 && snap.backlog.total === 0) {
        fire(['dance', 'sleep'], 'board clear')
      } else spoke = false
    }

    // SB: the mood also decides the ambient pool, so it is set even when nothing is fired —
    // otherwise a board that came up busy would loop the generic idle animations forever.
    const changed = next !== baseMood
    baseMood = next
    // A held reaction (hover, a pet, a finished task) outranks the board for its few seconds; the
    // new base is remembered and taken up when the hold lapses.
    if (!holdUntil) mood = next

    if (excited) react('excited', 12000)
    else if (changed && !spoke) { mood = next; holdUntil = 0; fire(MOODS[next].enter, MOODS[next].word); sayFor(next) }

    prev = { bad, busy, stale, pending }
  }

  // SB: nothing else re-evaluates him between snapshots, and two things drift on their own — the
  // clock crossing into night, and a mood entry that was swallowed while he was mid-animation.
  // This is a cheap re-check, not a second source of truth: it reads only the last snapshot.
  const MOOD_POLL_MS = 30 * 1000
  setInterval(() => {
    if (!lastSnap || reduced) return
    settle()
    if (holdUntil) return                        // mid-reaction; the board can wait its turn
    const next = moodOf(lastSnap)
    if (next === mood) return
    baseMood = next
    mood = next
    fire(MOODS[next].enter, MOODS[next].word)
  }, MOOD_POLL_MS)

  /* ================= SB: Feature 2 · the interactive half ================= */

  let hovering = false
  let nearSince = 0
  let dragging = false
  let dragged = false
  let dragX = 0
  let dragY = 0
  let clicks = []

  const PET_WINDOW_MS = 900     // three clicks inside this is a scratch, not three hellos
  const SHY_MS = 2600           // cursor parked on him this long and he gets self-conscious
  const DRAG_SLOP = 4           // px before a press counts as a drag rather than a click

  function restoreBoard () {
    if (window.board && window.board.restoreFromNiko) window.board.restoreFromNiko()
  }

  /* Click.

     SB: the two feature briefs disagree about what a single click on the pet does in niko-only
     mode — Feature 1 says it restores the board, Feature 2 says it plays a love animation and
     Feature 2's DOUBLE-click restores. Rather than pick one and drop the other, both happen: the
     animation and the bubble fire immediately, and the restore follows in the same handler. The
     window grows around a pet who is already mid-heart, and it is the same DOM either side of the
     resize, so the movement finishes on the rail. Double-click restores as well, which is then
     merely a second way to say the same thing rather than the only one.

     The knock-on is real and is left as it is: the three-click scratch cannot be reached in
     niko-only mode, because click one has already opened the board. Petting lives on the rail. */
  function onClick () {
    if (dragged) return
    const now = Date.now()
    clicks = clicks.filter(t => now - t < PET_WINDOW_MS)
    clicks.push(now)

    if (clicks.length >= 3) {
      clicks = []
      react('excited', 8000, false)
      fire(['love', 'happy'], 'petted')
      sayFor('pet')
    } else {
      fire(['love', 'celebrate'], 'petted')
      sayFor('hello')
    }

    if (nikoOnly) restoreBoard()
  }

  function onEnter () {
    hovering = true
    nearSince = Date.now()
    RAIL.classList.remove('ghost')
    // Already shy, or mid-scratch: leave him be rather than interrupting with a milder reaction.
    if (mood === 'shy' || mood === 'excited') return
    react('curious', 6000)
  }

  function onLeave () {
    hovering = false
    nearSince = 0
    if (mood === 'curious' || mood === 'shy') release()
  }

  // SB: hovering "looks at the cursor" only as far as the engine allows — `look` is a fixed
  // left-then-right movement and there is no runtime control of eye direction, so he looks
  // AROUND rather than AT. Recorded here rather than dressed up: the sprite has no pose for it.
  const SHY_TICK_MS = 700
  setInterval(() => {
    if (reduced || !hovering || !nearSince) return
    if (mood === 'shy') return
    if (Date.now() - nearSince < SHY_MS) return
    nearSince = Date.now() + 24 * 60 * 60 * 1000   // once per hover, not once per tick
    react('shy', 9000)
  }, SHY_TICK_MS)

  if (HIT) {
    HIT.addEventListener('click', onClick)
    HIT.addEventListener('dblclick', () => { if (!dragged) restoreBoard() })
    HIT.addEventListener('contextmenu', e => {
      e.preventDefault()
      if (window.board && window.board.nikoMenu) window.board.nikoMenu()
    })
    HIT.addEventListener('mouseenter', onEnter)
    HIT.addEventListener('mouseleave', onLeave)

    // Drag — niko-only mode only. On the board he stands on the frame edge and moving him would
    // mean moving the whole board, which is what the titlebar is for.
    HIT.addEventListener('mousedown', e => {
      if (e.button !== 0 || !nikoOnly) return
      dragging = true
      dragged = false
      dragX = e.screenX
      dragY = e.screenY
      HIT.classList.add('dragging')
      if (window.board && window.board.nikoDragStart) window.board.nikoDragStart()
    })
  }

  // Screen coordinates, not client ones: the window is moving under the cursor, so anything
  // measured relative to the window drifts by exactly the amount it just moved.
  window.addEventListener('mousemove', e => {
    cursor = { x: e.clientX, y: e.clientY }
    if (!dragging) return
    const dx = e.screenX - dragX
    const dy = e.screenY - dragY
    if (!dragged && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return
    dragged = true
    if (window.board && window.board.nikoDragMove) window.board.nikoDragMove(dx, dy)
  })

  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    if (HIT) HIT.classList.remove('dragging')
    if (window.board && window.board.nikoDragEnd) window.board.nikoDragEnd()
    // `click` is dispatched straight after `mouseup`, in the same task, so the flag has to
    // survive until then — a drag that ended over him must not also read as a click.
    setTimeout(() => { dragged = false }, 0)
  })

  /* ---- SB: Feature 1 · the mode switch ---- */
  function setNikoOnly (on) {
    const next = !!on
    if (next === nikoOnly) return
    nikoOnly = next
    document.body.classList.toggle('niko-only', nikoOnly)
    RAIL.classList.remove('ghost')
    hovering = false
    nearSince = 0
    clicks = []

    // The window resize is in flight when this arrives, so the rail's new width is not readable
    // yet. Two frames is enough for layout to settle, and measure() re-centres him.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      measure()
      paint()
    }))

    if (nikoOnly) {
      // Arriving on the desktop is worth a hello — and it is the one moment the pet has to say
      // what he is for, because the board that explained it has just gone away.
      fire(['poof', 'wave'], 'niko only')
      say('click me!', 3200)
    }
  }

  window.nikoPet = {
    observe,
    resize: measure,
    retheme: paint,
    mood: () => mood,
    say,
    setNikoOnly,
    isNikoOnly: () => nikoOnly,
    bye: () => { clearTimeout(timer); move = 'vanish'; frame = 0; step() }
  }

  // SB: measure AND repaint. The mode switch and the window resize are two separate events and
  // the renderer is told first, so the re-centre can happen against the old width — a 360px rail
  // centres him at ~148px, which is off the right-hand edge of a 128px pet window. The resize
  // that follows is what corrects it, and it has to redraw him where it puts him rather than
  // waiting for the next animation frame to notice.
  window.addEventListener('resize', () => { measure(); paint() })

  measure()
  if (reduced) {
    move = 'idle'
    paint()
  } else {
    step()
  }
})()

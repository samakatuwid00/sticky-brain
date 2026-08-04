#!/usr/bin/env node
/* NIKO — a terminal pet for Claude Code.
 *
 *   node niko-frames.js               demo every movement
 *   node niko-frames.js walk sleep    play specific moves
 *   node niko-frames.js --pet         corner-pet mode — watches the event file
 *   node niko-frames.js --list        list movements
 *   node niko-frames.js --text=walk   print plain-text frames (copyable, no color)
 *
 * Flags: --256  --mono  --no-tag  --w=30  --speed=1.5  --file=/path/to/event
 * Pet events:  echo think|tool|done|error|pet|snack|sleep|bye > $TMPDIR/niko-event
 * Hook those echoes from Claude Code settings.json (see the spec page).
 * Any UTF-8 terminal; truecolor with 256-color and mono fallbacks. No deps.
 */
(function (root) {
'use strict';

/* ---------- sprite: 13 x 12 pixel grid, drawn as 13 x 6 half-block cells ---------- */
var W = 13, H = 12, ROWS = 6;

function blank() { var g = [], r; for (r = 0; r < H; r++) g.push(new Array(W).fill(0)); return g; }
function fill(g, r0, r1, c0, c1, v) {
  if (v === undefined) v = 1;
  for (var r = r0; r <= r1; r++) { if (r < 0 || r >= H) continue;
    for (var c = c0; c <= c1; c++) if (c >= 0 && c < W) g[r][c] = v; }
}
function carve(g, r0, r1, c0, c1) { fill(g, r0, r1, c0, c1, 0); }

var EYES = {
  open:  { r: 6, h: 2, l: [2, 3],  rt: [9, 10] },
  shut:  { r: 7, h: 1, l: [2, 3],  rt: [9, 10] },
  happy: { r: 6, h: 1, l: [2, 3],  rt: [9, 10] },
  left:  { r: 6, h: 2, l: [1, 2],  rt: [8, 9]  },
  right: { r: 6, h: 2, l: [3, 4],  rt: [10, 11] },
  up:    { r: 5, h: 2, l: [2, 3],  rt: [9, 10] },
  down:  { r: 7, h: 2, l: [2, 3],  rt: [9, 10] },
  none:  null
};

function pose(o) {
  o = o || {};
  var g = blank(), sq = !!o.squash, tall = !!o.tall;
  var top = tall ? 3 : sq ? 5 : 4, bot = sq ? 10 : 9;
  fill(g, top, bot, 0, 12);
  var er = top - 1, ears = o.ears || 'up';
  if (ears === 'up')    { fill(g, er, er, 1, 2);     fill(g, er, er, 10, 11); }
  if (ears === 'perk')  { fill(g, er - 1, er, 1, 2); fill(g, er - 1, er, 10, 11); }
  if (ears === 'droop') { fill(g, er, er, 0, 1);     fill(g, er, er, 11, 12); }
  if (ears === 'waveA') { fill(g, er - 1, er, 1, 2); fill(g, er, er, 10, 11); }
  if (ears === 'waveB') { fill(g, er, er, 0, 1);     fill(g, er, er, 10, 11); }
  var e = EYES[o.eyes || 'open'];
  if (e) { var r = e.r + (sq ? 2 : 0);
    carve(g, r, r + e.h - 1, e.l[0], e.l[1]); carve(g, r, r + e.h - 1, e.rt[0], e.rt[1]); }
  var mr = sq ? 9 : 8;
  if (o.mouth === 'open') carve(g, mr, mr, 5, 7);
  if (o.mouth === 'big')  carve(g, mr, mr + 1, 5, 7);
  var L = o.legs || (sq ? 'stub' : 'stand');
  if (L === 'stand') { fill(g,10,10,1,2); fill(g,10,10,4,5); fill(g,10,10,7,8); fill(g,10,10,10,11); }
  if (L === 'stub')  { fill(g,11,11,1,2); fill(g,11,11,4,5); fill(g,11,11,7,8); fill(g,11,11,10,11); }
  if (L === 'a')     { fill(g,10,10,1,2); fill(g,10,10,7,8); fill(g,11,11,4,5); fill(g,11,11,10,11); }
  if (L === 'b')     { fill(g,10,10,4,5); fill(g,10,10,10,11); fill(g,11,11,1,2); fill(g,11,11,7,8); }
  if (L === 'tuck')  { fill(g,10,10,4,5); fill(g,10,10,7,8); }
  return g;
}

function art(g, tex) {
  var out = [], cr, c, t, b, s;
  for (cr = 0; cr < ROWS; cr++) {
    s = '';
    for (c = 0; c < W; c++) {
      t = g[cr * 2][c]; b = g[cr * 2 + 1][c];
      s += tex ? ((t || b) ? tex : ' ') : (t && b ? '█' : t ? '▀' : b ? '▄' : ' ');
    }
    out.push(s);
  }
  return out;
}

function F(p, x) { x = x || {}; return { art: art(pose(p), x.tex), dx: x.dx || 0, dy: x.dy || 0, fx: x.fx || [] }; }
function fx(x, y, t, c) { return { x: x, y: y, t: t, c: c || 'd' }; }
var EMPTY = { art: (function () { var a = [], i; for (i = 0; i < ROWS; i++) a.push('             '); return a; })(), dx: 0, dy: 0, fx: [] };

/* ---------- the movement set ---------- */
var ANIMATIONS = {
  idle:      { fps: 1.6, tag: 'core', desc: 'slow breathing — the default', frames: [F({}), F({ squash: 1 })] },
  blink:     { fps: 6, tag: 'core', desc: 'every few seconds', frames: [F({}), F({}), F({}), F({}), F({ eyes: 'shut' })] },
  look:      { fps: 2, tag: 'core', desc: 'checks both sides', frames: [F({}), F({ eyes: 'left' }), F({ eyes: 'left' }), F({}), F({ eyes: 'right' }), F({ eyes: 'right' })] },
  walk:      { fps: 4, tag: 'core', step: 1, desc: 'trot; player slides him sideways', frames: [F({ legs: 'a' }), F({ legs: 'b' })] },
  hop:       { fps: 8, tag: 'core', once: 1, desc: 'crouch, air, land', frames: [F({ squash: 1 }), F({ legs: 'tuck' }, { dy: -1 }), F({ legs: 'tuck', eyes: 'happy' }, { dy: -2 }), F({ legs: 'tuck' }, { dy: -1 }), F({ squash: 1 }), F({})] },
  stretch:   { fps: 2.5, tag: 'core', once: 1, desc: 'full-height morning stretch', frames: [F({ squash: 1, eyes: 'shut' }), F({}), F({ tall: 1, ears: 'perk' }), F({ tall: 1, ears: 'perk', eyes: 'shut' }), F({})] },
  wave:      { fps: 3, tag: 'core', desc: 'ear semaphore hello', frames: [F({ ears: 'waveA', eyes: 'happy' }), F({ ears: 'waveB', eyes: 'happy' })] },
  turn:      { fps: 2.5, tag: 'core', once: 1, desc: 'checks behind himself', frames: [F({ eyes: 'right' }), F({ eyes: 'none' }), F({ eyes: 'none' }), F({ eyes: 'left' }), F({})] },
  dance:     { fps: 4, tag: 'core', desc: 'side-step with music', frames: [
    F({ legs: 'a', ears: 'perk' }, { dx: -1, fx: [fx(14, 1, '♪')] }),
    F({ legs: 'b' }, { dx: 1, fx: [fx(15, 0, '♪')] }),
    F({ legs: 'a' }, { dx: 1, fx: [fx(-2, 1, '♪')] }),
    F({ legs: 'b', ears: 'perk' }, { dx: -1, fx: [fx(-3, 0, '♪')] })] },
  think:     { fps: 2, tag: 'react', desc: 'eyes up, dots build', frames: [
    F({ eyes: 'up' }, { fx: [fx(14, 0, '·')] }),
    F({ eyes: 'up' }, { fx: [fx(14, 0, '··')] }),
    F({ eyes: 'up' }, { fx: [fx(14, 0, '···')] })] },
  happy:     { fps: 5, tag: 'react', once: 1, desc: 'small pop + !', frames: [
    F({ squash: 1, eyes: 'happy' }),
    F({ eyes: 'happy', legs: 'tuck' }, { dy: -1, fx: [fx(6, -1, '!', 'a')] }),
    F({ eyes: 'happy' }, { fx: [fx(6, -1, '!', 'a')] })] },
  love:      { fps: 2.5, tag: 'react', desc: 'hearts drift up', frames: [
    F({ eyes: 'happy' }, { fx: [fx(13, 1, '♥', 'a')] }),
    F({ eyes: 'happy' }, { fx: [fx(14, 0, '♥', 'a')] }),
    F({ eyes: 'happy' }, { fx: [fx(15, -1, '♥', 'a'), fx(13, 1, '♥', 'a')] })] },
  celebrate: { fps: 5, tag: 'react', desc: 'sparkle jump', frames: [
    F({ legs: 'tuck', eyes: 'happy' }, { dy: -1, fx: [fx(-2, 0, '✦', 'a'), fx(14, 2, '✧', 'a')] }),
    F({ eyes: 'happy' }, { fx: [fx(-1, -1, '✧', 'a'), fx(15, 0, '✦', 'a')] }),
    F({ legs: 'tuck', eyes: 'happy' }, { dy: -1, fx: [fx(-3, 2, '✧', 'a'), fx(16, -1, '✦', 'a')] }),
    F({ eyes: 'happy' }, { fx: [fx(-1, 1, '✦', 'a'), fx(14, 0, '✧', 'a')] })] },
  eat:       { fps: 3, tag: 'react', once: 1, desc: 'snack in, chomp, done', frames: [
    F({ eyes: 'right' }, { fx: [fx(15, 3, '●', 'a')] }),
    F({ eyes: 'right', mouth: 'open' }, { fx: [fx(14, 3, '●', 'a')] }),
    F({ mouth: 'big' }, { fx: [fx(6, 4, '●', 'a')] }),
    F({ squash: 1, eyes: 'shut' }),
    F({ eyes: 'happy' }, { fx: [fx(13, 1, '♪')] })] },
  sad:       { fps: 1.5, tag: 'react', desc: 'ears drop, eyes down', frames: [
    F({ ears: 'droop', eyes: 'down' }),
    F({ ears: 'droop', eyes: 'down', squash: 1 }, { fx: [fx(11, 2, '◦')] })] },
  error:     { fps: 8, tag: 'react', once: 1, desc: 'shake + !', frames: [
    F({ eyes: 'shut' }, { dx: -1, fx: [fx(14, 0, '!', 'a')] }),
    F({ eyes: 'shut' }, { dx: 1, fx: [fx(14, 0, '!', 'a')] }),
    F({}, { dx: -1, fx: [fx(14, 0, '!', 'a')] }),
    F({}, { dx: 1, fx: [fx(14, 0, '!', 'a')] }),
    F({ eyes: 'down' })] },
  sleep:     { fps: 1.2, tag: 'system', desc: 'squashed, z drift — night + idle', frames: [
    F({ squash: 1, eyes: 'shut' }, { fx: [fx(13, 1, 'z')] }),
    F({ squash: 1, eyes: 'shut' }, { fx: [fx(14, 0, 'z')] }),
    F({ squash: 1, eyes: 'shut' }, { fx: [fx(15, -1, 'Z'), fx(13, 1, 'z')] })] },
  poof:      { fps: 5, tag: 'system', once: 1, desc: 'materialise on session start', frames: [
    F({}, { tex: '░' }), F({}, { tex: '▒' }), F({}, { tex: '▓' }),
    F({}, { fx: [fx(0, -1, '✦', 'a'), fx(12, -1, '✦', 'a')] })] },
  vanish:    { fps: 5, tag: 'system', once: 1, desc: 'dissolve on session end', frames: [
    F({}), F({}, { tex: '▓' }), F({}, { tex: '▒' }), F({}, { tex: '░' }), EMPTY] }
};

/* Claude Code event -> movement queue */
var EVENTS = {
  start: ['poof', 'wave'], think: ['think'], tool: ['walk'], work: ['walk'],
  done: ['celebrate', 'happy'], error: ['error', 'sad'], pet: ['love'],
  snack: ['eat'], sleep: ['sleep'], bye: ['vanish']
};
var AMBIENT = ['idle', 'idle', 'blink', 'idle', 'look', 'walk', 'idle', 'stretch', 'blink', 'turn', 'idle', 'dance'];

/* ---------- compositor: sprite + fx + name tag onto a w x h char canvas ---------- */
function compose(frame, o) {
  o = o || {};
  var w = o.w || 21, h = o.h || 9;
  var tag = o.name === undefined ? 'NIKO' : o.name;
  var ground = o.ground === undefined ? h - 2 : o.ground;
  var ox = (o.ox === undefined ? Math.floor((w - W) / 2) : o.ox) + frame.dx;
  var oy = ground - (ROWS - 1) + frame.dy;
  var grid = [], r, c;
  for (r = 0; r < h; r++) { var row = []; for (c = 0; c < w; c++) row.push(null); grid.push(row); }
  function set(r2, c2, ch, k) { if (r2 >= 0 && r2 < h && c2 >= 0 && c2 < w && ch !== ' ') grid[r2][c2] = { ch: ch, k: k }; }
  frame.art.forEach(function (line, ri) { for (var ci = 0; ci < line.length; ci++) set(oy + ri, ox + ci, line[ci], 'b'); });
  frame.fx.forEach(function (f) { var s = String(f.t); for (var i = 0; i < s.length; i++) set(oy + f.y, ox + f.x + i, s[i], f.c === 'a' ? 'a' : 'd'); });
  if (tag) { var lx = ox + Math.floor((W - tag.length) / 2); for (var i2 = 0; i2 < tag.length; i2++) set(ground + 1, lx + i2, tag[i2], 'd'); }
  return grid;
}

/* ---------- serializers ---------- */
var TC   = { b: [217, 119, 87], a: [236, 48, 19], d: [138, 133, 128] };
var C256 = { b: 173, a: 196, d: 245 };

function toText(grid, trim) {
  return grid.map(function (row) {
    var s = row.map(function (c) { return c ? c.ch : ' '; }).join('');
    return trim ? s.replace(/\s+$/, '') : s;
  }).join('\n');
}
function toANSI(grid, mode) {
  var out = '';
  grid.forEach(function (row) {
    var cur = null;
    row.forEach(function (cell) {
      if (!cell) { out += ' '; return; }
      if (mode !== 'mono' && cell.k !== cur) {
        cur = cell.k;
        out += mode === '256' ? '\x1b[38;5;' + C256[cur] + 'm' : '\x1b[38;2;' + TC[cur].join(';') + 'm';
      }
      out += cell.ch;
    });
    out += (mode !== 'mono' ? '\x1b[0m' : '') + '\n';
  });
  return out;
}
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function toHTML(grid, colors) {
  colors = colors || { b: '#d97757', a: '#ec3013', d: '#8a8580' };
  return grid.map(function (row) {
    var html = '', cur = null, buf = '';
    function flush() { if (!buf) return; html += cur ? '<span style="color:' + colors[cur] + '">' + esc(buf) + '</span>' : esc(buf); buf = ''; }
    row.forEach(function (cell) { var k = cell ? cell.k : null; if (k !== cur) { flush(); cur = k; } buf += cell ? cell.ch : ' '; });
    flush(); return html;
  }).join('\n');
}

var NikoPet = { W: W, ROWS: ROWS, ANIMATIONS: ANIMATIONS, EVENTS: EVENTS, AMBIENT: AMBIENT,
  compose: compose, toText: toText, toANSI: toANSI, toHTML: toHTML, colors: { tc: TC, c256: C256 } };
root.NikoPet = NikoPet;
if (typeof module !== 'undefined' && module.exports) module.exports = NikoPet;

/* ---------- CLI player (Node only) ---------- */
function cli() {
  var fs = require('fs'), os = require('os'), path = require('path');
  var argv = process.argv.slice(2), flags = {}, names = [];
  argv.forEach(function (a) {
    if (a.slice(0, 2) === '--') { var m = a.slice(2).split('='); flags[m[0]] = m[1] === undefined ? true : m[1]; }
    else names.push(a);
  });
  var mode = (flags.mono || process.env.NO_COLOR) ? 'mono' : flags['256'] ? '256' : 'tc';
  var tag = flags['no-tag'] ? '' : 'NIKO';
  var cols = process.stdout.columns || 40;
  var w = Math.max(21, Math.min(parseInt(flags.w || '30', 10) || 30, cols - 1));
  var h = 10, ground = 8;
  var speed = parseFloat(flags.speed || '1') || 1;
  var out = function (s) { process.stdout.write(s); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  if (flags.list) {
    Object.keys(ANIMATIONS).forEach(function (n) {
      var a = ANIMATIONS[n];
      console.log(n.padEnd(10) + (a.frames.length + 'f @ ' + a.fps + 'fps').padEnd(12) + (a.once ? 'one-shot  ' : 'loop      ') + a.desc);
    });
    return;
  }
  if (flags.text) {
    var ta = ANIMATIONS[flags.text];
    if (!ta) { console.log('no such move — try --list'); return; }
    ta.frames.forEach(function (f, i) {
      console.log('frame ' + (i + 1) + '/' + ta.frames.length);
      console.log(toText(compose(f, { w: 21, h: 9, name: tag }), true) + '\n');
    });
    return;
  }

  process.on('SIGINT', function () { out('\x1b[0m\x1b[?25h\n'); process.exit(0); });
  out('\x1b[?25l');
  var first = true;

  function playAnim(name, cycles) {
    var a = ANIMATIONS[name];
    if (!a) return Promise.resolve();
    var n = a.frames.length * (cycles || (a.once ? 1 : 2));
    var i = 0;
    function stepFrame() {
      if (i >= n) return Promise.resolve();
      var grid = compose(a.frames[i % a.frames.length], { w: w, h: h, ground: ground, name: tag });
      var label = ('▸ ' + name).padEnd(w);
      if (!first) out('\x1b[' + (h + 1) + 'F');
      first = false;
      out((mode === 'mono' ? label : '\x1b[38;5;245m' + label + '\x1b[0m') + '\n' + toANSI(grid, mode));
      i++;
      return sleep(1000 / (a.fps * speed)).then(stepFrame);
    }
    return stepFrame();
  }

  function playList(list) {
    var p = Promise.resolve();
    list.forEach(function (n) { p = p.then(function () { return playAnim(n); }); });
    return p.then(function () { out('\x1b[?25h\x1b[0m'); });
  }

  if (flags.pet) {
    var file = typeof flags.file === 'string' ? flags.file : path.join(os.tmpdir(), 'niko-event');
    try { if (!fs.existsSync(file)) fs.writeFileSync(file, ''); } catch (e) {}
    var pending = [], lastEv = Date.now();
    try {
      fs.watchFile(file, { interval: 250 }, function () {
        try {
          var ev = fs.readFileSync(file, 'utf8').trim().split(/\s+/).pop();
          if (EVENTS[ev]) { pending.push.apply(pending, EVENTS[ev]); lastEv = Date.now(); }
        } catch (e) {}
      });
    } catch (e) {}
    var amb = 0, queue = EVENTS.start.slice();
    (function loop() {
      var name;
      if (pending.length) queue = pending.splice(0);
      if (queue.length) name = queue.shift();
      else {
        var hr = new Date().getHours();
        name = (hr >= 22 || hr < 7 || Date.now() - lastEv > 180000) ? 'sleep' : AMBIENT[amb++ % AMBIENT.length];
      }
      playAnim(name).then(loop);
    })();
    return;
  }

  var seq = names.length ? names.filter(function (n) { return ANIMATIONS[n]; }) : Object.keys(ANIMATIONS);
  if (names.length && !seq.length) { out('\x1b[?25h'); console.log('no such move — try --list'); return; }
  playList(seq);
}

if (typeof process !== 'undefined' && typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) cli();

})(typeof globalThis !== 'undefined' ? globalThis : this);

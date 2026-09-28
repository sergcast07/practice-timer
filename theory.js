// Allegrow – music theory games (shared by the family app and the studio)
//
// Decks of questions, each with levels. A round is 10 questions; 8 or more right "passes" it, and passing
// PASSES_TO_LEVEL rounds at a level unlocks the next one. Teachers can set a student's level, the clef,
// which decks are on, and a goal (student.theoryPlan). Results travel with the practice data (practice.theory).
//
// Modes: 'cards' – tap the answer · 'play' – play the note shown on your instrument (microphone) ·
//        'echo' – hear a note, play or sing it back (microphone). Sound is analyzed on the device, never recorded.

const THEORY_ROUND = 10, THEORY_PASS = 8, PASSES_TO_LEVEL = 2;
const THEORY_DECKS = {
  notes:   { name: 'Note names', about: 'Read notes on the staff', modes: ['cards', 'play'],
             levels: ['Lines', 'Spaces', 'The whole staff', 'Just above and below', 'Ledger lines', 'Sharps and flats', 'Everything'] },
  rhythm:  { name: 'Rhythm', about: 'Notes, rests and how long they last', modes: ['cards'],
             levels: ['Whole, half and quarter notes', 'Eighth and sixteenth notes', 'Rests', 'Dotted notes', 'Everything'] },
  symbols: { name: 'Symbols & terms', about: 'Dynamics, tempo and signs', modes: ['cards'],
             levels: ['Dynamics', 'Tempo words', 'Signs', 'Italian terms'] },
  keys:    { name: 'Key signatures', about: 'Name the major key', modes: ['cards'],
             levels: ['C, G and F', 'Up to 2 sharps or flats', 'Up to 3', 'Up to 4', 'Up to 6'] },
  echo:    { name: 'Echo', about: 'Hear a note, play or sing it back', modes: ['echo'],
             levels: ['C to G', 'The C major scale', 'All 12 notes'] }
};
const THEORY_ORDER = ['notes', 'rhythm', 'symbols', 'keys', 'echo'];
const THEORY_MODES = { cards: 'Flash cards', play: 'Play it', echo: 'Echo' };
const theoryStars = (right, total = THEORY_ROUND) => right >= total ? 3 : right >= total - 1 ? 2 : right >= THEORY_PASS * total / THEORY_ROUND ? 1 : 0;
const theoryLevelName = (deck, level) => THEORY_DECKS[deck]?.levels[Math.max(1, level) - 1] || '';

// ---------- Notes and clefs ----------
// A staff position is a count of letter steps from middle C (C4 = 0, D4 = 1, B3 = -1 …)
const LETTERS = 'CDEFGAB', LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const CLEFS = { treble: { name: 'Treble', bottom: 2 }, bass: { name: 'Bass', bottom: -10 }, alto: { name: 'Alto', bottom: -4 } };
const mod = (n, m) => ((n % m) + m) % m;
const posLetter = p => LETTERS[mod(p, 7)];
const posOctave = p => 4 + Math.floor(p / 7);
const ACC = { '': 0, '♯': 1, '♭': -1 };
const noteName = (p, acc = '') => posLetter(p) + acc;
const notePc = (p, acc = '') => mod(LETTER_PC[mod(p, 7)] + ACC[acc], 12);
const PC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
// The clef an instrument reads (the teacher can choose another). Piano players can practice both ("mixed").
const defaultClef = instrument => ({ cello: 'bass', viola: 'alto' })[instrument] || 'treble';
// Transposing instruments: the written note sounds this many half steps away (only the letter matters, not the octave)
const TRANSPOSE = { clarinet: -2, trumpet: -2, saxophone: -9 };
// A comfortable octave for Echo notes (MIDI number of the C it starts from)
const echoBase = instrument => ['cello', 'guitar'].includes(instrument) ? 48 : 60;

function noteRange(level, bottom) {
  const b = bottom, r = (a, z) => Array.from({ length: z - a + 1 }, (_, i) => a + i);
  return [[b, b + 2, b + 4, b + 6, b + 8], [b + 1, b + 3, b + 5, b + 7], r(b, b + 8), r(b - 1, b + 9), r(b - 3, b + 11), r(b, b + 8), r(b - 3, b + 11)][level - 1] || r(b, b + 8);
}

// ---------- The staff (SVG). Clefs and symbols use the Noto Music font. ----------
function theoryStaff({ clef = 'treble', notes = [], key = null, width = 240 } = {}) {
  const b = CLEFS[clef].bottom, y = p => 90 - (p - b) * 6, x0 = 18;
  const lines = [0, 2, 4, 6, 8].map(i => `<line x1="${x0}" x2="${width - 8}" y1="${y(b + i)}" y2="${y(b + i)}"/>`).join('');
  // Noto Music is drawn to the staff: the baseline is the bottom line and the font size is the height of the staff (4 spaces)
  const SP = 12, ACC_Y = { '♯': 0.52, '♭': 0.45, '♮': 0.53 }, accY = (a, cy) => cy + ACC_Y[a] * SP;
  let out = `<text x="${x0 + 4}" y="${y(b)}" font-size="${4 * SP}">${{ treble: '𝄞', bass: '𝄢', alto: '𝄡' }[clef]}</text>`;
  let x = x0 + 46;
  if (key) {                                                        // key signature: sharps or flats in their standard places
    const shift = { treble: 0, bass: -14, alto: -7 }[clef];
    const SH = [10, 7, 11, 8, 5, 9, 6], FL = [6, 9, 5, 8, 4, 7, 3];
    (key.sharps ? SH.slice(0, key.sharps) : FL.slice(0, key.flats || 0)).forEach(p => {
      const a = key.sharps ? '♯' : '♭';
      out += `<text class="acc" x="${x}" y="${accY(a, y(p + shift))}" font-size="${4 * SP}">${a}</text>`; x += 14;
    });
    x += 10;
  }
  notes.forEach((n, i) => {
    const cx = x + 24 + i * 44, cy = y(n.p);
    for (let l = b - 2; l >= n.p; l -= 2) out += `<line class="ledger" x1="${cx - 13}" x2="${cx + 13}" y1="${y(l)}" y2="${y(l)}"/>`;
    for (let l = b + 10; l <= n.p; l += 2) out += `<line class="ledger" x1="${cx - 13}" x2="${cx + 13}" y1="${y(l)}" y2="${y(l)}"/>`;
    if (n.acc) out += `<text class="acc" x="${cx - 27}" y="${accY(n.acc, cy)}" font-size="${4 * SP}">${n.acc}</text>`;
    const up = n.p < b + 4;                                         // stems go up below the middle line
    out += `<ellipse class="head" cx="${cx}" cy="${cy}" rx="7.6" ry="5.6" transform="rotate(-20 ${cx} ${cy})"/>`;
    out += up ? `<line class="stem" x1="${cx + 6.8}" x2="${cx + 6.8}" y1="${cy - 1}" y2="${cy - 38}"/>` : `<line class="stem" x1="${cx - 6.8}" x2="${cx - 6.8}" y1="${cy + 1}" y2="${cy + 38}"/>`;
  });
  return `<svg class="staff" viewBox="0 0 ${width} 150" role="img" aria-label="A note on the ${CLEFS[clef].name.toLowerCase()} staff"><g class="lines">${lines}</g>${out}</svg>`;
}

// ---------- Question banks ----------
const RHYTHM = [
  { id: 'whole', glyph: '𝅝', name: 'Whole note', beats: '4' }, { id: 'half', glyph: '𝅗𝅥', name: 'Half note', beats: '2' },
  { id: 'quarter', glyph: '𝅘𝅥', name: 'Quarter note', beats: '1' }, { id: 'eighth', glyph: '𝅘𝅥𝅮', name: 'Eighth note', beats: '½' },
  { id: 'sixteenth', glyph: '𝅘𝅥𝅯', name: 'Sixteenth note', beats: '¼' },
  { id: 'r-whole', glyph: '𝄻', name: 'Whole rest', beats: '4' }, { id: 'r-half', glyph: '𝄼', name: 'Half rest', beats: '2' },
  { id: 'r-quarter', glyph: '𝄽', name: 'Quarter rest', beats: '1' }, { id: 'r-eighth', glyph: '𝄾', name: 'Eighth rest', beats: '½' },
  { id: 'd-half', glyph: '𝅗𝅥', dot: true, name: 'Dotted half note', beats: '3' }, { id: 'd-quarter', glyph: '𝅘𝅥', dot: true, name: 'Dotted quarter note', beats: '1½' },
  { id: 'd-eighth', glyph: '𝅘𝅥𝅮', dot: true, name: 'Dotted eighth note', beats: '¾' }
];
const RHYTHM_LEVELS = [['whole', 'half', 'quarter'], ['whole', 'half', 'quarter', 'eighth', 'sixteenth'], ['r-whole', 'r-half', 'r-quarter', 'r-eighth', 'quarter', 'half'],
  ['d-half', 'd-quarter', 'd-eighth', 'half', 'quarter'], RHYTHM.map(r => r.id)];
const SYMBOLS = [
  [ { id: 'pp', show: 'pp', dyn: 1, mean: 'Very soft' }, { id: 'p', show: 'p', dyn: 1, mean: 'Soft' }, { id: 'mp', show: 'mp', dyn: 1, mean: 'Medium soft' },
    { id: 'mf', show: 'mf', dyn: 1, mean: 'Medium loud' }, { id: 'f', show: 'f', dyn: 1, mean: 'Loud' }, { id: 'ff', show: 'ff', dyn: 1, mean: 'Very loud' } ],
  [ { id: 'largo', show: 'Largo', mean: 'Very slow and broad' }, { id: 'adagio', show: 'Adagio', mean: 'Slow' }, { id: 'andante', show: 'Andante', mean: 'At a walking pace' },
    { id: 'moderato', show: 'Moderato', mean: 'At a moderate speed' }, { id: 'allegro', show: 'Allegro', mean: 'Fast and lively' }, { id: 'presto', show: 'Presto', mean: 'Very fast' } ],
  [ { id: 'sharp', show: '♯', glyph: 1, mean: 'Raises a note a half step' }, { id: 'flat', show: '♭', glyph: 1, mean: 'Lowers a note a half step' },
    { id: 'natural', show: '♮', glyph: 1, mean: 'Cancels a sharp or flat' }, { id: 'fermata', show: '𝄐', glyph: 1, mean: 'Hold the note longer' },
    { id: 'repeat', show: '𝄇', glyph: 1, mean: 'Repeat the music' }, { id: 'cresc', show: '𝆒', glyph: 1, mean: 'Gradually louder' },
    { id: 'decresc', show: '𝆓', glyph: 1, mean: 'Gradually softer' } ],
  [ { id: 'legato', show: 'legato', mean: 'Smooth and connected' }, { id: 'staccato', show: 'staccato', mean: 'Short and detached' },
    { id: 'crescendo', show: 'crescendo', mean: 'Gradually louder' }, { id: 'diminuendo', show: 'diminuendo', mean: 'Gradually softer' },
    { id: 'ritardando', show: 'ritardando', mean: 'Gradually slower' }, { id: 'atempo', show: 'a tempo', mean: 'Back to the original speed' },
    { id: 'dolce', show: 'dolce', mean: 'Sweetly' }, { id: 'dcalfine', show: 'D.C. al Fine', mean: 'Go back to the start and end at Fine' } ]
];
const KEYS = [ { id: 'C', name: 'C major', sharps: 0 }, { id: 'G', name: 'G major', sharps: 1 }, { id: 'F', name: 'F major', flats: 1 },
  { id: 'D', name: 'D major', sharps: 2 }, { id: 'Bb', name: 'B♭ major', flats: 2 }, { id: 'A', name: 'A major', sharps: 3 }, { id: 'Eb', name: 'E♭ major', flats: 3 },
  { id: 'E', name: 'E major', sharps: 4 }, { id: 'Ab', name: 'A♭ major', flats: 4 }, { id: 'B', name: 'B major', sharps: 5 }, { id: 'Db', name: 'D♭ major', flats: 5 },
  { id: 'Fs', name: 'F♯ major', sharps: 6 }, { id: 'Gb', name: 'G♭ major', flats: 6 } ];
const KEY_LEVELS = [3, 5, 7, 9, 13];

const pick = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const choicesFrom = (answer, pool, n = 4) => shuffle([answer, ...shuffle([...new Set(pool)].filter(x => x !== answer)).slice(0, n - 1)]);

// One question. Returns { id (for "trouble spots"), prompt: { staff | glyph | text | dyn }, ask, choices, answer, pc (for play/echo) }
function theoryQuestion(deck, level, { clef = 'treble', instrument = '', mode = 'cards', last = null } = {}) {
  for (let tries = 0; tries < 8; tries++) {                         // avoid asking the same thing twice in a row
    const q = makeQuestion(deck, level, { clef, instrument, mode });
    if (q.id !== last) return q;
  }
  return makeQuestion(deck, level, { clef, instrument, mode });
}
function makeQuestion(deck, level, { clef, instrument, mode }) {
  if (deck === 'notes') {
    const c = clef === 'mixed' ? pick(['treble', 'bass']) : clef, p = pick(noteRange(level, CLEFS[c].bottom));
    const acc = level >= 6 && Math.random() < 0.6 ? pick(['♯', '♭']) : '';
    const name = noteName(p, acc), q = { id: `${c}:${p}${acc}`, prompt: { staff: theoryStaff({ clef: c, notes: [{ p, acc }] }) }, answer: name, pc: notePc(p, acc) };
    if (mode === 'play') return { ...q, ask: 'Play this note' };
    const letters = LETTERS.split('');
    return { ...q, ask: 'What note is this?', choices: acc ? choicesFrom(name, [posLetter(p), posLetter(p) + (acc === '♯' ? '♭' : '♯'), posLetter(p + 1) + acc, posLetter(p - 1) + acc, posLetter(p + 1), posLetter(p - 1)]) : letters, grid: !acc };
  }
  if (deck === 'rhythm') {
    const ids = RHYTHM_LEVELS[level - 1] || RHYTHM_LEVELS.at(-1), want = pick(ids), it = RHYTHM.find(r => r.id === want), pool = RHYTHM.filter(r => ids.includes(r.id));
    const beats = level >= 2 && Math.random() < 0.45;
    return { id: `rhythm:${it.id}${beats ? ':beats' : ''}`, prompt: { glyph: it.glyph, dot: it.dot }, ask: beats ? 'How many beats does it last? (in 4/4)' : 'What is this called?',
             answer: beats ? it.beats : it.name, choices: beats ? choicesFrom(it.beats, ['4', '3', '2', '1½', '1', '¾', '½', '¼']) : choicesFrom(it.name, pool.map(r => r.name).concat(RHYTHM.map(r => r.name))) };
  }
  if (deck === 'symbols') {
    const set = SYMBOLS[Math.min(level, SYMBOLS.length) - 1], it = pick(set);
    return { id: `symbols:${it.id}`, prompt: it.dyn ? { dyn: it.show } : it.glyph ? { glyph: it.show } : { text: it.show }, ask: 'What does it mean?',
             answer: it.mean, choices: choicesFrom(it.mean, set.map(s => s.mean)) };
  }
  if (deck === 'keys') {
    const pool = KEYS.slice(0, KEY_LEVELS[level - 1] || KEYS.length), it = pick(pool), c = clef === 'mixed' ? 'treble' : clef;
    return { id: `keys:${it.id}`, prompt: { staff: theoryStaff({ clef: c, key: it, width: 220 }) }, ask: 'Which major key is this?', answer: it.name, choices: choicesFrom(it.name, pool.map(k => k.name)) };
  }
  if (deck === 'echo') {
    const pcs = [[0, 2, 4, 5, 7], [0, 2, 4, 5, 7, 9, 11], Array.from({ length: 12 }, (_, i) => i)][level - 1] || [0, 2, 4, 5, 7];
    const pc = pick(pcs);
    return { id: `echo:${pc}`, prompt: { listen: true }, ask: 'Listen, then play or sing it back', answer: PC_NAMES[pc], pc, midi: echoBase(instrument) + pc };
  }
}

// Plain-language name for a question, for teachers' "trouble spots" (e.g. "F♯ · treble staff", "Dotted quarter note (beats)")
function theoryItemLabel(id) {
  const [a, b, c] = id.split(':');
  if (CLEFS[a]) { const m = b.match(/^(-?\d+)(.*)$/), p = +m[1]; return `${noteName(p, m[2])}${posOctave(p)} · ${a} staff`; }
  if (a === 'rhythm') { const r = RHYTHM.find(x => x.id === b); return r ? r.name + (c ? ' (beats)' : '') : id; }
  if (a === 'symbols') { const s = SYMBOLS.flat().find(x => x.id === b); return s ? `${s.show} – ${s.mean.toLowerCase()}` : id; }
  if (a === 'keys') return KEYS.find(k => k.id === b)?.name || id;
  if (a === 'echo') return `${PC_NAMES[+b]} by ear`;
  return id;
}

// ---------- A student's progress ----------
// state: { levels: {deck: n}, passes: {deck: n at this level}, setAt: {deck: when the teacher last set it}, rounds: [...], ups: [...] }
function theoryLevel(state, deck) { return Math.min(Math.max(state?.levels?.[deck] || 1, 1), THEORY_DECKS[deck].levels.length); }
// Apply the teacher's plan: a level the teacher set more recently than the last time it was applied wins
function applyTheoryPlan(state, plan) {
  let changed = false;
  for (const [deck, v] of Object.entries(plan?.levels || {})) {
    if (!THEORY_DECKS[deck] || !v?.at || (state.setAt?.[deck] || '') >= v.at) continue;
    state.levels = { ...state.levels, [deck]: Math.min(Math.max(+v.level || 1, 1), THEORY_DECKS[deck].levels.length) };
    state.passes = { ...state.passes, [deck]: 0 };
    state.setAt = { ...state.setAt, [deck]: v.at };
    changed = true;
  }
  return changed;
}
// Record a finished round; returns { passed, levelUp, level }
function recordTheoryRound(state, { deck, mode, right, total, ms, miss }) {
  const level = theoryLevel(state, deck), passed = right >= THEORY_PASS * total / THEORY_ROUND;
  state.rounds = [...(state.rounds || []), { at: new Date().toISOString(), deck, mode, level, right, total, ms: Math.round(ms), miss: miss.slice(0, 10) }].slice(-300);
  let levelUp = false;
  if (passed) {
    const n = (state.passes?.[deck] || 0) + 1;
    if (n >= PASSES_TO_LEVEL && level < THEORY_DECKS[deck].levels.length) {
      state.levels = { ...state.levels, [deck]: level + 1 }; state.passes = { ...state.passes, [deck]: 0 };
      state.ups = [...(state.ups || []), { at: new Date().toISOString(), deck, level: level + 1 }].slice(-100);
      levelUp = true;
    } else state.passes = { ...state.passes, [deck]: Math.min(n, PASSES_TO_LEVEL) };
  }
  return { passed, levelUp, level: theoryLevel(state, deck) };
}

// ---------- Hearing a note (Play it / Echo) ----------
// Listens to the microphone and calls onNote(pitchClass, cents, hz) once a note has been held steadily for ~0.25 s.
// pitchOf(samples, sampleRate) finds the pitch (the family app's YIN detector).
async function theoryListen(onNote, { pitchOf, minF = 55, onLevel } = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
  an.fftSize = 4096; src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let lastPc = null, since = 0, paused = false, done = false;
  const timer = setInterval(() => {
    if (paused || done) return;
    an.getFloatTimeDomainData(buf);
    let rms = 0; for (const v of buf) rms += v * v; rms = Math.sqrt(rms / buf.length);
    onLevel?.(rms);
    const f = rms > 0.01 ? pitchOf(buf, ctx.sampleRate, minF) : null;
    if (!f || f < minF || f > 2200) { lastPc = null; return; }
    const midi = 69 + 12 * Math.log2(f / 440), pc = mod(Math.round(midi), 12), cents = Math.round((midi - Math.round(midi)) * 100);
    const now = performance.now();
    if (pc !== lastPc) { lastPc = pc; since = now; return; }
    if (now - since >= 250) { lastPc = null; onNote(pc, cents, f); }
  }, 50);
  return {
    ctx,
    pause() { paused = true; lastPc = null; }, resume() { paused = false; lastPc = null; },
    stop() { done = true; clearInterval(timer); stream.getTracks().forEach(t => t.stop()); ctx.close(); }
  };
}
// A short, clear reference tone for Echo (MIDI note number)
function theoryTone(ctx, midi, seconds = 1.1) {
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'triangle'; o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.03); g.gain.setValueAtTime(0.5, t + seconds - 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + seconds + 0.05);
  return new Promise(r => setTimeout(r, seconds * 1000 + 120));
}

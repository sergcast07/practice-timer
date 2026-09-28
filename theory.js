// Allegrow – music theory games (shared by the family app and the studio)
//
// Built-in decks have levels: a round is 10 questions, 8 right passes it, and PASSES_TO_LEVEL passed rounds unlock
// the next level. Teachers can also build their own sets (student.theoryPlan.sets): the kind of question, clefs
// (treble, bass, alto, tenor, grand staff), exact notes picked on a staff or a range, accidentals, naming the octave,
// interval sizes and qualities, chord types and inversions, keys, cards per round, a time limit and the pass mark.
// Results travel with the practice data (practice.theory).
//
// Modes: cards – tap the answer · place – tap where the note goes on the staff · play – play it (microphone) ·
//        echo – hear a note, play or sing it back (microphone). Sound is analyzed on the device, never recorded.

const THEORY_ROUND = 10, THEORY_PASS = 8, PASSES_TO_LEVEL = 2;
const THEORY_DECKS = {
  notes:     { name: 'Note names', about: 'Read notes on the staff', modes: ['cards', 'place', 'play'],
               levels: ['Lines', 'Spaces', 'The whole staff', 'Just above and below', 'Ledger lines', 'Sharps and flats', 'Everything', 'Grand staff', 'Grand staff with sharps and flats'] },
  rhythm:    { name: 'Rhythm', about: 'Notes, rests and how long they last', modes: ['cards'],
               levels: ['Whole, half and quarter notes', 'Eighth and sixteenth notes', 'Rests', 'Dotted notes', 'Everything'] },
  symbols:   { name: 'Symbols & terms', about: 'Dynamics, tempo and signs', modes: ['cards'],
               levels: ['Dynamics', 'Tempo words', 'Signs', 'Italian terms'] },
  keys:      { name: 'Key signatures', about: 'Name the key', modes: ['cards'],
               levels: ['C, G and F', 'Up to 2 sharps or flats', 'Up to 3', 'Up to 4', 'Up to 6', 'Minor keys', 'Major and minor, up to 7'] },
  intervals: { name: 'Intervals', about: 'How far apart two notes are', modes: ['cards'],
               levels: ['2nds and 3rds', '2nds to 5ths', 'Up to an octave', 'Major, minor and perfect', 'Every quality, with sharps and flats'] },
  chords:    { name: 'Chords', about: 'Name the triad', modes: ['cards'],
               levels: ['Major and minor', 'Diminished and augmented too', 'Inversions', 'Sharp and flat roots'] },
  echo:      { name: 'Echo', about: 'Hear a note, play or sing it back', modes: ['echo'],
               levels: ['C to G', 'The C major scale', 'All 12 notes'] }
};
const THEORY_ORDER = ['notes', 'rhythm', 'symbols', 'keys', 'intervals', 'chords', 'echo'];
const THEORY_MODES = { cards: 'Flash cards', place: 'Find it on the staff', play: 'Play it', echo: 'Echo' };
// What a teacher's own set can ask
const SET_KINDS = { name: { label: 'Name the note', mode: 'cards' }, place: { label: 'Find it on the staff', mode: 'place' }, play: { label: 'Play the note', mode: 'play' },
                    interval: { label: 'Intervals', mode: 'cards' }, chord: { label: 'Chords', mode: 'cards' }, key: { label: 'Key signatures', mode: 'cards' } };
const theoryPassAt = (total, pct = 80) => Math.ceil(total * pct / 100);
const theoryStars = (right, total = THEORY_ROUND, passAt = theoryPassAt(total)) => right >= total ? 3 : right >= total - 1 && right >= passAt ? 2 : right >= passAt ? 1 : 0;
const theoryLevelName = (deck, level) => THEORY_DECKS[deck]?.levels[Math.max(1, level) - 1] || '';

// ---------- Notes and clefs ----------
// A staff position is a count of letter steps from middle C (C4 = 0, D4 = 1, B3 = -1 …); `bottom` is the bottom line
const LETTERS = 'CDEFGAB', LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const CLEFS = { treble: { name: 'Treble', bottom: 2 }, bass: { name: 'Bass', bottom: -10 }, alto: { name: 'Alto', bottom: -4 }, tenor: { name: 'Tenor', bottom: -6 } };
const CLEF_CHOICES = { treble: 'Treble', bass: 'Bass', alto: 'Alto', tenor: 'Tenor', grand: 'Grand staff' };
const mod = (n, m) => ((n % m) + m) % m;
const posLetter = p => LETTERS[mod(p, 7)];
const posOctave = p => 4 + Math.floor(p / 7);
const ACC = { '': 0, '♯': 1, '♭': -1 };
const noteName = (p, acc = '') => posLetter(p) + acc;
const notePc = (p, acc = '') => mod(LETTER_PC[mod(p, 7)] + ACC[acc], 12);
const noteMidi = (p, acc = '') => 60 + 12 * Math.floor(p / 7) + LETTER_PC[mod(p, 7)] + ACC[acc];
const PC_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
// The clef an instrument reads (the teacher can choose others)
const defaultClef = instrument => ({ cello: 'bass', viola: 'alto' })[instrument] || 'treble';
// Clef settings: a list of treble / bass / alto / tenor / grand ('mixed' was the old "treble and bass")
const normClefs = c => { const a = (Array.isArray(c) ? c : c === 'mixed' ? ['treble', 'bass'] : [c]).filter(x => CLEF_CHOICES[x]); return a.length ? [...new Set(a)] : ['treble']; };
// Transposing instruments: the written note sounds this many half steps away (only the letter matters, not the octave)
const TRANSPOSE = { clarinet: -2, trumpet: -2, saxophone: -9 };
// A comfortable octave for Echo notes (MIDI number of the C it starts from)
const echoBase = instrument => ['cello', 'guitar'].includes(instrument) ? 48 : 60;

// Positions on one staff: lines, spaces or both, with `ledger` ledger lines above and below (-1 = just the staff)
function staffPositions(clef, { ledger = 0, lines = 'both' } = {}) {
  const b = CLEFS[clef].bottom, lo = ledger < 0 ? b : b - 1 - 2 * ledger, hi = ledger < 0 ? b + 8 : b + 9 + 2 * ledger, out = [];
  for (let p = lo; p <= hi; p++) { const onLine = mod(p - b, 2) === 0; if (lines === 'both' || (lines === 'lines') === onLine) out.push(p); }
  return out;
}
// Every note a question may use: { display (the clef shown, or 'grand'), staff (the staff it sits on), p }
function noteCandidates(spec) {
  if (spec.picks?.length) return spec.picks.map(id => { const a = String(id).split(':'); return a.length === 3 ? { display: 'grand', staff: a[1], p: +a[2] } : { display: a[0], staff: a[0], p: +a[1] }; })
    .filter(c => CLEFS[c.staff] && Number.isFinite(c.p));
  const out = [], o = { ledger: spec.ledger ?? 0, lines: spec.lines || 'both' };
  for (const c of normClefs(spec.clefs)) {
    if (c === 'grand') {
      staffPositions('treble', o).filter(p => p >= 0).forEach(p => out.push({ display: 'grand', staff: 'treble', p }));
      staffPositions('bass', o).filter(p => p <= 0).forEach(p => out.push({ display: 'grand', staff: 'bass', p }));
    } else staffPositions(c, o).forEach(p => out.push({ display: c, staff: c, p }));
  }
  return out.length ? out : staffPositions('treble').map(p => ({ display: 'treble', staff: 'treble', p }));
}
const pickAcc = a => { const r = Math.random(); return a === 'sharps' ? (r < 0.6 ? '♯' : '') : a === 'flats' ? (r < 0.6 ? '♭' : '') : a === 'both' ? (r < 0.3 ? '♯' : r < 0.6 ? '♭' : '') : ''; };

// ---------- The staff (SVG). Clefs and signs use the Noto Music font, drawn to the staff: its baseline is the bottom
// line and its size is the height of the staff (4 spaces). One staff, or the grand staff (treble over bass). ----------
const SP = 12, HALF = 6, ACC_Y = { '♯': 0.52, '♭': 0.45, '♮': 0.53 };
const staffLayout = display => display === 'grand' ? [{ clef: 'treble', base: 108 }, { clef: 'bass', base: 216 }] : [{ clef: CLEFS[display] ? display : 'treble', base: 108 }];
function theoryStaff({ clef = 'treble', notes = [], key = null, width = 0, place = false } = {}) {
  const staves = staffLayout(clef), H = clef === 'grand' ? 280 : 172, x0 = clef === 'grand' ? 26 : 18;
  const cols = notes.length ? Math.max(...notes.map(n => n.col || 0)) + 1 : 0, keyN = key ? Math.max(key.sharps || 0, key.flats || 0) : 0;
  const xs = x0 + 46 + (keyN ? keyN * 14 + 10 : 0), W = width || Math.max(place ? 300 : 200, xs + 30 + cols * 50 + (place ? 110 : 14));
  const stOf = s => staves.find(t => t.clef === s) || staves[0], y = (p, st) => st.base - (p - CLEFS[st.clef].bottom) * HALF;
  let out = '';
  for (const st of staves) {
    const b = CLEFS[st.clef].bottom;
    out += `<g class="lines">${[0, 2, 4, 6, 8].map(i => `<line x1="${x0}" x2="${W - 8}" y1="${y(b + i, st)}" y2="${y(b + i, st)}"/>`).join('')}</g>`;
    out += `<text x="${x0 + 4}" y="${st.base - (st.clef === 'tenor' ? SP : 0)}" font-size="${4 * SP}">${{ treble: '𝄞', bass: '𝄢', alto: '𝄡', tenor: '𝄡' }[st.clef]}</text>`;
    if (key && st.clef !== 'tenor') {                              // key signature in its standard places (not for tenor clef)
      const shift = { treble: 0, bass: -14, alto: -7 }[st.clef], SH = [10, 7, 11, 8, 5, 9, 6], FL = [6, 9, 5, 8, 4, 7, 3], a = key.sharps ? '♯' : '♭';
      (key.sharps ? SH.slice(0, key.sharps) : FL.slice(0, key.flats || 0)).forEach((p, i) =>
        out += `<text class="acc" x="${x0 + 46 + i * 14}" y="${y(p + shift, st) + ACC_Y[a] * SP}" font-size="${4 * SP}">${a}</text>`);
    }
  }
  if (clef === 'grand') {                                           // the brace and the line joining the two staves
    const top = staves[0].base - 8 * HALF, bot = staves[1].base, mid = (top + bot) / 2;
    out += `<line class="stem" x1="${x0}" x2="${x0}" y1="${top}" y2="${bot}"/><path class="brace" d="M${x0 - 5} ${top} C${x0 - 17} ${top + 26} ${x0 - 4} ${mid - 20} ${x0 - 14} ${mid} C${x0 - 4} ${mid + 20} ${x0 - 17} ${bot - 26} ${x0 - 5} ${bot}"/>`;
  }
  notes.forEach(n => {
    const st = stOf(n.staff || staves[0].clef), b = CLEFS[st.clef].bottom, cx = n.x ?? xs + 26 + (n.col || 0) * 50, cy = y(n.p, st), cls = n.mark ? ` ${n.mark}` : '';
    for (let l = b - 2; l >= n.p; l -= 2) out += `<line class="ledger${cls}" x1="${cx - 14}" x2="${cx + 14}" y1="${y(l, st)}" y2="${y(l, st)}"/>`;
    for (let l = b + 10; l <= n.p; l += 2) out += `<line class="ledger${cls}" x1="${cx - 14}" x2="${cx + 14}" y1="${y(l, st)}" y2="${y(l, st)}"/>`;
    if (n.acc) out += `<text class="acc${cls}" x="${cx - (n.accX || 27)}" y="${cy + ACC_Y[n.acc] * SP}" font-size="${4 * SP}">${n.acc}</text>`;
    if (n.whole) out += `<ellipse class="head whole${cls}" cx="${cx}" cy="${cy}" rx="8.6" ry="5.8"/>`;
    else {
      const up = n.p < b + 4;                                       // stems go up below the middle line
      out += `<ellipse class="head${cls}" cx="${cx}" cy="${cy}" rx="7.6" ry="5.6" transform="rotate(-20 ${cx} ${cy})"/>`;
      out += up ? `<line class="stem${cls}" x1="${cx + 6.8}" x2="${cx + 6.8}" y1="${cy - 1}" y2="${cy - 38}"/>` : `<line class="stem${cls}" x1="${cx - 6.8}" x2="${cx - 6.8}" y1="${cy + 1}" y2="${cy + 38}"/>`;
    }
  });
  const label = clef === 'grand' ? 'the grand staff' : `the ${CLEFS[staves[0].clef].name.toLowerCase()} staff`;
  return `<svg class="staff${place ? ' placeable' : ''}" viewBox="0 0 ${W} ${H}" data-staves='${JSON.stringify(staves)}' data-x="${xs + 26}" role="img" aria-label="${place ? 'Tap on ' : 'Notes on '}${label}">${out}</svg>`;
}
// Where on a staff drawing someone tapped: { staff, p } (snapped to a line or space, at most 4 ledger lines out)
function theoryStaffHit(svg, clientX, clientY) {
  const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
  const q = pt.matrixTransform(svg.getScreenCTM().inverse()), staves = JSON.parse(svg.dataset.staves);
  let best = null;
  for (const st of staves) { const d = Math.abs(q.y - (st.base - 4 * HALF)); if (!best || d < best.d) best = { d, st }; }
  const b = CLEFS[best.st.clef].bottom, p = b + Math.round((best.st.base - q.y) / HALF);
  return { staff: best.st.clef, p: Math.max(b - 9, Math.min(b + 17, p)) };
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

KEYS.push({ id: 'Cs', name: 'C♯ major', sharps: 7 }, { id: 'Cb', name: 'C♭ major', flats: 7 });
const MINOR_OF = { C: 'A', G: 'E', F: 'D', D: 'B', Bb: 'G', A: 'F♯', Eb: 'C', E: 'C♯', Ab: 'F', B: 'G♯', Db: 'B♭', Fs: 'D♯', Gb: 'E♭', Cs: 'A♯', Cb: 'A♭' };
const keyAcc = k => Math.max(k.sharps || 0, k.flats || 0);

const pick = a => a[Math.floor(Math.random() * a.length)];
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const choicesFrom = (answer, pool, n = 4) => shuffle([answer, ...shuffle([...new Set(pool)].filter(x => x && x !== answer)).slice(0, n - 1)]);

// ---------- What each built-in level asks (the same "spec" a teacher's own set uses) ----------
function deckSpec(deck, level, clefs) {
  const L = level, cl = normClefs(clefs);
  if (deck === 'notes') {
    const s = [{ ledger: -1, lines: 'lines' }, { ledger: -1, lines: 'spaces' }, { ledger: -1 }, { ledger: 0 }, { ledger: 1 }, { ledger: -1, acc: 'both' },
               { ledger: 1, acc: 'both' }, { ledger: 1, grand: true }, { ledger: 1, acc: 'both', grand: true }][L - 1] || { ledger: 1 };
    return { kind: 'name', clefs: s.grand ? ['grand'] : cl, ledger: s.ledger, lines: s.lines || 'both', acc: s.acc || 'none' };
  }
  if (deck === 'keys') return { kind: 'key', clefs: cl, keysMax: [1, 2, 3, 4, 6, 4, 7][L - 1] ?? 3, keyMode: L === 6 ? 'minor' : L === 7 ? 'both' : 'major' };
  if (deck === 'intervals') return { kind: 'interval', clefs: cl, ledger: 0, sizes: [[2, 3], [2, 3, 4, 5], [2, 3, 4, 5, 6, 7, 8], [2, 3, 4, 5, 6, 7, 8], [2, 3, 4, 5, 6, 7, 8]][L - 1] || [2, 3],
                                     quality: L >= 4, acc: L >= 5 ? 'both' : 'none' };
  if (deck === 'chords') return { kind: 'chord', clefs: cl, chords: L >= 2 ? ['maj', 'min', 'dim', 'aug'] : ['maj', 'min'], inversions: L >= 3, accRoots: L >= 4 };
  return { kind: deck, level: L };                                 // rhythm, symbols, echo
}

// ---------- Questions ----------
// Each returns { id (for "trouble spots"), ask, prompt: { staff | glyph | text | dyn | listen }, answer, choices?, grid?, pc?, midi?, target? }
function noteQuestion(spec, mode) {
  const c = pick(noteCandidates(spec)), acc = mode === 'place' ? '' : pickAcc(spec.acc);
  const name = noteName(c.p, acc), full = name + posOctave(c.p), staffSvg = theoryStaff({ clef: c.display, notes: [{ staff: c.staff, p: c.p, acc }] });
  if (mode === 'place') return { id: `place:${c.staff}:${c.p}`, ask: `Tap where ${full} goes${c.display === 'grand' ? ' on the grand staff' : ''}`, answer: full,
    target: { staff: c.staff, p: c.p }, display: c.display, prompt: { staff: theoryStaff({ clef: c.display, place: true }), place: true } };
  const q = { id: `${c.staff}:${c.p}${acc}`, prompt: { staff: staffSvg }, pc: notePc(c.p, acc) };
  if (mode === 'play') return { ...q, ask: 'Play this note', answer: name };
  if (spec.octave) {
    const o = posOctave(c.p);
    return { ...q, ask: 'What note is this? Include the octave.', answer: full,
             choices: choicesFrom(full, [name + (o + 1), name + (o - 1), noteName(c.p + 1, acc) + posOctave(c.p + 1), noteName(c.p - 1, acc) + posOctave(c.p - 1), noteName(c.p + 2, acc) + posOctave(c.p + 2)]) };
  }
  if (!acc) return { ...q, ask: 'What note is this?', answer: name, choices: LETTERS.split(''), grid: true };
  const L = posLetter(c.p);
  return { ...q, ask: 'What note is this?', answer: name, choices: choicesFrom(name, [L, L + (acc === '♯' ? '♭' : '♯'), posLetter(c.p + 1) + acc, posLetter(c.p - 1) + acc, posLetter(c.p + 1), posLetter(c.p - 1)]) };
}

const ORD = ['', 'Unison', '2nd', '3rd', '4th', '5th', '6th', '7th', 'Octave'];
const MAJOR_SEMIS = [0, 0, 2, 4, 5, 7, 9, 11, 12];
const PERFECT = n => [1, 4, 5, 8].includes(n);
const QUALITIES = n => PERFECT(n) ? ['Perfect', 'Augmented', 'Diminished'] : ['Major', 'Minor', 'Augmented', 'Diminished'];
function intervalQuality(n, semis) {
  const d = semis - MAJOR_SEMIS[n];
  return PERFECT(n) ? { 0: 'Perfect', 1: 'Augmented', '-1': 'Diminished' }[d] : { 0: 'Major', '-1': 'Minor', 1: 'Augmented', '-2': 'Diminished' }[d];
}
function intervalQuestion(spec) {
  const sizes = (spec.sizes?.length ? spec.sizes : [2, 3, 4, 5]).filter(n => n >= 2 && n <= 8);
  for (let t = 0; t < 40; t++) {
    const c = pick(noteCandidates({ ...spec, ledger: Math.min(spec.ledger ?? 0, 1) })), n = pick(sizes), p1 = c.p, p2 = p1 + n - 1, b = CLEFS[c.staff].bottom;
    if (p2 > b + 11) continue;                                       // keep the top note near the staff
    const a1 = spec.quality ? pickAcc(spec.acc) : '', a2 = spec.quality ? pickAcc(spec.acc) : '';
    const q = intervalQuality(n, noteMidi(p2, a2) - noteMidi(p1, a1));
    if (spec.quality && !q) continue;                                // (never "doubly augmented")
    const answer = spec.quality ? `${q} ${ORD[n]}` : ORD[n];
    const pool = spec.quality ? [...QUALITIES(n).map(w => `${w} ${ORD[n]}`), ...[n - 1, n + 1].filter(x => x >= 2 && x <= 8).map(x => `${pick(QUALITIES(x))} ${ORD[x]}`)]
      : [...sizes, n - 1, n + 1].filter(x => x >= 2 && x <= 8).map(x => ORD[x]);
    return { id: `int:${c.staff}:${p1}${a1}:${p2}${a2}`, ask: spec.quality ? 'Name the interval' : 'How far apart are these notes?', answer, choices: choicesFrom(answer, pool),
             prompt: { staff: theoryStaff({ clef: c.display, notes: [{ staff: c.staff, p: p1, acc: a1, whole: true, col: 0 }, { staff: c.staff, p: p2, acc: a2, whole: true, col: 1 }] }) } };
  }
  return null;
}

const CHORD_Q = { maj: { word: 'major', third: 4, fifth: 7 }, min: { word: 'minor', third: 3, fifth: 7 }, dim: { word: 'diminished', third: 3, fifth: 6 }, aug: { word: 'augmented', third: 4, fifth: 8 } };
const INVERSIONS = ['Root position', '1st inversion', '2nd inversion'];
// The sharp or flat that turns the letter at p into pitch class pc (null if it would need a double sharp or flat)
const spellAt = (p, pc) => { const d = mod(pc - LETTER_PC[mod(p, 7)] + 6, 12) - 6; return d === 0 ? '' : d === 1 ? '♯' : d === -1 ? '♭' : null; };
function chordQuestion(spec) {
  const quals = (spec.chords?.length ? spec.chords : ['maj', 'min']).filter(q => CHORD_Q[q]);
  for (let t = 0; t < 60; t++) {
    const c = pick(noteCandidates({ ...spec, ledger: 0 })), q = pick(quals), inv = spec.inversions ? pick([0, 1, 2]) : 0, b = CLEFS[c.staff].bottom;
    const rp = c.p, ra = spec.accRoots ? pickAcc('both') : '', rpc = notePc(rp, ra);
    const a3 = spellAt(rp + 2, rpc + CHORD_Q[q].third), a5 = spellAt(rp + 4, rpc + CHORD_Q[q].fifth);
    if (a3 == null || a5 == null) continue;
    let ns = [{ p: rp, acc: ra }, { p: rp + 2, acc: a3 }, { p: rp + 4, acc: a5 }];
    if (inv >= 1) ns = [ns[1], ns[2], { p: rp + 7, acc: ra }];
    if (inv === 2) ns = [ns[1], ns[2], { p: rp + 9, acc: a3 }];
    if (ns[0].p < b - 3 || ns[2].p > b + 11) continue;
    const root = noteName(rp, ra), name = `${root} ${CHORD_Q[q].word}`;
    // stack as whole notes; accidentals step left so they don't collide
    let k = 0; const notes = [...ns].sort((x, y) => y.p - x.p).map(n => ({ staff: c.staff, p: n.p, acc: n.acc, whole: true, col: 0, accX: n.acc ? 26 + 13 * (k++ % 3) : 0 }));
    const staff = theoryStaff({ clef: c.display, notes });
    if (spec.inversions && Math.random() < 0.35)
      return { id: `chordinv:${root}:${q}:${inv}`, ask: 'Which position is this chord in?', answer: INVERSIONS[inv], choices: INVERSIONS, prompt: { staff } };
    const others = [...quals.filter(x => x !== q).map(x => `${root} ${CHORD_Q[x].word}`), `${noteName(rp + 2, a3)} ${CHORD_Q[q].word}`, `${noteName(rp + 4, a5)} ${CHORD_Q[q].word}`,
                    `${noteName(rp + 1)} ${CHORD_Q[q].word}`, `${root} ${CHORD_Q[q === 'maj' ? 'min' : 'maj'].word}`];
    return { id: `chord:${root}:${q}:${inv}`, ask: 'What chord is this?', answer: name, choices: choicesFrom(name, others), prompt: { staff } };
  }
  return null;
}

function keyQuestion(spec) {
  const max = Math.min(7, Math.max(1, spec.keysMax ?? 3)), pool = KEYS.filter(k => keyAcc(k) <= max);
  const k = pick(pool), minor = spec.keyMode === 'minor' || (spec.keyMode === 'both' && Math.random() < 0.5);
  const display = pick(normClefs(spec.clefs).filter(c => c !== 'tenor')) || 'treble', nameOf = kk => minor ? `${MINOR_OF[kk.id]} minor` : kk.name;
  return { id: `keys:${k.id}${minor ? ':m' : ''}`, ask: minor ? 'Which minor key is this?' : 'Which major key is this?', answer: nameOf(k),
           choices: choicesFrom(nameOf(k), pool.map(nameOf)), prompt: { staff: theoryStaff({ clef: display, key: k }) } };
}

function rhythmQuestion(level) {
  const ids = RHYTHM_LEVELS[level - 1] || RHYTHM_LEVELS.at(-1), want = pick(ids), it = RHYTHM.find(r => r.id === want), pool = RHYTHM.filter(r => ids.includes(r.id));
  const beats = level >= 2 && Math.random() < 0.45;
  return { id: `rhythm:${it.id}${beats ? ':beats' : ''}`, prompt: { glyph: it.glyph, dot: it.dot }, ask: beats ? 'How many beats does it last? (in 4/4)' : 'What is this called?',
           answer: beats ? it.beats : it.name, choices: beats ? choicesFrom(it.beats, ['4', '3', '2', '1½', '1', '¾', '½', '¼']) : choicesFrom(it.name, pool.map(r => r.name).concat(RHYTHM.map(r => r.name))) };
}
function symbolsQuestion(level) {
  const set = SYMBOLS[Math.min(level, SYMBOLS.length) - 1], it = pick(set);
  return { id: `symbols:${it.id}`, prompt: it.dyn ? { dyn: it.show } : it.glyph ? { glyph: it.show } : { text: it.show }, ask: 'What does it mean?',
           answer: it.mean, choices: choicesFrom(it.mean, set.map(s => s.mean)) };
}
function echoQuestion(level, instrument) {
  const pcs = [[0, 2, 4, 5, 7], [0, 2, 4, 5, 7, 9, 11], Array.from({ length: 12 }, (_, i) => i)][level - 1] || [0, 2, 4, 5, 7], pc = pick(pcs);
  return { id: `echo:${pc}`, prompt: { listen: true }, ask: 'Listen, then play or sing it back', answer: PC_NAMES[pc], pc, midi: echoBase(instrument) + pc };
}

function makeFromSpec(spec, mode, instrument) {
  switch (spec.kind) {
    case 'name': case 'place': case 'play': return noteQuestion(spec, mode);
    case 'interval': return intervalQuestion(spec);
    case 'chord': return chordQuestion(spec);
    case 'key': return keyQuestion(spec);
    case 'rhythm': return rhythmQuestion(spec.level || 1);
    case 'symbols': return symbolsQuestion(spec.level || 1);
    case 'echo': return echoQuestion(spec.level || 1, instrument);
  }
  return null;
}
// One question for a built-in deck at a level, or for a teacher's set ({ set })
function theoryQuestion(deck, level, { clef, clefs, instrument = '', mode = 'cards', last = null, set = null } = {}) {
  const spec = set ? normalizeSet(set) : deckSpec(deck, level, clefs || clef), m = set ? SET_KINDS[spec.kind].mode : mode;
  let q = null;
  for (let i = 0; i < 8; i++) { q = makeFromSpec(spec, m, instrument); if (q && q.id !== last) return q; }  // not the same thing twice in a row
  return q || noteQuestion({ clefs: ['treble'] }, 'cards');
}

// ---------- A teacher's own set ----------
// { id, name, kind, clefs, picks (exact notes, 'treble:6' or 'grand:bass:-4'), ledger, lines, acc, octave, sizes, quality,
//   chords, inversions, accRoots, keysMax, keyMode, cards, seconds, pass (%), due }
function normalizeSet(s) {
  const n = (v, lo, hi, d) => Number.isFinite(+v) && v !== '' && v != null ? Math.min(hi, Math.max(lo, Math.round(+v))) : d;
  return { ...s, kind: SET_KINDS[s?.kind] ? s.kind : 'name', clefs: normClefs(s?.clefs), picks: Array.isArray(s?.picks) ? s.picks.slice(0, 80) : [],
           ledger: n(s?.ledger, -1, 4, 0), lines: ['lines', 'spaces'].includes(s?.lines) ? s.lines : 'both', acc: ['sharps', 'flats', 'both'].includes(s?.acc) ? s.acc : 'none',
           octave: !!s?.octave, sizes: (Array.isArray(s?.sizes) ? s.sizes : [2, 3, 4, 5]).map(Number).filter(x => x >= 2 && x <= 8), quality: !!s?.quality,
           chords: (Array.isArray(s?.chords) ? s.chords : ['maj', 'min']).filter(q => CHORD_Q[q]), inversions: !!s?.inversions, accRoots: !!s?.accRoots,
           keysMax: n(s?.keysMax, 1, 7, 3), keyMode: ['minor', 'both'].includes(s?.keyMode) ? s.keyMode : 'major',
           cards: n(s?.cards, 5, 30, 10), seconds: n(s?.seconds, 0, 60, 0), pass: n(s?.pass, 50, 100, 80) };
}
// One line describing a set, e.g. "Name the note · grand staff · 2 ledger lines · sharps & flats · 15 cards · 5 s each · pass 80%"
function theorySetSummary(raw) {
  const s = normalizeSet(raw), bits = [SET_KINDS[s.kind].label];
  const clefText = s.picks.length ? `${s.picks.length} chosen ${s.picks.length === 1 ? 'note' : 'notes'}` : s.clefs.map(c => CLEF_CHOICES[c].toLowerCase()).join(' + ');
  if (['name', 'place', 'play'].includes(s.kind)) {
    bits.push(clefText);
    if (!s.picks.length) bits.push(s.ledger < 0 ? 'on the staff' : s.ledger === 0 ? 'just above and below' : `${s.ledger} ledger ${s.ledger === 1 ? 'line' : 'lines'}`);
    if (!s.picks.length && s.lines !== 'both') bits.push(`${s.lines} only`);
    if (s.acc !== 'none' && s.kind !== 'place') bits.push({ sharps: 'sharps', flats: 'flats', both: 'sharps & flats' }[s.acc]);
    if (s.octave && s.kind === 'name') bits.push('with octave');
  }
  if (s.kind === 'interval') bits.push(s.sizes.map(x => ORD[x]).join(', '), s.quality ? 'with quality' : 'size only', clefText);
  if (s.kind === 'chord') bits.push(s.chords.map(q => CHORD_Q[q].word).join(', '), ...(s.inversions ? ['inversions'] : []), ...(s.accRoots ? ['sharp & flat roots'] : []));
  if (s.kind === 'key') bits.push(`up to ${s.keysMax} ${s.keysMax === 1 ? 'sharp or flat' : 'sharps or flats'}`, { major: 'major', minor: 'minor', both: 'major & minor' }[s.keyMode]);
  bits.push(`${s.cards} cards`); if (s.seconds) bits.push(`${s.seconds} s each`); bits.push(`pass ${s.pass}%`);
  return bits.join(' · ');
}

// Plain-language name for a question, for teachers' "trouble spots"
function theoryItemLabel(id) {
  const a = String(id).split(':'), nm = (s) => { const m = String(s).match(/^(-?\d+)(.*)$/); return m ? noteName(+m[1], m[2]) + posOctave(+m[1]) : s; };
  if (CLEFS[a[0]]) return `${nm(a[1])} · ${a[0]} staff`;
  if (a[0] === 'place') return `Find ${nm(a[2])} on the ${a[1]} staff`;
  if (a[0] === 'int') { const p1 = parseInt(a[2]), p2 = parseInt(a[3]); return `${nm(a[2])}–${nm(a[3])} (${ORD[p2 - p1 + 1] || 'interval'}) · ${a[1]} staff`; }
  if (a[0] === 'chord') return `${a[1]} ${CHORD_Q[a[2]]?.word || ''}${+a[3] ? `, ${INVERSIONS[+a[3]].toLowerCase()}` : ''}`;
  if (a[0] === 'chordinv') return `Position of ${a[1]} ${CHORD_Q[a[2]]?.word || ''} (${INVERSIONS[+a[3]]?.toLowerCase()})`;
  if (a[0] === 'rhythm') { const r = RHYTHM.find(x => x.id === a[1]); return r ? r.name + (a[2] ? ' (beats)' : '') : id; }
  if (a[0] === 'symbols') { const s = SYMBOLS.flat().find(x => x.id === a[1]); return s ? `${s.show} – ${s.mean.toLowerCase()}` : id; }
  if (a[0] === 'keys') { const k = KEYS.find(x => x.id === a[1]); return k ? (a[2] === 'm' ? `${MINOR_OF[k.id]} minor` : k.name) : id; }
  if (a[0] === 'echo') return `${PC_NAMES[+a[1]]} by ear`;
  return id;
}

// ---------- A student's progress ----------
// state: { levels: {deck: n}, passes: {deck: n at this level}, setAt: {deck: when the teacher last set it},
//          sets: {setId: { best, passes, rounds }}, rounds: [...], ups: [...] }. A teacher's set is deck 'set:<id>'.
function theoryLevel(state, deck) { return THEORY_DECKS[deck] ? Math.min(Math.max(state?.levels?.[deck] || 1, 1), THEORY_DECKS[deck].levels.length) : 1; }
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
function recordTheoryRound(state, { deck, mode, right, total, ms, miss, passAt = theoryPassAt(total) }) {
  const level = theoryLevel(state, deck), passed = right >= passAt;
  state.rounds = [...(state.rounds || []), { at: new Date().toISOString(), deck, mode, level, right, total, ms: Math.round(ms), miss: miss.slice(0, 12) }].slice(-300);
  if (deck.startsWith('set:')) {                                     // a teacher's set: best score and how often it was passed
    const id = deck.slice(4), cur = state.sets?.[id] || {};
    state.sets = { ...state.sets, [id]: { best: Math.max(cur.best || 0, Math.round(100 * right / total)), passes: (cur.passes || 0) + (passed ? 1 : 0), rounds: (cur.rounds || 0) + 1 } };
    return { passed, levelUp: false, level: 1 };
  }
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

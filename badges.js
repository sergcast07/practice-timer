// Allegrow – badges (shared by the family app and the teacher studio)
//
// Badges are earned automatically from practice data. Each badge measures one thing (its metric) and has
// levels (tiers); the child always sees the next level, so there's always something within reach.
// A studio starts with the default set below. A teacher can clear it, reset it, or build their own set
// (studio.badgeSet → copied onto each student as student.badgeSet).

const BADGE_TIERS = [
  { name: 'Bronze', color: '#b27a4c' },
  { name: 'Silver', color: '#8a97a8' },
  { name: 'Gold', color: '#cf9f2e' },
  { name: 'Platinum', color: '#3f9fb0' },
  { name: 'Diamond', color: '#7a63db' }
];

// What a badge can measure (all worked out from practice data, nothing to award by hand)
const BADGE_METRICS = {
  streak:   { label: 'Days in a row', unit: n => `${n} days in a row`, about: 'Practice on days in a row. Planned rest days don’t break it.' },
  days:     { label: 'Practice days (total)', unit: n => `${n} practice ${n === 1 ? 'day' : 'days'}`, about: 'Every day with some practice counts.' },
  goals:    { label: 'Days the goal was reached', unit: n => n === 1 ? 'first goal reached' : `${n} goals reached`, about: 'Reach the day’s practice goal.' },
  hours:    { label: 'Hours practiced (total)', unit: n => `${n} ${n === 1 ? 'hour' : 'hours'} practiced`, about: 'All practice time added up.' },
  focus:    { label: 'Minutes without stopping', unit: n => `${n} min without stopping`, about: 'Play for a long stretch without stopping.' },
  tune:     { label: '% of notes in tune in a day', unit: n => `${n}% in tune in a day`, strings: true, about: 'Play most notes in tune in one day (at least 50 notes).' },
  rhythm:   { label: '% steady with the metronome', unit: n => `${n}% steady with the metronome`, about: 'Keep a steady beat with the metronome in one day (at least 40 notes).' },
  early:    { label: 'Mornings before 8 am', unit: n => `${n} ${n === 1 ? 'morning' : 'mornings'} before 8 am`, about: 'Practice before 8 in the morning.' },
  weekend:  { label: 'Full weekends', unit: n => `${n} full ${n === 1 ? 'weekend' : 'weekends'}`, about: 'Practice on both Saturday and Sunday.' },
  comeback: { label: 'Comebacks after a break', unit: n => n === 1 ? 'came back after a break' : `${n} comebacks`, about: 'Start again after a few days off – that takes grit.' },
  theory:   { label: 'Theory rounds passed', unit: n => `${n} theory ${n === 1 ? 'round' : 'rounds'} passed`, about: 'Pass music theory rounds (8 out of 10 or better).' },
  homework: { label: 'Days of assignments ticked', unit: n => `${n} days of assignments`, about: 'Tick off the teacher’s assignments.' }
};

// The default set every studio starts with
const BADGES = [
  { id: 'streak', metric: 'streak', name: 'On a roll', icon: 'flame', tiers: [3, 7, 14, 30, 60] },
  { id: 'goals', metric: 'goals', name: 'Goal getter', icon: 'flag', tiers: [1, 10, 25, 50, 100] },
  { id: 'hours', metric: 'hours', name: 'Time invested', icon: 'clock', tiers: [1, 5, 10, 25, 50] },
  { id: 'focus', metric: 'focus', name: 'Deep focus', icon: 'target', tiers: [10, 20, 30, 45] },
  { id: 'tune', metric: 'tune', name: 'Sweet spot', icon: 'tune', tiers: [80, 88, 94] },
  { id: 'rhythm', metric: 'rhythm', name: 'Steady beat', icon: 'metronome', tiers: [75, 85, 92] },
  { id: 'early', metric: 'early', name: 'Early bird', icon: 'sun', tiers: [1, 5, 20] },
  { id: 'weekend', metric: 'weekend', name: 'Weekend warrior', icon: 'calendar', tiers: [1, 4, 12] },
  { id: 'comeback', metric: 'comeback', name: 'Comeback', icon: 'refresh', tiers: [1, 5] },
  { id: 'homework', metric: 'homework', name: 'Homework hero', icon: 'book', tiers: [5, 20, 50, 100] },
  { id: 'theory', metric: 'theory', name: 'Theory whiz', icon: 'note', tiers: [3, 10, 25, 60] }
];
// Pictures for badges (auto or awarded by hand)
const BADGE_ICONS = ['star', 'trophy', 'award', 'flame', 'flag', 'clock', 'target', 'tune', 'metronome', 'sun', 'calendar', 'refresh', 'book', 'heart', 'spark', 'note'];

// A badge with its metric's wording filled in
const badgeDef = b => { const m = BADGE_METRICS[b.metric || b.id] || BADGE_METRICS.days; return { ...b, metric: b.metric || b.id, unit: m.unit, about: b.about || m.about, strings: !!m.strings }; };

// The badges in effect for a student: the studio's own set if it has one, otherwise the defaults
// (with any older per-badge on/off and level changes applied)
function badgeSetFor(set, rules = {}) {
  if (Array.isArray(set)) return set.map(badgeDef);
  return BADGES.filter(b => !rules.off?.[b.id]).map(b => badgeDef({ ...b, tiers: rules.tiers?.[b.id]?.length ? rules.tiers[b.id] : b.tiers }));
}

// ---------- Lesson times ----------
// A student can have several weekly lesson times, each running between two dates (e.g. one per semester):
//   slots: [{ day: 0–6 (Sunday first), time: 'HH:MM', length: minutes, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' or '' }]
// Older records have a single `lesson` with the same fields (and no end date).
const lessonSlots = s => (Array.isArray(s?.slots) && s.slots.length ? s.slots : s?.lesson ? [s.lesson] : [])
  .filter(l => l && l.day !== '' && l.day != null && l.time);
// The weekly lesson (if any) on this day key
const slotOn = (s, key) => lessonSlots(s).find(l => _dow(key) === +l.day && (!l.start || key >= l.start) && (!l.end || key <= l.end)) || null;

// ---------- Weekly practice plan ----------
// Minutes for each day of the week, Sunday first (JavaScript's getDay order); 0 = rest day.
const PLAN_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PLAN_ORDER = [1, 2, 3, 4, 5, 6, 0];                        // shown Monday first
const planOf = (plan, fallback = 20) => Array.isArray(plan) && plan.length === 7 ? plan.map(n => Math.max(0, +n || 0)) : Array(7).fill(fallback);
const planTotal = p => p.reduce((a, b) => a + b, 0);
const planDayCount = p => p.filter(n => n > 0).length;
// "20 min every day", "5 days × 30 min", "3 × 60 min + 2 × 30 min"
function planText(p) {
  const on = p.filter(n => n > 0);
  if (!on.length) return 'No practice days set';
  const counts = {}; on.forEach(n => counts[n] = (counts[n] || 0) + 1);
  const groups = Object.entries(counts).sort((a, b) => b[0] - a[0]);
  if (groups.length === 1) return on.length === 7 ? `${on[0]} min every day` : `${on.length} days × ${on[0]} min`;
  return groups.map(([m, c]) => `${c} × ${m} min`).join(' + ');
}
const PLAN_PRESETS = [
  ['20 min every day', [20, 20, 20, 20, 20, 20, 20]],
  ['5 weekdays × 30 min', [0, 30, 30, 30, 30, 30, 0]],
  ['3 × 60 min + 2 × 30 min', [0, 60, 30, 60, 30, 60, 0]],
  ['6 days × 45 min', [0, 45, 45, 45, 45, 45, 45]],
  ['4 days × 30 min', [0, 30, 0, 30, 0, 30, 30]]
];

// Icons a teacher can pick for a badge they award by hand
const AWARD_ICONS = ['star', 'trophy', 'award', 'note', 'heart', 'spark', 'target', 'flame'];

// Kinds of challenge a teacher can set for one student, measured over the challenge's dates
const CHALLENGES = {
  days:      { label: 'Practice on {n} days', unit: 'days' },
  minutes:   { label: 'Practice {n} minutes in total', unit: 'minutes' },
  goals:     { label: 'Reach the daily goal {n} times', unit: 'days' },
  streak:    { label: 'Practice {n} days in a row', unit: 'days in a row' },
  metronome: { label: 'Use the metronome on {n} days', unit: 'days' },
  homework:  { label: 'Tick off assignments on {n} days', unit: 'days' }
};
const challengeTitle = c => c.title || CHALLENGES[c.kind]?.label.replace('{n}', c.target) || 'Challenge';

// ---------- Measuring ----------
// days: [{ key: 'YYYY-MM-DD', ms, stats }] (any order; ms includes practice logged by hand),
// goalFor(key) → that day's goal in ms (0 = planned rest day) – or goalMs, one goal for every day;
// tickDays: Set of day keys with an assignment ticked
const _addKey = (k, n) => { const [y, m, d] = k.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
const _dow = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

// Longest run of practice days; planned rest days in between don't break it (they just don't add to it)
function _bestRun(on, goalFor) {
  if (!on.length) return 0;
  const set = new Set(on); let best = 0, run = 0;
  for (let k = on[0]; k <= on[on.length - 1]; k = _addKey(k, 1)) {
    if (set.has(k)) best = Math.max(best, ++run);
    else if (goalFor(k) > 0) run = 0;
  }
  return best;
}
const _goalFn = (goalFor, goalMs) => typeof goalFor === 'function' ? goalFor : () => goalMs ?? 20 * 60000;

function badgeMetrics({ days, goalFor, goalMs, tickDays = new Set() }) {
  const g = _goalFn(goalFor, goalMs);
  const on = days.filter(d => d.ms >= 60000).map(d => d.key).sort(), set = new Set(on);
  let prev = null, comebacks = 0;
  for (const k of on) {
    if (prev && _addKey(prev, 5) <= k) comebacks++;                  // 4+ days off, then back
    prev = k;
  }
  const best = _bestRun(on, g);
  let weekends = 0;
  for (const k of on) if (_dow(k) === 6 && set.has(_addKey(k, 1))) weekends++;
  const m = { streak: best, goals: days.filter(d => g(d.key) > 0 && d.ms >= g(d.key)).length, hours: Math.floor(days.reduce((a, d) => a + d.ms, 0) / 36e5),
              days: on.length, focus: 0, tune: 0, rhythm: 0, early: 0, weekend: weekends, comeback: comebacks, homework: tickDays.size, theory: 0 };
  for (const d of days) {
    const s = d.stats || {};
    m.focus = Math.max(m.focus, Math.floor((s.longest || 0) / 60000));
    if (s.notes >= 50) m.tune = Math.max(m.tune, Math.floor(100 * s.inTune / s.notes));
    if (s.beats >= 40) m.rhythm = Math.max(m.rhythm, Math.floor(100 * s.steady / s.beats));
    if ((s.early || 0) >= 5 * 60000) m.early++;
    m.theory += s.theory || 0;                                        // theory rounds passed that day
  }
  return m;
}

// Which level of each badge is reached, and what's next. set = a studio's own badges (array) or null for the
// defaults; rules = older { off, tiers } tweaks to the defaults.
// `off`: metrics whose badges are hidden (e.g. ['tune'] when a teacher turned tuning scores off)
function badgeLevels(metrics, rules = {}, { strings = true, off = [] } = {}, set = null) {
  return badgeSetFor(set, rules).filter(b => (strings || !b.strings) && !off.includes(b.metric)).map(b => {
    const tiers = (b.tiers || []).map(Number).filter(n => n > 0).slice(0, BADGE_TIERS.length);
    const value = metrics[b.metric] || 0;
    let tier = -1; tiers.forEach((t, i) => { if (value >= t) tier = i; });
    return { ...b, tiers, value, tier, next: tiers[tier + 1] ?? null, prev: tier >= 0 ? tiers[tier] : 0 };
  }).filter(b => b.tiers.length);
}

function challengeProgress(c, days, goalFor, tickDays = new Set()) {
  const g = _goalFn(goalFor, goalFor);
  const inRange = days.filter(d => d.key >= c.start && d.key <= c.end);
  const on = inRange.filter(d => d.ms >= 60000).map(d => d.key).sort();
  let value = 0;
  if (c.kind === 'days') value = on.length;
  else if (c.kind === 'minutes') value = Math.floor(inRange.reduce((a, d) => a + d.ms, 0) / 60000);
  else if (c.kind === 'goals') value = inRange.filter(d => g(d.key) > 0 && d.ms >= g(d.key)).length;
  else if (c.kind === 'metronome') value = inRange.filter(d => (d.stats?.beats || 0) > 0).length;
  else if (c.kind === 'homework') value = [...tickDays].filter(k => k >= c.start && k <= c.end).length;
  else if (c.kind === 'streak') value = _bestRun(on, g);
  return { value, done: value >= c.target };
}

// Medal artwork (inline SVG); uses the page's own icon sprite for the symbol in the middle
function medalSvg(iconId, color, { locked = false, size = 64 } = {}) {
  const c = locked ? 'var(--track)' : color, ink = locked ? 'var(--muted)' : '#fff';
  return `<svg class="medalArt${locked ? ' locked' : ''}" width="${size}" height="${size}" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="30" fill="${c}" opacity="${locked ? 1 : .22}"/>
    <circle cx="32" cy="32" r="24" fill="${c}"/>
    <circle cx="32" cy="32" r="24" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="${locked ? '3 4' : '0'}"/>
    <svg x="18" y="18" width="28" height="28" viewBox="0 0 24 24" style="color:${ink}"><use href="#i-${iconId}" style="stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round"/></svg>
  </svg>`;
}

// ---------- Photos ----------
// A small square picture (160 × 160 JPEG, about 6–14 KB) kept right on the player/student record, so no file
// storage is needed. Just enough for a teacher with many students to see who's who.
// choosePhoto() picks a file, then lets the person drag and zoom to frame it in the circle that's shown in the app.

// Open the file picker; resolves with the file, or null. (The input is kept in the page until it's used:
// some browsers never report the choice from a detached input.)
function pickImageFile() {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    document.body.append(input);
    const done = f => { input.remove(); resolve(f); };
    input.onchange = () => done(input.files[0] || null);
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}
async function loadPhoto(file) {
  if (/heic|heif/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '')) {
    try { return await createImageBitmap(file); }                  // Safari can open these; most other browsers can't
    catch { throw new Error('heic'); }
  }
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch {
    const img = new Image(), url = URL.createObjectURL(file);
    try { img.src = url; await img.decode(); return img; } catch { throw new Error('decode'); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  }
}
const photoError = e => e?.message === 'heic'
  ? 'This browser can’t open iPhone HEIC photos. Try it in Safari, or pick a JPEG or PNG (a screenshot of the photo works too).'
  : 'Couldn’t open that picture. Try a JPEG or PNG.';

// The framing step: returns a JPEG data URL, or null if they cancel
function framePhoto(src, size = 160) {
  const W = src.width, H = src.height, S = 280;                    // S = the frame on screen (CSS px)
  const base = Math.max(S / W, S / H);                             // smallest zoom that still fills the frame
  let zoom = 1, cx = W / 2, cy = H / 2;                            // image point at the center of the frame
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
  ov.innerHTML = `<div role="dialog" aria-label="Frame the photo" style="background:var(--card,#1d212b);color:var(--ink,#eef0f5);border-radius:20px;padding:18px;width:min(340px,100%);display:grid;gap:12px;justify-items:center;box-shadow:0 20px 60px rgba(0,0,0,.4);font-family:var(--sans,system-ui)">
      <b style="font-size:17px">Frame the photo</b>
      <span style="font-size:13px;color:var(--muted,#9aa1b1);text-align:center;margin-top:-6px">Drag to move it. Zoom with the slider, a pinch or the scroll wheel.</span>
      <canvas style="width:${S}px;height:${S}px;max-width:100%;border-radius:16px;touch-action:none;cursor:grab;background:#000"></canvas>
      <label style="display:flex;align-items:center;gap:10px;width:100%;font-size:13px;color:var(--muted,#9aa1b1)">Zoom<input type="range" min="1" max="5" step="0.01" value="1" style="flex:1"></label>
      <div style="display:flex;gap:10px;width:100%"><button type="button" class="secondary" data-x style="flex:1">Cancel</button><button type="button" class="primary" data-ok style="flex:1">Use photo</button></div>
    </div>`;
  document.body.append(ov);
  const cv = ov.querySelector('canvas'), range = ov.querySelector('input'), dpr = Math.min(window.devicePixelRatio || 1, 3), ctx = cv.getContext('2d');
  cv.width = cv.height = Math.round(S * dpr);
  const clamp = () => {                                            // keep the frame covered by the picture
    const half = S / (2 * base * zoom);
    cx = Math.min(Math.max(cx, half), W - half); cy = Math.min(Math.max(cy, half), H - half);
  };
  const paint = (c, px) => {                                       // draw the framed square onto a px × px canvas
    const k = base * zoom * px / S, g = c.getContext('2d');
    g.imageSmoothingQuality = 'high'; g.fillStyle = '#fff'; g.fillRect(0, 0, px, px);
    g.drawImage(src, px / 2 - cx * k, px / 2 - cy * k, W * k, H * k);
  };
  const draw = () => {
    clamp(); paint(cv, cv.width);
    const r = cv.width / 2;                                        // dim what falls outside the circle the app shows
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.beginPath(); ctx.rect(0, 0, cv.width, cv.width); ctx.arc(r, r, r - 1, 0, Math.PI * 2, true); ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(r, r, r - dpr, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  };
  const setZoom = (z, fx = S / 2, fy = S / 2) => {                 // zoom around a point in the frame
    z = Math.min(5, Math.max(1, z));
    const k0 = base * zoom, k1 = base * z;
    cx += (fx - S / 2) / k0 - (fx - S / 2) / k1; cy += (fy - S / 2) / k0 - (fy - S / 2) / k1;
    zoom = z; range.value = z; draw();
  };
  const pts = new Map(); let pinch = null;
  const local = e => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) * S / b.width, (e.clientY - b.top) * S / b.height]; };
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e)); cv.style.cursor = 'grabbing'; pinch = null; });
  cv.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const [x, y] = local(e), [px, py] = pts.get(e.pointerId); pts.set(e.pointerId, [x, y]);
    if (pts.size === 1) { const k = base * zoom; cx -= (x - px) / k; cy -= (y - py) / k; draw(); return; }
    const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) setZoom(pinch.z * d / pinch.d, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); else pinch = { d, z: zoom };
  });
  const up = e => { pts.delete(e.pointerId); pinch = null; if (!pts.size) cv.style.cursor = 'grab'; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', e => { e.preventDefault(); const [x, y] = local(e); setZoom(zoom * Math.exp(-e.deltaY / 400), x, y); }, { passive: false });
  range.oninput = () => setZoom(+range.value);
  draw();
  return new Promise(resolve => {
    const close = v => { ov.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', key, true);
    ov.querySelector('[data-x]').onclick = () => close(null);
    ov.addEventListener('click', e => { if (e.target === ov) close(null); });
    ov.querySelector('[data-ok]').onclick = () => {
      const out = document.createElement('canvas'); out.width = out.height = size; paint(out, size);
      let q = 0.85, url = out.toDataURL('image/jpeg', q);
      while (url.length > 20000 && q > 0.4) { q -= 0.1; url = out.toDataURL('image/jpeg', q); }
      close(url);
    };
  });
}
// Pick a picture and frame it: resolves with the photo (a JPEG data URL) or null. Shows its own error message.
async function choosePhoto() {
  const file = await pickImageFile(); if (!file) return null;
  let src;
  try { src = await loadPhoto(file); } catch (e) { console.error(e); alert(photoError(e)); return null; }
  return framePhoto(src);
}
// Only ever display a small JPEG data URL – anything else stored in a photo field is ignored
const safePhoto = p => typeof p === 'string' && p.length < 40000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(p) ? p : null;

// ---------- Instruments ----------
// The 12 most common lesson instruments. `low` = the lowest note (Hz) we listen for on instruments whose
// tuning the player controls note by note; no `low` = fixed pitch or chords (piano, guitar, drums): no tuning score.
// A student's `instrument` is one of these keys, or – for anything else – the name the teacher or parent typed.
const INSTRUMENTS = {
  piano:     { label: 'Piano' },
  guitar:    { label: 'Guitar' },
  violin:    { label: 'Violin', low: 180 },
  voice:     { label: 'Voice', low: 75 },
  drums:     { label: 'Drums' },
  cello:     { label: 'Cello', low: 60 },
  flute:     { label: 'Flute', low: 240 },
  clarinet:  { label: 'Clarinet', low: 140 },
  saxophone: { label: 'Saxophone', low: 65 },
  trumpet:   { label: 'Trumpet', low: 155 },
  viola:     { label: 'Viola', low: 120 },
  ukulele:   { label: 'Ukulele' }
};
const OLD_INSTRUMENTS = { other: { label: 'Other', low: 60 } };   // earlier "Other (flute, voice, …)" choice
const instrumentInfo = v => INSTRUMENTS[v] || OLD_INSTRUMENTS[v] || null;
const instrumentLabel = (v, fallback = '') => instrumentInfo(v)?.label || (v ? String(v) : fallback);
const instrumentLow = v => instrumentInfo(v)?.low || 0;           // 0 = no tuning score
// Turn typed text ("Keyboard", "alto sax", "Bb clarinet", "Harp") into a catalog key, or keep the name as typed
const INSTRUMENT_WORDS = [[/pian|keyboard|keys/, 'piano'], [/ukul|uke\b/, 'ukulele'], [/guitar/, 'guitar'], [/viola|vla/, 'viola'],
  [/violin|fiddle|vln/, 'violin'], [/cello|\bvc\b/, 'cello'], [/voice|vocal|sing|choir/, 'voice'], [/drum|percussion/, 'drums'],
  [/flute|piccolo/, 'flute'], [/clarinet/, 'clarinet'], [/sax/, 'saxophone'], [/trumpet|cornet/, 'trumpet']];
function instrumentFrom(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  if (!t) return '';
  const low = t.toLowerCase();
  if (INSTRUMENTS[low]) return low;
  const hit = INSTRUMENT_WORDS.find(([re]) => re.test(low));
  return hit ? hit[1] : t.charAt(0).toUpperCase() + t.slice(1);
}
// <option>s for an instrument <select>, with "Other – type it in" last (value "__other")
const instrumentOptions = (v, placeholder = 'Choose…') => `<option value="" ${v ? '' : 'selected'} disabled>${placeholder}</option>` +
  Object.entries(INSTRUMENTS).sort((a, b) => a[1].label.localeCompare(b[1].label)).map(([k, i]) => `<option value="${k}" ${v === k ? 'selected' : ''}>${i.label}</option>`).join('') +
  `<option value="__other" ${v && !INSTRUMENTS[v] ? 'selected' : ''}>Other – type it in…</option>`;

// ---------- Practice insights: focus, tuning and rhythm ----------
// Scores worked out by listening. A teacher chooses, for the studio and per student, whether each one is shown as a
// number, as a trend only ("Improving", "Steady"), or not at all. The student record carries the result in
// `insights` (e.g. { focus: 'show', tune: 'off', rhythm: 'trend' }), so the family app, reports and emails follow it.
// A parent can also turn tuning off for their child; whichever setting is stricter wins.
const INSIGHTS = {
  focus: {
    label: 'Focus', unit: 'focus',
    what: 'How much of the practice session was spent playing.',
    how: ['While the practice timer runs, Allegrow listens. Minutes where it hears music count as playing; pauses, talking and quiet count as breaks.',
          'Focus = minutes playing ÷ minutes the timer was listening. The app also notes the longest stretch without stopping and how many breaks there were.',
          'Some pauses are part of good practice – fixing a spot, listening back, reading ahead – so a score below 100% is normal.'],
    limits: 'A noisy room or long silent rests in the music can make it read lower than it should.'
  },
  tune: {
    label: 'Tuning', unit: 'in tune',
    what: 'How many notes were in tune.',
    how: ['Each note held for at least 0.15 seconds is checked against the instrument’s own tuning (so a violin tuned a little sharp overall isn’t marked wrong for every note).',
          'A note counts as in tune within 20 cents – one fifth of a half step. The score is in-tune notes ÷ notes checked, shown once at least 10 notes were checked.',
          'Only for instruments where the player shapes every note: violin, viola, cello, voice, flute, clarinet, saxophone and trumpet. Never for piano, guitar, ukulele or drums.'],
    limits: 'It listens through a phone microphone, so echoey rooms, fast passages, double stops and vibrato can make it less accurate. Treat it as a trend, not a grade.'
  },
  rhythm: {
    label: 'Rhythm', unit: 'steady rhythm',
    what: 'How steadily notes landed with the metronome.',
    how: ['Only measured while the app’s metronome is on.',
          'The start of each note is compared with the metronome’s beat grid (eighth notes). A note counts as steady if it lands within 50 milliseconds (less at fast tempos) of where the player usually lands – so a constant delay from the phone’s speaker isn’t held against them.',
          'The score is steady notes ÷ notes played with the metronome, shown once at least 8 notes were played.'],
    limits: 'Rests, syncopation and very soft note starts can be missed or misread.'
  }
};
const INSIGHT_ORDER = ['focus', 'tune', 'rhythm'];
const INSIGHT_MODES = { show: 'Show scores', trend: 'Trends only', off: 'Off' };
const INSIGHT_MODE_ABOUT = { show: 'Percentages, with the change from the week before.', trend: 'No numbers – just “Improving”, “Steady” or “A little lower”.', off: 'Not shown anywhere – not to you, the family or in reports and emails.' };
const insightMode = (ins, m) => INSIGHT_MODES[ins?.[m]] ? ins[m] : 'show';
// Studio defaults + this student's own choices → what everyone sees for this student
const insightsFor = (studioIns, own) => Object.fromEntries(INSIGHT_ORDER.map(m => [m, INSIGHT_MODES[own?.[m]] ? own[m] : insightMode(studioIns, m)]));
// A number-free trend for "Trends only": this week against the week before (in percentage points)
function trendWord(cur, prev) {
  if (cur == null) return null;
  if (prev == null) return { text: 'Getting started', cls: '' };
  const d = Math.round((cur - prev) * 100);
  return d >= 3 ? { text: 'Improving', cls: 'up' } : d <= -3 ? { text: 'A little lower', cls: 'down' } : { text: 'Steady', cls: '' };
}

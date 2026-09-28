// Practice Timer – badges (shared by the family app and the teacher studio)
//
// Badges are earned automatically from practice data. Each badge has levels (tiers); the child always
// sees the next one, so there's always something within reach. Teachers can switch badges off or change
// the thresholds for their studio (studio.badgeRules → mirrored to each student as student.badgeRules).

const BADGE_TIERS = [
  { name: 'Bronze', color: '#b27a4c' },
  { name: 'Silver', color: '#8a97a8' },
  { name: 'Gold', color: '#cf9f2e' },
  { name: 'Platinum', color: '#3f9fb0' },
  { name: 'Diamond', color: '#7a63db' }
];

const BADGES = [
  { id: 'streak', name: 'On a roll', icon: 'flame', tiers: [3, 7, 14, 30, 60], unit: n => `${n} days in a row`,
    about: 'Practice on days in a row. Practice logged by hand counts too.' },
  { id: 'goals', name: 'Goal getter', icon: 'flag', tiers: [1, 10, 25, 50, 100], unit: n => n === 1 ? 'first daily goal' : `${n} daily goals`,
    about: 'Reach your daily goal.' },
  { id: 'hours', name: 'Time invested', icon: 'clock', tiers: [1, 5, 10, 25, 50], unit: n => `${n} ${n === 1 ? 'hour' : 'hours'} practiced`,
    about: 'All your practice time added up.' },
  { id: 'focus', name: 'Deep focus', icon: 'target', tiers: [10, 20, 30, 45], unit: n => `${n} min without stopping`,
    about: 'Play for a long stretch without stopping.' },
  { id: 'tune', name: 'Sweet spot', icon: 'tune', tiers: [80, 88, 94], unit: n => `${n}% in tune in a day`, strings: true,
    about: 'Play most of your notes in tune in one day (at least 50 notes).' },
  { id: 'rhythm', name: 'Steady beat', icon: 'metronome', tiers: [75, 85, 92], unit: n => `${n}% steady with the metronome`,
    about: 'Keep a steady beat with the metronome in one day (at least 40 notes).' },
  { id: 'early', name: 'Early bird', icon: 'sun', tiers: [1, 5, 20], unit: n => `${n} ${n === 1 ? 'morning' : 'mornings'} before 8 am`,
    about: 'Practice before 8 in the morning.' },
  { id: 'weekend', name: 'Weekend warrior', icon: 'calendar', tiers: [1, 4, 12], unit: n => `${n} full ${n === 1 ? 'weekend' : 'weekends'}`,
    about: 'Practice on both Saturday and Sunday.' },
  { id: 'comeback', name: 'Comeback', icon: 'refresh', tiers: [1, 5], unit: n => n === 1 ? 'came back after a break' : `${n} comebacks`,
    about: 'Start again after a few days off – that takes grit.' },
  { id: 'homework', name: 'Homework hero', icon: 'book', tiers: [5, 20, 50, 100], unit: n => `${n} days of assignments`,
    about: 'Tick off your teacher’s assignments.' }
];

// Icons a teacher can pick for a badge they award themselves
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
// goalMs: the daily goal, tickDays: Set of day keys with an assignment ticked
const _addKey = (k, n) => { const [y, m, d] = k.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
const _dow = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

function badgeMetrics({ days, goalMs, tickDays = new Set() }) {
  const on = days.filter(d => d.ms >= 60000).map(d => d.key).sort(), set = new Set(on);
  let best = 0, run = 0, prev = null, comebacks = 0;
  for (const k of on) {
    run = prev && _addKey(prev, 1) === k ? run + 1 : 1; best = Math.max(best, run);
    if (prev && _addKey(prev, 5) <= k) comebacks++;                  // 4+ days off, then back
    prev = k;
  }
  let weekends = 0;
  for (const k of on) if (_dow(k) === 6 && set.has(_addKey(k, 1))) weekends++;
  const m = { streak: best, goals: days.filter(d => d.ms >= goalMs).length, hours: Math.floor(days.reduce((a, d) => a + d.ms, 0) / 36e5),
              focus: 0, tune: 0, rhythm: 0, early: 0, weekend: weekends, comeback: comebacks, homework: tickDays.size };
  for (const d of days) {
    const s = d.stats || {};
    m.focus = Math.max(m.focus, Math.floor((s.longest || 0) / 60000));
    if (s.notes >= 50) m.tune = Math.max(m.tune, Math.floor(100 * s.inTune / s.notes));
    if (s.beats >= 40) m.rhythm = Math.max(m.rhythm, Math.floor(100 * s.steady / s.beats));
    if ((s.early || 0) >= 5 * 60000) m.early++;
  }
  return m;
}

// Which level of each badge is reached, and what's next. rules = { off: {id: true}, tiers: {id: [numbers]} }
function badgeLevels(metrics, rules = {}, { strings = true } = {}) {
  return BADGES.filter(b => !rules.off?.[b.id] && (strings || !b.strings)).map(b => {
    const tiers = (rules.tiers?.[b.id]?.length ? rules.tiers[b.id] : b.tiers).slice(0, BADGE_TIERS.length);
    const value = metrics[b.id] || 0;
    let tier = -1; tiers.forEach((t, i) => { if (value >= t) tier = i; });
    return { ...b, tiers, value, tier, next: tiers[tier + 1] ?? null, prev: tier >= 0 ? tiers[tier] : 0 };
  });
}

function challengeProgress(c, days, goalMs, tickDays = new Set()) {
  const inRange = days.filter(d => d.key >= c.start && d.key <= c.end);
  const on = inRange.filter(d => d.ms >= 60000).map(d => d.key).sort();
  let value = 0;
  if (c.kind === 'days') value = on.length;
  else if (c.kind === 'minutes') value = Math.floor(inRange.reduce((a, d) => a + d.ms, 0) / 60000);
  else if (c.kind === 'goals') value = inRange.filter(d => d.ms >= goalMs).length;
  else if (c.kind === 'metronome') value = inRange.filter(d => (d.stats?.beats || 0) > 0).length;
  else if (c.kind === 'homework') value = [...tickDays].filter(k => k >= c.start && k <= c.end).length;
  else if (c.kind === 'streak') { let run = 0, prev = null; for (const k of on) { run = prev && _addKey(prev, 1) === k ? run + 1 : 1; value = Math.max(value, run); prev = k; } }
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

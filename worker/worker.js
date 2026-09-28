// Allegrow – calendar feeds and teacher emails (runs free on Cloudflare Workers)
//
// It reads the same Firestore documents the apps use (readable only with their long random codes):
//   feeds/{token}      a teacher's calendar/email settings + list of student codes (written by teacher.html)
//   students/{code}    one student: weekly lesson slot, lesson changes, assignments, recitals, mirrored practice
// and provides:
//   GET  /cal/t/{token}.ics   live calendar of all the teacher's lessons and recitals
//   GET  /cal/s/{code}.ics    live calendar of one student's lessons and recitals (for the family)
//   POST /register            remember a teacher's feed so the scheduler emails them
//   POST /test                send a test email now (rate limited)
//   cron (hourly)             teaching-day brief ~1 hour before the first lesson; Sunday 6 pm studio digest
//
// Secret: RESEND_API_KEY. Vars (wrangler.toml): PROJECT_ID, API_KEY, FROM_EMAIL, APP_URL,
// FIRESTORE (only for the local emulator), DRY_RUN ("1" = don't send, and allow /preview for testing).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const validCode = c => /^[a-z0-9-]{20,40}$/.test(c || '');

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      let m;
      if ((m = path.match(/^\/cal\/t\/([a-z0-9-]+)\.ics$/)) && validCode(m[1])) {
        const feed = await getDoc(env, `feeds/${m[1]}`);
        if (!feed) return new Response('Not found', { status: 404 });
        const students = await loadStudents(env, feed);
        return ics(teacherCalendar(feed, students));
      }
      if ((m = path.match(/^\/cal\/s\/([a-z0-9-]+)\.ics$/)) && validCode(m[1])) {
        const s = await getDoc(env, `students/${m[1]}`);
        if (!s) return new Response('Not found', { status: 404 });
        return ics(studentCalendar({ ...s, id: m[1] }));
      }
      if (path === '/register' && req.method === 'POST') {
        const { token } = await req.json();
        if (!validCode(token) || !(await getDoc(env, `feeds/${token}`))) return json({ error: 'unknown feed' }, 404);
        await env.KV.put(`feed:${token}`, '1');
        return json({ ok: true });
      }
      if (path === '/test' && req.method === 'POST') {
        const { token, kind } = await req.json();
        if (!validCode(token) || !['brief', 'digest'].includes(kind)) return json({ error: 'bad request' }, 400);
        if (await env.KV.get(`rl:${token}:${kind}`)) return json({ error: 'Please wait a minute before sending another test.' }, 429);
        const feed = await getDoc(env, `feeds/${token}`);
        if (!feed?.email) return json({ error: 'No email address saved yet.' }, 400);
        await env.KV.put(`rl:${token}:${kind}`, '1', { expirationTtl: 60 });
        const mail = await buildEmail(env, feed, kind, { test: true });
        await sendEmail(env, feed.email, mail.subject, mail.html);
        return json({ ok: true, to: feed.email, subject: mail.subject });
      }
      if (env.DRY_RUN && (m = path.match(/^\/preview\/([a-z0-9-]+)\/(brief|digest)$/))) {
        const feed = await getDoc(env, `feeds/${m[1]}`);
        if (!feed) return new Response('Not found', { status: 404 });
        const mail = await buildEmail(env, feed, m[2], { test: url.searchParams.has('test') });
        return new Response(`<!-- ${mail.subject} -->` + mail.html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (path === '/') return new Response('Allegrow calendar & email service', { headers: CORS });
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: 'Something went wrong' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  }
};

// ============================================================================================
// Firestore (REST, unauthenticated – the security rules allow reading these by their long codes)
// ============================================================================================
function decode(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  return null;
}
async function getDoc(env, path) {
  const base = env.FIRESTORE || 'https://firestore.googleapis.com/v1';
  const r = await fetch(`${base}/projects/${env.PROJECT_ID}/databases/(default)/documents/${path}?key=${env.API_KEY}`);
  if (r.status === 404 || r.status === 403) return null;
  if (!r.ok) throw new Error(`Firestore ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return decode({ mapValue: { fields: j.fields || {} } });
}
async function loadStudents(env, feed) {
  const list = await Promise.all((feed.students || []).filter(validCode).map(async id => { const s = await getDoc(env, `students/${id}`); return s && { ...s, id }; }));
  return list.filter(s => s && !s.archived).sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================================
// Dates in the teacher's time zone. Day keys are 'YYYY-MM-DD'; lesson times are 'HH:MM' local.
// ============================================================================================
function localNow(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { key: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}
const keyDate = k => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addKey = (k, n) => { const d = keyDate(k); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = k => keyDate(k).getUTCDay();
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toMin = t => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
const fmtTime = t => { const [h, m] = t.split(':').map(Number); return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
const fmtDay = k => keyDate(k).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const INSTRUMENTS = { piano: 'Piano', violin: 'Violin', viola: 'Viola', cello: 'Cello', other: 'Music' };

// A student's weekly lesson times, each between a start and (optional) end date – e.g. one per semester
const lessonSlots = s => (Array.isArray(s.slots) && s.slots.length ? s.slots : s.lesson ? [s.lesson] : []).filter(l => l && l.day !== '' && l.day != null && l.time);
const slotOn = (s, key) => lessonSlots(s).find(l => dow(key) === +l.day && (!l.start || key >= l.start) && (!l.end || key <= l.end)) || null;
function lessonsOn(s, key) {
  const L = slotOn(s, key), c = s.lessonChanges?.[key], len = (L || lessonSlots(s)[0])?.length || 30;
  if (c?.status === 'extra') return [{ time: c.time, length: len }];
  if (!L) return [];
  if (c && (c.status === 'cancelled' || c.status === 'moved')) return [];
  return [{ time: L.time, length: len }];
}

// ============================================================================================
// Calendars
// ============================================================================================
const icsEsc = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
const icsFold = line => { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); };
const icsLocal = (key, time) => key.replace(/-/g, '') + 'T' + (time || '12:00').replace(':', '') + '00';
const icsEnd = (key, time, minutes) => { const t = toMin(time) + minutes, k = addKey(key, Math.floor(t / 1440)), r = t % 1440; return icsLocal(k, `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`); };

function calendarText(name, tz, events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const at = (prop, key, time) => tz ? `${prop};TZID=${tz}:${icsLocal(key, time)}` : `${prop}:${icsLocal(key, time)}`;
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Allegrow//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
             'X-WR-CALNAME:' + icsEsc(name), 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', ...(tz ? ['X-WR-TIMEZONE:' + tz] : [])];
  for (const e of events) {
    L.push('BEGIN:VEVENT', 'UID:' + e.uid, 'DTSTAMP:' + stamp, at('DTSTART', e.date, e.time),
           tz ? `DTEND;TZID=${tz}:${icsEnd(e.date, e.time, e.minutes)}` : 'DTEND:' + icsEnd(e.date, e.time, e.minutes), 'SUMMARY:' + icsEsc(e.title));
    if (e.rrule) L.push('RRULE:' + e.rrule);
    for (const x of e.exdates || []) L.push(at('EXDATE', x, e.time));
    if (e.location) L.push('LOCATION:' + icsEsc(e.location));
    if (e.desc) L.push('DESCRIPTION:' + icsEsc(e.desc));
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(icsFold).join('\r\n') + '\r\n';
}
const ics = text => new Response(text, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=900', ...CORS } });

// Lessons for one student: a weekly repeating event (skipping canceled/moved dates) plus one-off extra lessons
function studentLessonEvents(s, title, desc, fromKey) {
  const out = [], ch = s.lessonChanges || {}, len = lessonSlots(s)[0]?.length || 30;
  for (const L of lessonSlots(s)) {                 // one repeating event per lesson time, stopping at its end date
    if (L.end && L.end < fromKey) continue;
    let first = L.start && L.start > fromKey ? L.start : fromKey;
    while (dow(first) !== +L.day) first = addKey(first, 1);
    if (L.end && first > L.end) continue;
    out.push({ uid: `lesson-${s.id}-${first}@practice-timer`, date: first, time: L.time, minutes: L.length || 30, title, desc,
               rrule: 'FREQ=WEEKLY' + (L.end ? `;UNTIL=${addKey(L.end, 1).replace(/-/g, '')}T060000Z` : ''),
               exdates: Object.keys(ch).filter(k => k >= first && dow(k) === +L.day && (!L.end || k <= L.end)) });
  }
  for (const [k, c] of Object.entries(ch)) if (c.status === 'extra' && k >= fromKey)
    out.push({ uid: `extra-${s.id}-${k}@practice-timer`, date: k, time: c.time, minutes: len, title, desc });
  return out;
}
function teacherCalendar(feed, students) {
  const from = addKey(localNow(feed.tz || 'UTC').key, -56), events = [], recitals = {};
  for (const s of students) {
    events.push(...studentLessonEvents(s, `${s.name} – ${INSTRUMENTS[s.instrument] || 'Music'} lesson`, `${s.name}'s lesson`, from));
    for (const [id, e] of Object.entries(s.upcoming || {})) {
      (recitals[id] ??= { ...e, names: [] }).names.push(`${s.name}${e.piece ? ': ' + e.piece : ''}`);
    }
  }
  for (const [id, e] of Object.entries(recitals)) if (e.date >= from)
    events.push({ uid: `event-${id}@practice-timer`, date: e.date, time: e.time || '12:00', minutes: 120, title: e.title, location: e.location, desc: e.names.join('\n') });
  return calendarText(`${feed.studioName} – lessons`, feed.tz, events);
}
function studentCalendar(s) {
  const name = s.kidName || s.name.split(' ')[0], tz = s.tz || null, from = addKey(localNow(tz || 'UTC').key, -56);
  const events = studentLessonEvents(s, `${INSTRUMENTS[s.instrument] || 'Music'} lesson – ${name}`, `With ${s.teacherName}, ${s.studioName}`, from);
  for (const [id, e] of Object.entries(s.upcoming || {})) if (e.date >= from)
    events.push({ uid: `event-${id}-${s.id}@practice-timer`, date: e.date, time: e.time || '12:00', minutes: 90, title: `${e.title} – ${name}`,
                  location: e.location, desc: [e.piece && 'Piece: ' + e.piece, `${s.teacherName}, ${s.studioName}`].filter(Boolean).join('\n') });
  return calendarText(`${name} – music lessons`, tz, events);
}

// ============================================================================================
// Practice numbers (same definitions as the apps)
// ============================================================================================
const minsText = ms => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`; };
const pct = x => x == null ? '–' : Math.round(x * 100) + '%';
function week(s, endKey, offset = 0) {
  const keys = Array.from({ length: 7 }, (_, i) => addKey(endKey, -6 + i - 7 * offset));
  const t = { total: 0, manual: 0, days: 0, active: 0, played: 0, notes: 0, inTune: 0, beats: 0, steady: 0, longest: 0 };
  for (const k of keys) {
    const rec = s.practice?.log?.[k] || 0, man = s.practice?.manual?.[k] || 0, ms = rec + man, st = s.practice?.stats?.[k] || {};
    t.total += ms; t.manual += man; if (ms >= 60000) t.days++;
    if (st.active) { t.active += st.active; t.played += Math.min(rec, st.active); }
    t.notes += st.notes || 0; t.inTune += st.inTune || 0; t.beats += st.beats || 0; t.steady += st.steady || 0; t.longest = Math.max(t.longest, st.longest || 0);
  }
  return { ...t, focus: t.active >= 60000 ? t.played / t.active : null, tune: t.notes >= 10 ? t.inTune / t.notes : null, rhythm: t.beats >= 8 ? t.steady / t.beats : null };
}
function lastPracticed(s, todayKey) {
  for (let i = 0; i < 60; i++) { const k = addKey(todayKey, -i); if ((s.practice?.log?.[k] || 0) + (s.practice?.manual?.[k] || 0) >= 60000) return i; }
  return null;
}
const CHALLENGE_LABELS = { days: 'Practice on {n} days', minutes: 'Practice {n} minutes in total', goals: 'Reach the daily goal {n} times',
  streak: 'Practice {n} days in a row', metronome: 'Use the metronome on {n} days', homework: 'Tick off assignments on {n} days' };
// Weekly plan (minutes per weekday, Sunday first; 0 = rest). The family's shared plan wins, then the teacher's.
const planOf = s => { const p = s.practice?.plan || s.plan; return Array.isArray(p) && p.length === 7 ? p : Array(7).fill(s.target || 20); };
const plannedDays = s => planOf(s).filter(n => n > 0).length;
const currentAssignment = s => Object.values(s.assignments || {}).filter(a => a.status === 'active').sort((a, b) => (a.due || '9').localeCompare(b.due || '9'))[0];
const first = n => (n || '').split(' ')[0];
function nextLessonAfter(s, fromKey, days = 14) {
  for (let i = 1; i <= days; i++) { const k = addKey(fromKey, i); if (lessonsOn(s, k).length) return k; }
  return null;
}

// ============================================================================================
// Emails
// ============================================================================================
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function layout(env, feed, heading, intro, body, why) {
  const app = (env.APP_URL || '') + 'teacher.html';
  return `<!doctype html><html><body style="margin:0;background:#f6f3ee;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1e2a44">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:18px;padding:28px 26px" cellspacing="0" cellpadding="0"><tr><td>
    <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6e7385">${esc(feed.studioName)}</div>
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;margin:6px 0 6px;font-weight:600">${heading}</h1>
    <p style="margin:0 0 18px;color:#3d4760;font-size:15px;line-height:1.5">${intro}</p>
    ${body}
    <p style="margin:24px 0 0"><a href="${app}" style="display:inline-block;background:#1e2a44;color:#f6f3ee;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:12px;font-size:15px">Open your studio</a></p>
  </td></tr></table>
  <p style="max-width:560px;font-size:12px;color:#8a8f9e;line-height:1.5;margin:14px auto 0">${why} Change this in your studio: Settings → Calendar &amp; email.</p>
  </td></tr></table></body></html>`;
}
const row = (left, title, lines) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #e9e3da"><tr>
  ${left ? `<td style="padding:12px 12px 12px 0;width:72px;vertical-align:top;font-weight:700;font-size:14px;white-space:nowrap">${left}</td>` : ''}
  <td style="padding:12px 0;vertical-align:top"><div style="font-weight:700;font-size:15px">${title}</div>${lines.filter(Boolean).map(l => `<div style="font-size:14px;color:#3d4760;margin-top:3px;line-height:1.45">${l}</div>`).join('')}</td></tr></table>`;
const section = (title, inner) => `<h2 style="font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6e7385;margin:22px 0 4px">${title}</h2>${inner}`;
const good = t => `<span style="color:#23865f;font-weight:600">${t}</span>`;
const trendTxt = (a, b) => { if (a == null || b == null) return ''; const d = Math.round((a - b) * 100); return d >= 3 ? ' ' + good(`↑${d}`) : ''; };

// One line that tells the teacher how the week went, in the order a teacher cares about (numbers only – safe as HTML)
function weekLine(s, todayKey) {
  if (!s.linkedAt) return 'Not connected to the app yet';
  const c = week(s, todayKey), p = week(s, todayKey, 1), parts = [`${c.days} of ${plannedDays(s)} planned days · ${minsText(c.total)}${c.manual ? ` <span style="color:#6e7385">(${minsText(c.manual)} by hand)</span>` : ''}`];
  if (c.focus != null) parts.push(`focus ${pct(c.focus)}${trendTxt(c.focus, p.focus)}`);
  if (s.instrument !== 'piano' && c.tune != null) parts.push(`in tune ${pct(c.tune)}${trendTxt(c.tune, p.tune)}`);
  if (c.rhythm != null) parts.push(`rhythm ${pct(c.rhythm)}${trendTxt(c.rhythm, p.rhythm)}`);
  return parts.join(' · ');
}
function assignmentLine(s, todayKey) {
  const a = currentAssignment(s); if (!a) return '';
  const ticks = Object.keys(s.progress?.[a.id] || {}).filter(k => k > addKey(todayKey, -7)).length;
  return `Working on: ${esc(a.title)}${s.linkedAt ? ` <span style="color:#6e7385">(${ticks ? `ticked ${ticks} ${ticks === 1 ? 'day' : 'days'} this week` : 'not ticked yet this week'})</span>` : ''}`;
}

async function buildEmail(env, feed, kind, { test = false } = {}) {
  const tz = feed.tz || 'UTC', now = localNow(tz), students = await loadStudents(env, feed);
  return kind === 'brief' ? briefEmail(env, feed, students, now, test) : digestEmail(env, feed, students, now, test);
}

// Teaching-day brief: just the students you're about to see, one or two lines each
function briefEmail(env, feed, students, now, test) {
  let day = now.key, lessons = todaysLessons(students, day);
  if (test && !lessons.length) for (let i = 1; i <= 7 && !lessons.length; i++) { day = addKey(now.key, i); lessons = todaysLessons(students, day); }
  const when = day === now.key ? 'Today' : DAYS[dow(day)];
  const body = lessons.length ? lessons.map(({ s, time, length }) => {
    const lp = s.linkedAt ? lastPracticed(s, now.key) : null;
    return row(fmtTime(time), `${esc(s.name)} <span style="font-weight:500;color:#6e7385">· ${esc(INSTRUMENTS[s.instrument] || '')} · ${length} min</span>`, [
      weekLine(s, now.key), assignmentLine(s, now.key),
      s.linkedAt && (lp == null || lp >= 4) ? `<span style="color:#c0612b">Hasn’t practiced for ${lp == null ? 'a while' : lp + ' days'} – worth a gentle check-in.</span>` : ''
    ]);
  }).join('') : '<p style="color:#6e7385">No lessons scheduled in the next week.</p>';
  const n = lessons.length;
  return {
    subject: `${test ? '[Test] ' : ''}${when}: ${n} ${n === 1 ? 'lesson' : 'lessons'}${n ? `, first at ${fmtTime(lessons[0].time)}` : ''}`,
    html: layout(env, feed, `${when}’s lessons`, n ? `Here’s how each student’s week has gone, so you can walk in ready.` : '', body,
                 'You get this about an hour before your first lesson, only on days you teach.')
  };
}
function todaysLessons(students, key) {
  return students.flatMap(s => lessonsOn(s, key).map(l => ({ s, ...l }))).sort((a, b) => toMin(a.time) - toMin(b.time));
}

// Sunday digest: a few wins, who could use a nudge (with a ready-to-send message), what's coming up
function digestEmail(env, feed, students, now, test) {
  const linked = students.filter(s => s.linkedAt), weeks = linked.map(s => ({ s, c: week(s, now.key), p: week(s, now.key, 1) }));
  const total = weeks.reduce((a, w) => a + w.c.total, 0), prevTotal = weeks.reduce((a, w) => a + w.p.total, 0);
  const wins = [];
  for (const { s, c, p } of weeks) {
    const planned = plannedDays(s);
    if (planned && c.days >= planned) wins.push([90, `${esc(first(s.name))} practiced on ${c.days > planned ? `${c.days} days – more than the ${planned} planned` : `every planned day (${planned})`}.`]);
    if (s.instrument !== 'piano' && c.tune != null && p.tune != null && c.tune - p.tune >= 0.05) wins.push([80, `${esc(first(s.name))}’s tuning improved from ${pct(p.tune)} to ${pct(c.tune)}.`]);
    if (c.rhythm != null && p.rhythm != null && c.rhythm - p.rhythm >= 0.05) wins.push([75, `${esc(first(s.name))}’s rhythm got steadier: ${pct(p.rhythm)} → ${pct(c.rhythm)}.`]);
    if (p.total > 0 && c.total >= p.total * 1.5 && c.total - p.total >= 20 * 60000) wins.push([65, `${esc(first(s.name))} practiced ${minsText(c.total - p.total)} more than last week.`]);
    // badges and teacher challenges completed this week (reported by the family app)
    for (const b of Object.values(s.badges || {})) if (b.date > addKey(now.key, -7) && b.tier >= 1) wins.push([70 + 3 * b.tier, `${esc(first(s.name))} earned ${esc(b.label)}.`]);
    for (const [id, d] of Object.entries(s.challengeDone || {})) if (d > addKey(now.key, -7) && s.challenges?.[id])
      wins.push([88, `${esc(first(s.name))} completed your challenge “${esc(s.challenges[id].title || CHALLENGE_LABELS[s.challenges[id].kind]?.replace('{n}', s.challenges[id].target) || 'Challenge')}”.`]);
    const done = Object.values(s.assignments || {}).filter(a => a.status === 'done' && a.completed && a.completed > addKey(now.key, -7));
    for (const a of done) wins.push([60, `${esc(first(s.name))} finished “${esc(a.title)}”.`]);
    if (planned && c.days === planned - 1 && c.days >= 3) wins.push([50, `${esc(first(s.name))} practiced ${c.days} of ${planned} planned days.`]);
  }
  const topWins = wins.sort((a, b) => b[0] - a[0]).slice(0, 3).map(w => w[1]);
  const nudges = weeks.filter(({ s, c }) => c.days <= Math.min(1, plannedDays(s) - 2)).sort((a, b) => a.c.total - b.c.total).slice(0, 3);
  const upcoming = Object.values(Object.fromEntries(students.flatMap(s => Object.entries(s.upcoming || {}).map(([id, e]) => [id, e]))))
    .filter(e => e.date >= now.key && e.date <= addKey(now.key, 21)).sort((a, b) => a.date.localeCompare(b.date));
  const lessonsNext = Array.from({ length: 7 }, (_, i) => todaysLessons(students, addKey(now.key, i + 1)).length).reduce((a, b) => a + b, 0);
  const unlinked = students.length - linked.length;

  let body = '';
  body += section('This week’s wins', topWins.length ? topWins.map(w => `<p style="margin:8px 0;font-size:15px;line-height:1.5">★ ${w}</p>`).join('')
    : `<p style="margin:8px 0;font-size:15px;color:#3d4760">A quieter week across the studio – that happens. A fresh week starts tomorrow.</p>`);
  if (nudges.length) body += section('Could use a nudge', nudges.map(({ s }) => {
    const a = currentAssignment(s), nl = nextLessonAfter(s, now.key);
    const msg = `Hi! Just a friendly note from ${feed.teacherName}: ${first(s.name)} has had a quieter week. Even 10 minutes a day${a ? ` on ${a.title}` : ''}${nl ? ` before ${DAYS[dow(nl)]}’s lesson` : ''} would make a real difference. Thank you!`;
    return row('', esc(s.name), [weekLine(s, now.key),
      `<div style="background:#f6f3ee;border-radius:10px;padding:10px 12px;margin-top:6px;color:#1e2a44">${esc(msg)}</div><div style="font-size:12px;color:#8a8f9e;margin-top:4px">Suggested message – copy it to the family if you like.</div>`]);
  }).join(''));
  body += section('Coming up', [
    `<p style="margin:8px 0;font-size:15px">${lessonsNext} ${lessonsNext === 1 ? 'lesson' : 'lessons'} next week.</p>`,
    ...upcoming.map(e => `<p style="margin:8px 0;font-size:15px"><b>${esc(e.title)}</b> · ${fmtDay(e.date)}${e.time ? ' at ' + fmtTime(e.time) : ''}</p>`),
    unlinked ? `<p style="margin:8px 0;font-size:14px;color:#6e7385">${unlinked} ${unlinked === 1 ? 'student hasn’t' : 'students haven’t'} connected the app yet – their invite link is on their page.</p>` : ''
  ].join(''));
  const change = prevTotal ? (total >= prevTotal ? ` (up from ${minsText(prevTotal)})` : '') : '';
  return {
    subject: `${test ? '[Test] ' : ''}Your studio this week: ${minsText(total)} of practice`,
    html: layout(env, feed, 'Your week in the studio', `${linked.length ? `Your students practiced <b>${minsText(total)}</b> this week${change}.` : 'Once families connect the app, their practice shows up here.'}`, body,
                 'You get this on Sunday evenings.')
  };
}

async function sendEmail(env, to, subject, html) {
  if (env.DRY_RUN) { console.log(`[dry run] email to ${to}: ${subject}`); return { dryRun: true }; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html })
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  return r.json();
}

// ============================================================================================
// Scheduler (hourly): brief when the first lesson is 30–90 minutes away; digest on Sunday at 6 pm
// ============================================================================================
async function runSchedule(env) {
  let cursor, sent = [];
  do {
    const page = await env.KV.list({ prefix: 'feed:', cursor });
    for (const k of page.keys) {
      const token = k.name.slice(5);
      try { sent.push(...await processFeed(env, token)); } catch (e) { console.error('feed', token.slice(0, 5), e.message); }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return sent;
}
async function processFeed(env, token) {
  const feed = await getDoc(env, `feeds/${token}`);
  if (!feed) { await env.KV.delete(`feed:${token}`); return []; }
  if (!feed.email || (!feed.brief && !feed.digest)) return [];
  const tz = feed.tz || 'UTC', now = localNow(tz), out = [];
  if (feed.brief) {
    const key = `sent:brief:${token}:${now.key}`;
    if (!(await env.KV.get(key))) {
      const students = await loadStudents(env, feed), lessons = todaysLessons(students, now.key);
      const until = lessons.length ? toMin(lessons[0].time) - now.minutes : -1;
      if (until > 30 && until <= 90) {
        const mail = briefEmail(env, feed, students, now, false);
        await sendEmail(env, feed.email, mail.subject, mail.html);
        await env.KV.put(key, '1', { expirationTtl: 172800 });
        out.push(['brief', mail.subject]);
      }
    }
  }
  if (feed.digest && dow(now.key) === 0 && now.minutes >= 18 * 60 && now.minutes < 19 * 60) {
    const key = `sent:digest:${token}:${now.key}`;
    if (!(await env.KV.get(key))) {
      const mail = await buildEmail(env, feed, 'digest');
      await sendEmail(env, feed.email, mail.subject, mail.html);
      await env.KV.put(key, '1', { expirationTtl: 172800 });
      out.push(['digest', mail.subject]);
    }
  }
  return out;
}

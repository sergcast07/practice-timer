// AlleGrow – calendar feeds and teacher emails (runs free on Cloudflare Workers)
//
// It reads the same Firestore documents the apps use (readable only with their long random codes):
//   feeds/{token}      a teacher's calendar/email settings + list of student codes (written by studio.html)
//   students/{code}    one student: weekly lesson slot, lesson changes, assignments, recitals, mirrored practice
// and provides:
//   GET  /cal/t/{token}.ics   live calendar of all the teacher's lessons and recitals
//   GET  /cal/s/{code}.ics    live calendar of one student's lessons and recitals (for the family)
//   POST /register            remember a teacher's feed so the scheduler emails them
//   POST /test                send a test email now (rate limited)
//   POST /parents/link        a signed-in parent (family app) – remember their verified email for their family
//   POST /parents/prefs       turn their weekly family summary on/off      POST /parents/test   send one now
//   POST /parents/unlink      forget a parent                               GET /parents/unsubscribe  (link in emails)
//   POST /parents/pin-code    email a PIN reset code to a family's parents  POST /parents/pin-verify  check it
//   POST /bill/test           a sample payment reminder to the teacher      GET /bill/unsubscribe  (link in reminders)
//   cron (hourly)             teaching-day brief ~1 hour before the first lesson; Sunday 6 pm studio digest;
//                             Sunday 6 pm family summaries (parent's own time zone); payment reminders ~9 am
//
// Parents prove who they are with their Firebase sign-in token: reading their own parents/{uid} record with it succeeds only
// if the token is genuine and theirs (Firestore checks it). Their email comes from that token, so it's a verified address.
//
// Secrets: RESEND_API_KEY, PARENT_SECRET (signs unsubscribe links). Vars (wrangler.toml): PROJECT_ID, API_KEY, FROM_EMAIL, APP_URL,
// FIRESTORE (only for the local emulator), DRY_RUN ("1" = don't send, and allow /preview for testing).

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const TEST_SENDER = /onboarding@resend\.dev/;
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
      if (path.startsWith('/parents/')) return await parentsApi(req, env, url);
      if (path.startsWith('/bill/')) return await billApi(req, env, url);
      if (env.DRY_RUN && (m = path.match(/^\/preview\/([a-z0-9-]+)\/(brief|digest)$/))) {
        const feed = await getDoc(env, `feeds/${m[1]}`);
        if (!feed) return new Response('Not found', { status: 404 });
        const mail = await buildEmail(env, feed, m[2], { test: url.searchParams.has('test') });
        return new Response(`<!-- ${mail.subject} -->` + mail.html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (path === '/') return new Response('AlleGrow calendar & email service', { headers: CORS });
      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: 'Something went wrong' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
    ctx.waitUntil(runParents(env));
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
// Family records are readable only by the family's own members, so the weekly family summary reads them as the service
// itself: a Google service account (secret FIREBASE_SA = the key's JSON) signs a short-lived token. Everything else is
// readable by its long random code. (The local emulator accepts "owner".)
const toB64url = b => btoa(typeof b === 'string' ? b : String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
let saCache = null;
async function serviceToken(env) {
  if (env.FIRESTORE) return 'owner';
  if (!env.FIREBASE_SA) return null;
  if (saCache && saCache.exp > Date.now() + 120000) return saCache.token;
  const sa = JSON.parse(env.FIREBASE_SA), now = Math.floor(Date.now() / 1000);
  const body = `${toB64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${toB64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const jwt = `${body}.${toB64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body)))}`;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}` });
  const j = await r.json();
  if (!j.access_token) throw new Error('service account: ' + JSON.stringify(j).slice(0, 200));
  saCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return saCache.token;
}
async function getDoc(env, path) {
  const base = env.FIRESTORE || 'https://firestore.googleapis.com/v1';
  const token = path.startsWith('families/') ? await serviceToken(env) : null;
  const r = await fetch(`${base}/projects/${env.PROJECT_ID}/databases/(default)/documents/${path}?key=${env.API_KEY}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
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
// Same keys as the app's list (badges.js); anything else is an instrument name the teacher or parent typed
const INSTRUMENTS = { piano: 'Piano', guitar: 'Guitar', violin: 'Violin', voice: 'Voice', drums: 'Drums', cello: 'Cello', flute: 'Flute',
  clarinet: 'Clarinet', saxophone: 'Saxophone', trumpet: 'Trumpet', viola: 'Viola', ukulele: 'Ukulele', other: 'Music' };
const instLabel = (v, fallback = '') => INSTRUMENTS[v] || (v ? String(v).slice(0, 30) : fallback);

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
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AlleGrow//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
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
    events.push(...studentLessonEvents(s, `${s.name} – ${instLabel(s.instrument, 'Music')} lesson`, `${s.name}'s lesson`, from));
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
  const events = studentLessonEvents(s, `${instLabel(s.instrument, 'Music')} lesson – ${name}`, `With ${s.teacherName}, ${s.studioName}`, from);
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
// A day's total, with a teacher's correction (student.practiceEdits) applied – see the studio's practiceEditModal
function dayMs(s, k) {
  const raw = (s.practice?.log?.[k] || 0) + (s.practice?.manual?.[k] || 0), e = s.practiceEdits?.[k];
  return e ? Math.max(0, e.ms + raw - e.was) : raw;
}
function week(s, endKey, offset = 0) {
  const keys = Array.from({ length: 7 }, (_, i) => addKey(endKey, -6 + i - 7 * offset));
  const t = { total: 0, manual: 0, days: 0, active: 0, played: 0, notes: 0, inTune: 0, beats: 0, steady: 0, longest: 0 };
  for (const k of keys) {
    const rec = s.practice?.log?.[k] || 0, ms = dayMs(s, k), man = s.practiceEdits?.[k] ? Math.max(0, ms - rec) : s.practice?.manual?.[k] || 0, st = s.practice?.stats?.[k] || {};
    t.total += ms; t.manual += man; if (ms >= 60000) t.days++;
    if (st.active) { t.active += st.active; t.played += Math.min(rec, st.active); }
    t.notes += st.notes || 0; t.inTune += st.inTune || 0; t.beats += st.beats || 0; t.steady += st.steady || 0; t.longest = Math.max(t.longest, st.longest || 0);
  }
  return { ...t, focus: t.active >= 60000 ? t.played / t.active : null, tune: t.notes >= 10 ? t.inTune / t.notes : null, rhythm: t.beats >= 8 ? t.steady / t.beats : null };
}
function lastPracticed(s, todayKey) {
  for (let i = 0; i < 60; i++) { const k = addKey(todayKey, -i); if (dayMs(s, k) >= 60000) return i; }
  return null;
}
// Music theory (the family app's theory.js): names for level-ups in emails
const THEORY_NAMES = { notes: 'Note names', rhythm: 'Rhythm', symbols: 'Symbols & terms', keys: 'Key signatures', intervals: 'Intervals', chords: 'Chords', echo: 'Echo' };
function theoryWeek(t, todayKey) {
  const since = addKey(todayKey, -6), T = t?.practice?.theory || t?.theory || {};
  const rounds = (T.rounds || []).filter(r => r.at.slice(0, 10) >= since), ups = (T.ups || []).filter(u => u.at.slice(0, 10) >= since);
  return { rounds: rounds.length, passed: rounds.filter(r => r.right >= 8 * r.total / 10).length, ups };
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
  const app = (env.APP_URL || '') + 'studio';
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
// Practice insights: the teacher's choice per student (show / trend / off), copied onto the student by the studio
const insMode = (s, m) => ['show', 'trend', 'off'].includes(s.insights?.[m]) ? s.insights[m] : 'show';
const trendWordTxt = (a, b) => { if (b == null) return 'getting started'; const d = Math.round((a - b) * 100); return d >= 3 ? good('improving') : d <= -3 ? 'a little lower' : 'steady'; };
const scoreTxt = (s, m, label, c, p) => c[m] == null || insMode(s, m) === 'off' ? null
  : insMode(s, m) === 'trend' ? `${label} ${trendWordTxt(c[m], p[m])}` : `${label} ${pct(c[m])}${trendTxt(c[m], p[m])}`;
const trendTxt = (a, b) => { if (a == null || b == null) return ''; const d = Math.round((a - b) * 100); return d >= 3 ? ' ' + good(`↑${d}`) : ''; };

// One line that tells the teacher how the week went, in the order a teacher cares about (numbers only – safe as HTML)
function weekLine(s, todayKey) {
  if (!s.linkedAt) return s.consent?.withdrawnAt ? `Family disconnected on ${fmtDay(s.consent.withdrawnAt.slice(0, 10))}` : 'Not connected to the app yet';
  const c = week(s, todayKey), p = week(s, todayKey, 1), parts = [`${c.days} of ${plannedDays(s)} planned days · ${minsText(c.total)}${c.manual ? ` <span style="color:#6e7385">(${minsText(c.manual)} by hand)</span>` : ''}`];
  for (const [m, label] of [['focus', 'focus'], ['tune', 'in tune'], ['rhythm', 'rhythm']]) { const t = scoreTxt(s, m, label, c, p); if (t) parts.push(t); }
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
    return row(fmtTime(time), `${esc(s.name)} <span style="font-weight:500;color:#6e7385">· ${esc(instLabel(s.instrument, ''))} · ${length} min</span>`, [
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
    const num = m => insMode(s, m) === 'show';
    if (insMode(s, 'tune') !== 'off' && c.tune != null && p.tune != null && c.tune - p.tune >= 0.05) wins.push([80, `${esc(first(s.name))}’s tuning improved${num('tune') ? ` from ${pct(p.tune)} to ${pct(c.tune)}` : ''}.`]);
    if (insMode(s, 'rhythm') !== 'off' && c.rhythm != null && p.rhythm != null && c.rhythm - p.rhythm >= 0.05) wins.push([75, `${esc(first(s.name))}’s rhythm got steadier${num('rhythm') ? `: ${pct(p.rhythm)} → ${pct(c.rhythm)}` : ''}.`]);
    if (p.total > 0 && c.total >= p.total * 1.5 && c.total - p.total >= 20 * 60000) wins.push([65, `${esc(first(s.name))} practiced ${minsText(c.total - p.total)} more than last week.`]);
    // badges and teacher challenges completed this week (reported by the family app)
    for (const b of Object.values(s.badges || {})) if (b.date > addKey(now.key, -7) && b.tier >= 1) wins.push([70 + 3 * b.tier, `${esc(first(s.name))} earned ${esc(b.label)}.`]);
    for (const [id, d] of Object.entries(s.challengeDone || {})) if (d > addKey(now.key, -7) && s.challenges?.[id])
      wins.push([88, `${esc(first(s.name))} completed your challenge “${esc(s.challenges[id].title || CHALLENGE_LABELS[s.challenges[id].kind]?.replace('{n}', s.challenges[id].target) || 'Challenge')}”.`]);
    for (const u of theoryWeek(s, now.key).ups) wins.push([72, `${esc(first(s.name))} reached ${esc(THEORY_NAMES[u.deck] || 'theory')} level ${u.level} in music theory.`]);
    const done = Object.values(s.assignments || {}).filter(a => a.status === 'done' && a.completed && a.completed > addKey(now.key, -7));
    for (const a of done) wins.push([60, `${esc(first(s.name))} finished “${esc(a.title)}”.`]);
    if (planned && c.days === planned - 1 && c.days >= 3) wins.push([50, `${esc(first(s.name))} practiced ${c.days} of ${planned} planned days.`]);
  }
  const topWins = wins.sort((a, b) => b[0] - a[0]).slice(0, 3).map(w => w[1]);
  const nudges = weeks.filter(({ s, c }) => c.days <= Math.min(1, plannedDays(s) - 2)).sort((a, b) => a.c.total - b.c.total).slice(0, 3);
  const upcoming = Object.values(Object.fromEntries(students.flatMap(s => Object.entries(s.upcoming || {}).map(([id, e]) => [id, e]))))
    .filter(e => e.date >= now.key && e.date <= addKey(now.key, 21)).sort((a, b) => a.date.localeCompare(b.date));
  const lessonsNext = Array.from({ length: 7 }, (_, i) => todaysLessons(students, addKey(now.key, i + 1)).length).reduce((a, b) => a + b, 0);
  const left = students.filter(s => !s.linkedAt && s.consent?.withdrawnAt && s.consent.withdrawnAt.slice(0, 10) > addKey(now.key, -7));
  const unlinked = students.length - linked.length - left.length;

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
    ...left.map(s => `<p style="margin:8px 0;font-size:14px;color:#c0612b">${esc(s.name)}’s family disconnected from your studio on ${fmtDay(s.consent.withdrawnAt.slice(0, 10))}${s.consent.removedData ? ' and removed the practice they’d shared' : ''}. You can archive ${esc(first(s.name))} in AlleGrow Studio.</p>`),
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
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, html, ...(env.REPLY_TO ? { reply_to: env.REPLY_TO } : {}) })
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
  const tz = feed.tz || 'UTC', now = localNow(tz), out = [];
  out.push(...await runBillReminders(env, feed, now));
  if (!feed.email || (!feed.brief && !feed.digest)) return out;
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


// ============================================================================================
// Parents (family app): weekly family summary and PIN reset codes
// KV: parent:{uid} = { family, email, name, tz, weekly }   fam:{family}:{uid} = '1' (which parents a family has)
// ============================================================================================
const b64url = t => { t = t.replace(/-/g, '+').replace(/_/g, '/'); return atob(t + '='.repeat((4 - t.length % 4) % 4)); };
async function verifyParent(env, idToken) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) return null;
  let claims; try { claims = JSON.parse(b64url(idToken.split('.')[1])); } catch { return null; }
  const uid = claims.user_id || claims.sub;
  if (!uid || !/^[A-Za-z0-9]{6,128}$/.test(uid)) return null;
  const base = env.FIRESTORE || 'https://firestore.googleapis.com/v1';
  const r = await fetch(`${base}/projects/${env.PROJECT_ID}/databases/(default)/documents/parents/${uid}?key=${env.API_KEY}`, { headers: { Authorization: `Bearer ${idToken}` } });
  if (!r.ok) return null;                                    // not their record, expired or fake token
  const rec = decode({ mapValue: { fields: (await r.json()).fields || {} } });
  if (!claims.email || !validCode(rec.family)) return null;
  // Email + password (and some Microsoft) accounts start unconfirmed: we don't email an address until its owner confirms it
  return { uid, email: claims.email, name: claims.name || rec.name || '', family: rec.family, unverified: claims.email_verified !== true };
}
async function hmac(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PARENT_SECRET || 'dev-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)))].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
const sha = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');
const getJSON = async (env, key) => JSON.parse(await env.KV.get(key) || 'null');
const validTz = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
// Resend's shared test sender only delivers to the Resend account's own address
const sendError = e => TEST_SENDER.test(String(e?.message)) || /only send testing emails/i.test(String(e?.message))
  ? 'AlleGrow can’t email this address yet (the email service is still in test mode). Please try again later.' : 'Couldn’t send the email. Please try again.';

// ============================================================================================
// Payment reminders (teacher's billing): around 9 am in the teacher's time zone, for each student with billing emails.
// The studio keeps students/{sid}.billShare up to date: open charges with due dates ({text, date, due, amount, open}),
// upcoming flat fees, the balance, the payment link and how to pay. The feed holds the schedule (bill) and addresses (billTo).
// KV: sent:bill:{sid}:{day} (one reminder per student per day), billoff:{sid}:{email hash} (unsubscribed)
// ============================================================================================
const money = (n, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Math.round((n || 0) * 100) / 100);
const dayDiff = (a, b) => Math.round((keyDate(a) - keyDate(b)) / 864e5);
// What to say today. Overdue notices follow the teacher's choice (R.overdueMode):
//   'auto'   – start `after` days past a charge's due date;
//   'marked' – only for charges the teacher marked past due in the studio (billShare.pastDue = the day they did; charges due before it);
//   'off'    – none.
// Then again every `every` days (0 = just once), up to `max` notices, while something stays overdue. state = { ref, last, count }
// is kept per student (KV) so notices keep their rhythm; returns { rem: {kind, overdue, dueToday, soon} | null, state }.
function reminderFor(bs, R, today, state = null) {
  if (!bs) return { rem: null, state };
  const open = (bs.items || []).filter(i => i.open > 0.004);
  const mode = R.overdueMode || (R.every > 0 ? 'auto' : 'off'), after = R.after ?? (R.every || 7);
  const late = mode === 'marked' ? open.filter(i => bs.pastDue && i.due < bs.pastDue && i.due < today)
    : mode === 'auto' ? open.filter(i => dayDiff(today, i.due) >= Math.max(1, after)) : [];
  const dueToday = open.filter(i => i.due === today), soonDay = R.before > 0 ? addKey(today, R.before) : null;
  const soon = soonDay ? [...open, ...(bs.upcoming || []).map(u => ({ ...u, open: u.amount }))].filter(i => i.due === soonDay) : [];
  let next = late.length ? state : null, nudge = false;
  if (late.length) {
    const ref = mode === 'marked' ? bs.pastDue : state?.ref || today;          // a new marking starts a new round of notices
    if (!state || state.ref !== ref) { nudge = true; next = { ref, last: today, count: 1 }; }
    else if (R.every > 0 && dayDiff(today, state.last) >= R.every && state.count < (R.max || 3)) { nudge = true; next = { ...state, last: today, count: state.count + 1 }; }
  }
  const pack = kind => ({ kind, overdue: late, dueToday, soon });
  if (nudge) return { rem: pack('overdue'), state: next };
  if (R.onDue !== false && dueToday.length) return { rem: pack('due'), state: next };
  if (soon.length) return { rem: pack('soon'), state: next };
  return { rem: null, state: next };
}
async function billEmail(env, feed, s, rem, to, { test } = {}) {
  const bs = s.billShare, cur = bs.currency || 'USD', first = String(s.name || '').split(' ')[0] || 'your child', who = feed.teacherName || feed.studioName || 'your teacher';
  const sum = list => list.reduce((a, i) => a + (i.open ?? i.amount), 0);
  const row = (i, note) => `<tr><td style="padding:7px 0;border-bottom:1px solid #eee;font-size:14px">${esc(i.text)}<div style="color:#8a8f9e;font-size:12.5px">${note}</div></td>
    <td style="padding:7px 0;border-bottom:1px solid #eee;text-align:right;font-size:14px;white-space:nowrap">${money(i.open ?? i.amount, cur)}</td></tr>`;
  const due = sum(rem.overdue) + sum(rem.dueToday);
  const subject = test ? `Sample reminder: ${first}’s lessons` : rem.kind === 'overdue' ? `Overdue: ${money(sum(rem.overdue), cur)} for ${first}’s lessons`
    : rem.kind === 'due' ? `Due today: ${money(due, cur)} for ${first}’s lessons` : `Coming up: ${money(sum(rem.soon), cur)} due ${fmtDay(rem.soon[0].due)} for ${first}’s lessons`;
  const heading = rem.kind === 'overdue' ? 'A payment is overdue' : rem.kind === 'due' ? 'A payment is due today' : 'A payment is coming up';
  const rows = [...rem.overdue.map(i => row(i, `Was due ${fmtDay(i.due)}`)), ...rem.dueToday.map(i => row(i, 'Due today')), ...rem.soon.map(i => row(i, `Due ${fmtDay(i.due)}`))].join('');
  const link = /^https?:\/\//i.test(bs.payLink || '') ? bs.payLink : '';
  const body = `${feed.bill?.message ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;white-space:pre-line">${esc(feed.bill.message)}</p>` : ''}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table>
    <p style="margin:14px 0 0;font-size:15px"><b>${due > 0 ? `Due now: ${money(due, cur)}` : `Balance: ${money(bs.balance, cur)}`}</b></p>
    ${link ? `<p style="margin:18px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#23865f;color:#fff;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:12px;font-size:15px">Pay ${esc(who)}</a></p>` : ''}
    ${bs.payNote || (!link && bs.payLink) ? `<p style="margin:14px 0 0;font-size:14px;color:#3d4760;white-space:pre-line"><b>How to pay:</b> ${esc([bs.payNote, link ? '' : bs.payLink].filter(Boolean).join('\n'))}</p>` : ''}
    <p style="margin:14px 0 0;font-size:12.5px;color:#8a8f9e">Balance as of ${fmtDay(bs.asOf)}. Already paid? Thank you – it may not be recorded yet.</p>`;
  const off = `${env.WORKER_URL || ''}/bill/unsubscribe?s=${encodeURIComponent(s.id)}&e=${encodeURIComponent(to)}&k=${await hmac(env, `billoff:${s.id}:${to}`)}`;
  const intro = `From ${esc(who)}${feed.studioName && feed.studioName !== who ? ` (${esc(feed.studioName)})` : ''} about ${esc(first)}’s lessons.`;
  return { subject, html: parentLayout(env, heading, intro, body, `${test ? '<b>This is a sample.</b> ' : ''}Sent for ${esc(who)} by AlleGrow. Questions about a payment? Just reply to this email. <a href="${off}" style="color:#8a8f9e">Stop payment reminders</a>`) };
}
async function sendBill(env, to, mail, replyTo) {
  if (env.DRY_RUN) { console.log(`[dry run] reminder to ${to}: ${mail.subject}`); return; }
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject: mail.subject, html: mail.html, ...(replyTo || env.REPLY_TO ? { reply_to: replyTo || env.REPLY_TO } : {}) }) });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}
async function runBillReminders(env, feed, now) {
  const R = feed.bill, out = [];
  if (!R?.on || !feed.billTo || now.minutes < 9 * 60 || now.minutes >= 10 * 60) return out;
  for (const [sid, emails] of Object.entries(feed.billTo)) {
    if (!validCode(sid) || !(feed.students || []).includes(sid)) continue;
    const key = `sent:bill:${sid}:${now.key}`;
    if (await env.KV.get(key)) continue;
    const s = await getDoc(env, `students/${sid}`);
    if (!s || s.archived || !s.billShare) continue;
    const stKey = `billstate:${sid}`, state = await getJSON(env, stKey);
    const { rem, state: next } = reminderFor(s.billShare, R, now.key, state);
    if (JSON.stringify(next) !== JSON.stringify(state)) next ? await env.KV.put(stKey, JSON.stringify(next), { expirationTtl: 180 * 86400 }) : await env.KV.delete(stKey);
    if (!rem) continue;
    await env.KV.put(key, '1', { expirationTtl: 172800 });
    for (const to of (emails || []).slice(0, 3)) {
      if (await env.KV.get(`billoff:${sid}:${await sha(to)}`)) continue;
      try { const mail = await billEmail(env, feed, { ...s, id: sid }, rem, to); await sendBill(env, to, mail, R.replyTo); out.push(['bill', mail.subject]); }
      catch (e) { console.error('bill', sid.slice(0, 5), e.message); }
    }
  }
  return out;
}
async function billApi(req, env, url) {
  const path = url.pathname;
  if (path === '/bill/unsubscribe' && req.method === 'GET') {
    const s = url.searchParams.get('s') || '', e = (url.searchParams.get('e') || '').toLowerCase(), k = url.searchParams.get('k') || '';
    if (!validCode(s) || !e || k !== await hmac(env, `billoff:${s}:${e}`)) return new Response('This link isn’t valid.', { status: 400 });
    await env.KV.put(`billoff:${s}:${await sha(e)}`, '1');
    return new Response(parentLayout(env, 'Payment reminders stopped', `We won’t email ${esc(e)} payment reminders for this student any more. The teacher can still send you statements.`, '', 'AlleGrow'),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (env.DRY_RUN && path === '/bill/preview') {                   // local testing only: what today's reminder would look like
    const feed = await getDoc(env, `feeds/${url.searchParams.get('token')}`), sid = url.searchParams.get('sid'), s = await getDoc(env, `students/${sid}`);
    const day = url.searchParams.get('day') || localNow(feed.tz || 'UTC').key, { rem } = reminderFor(s.billShare, feed.bill, day, JSON.parse(url.searchParams.get('state') || 'null'));
    if (!rem) return new Response(`No reminder on ${day}`);
    return new Response((await billEmail(env, feed, { ...s, id: sid }, rem, 'parent@example.com')).html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (path === '/bill/test' && req.method === 'POST') {
    const body = await req.json().catch(() => ({})), { token, sid } = body;
    if (!validCode(token)) return json({ error: 'Your studio’s email settings aren’t set up yet. Reload the page and try again.' }, 400);
    if (!validCode(sid)) return json({ error: 'Add a student first.' }, 400);
    if (await env.KV.get(`rl:${token}:bill`)) return json({ error: 'Please wait a minute before sending another sample.' }, 429);
    const feed = await getDoc(env, `feeds/${token}`);
    if (!feed) return json({ error: 'Your studio’s email settings aren’t saved yet. Try again in a moment.' }, 400);
    // the sample goes to the teacher (their sign-in email, or the one in Calendar & email settings) – never to a family
    const to = [feed.bill?.replyTo, feed.email].find(x => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x || ''));
    if (!to) return json({ error: 'Add your email address in Calendar & email settings first.' }, 400);
    if (!(feed.students || []).includes(sid)) return json({ error: 'That student isn’t in your studio’s email settings yet. Try again in a moment.' }, 400);
    const s = await getDoc(env, `students/${sid}`);
    const sent = body.share && typeof body.share === 'object' ? body.share : null;          // today's numbers from the studio
    const bs = sent ? { asOf: String(sent.asOf || ''), currency: String(sent.currency || 'USD').slice(0, 3), balance: +sent.balance || 0,
                        payLink: String(sent.payLink || '').slice(0, 200), payNote: String(sent.payNote || '').slice(0, 400),
                        items: (Array.isArray(sent.items) ? sent.items : []).slice(0, 20), upcoming: (Array.isArray(sent.upcoming) ? sent.upcoming : []).slice(0, 5) } : s?.billShare;
    if (!s || !bs) return json({ error: 'Couldn’t find that student’s billing yet. Try again in a moment.' }, 400);
    await env.KV.put(`rl:${token}:bill`, '1', { expirationTtl: 60 });
    // a sample shows what a real reminder would say today (or, with nothing owed, the next charge)
    const t = localNow(feed.tz || 'UTC').key, open = (bs.items || []).filter(i => i.open > 0.004);
    const rem = { overdue: open.filter(i => i.due < t), dueToday: open.filter(i => i.due === t), soon: [...open.filter(i => i.due > t), ...(bs.upcoming || [])].slice(0, 3) };
    rem.kind = rem.overdue.length ? 'overdue' : rem.dueToday.length ? 'due' : 'soon';
    if (!rem.soon.length && rem.kind === 'soon') rem.soon = [{ text: 'Nothing is due right now', due: t, amount: 0 }];
    const f = { ...feed, bill: { ...(feed.bill || {}), message: String(body.message ?? feed.bill?.message ?? '').slice(0, 600) } };
    try { const mail = await billEmail(env, f, { ...s, id: sid, billShare: bs }, rem, to, { test: true }); await sendBill(env, to, mail, to); return json({ ok: true, to, subject: mail.subject }); }
    catch (e) { console.error(e); return json({ error: sendError(e) }, 500); }
  }
  return json({ error: 'not found' }, 404);
}

async function parentsApi(req, env, url) {
  const path = url.pathname;
  if (path === '/parents/unsubscribe' && req.method === 'GET') {
    const uid = url.searchParams.get('u') || '', sig = url.searchParams.get('s') || '';
    const rec = await getJSON(env, `parent:${uid}`);
    if (rec && sig === await hmac(env, 'unsub:' + uid)) await env.KV.put(`parent:${uid}`, JSON.stringify({ ...rec, weekly: false }));
    return new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f6f3ee;color:#1e2a44;display:grid;place-items:center;min-height:90vh;margin:0">
      <div style="background:#fff;border-radius:18px;padding:28px;max-width:420px;text-align:center"><h1 style="font-family:Georgia,serif;font-weight:600">You’re unsubscribed</h1>
      <p>You won’t get the weekly AlleGrow family summary any more. You can turn it back on in the app: Parents → Settings → Devices &amp; sync.</p></div></body>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  // Local testing only (DRY_RUN): see a parent's weekly summary as HTML
  if (env.DRY_RUN && path.startsWith('/parents/preview/')) {
    const uid = path.split('/')[3], rec = await getJSON(env, `parent:${uid}`);
    const mail = rec && await familyEmail(env, { ...rec, uid });
    return mail ? new Response(`<!-- ${mail.subject} -->` + mail.html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response('Not found', { status: 404 });
  }
  if (req.method !== 'POST') return new Response('Not found', { status: 404 });
  const body = await req.json().catch(() => ({}));

  // PIN reset codes don't need a sign-in (that's the point): they go only to the family's verified parent emails
  if (path === '/parents/pin-code') {
    const family = body.family;
    if (!validCode(family)) return json({ error: 'bad request' }, 400);
    const emails = await familyParentEmails(env, family);
    if (!emails.length) return json({ error: 'No confirmed parent email is set up for this family yet.' }, 404);
    const sentKey = `pinrl:${family}`, count = +(await env.KV.get(sentKey) || 0);
    if (count >= 3) return json({ error: 'Too many codes requested. Please wait an hour and try again.' }, 429);
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    await env.KV.put(`pin:${family}`, JSON.stringify({ hash: await sha(family + ':' + code), tries: 0 }), { expirationTtl: 900 });
    await env.KV.put(sentKey, String(count + 1), { expirationTtl: 3600 });
    const mail = pinEmail(env, code);
    const results = await Promise.allSettled(emails.map(e => sendEmail(env, e, mail.subject, mail.html)));
    const ok = emails.filter((_, i) => results[i].status === 'fulfilled');
    if (!ok.length) return json({ error: sendError(results[0].reason) }, 502);
    return json({ ok: true, to: ok.map(maskEmail) });
  }
  if (path === '/parents/pin-verify') {
    const { family, code } = body;
    if (!validCode(family) || !/^\d{6}$/.test(code || '')) return json({ ok: false, error: 'Enter the 6-digit code from the email.' }, 400);
    const rec = await getJSON(env, `pin:${family}`);
    if (!rec) return json({ ok: false, error: 'That code has expired. Ask for a new one.' });
    if (rec.tries >= 5) { await env.KV.delete(`pin:${family}`); return json({ ok: false, error: 'Too many tries. Ask for a new code.' }); }
    if (rec.hash !== await sha(family + ':' + code)) { await env.KV.put(`pin:${family}`, JSON.stringify({ ...rec, tries: rec.tries + 1 }), { expirationTtl: 900 }); return json({ ok: false, error: 'That code isn’t right.' }); }
    await env.KV.delete(`pin:${family}`);
    return json({ ok: true });
  }

  // Everything else is a signed-in parent looking after their own settings
  const me = await verifyParent(env, body.idToken);
  if (!me) return json({ error: 'Please sign in again.' }, 401);
  if (me.unverified && path !== '/parents/unlink')
    return json({ error: `Please confirm ${me.email} first – use the link we emailed you.`, unverified: true }, 403);
  const old = await getJSON(env, `parent:${me.uid}`);
  if (path === '/parents/link' || path === '/parents/prefs') {
    const weekly = path === '/parents/prefs' ? !!body.weekly : old ? !!old.weekly : !!body.weekly;   // a first link can ask for the summary
    const rec = { family: me.family, email: me.email, name: me.name, tz: validTz(body.tz) ? body.tz : old?.tz || 'UTC', weekly };
    if (old?.family && old.family !== me.family) await env.KV.delete(`fam:${old.family}:${me.uid}`);
    await env.KV.put(`parent:${me.uid}`, JSON.stringify(rec));
    await env.KV.put(`fam:${me.family}:${me.uid}`, '1');
    return json({ ok: true, weekly, email: me.email });
  }
  if (path === '/parents/unlink') {
    if (old) await env.KV.delete(`fam:${old.family}:${me.uid}`);
    await env.KV.delete(`parent:${me.uid}`);
    return json({ ok: true });
  }
  if (path === '/parents/test') {
    if (await env.KV.get(`rl:parent:${me.uid}`)) return json({ error: 'Please wait a minute before sending another test.' }, 429);
    await env.KV.put(`rl:parent:${me.uid}`, '1', { expirationTtl: 60 });
    const tz = validTz(body.tz) ? body.tz : old?.tz || 'UTC';
    const mail = await familyEmail(env, { ...me, tz }, { test: true });
    if (!mail) return json({ error: 'Couldn’t find your family.' }, 404);
    try { await sendEmail(env, me.email, mail.subject, mail.html); } catch (e) { return json({ error: sendError(e) }, 502); }
    return json({ ok: true, to: me.email, subject: mail.subject });
  }
  return new Response('Not found', { status: 404 });
}
const maskEmail = e => e.replace(/^(.).*?(.)?@/, (m, a, b) => `${a}•••${b || ''}@`);
async function familyParentEmails(env, family) {
  const page = await env.KV.list({ prefix: `fam:${family}:` }), out = [];
  for (const k of page.keys) { const rec = await getJSON(env, `parent:${k.name.split(':')[2]}`); if (rec?.family === family && rec.email) out.push(rec.email); }
  return [...new Set(out)];
}

function parentLayout(env, heading, intro, body, footer) {
  const app = (env.APP_URL || '') + 'app';
  return `<!doctype html><html><body style="margin:0;background:#f6f3ee;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1e2a44">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:18px;padding:28px 26px" cellspacing="0" cellpadding="0"><tr><td>
    <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#23865f">AlleGrow</div>
    <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.2;margin:6px 0 6px;font-weight:600">${heading}</h1>
    <p style="margin:0 0 18px;color:#3d4760;font-size:15px;line-height:1.5">${intro}</p>
    ${body}
    <p style="margin:24px 0 0"><a href="${app}" style="display:inline-block;background:#1e2a44;color:#f6f3ee;text-decoration:none;font-weight:600;padding:11px 18px;border-radius:12px;font-size:15px">Open AlleGrow</a></p>
  </td></tr></table>
  <p style="max-width:560px;font-size:12px;color:#8a8f9e;line-height:1.5;margin:14px auto 0">${footer}</p>
  </td></tr></table></body></html>`;
}
function pinEmail(env, code) {
  return { subject: `Your AlleGrow PIN reset code: ${code}`,
    html: parentLayout(env, 'Reset your parent PIN', 'Someone asked to reset the parent PIN in AlleGrow. Enter this code in the app to choose a new PIN:',
      `<div style="font-size:34px;font-weight:700;letter-spacing:.3em;background:#f6f3ee;border-radius:14px;padding:16px;text-align:center;font-variant-numeric:tabular-nums">${code}</div>
       <p style="font-size:14px;color:#3d4760;margin:14px 0 0">It works for 15 minutes. If this wasn’t you, you can ignore this email – the PIN stays the same.</p>`,
      'You got this because your Google account is a parent account on an AlleGrow family.') };
}

// The family's week: time and days for each child, plus what their teacher sent (numbers only; no scores)
async function familyEmail(env, parent, { test } = {}) {
  const fam = await getDoc(env, `families/${parent.family}`);
  if (!fam) return null;
  const now = localNow(parent.tz || 'UTC'), rows = [];
  let total = 0, prevTotal = 0;
  for (const k of fam.kids || []) {
    const man = {}; for (const e of Object.values(fam.manual?.[k.id] || {})) if (e?.day) man[e.day] = (man[e.day] || 0) + (e.ms || 0);
    const t = k.link && validCode(k.link) ? await getDoc(env, `students/${k.link}`) : null;
    const linked = t && t.linkedAt;
    const plan = Array.isArray(k.parentPlan) ? k.parentPlan : linked && Array.isArray(t.plan) ? t.plan : Array.isArray(k.plan) ? k.plan : Array(7).fill(k.goal || 20);
    const s = { name: k.name, practice: { log: fam.log?.[k.id] || {}, manual: man, stats: fam.stats?.[k.id] || {}, plan }, practiceEdits: linked ? t.practiceEdits : null };
    const c = week(s, now.key), p = week(s, now.key, 1), planned = plan.filter(n => n > 0).length;
    total += c.total; prevTotal += p.total;
    const lines = [`${c.days} of ${planned} planned ${planned === 1 ? 'day' : 'days'}${c.manual ? ` · ${minsText(c.manual)} logged by hand` : ''}`];
    if (c.longest >= 5 * 60000 && (!linked || insMode(t, 'focus') !== 'off')) lines.push(`Longest stretch without stopping: ${minsText(c.longest)}`);
    if (linked) {
      const since = addKey(now.key, -6);
      const stars = Object.values(t.cheers || {}).filter(x => x.date >= since);
      const badges = Object.values(t.badges || {}).filter(b => b.date >= since);
      if (stars.length) lines.push(good(`${stars.length === 1 ? 'A star' : stars.length + ' stars'} from ${esc(t.teacherName)}`) + (stars[0].note ? ` – “${esc(stars[0].note)}”` : ''));
      if (badges.length) lines.push(good(`Earned ${badges.map(b => esc(b.label)).join(', ')}`));
      const a = currentAssignment(t); if (a) lines.push(`Working on: ${esc(a.title)}${a.due ? ` (due ${fmtDay(a.due)})` : ''}`);
      const nl = nextLessonAfter(t, now.key, 10); if (nl) { const l = lessonsOn(t, nl)[0]; lines.push(`Next lesson: ${fmtDay(nl)}${l?.time ? ' at ' + fmtTime(l.time) : ''}`); }
    }
    const th = theoryWeek({ theory: fam.theory?.[k.id] }, now.key);
    if (th.ups.length) lines.push(good(`Music theory: reached ${th.ups.map(u => `${esc(THEORY_NAMES[u.deck] || '')} level ${u.level}`).join(', ')}`));
    else if (th.rounds) lines.push(`Music theory: ${th.rounds} ${th.rounds === 1 ? 'round' : 'rounds'} played, ${th.passed} passed`);
    rows.push(row('', `${esc(k.name)} · ${minsText(c.total)}${p.total ? ` <span style="font-weight:500;color:#6e7385">(${minsText(p.total)} the week before)</span>` : ''}`, lines));
  }
  if (!rows.length) rows.push('<p style="font-size:15px;color:#3d4760">No players yet – add them in the app under Parents → Settings.</p>');
  const unsub = `${env.WORKER_URL || ''}/parents/unsubscribe?u=${encodeURIComponent(parent.uid)}&s=${await hmac(env, 'unsub:' + parent.uid)}`;
  return {
    subject: `${test ? '[Test] ' : ''}Your family’s week in music: ${minsText(total)} of practice`,
    html: parentLayout(env, 'Your week in music', total ? `Together your family practiced <b>${minsText(total)}</b> this week${prevTotal && total > prevTotal ? ` – up from ${minsText(prevTotal)}` : ''}.` : 'A quiet week – a fresh one starts tomorrow. Even 10 minutes a day adds up.',
      rows.join(''), `You get this on Sunday evenings because you turned on the weekly summary in AlleGrow. <a href="${unsub}" style="color:#8a8f9e">Unsubscribe</a>`)
  };
}
async function runParents(env) {
  let cursor; const sent = [];
  do {
    const page = await env.KV.list({ prefix: 'parent:', cursor });
    for (const k of page.keys) {
      try {
        const rec = await getJSON(env, k.name); if (!rec?.weekly || !rec.email) continue;
        const now = localNow(rec.tz || 'UTC');
        if (dow(now.key) !== 0 || now.minutes < 18 * 60 || now.minutes >= 19 * 60) continue;
        const key = `sent:family:${k.name.slice(7)}:${now.key}`;
        if (await env.KV.get(key)) continue;
        const mail = await familyEmail(env, { ...rec, uid: k.name.slice(7) });
        if (mail) { await sendEmail(env, rec.email, mail.subject, mail.html); sent.push(rec.email); }
        await env.KV.put(key, '1', { expirationTtl: 172800 });
      } catch (e) { console.error('parent', e.message); }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return sent;
}

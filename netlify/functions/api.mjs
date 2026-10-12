import { getUser } from '@netlify/identity';
import { getStore } from '@netlify/blobs';
import { SEED_CONFIG } from './seed.mjs';
import { buildWeekWorkbook, sendWeekEmail } from './_notify.mjs';

const STORE = 'brandtime';
const WEEK_RE = /^\d{4}-W\d{2}$/;
const REPORT_KEYS = ['settings', 'excuses', 'acks', 'people'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
}
function isAdmin(u) {
  if (!u) return false;
  const roles = u.roles || (u.app_metadata && u.app_metadata.roles) || [];
  if (Array.isArray(roles) && roles.includes('admin')) return true;
  return adminEmails().includes(String(u.email || '').toLowerCase());
}

/* Strip anything we didn't put there, and cap the shape so one bad client
   can't write an unbounded blob. */
function cleanDoc(raw) {
  const out = { days: {}, submitted: !!(raw && raw.submitted), submittedAt: null, dailyDefault: 8 };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.submittedAt === 'string') out.submittedAt = raw.submittedAt.slice(0, 40);
  const dd = Number(raw.dailyDefault);
  if (Number.isFinite(dd) && dd >= 0 && dd <= 24) out.dailyDefault = dd;

  const days = raw.days && typeof raw.days === 'object' ? raw.days : {};
  Object.keys(days).slice(0, 10).forEach((k) => {
    if (!DATE_RE.test(k)) return;
    const d = days[k] || {};
    const worked = Number(d.worked);
    const rows = Array.isArray(d.rows) ? d.rows.slice(0, 40) : [];
    out.days[k] = {
      worked: Number.isFinite(worked) && worked >= 0 && worked <= 24 ? worked : null,
      rows: rows.map((r) => {
        const h = Number(r && r.h);
        return {
          b: String((r && r.b) || '').slice(0, 60),
          t: String((r && r.t) || '').slice(0, 60),
          h: Number.isFinite(h) && h >= 0 && h <= 24 ? h : 0,
          n: String((r && r.n) || '').slice(0, 300)
        };
      })
    };
  });
  return out;
}

function cleanConfig(raw) {
  const brands = Array.isArray(raw && raw.brands) ? raw.brands.slice(0, 150) : [];
  const tasks = Array.isArray(raw && raw.tasks) ? raw.tasks.slice(0, 40) : [];
  return {
    brands: brands.map((b) => ({
      id: String((b && b.id) || '').slice(0, 60),
      name: String((b && b.name) || '').slice(0, 80),
      group: ['reploid', 'external', 'internal'].includes(b && b.group) ? b.group : 'internal',
      archived: !!(b && b.archived)
    })).filter((b) => b.id && b.name),
    tasks: tasks.map((t) => String(t || '').slice(0, 60)).filter(Boolean),
    updatedAt: new Date().toISOString()
  };
}

async function readProfiles(store) {
  const { blobs } = await store.list({ prefix: 'profile/' });
  const rows = await Promise.all(blobs.map(async (b) => {
    const p = await store.get(b.key, { type: 'json' }).catch(() => null);
    return { userId: b.key.slice('profile/'.length), email: (p && p.email) || '' };
  }));
  return rows;
}

/* The roster is ALLOWED_EMAILS, not "everyone who has ever logged in" — an
   old profile from someone who left doesn't block the notification, and
   someone added mid-week is expected before it fires. */
function rosterEmails() {
  // Set() so an address accidentally listed twice isn't counted (or exported) twice.
  return [...new Set(String(process.env.ALLOWED_EMAILS || '')
    .toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))];
}

/* Who receives the completion email. Independent of ALLOWED_EMAILS: a
   recipient does not need a login. NOTIFY_EMAIL may hold several
   comma-separated addresses; falls back to the first admin. */
function notifyRecipients() {
  const raw = process.env.NOTIFY_EMAIL || adminEmails()[0] || '';
  return [...new Set(String(raw).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))];
}

/* A week is closed once every address on the roster has submitted. From
   that moment nobody can change it, and exactly one report email goes out.
   `notified/<week>` is the marker the earlier version wrote after sending;
   weeks that already have it count as closed. */
async function isClosed(store, week) {
  const [closed, legacy] = await Promise.all([
    store.get(`closed/${week}`, { type: 'json' }).catch(() => null),
    store.get(`notified/${week}`, { type: 'json' }).catch(() => null)
  ]);
  return !!(closed || legacy);
}

/* Returns true if this week is closed after the call. The close itself is an
   atomic write-only-if-new, so when two final submissions land together
   exactly one of them wins the claim and sends the email. */
async function maybeCloseWeek(store, week) {
  const roster = rosterEmails();
  if (!roster.length) return false;

  const people = await readProfiles(store);
  const byEmail = {};
  people.forEach((p) => { if (p.email) byEmail[p.email.toLowerCase()] = p; });

  const rows = [];
  let submittedCount = 0;
  for (const email of roster) {
    const p = byEmail[email];
    const doc = p ? await store.get(`week/${p.userId}/${week}`, { type: 'json' }).catch(() => null) : null;
    if (doc && doc.submitted) submittedCount += 1;
    if (p) rows.push({ userId: p.userId, email: p.email, doc });
  }
  if (submittedCount < roster.length) return false; // still waiting on someone

  const recipients = notifyRecipients();
  const claim = await store.setJSON(
    `closed/${week}`,
    { closedAt: new Date().toISOString(), to: recipients },
    { onlyIfNew: true }
  );
  if (!claim.modified) return true; // another request closed it and sends the email

  if (recipients.length) {
    try {
      const cfg = (await store.get('config', { type: 'json' }).catch(() => null)) || { brands: [], tasks: [] };
      const buffer = await buildWeekWorkbook(cfg, week, rows);
      await sendWeekEmail({ to: recipients, week, buffer, complete: submittedCount, total: roster.length });
    } catch (e) {
      // Nothing was sent, so release the claim: the week stays open and the
      // next save of a submitted week tries again.
      await store.delete(`closed/${week}`).catch(() => {});
      throw e;
    }
  }
  return true;
}

export default async (req) => {
  const user = await getUser();
  if (!user) return json({ error: 'Not signed in.' }, 401);

  const url = new URL(req.url);
  const op = url.searchParams.get('op');
  const store = getStore({ name: STORE, consistency: 'strong' });
  const uid = user.id;
  const admin = isAdmin(user);

  let body = {};
  if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }

  try {
    /* ---------- everyone ---------- */
    if (op === 'bootstrap') {
      let [config, profile] = await Promise.all([
        store.get('config', { type: 'json' }).catch(() => null),
        store.get(`profile/${uid}`, { type: 'json' }).catch(() => null)
      ]);
      // First admin to open a fresh deploy gets the starting brand list.
      if (!config && admin) {
        config = cleanConfig(SEED_CONFIG);
        await store.setJSON('config', config);
      }
      // Record the login so the person shows up in the roster before their first save.
      if (!profile || profile.email !== user.email) {
        await store.setJSON(`profile/${uid}`, {
          email: user.email || '',
          dailyDefault: (profile && profile.dailyDefault) || 8,
          seenAt: new Date().toISOString()
        });
      }
      return json({
        user: { id: uid, email: user.email, admin },
        config: config || { brands: [], tasks: [] },
        profile: profile || { dailyDefault: 8 }
      });
    }

    if (op === 'week') {
      if (req.method === 'POST') {
        const week = String(body.week || '');
        if (!WEEK_RE.test(week)) return json({ error: 'Bad week.' }, 400);
        if (await isClosed(store, week)) {
          return json({ error: 'This week is closed — everyone has submitted.', closed: true }, 409);
        }
        const cleaned = cleanDoc(body.doc);
        await store.setJSON(`week/${uid}/${week}`, {
          ...cleaned, userId: uid, week, updatedAt: new Date().toISOString()
        });
        let closed = false;
        if (cleaned.submitted) {
          try {
            closed = await maybeCloseWeek(store, week);
          } catch (e) {
            console.error('brand-time close/notify failed:', e && e.message);
          }
        }
        return json({ ok: true, closed });
      }
      const week = String(url.searchParams.get('week') || '');
      if (!WEEK_RE.test(week)) return json({ error: 'Bad week.' }, 400);
      const [doc, closed] = await Promise.all([
        store.get(`week/${uid}/${week}`, { type: 'json' }).catch(() => null),
        isClosed(store, week)
      ]);
      return json({ doc: doc || null, closed });
    }

    /* ---------- admin only, from here down ---------- */
    if (!admin) return json({ error: 'Not allowed.' }, 403);

    if (op === 'config' && req.method === 'POST') {
      await store.setJSON('config', cleanConfig(body));
      return json({ ok: true });
    }

    /* ---------- reports (admin only) ---------- */
    if (op === 'reports') {
      const people = await readProfiles(store);
      const byId = {};
      people.forEach((p) => { byId[p.userId] = p; });
      const { blobs } = await store.list({ prefix: 'week/' });
      const [config, ...saved] = await Promise.all([
        store.get('config', { type: 'json' }).catch(() => null),
        ...REPORT_KEYS.map((k) => store.get(`reports/${k}`, { type: 'json' }).catch(() => null))
      ]);
      const weeks = (await Promise.all(blobs.map(async (b) => {
        const parts = b.key.split('/');                       // week/<uid>/<weekId>
        if (parts.length !== 3) return null;
        const doc = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (!doc) return null;
        return { userId: parts[1], week: parts[2], email: (byId[parts[1]] || {}).email || '', doc };
      }))).filter(Boolean);
      const state = {};
      REPORT_KEYS.forEach((k, i) => { state[k] = saved[i] || {}; });
      return json({
        config: config || { brands: [], tasks: [] },
        roster: rosterEmails(),
        weeks,
        state,
        me: { email: user.email }
      });
    }

    if (op === 'reports-save' && req.method === 'POST') {
      const key = String(body.key || '');
      if (!REPORT_KEYS.includes(key)) return json({ error: 'Unknown report setting.' }, 400);
      const value = body.value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return json({ error: 'Bad value.' }, 400);
      if (JSON.stringify(value).length > 200000) return json({ error: 'Too large.' }, 413);
      await store.setJSON(`reports/${key}`, value);
      return json({ ok: true });
    }

    if (op === 'team') {
      const week = String(url.searchParams.get('week') || '');
      if (!WEEK_RE.test(week)) return json({ error: 'Bad week.' }, 400);
      const people = await readProfiles(store);
      const rows = await Promise.all(people.map(async (p) => {
        const doc = await store.get(`week/${p.userId}/${week}`, { type: 'json' }).catch(() => null);
        return { userId: p.userId, email: p.email, doc };
      }));
      return json({ rows });
    }

    if (op === 'export') {
      const from = String(url.searchParams.get('from') || '');
      const to = String(url.searchParams.get('to') || '');
      if (!DATE_RE.test(from) || !DATE_RE.test(to)) return json({ error: 'Bad dates.' }, 400);
      const people = await readProfiles(store);
      const byId = {};
      people.forEach((p) => { byId[p.userId] = p; });
      const { blobs } = await store.list({ prefix: 'week/' });
      const rows = await Promise.all(blobs.map(async (b) => {
        const parts = b.key.split('/');           // week/<uid>/<weekId>
        const userId = parts[1], week = parts[2];
        const doc = await store.get(b.key, { type: 'json' }).catch(() => null);
        if (!doc) return null;
        const p = byId[userId] || { email: '' };
        return { userId, week, email: p.email, doc };
      }));
      return json({ rows: rows.filter(Boolean) });
    }

    return json({ error: 'Unknown operation.' }, 400);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, 500);
  }
};

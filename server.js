const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { pool, init } = require('./db');

const API_KEY = process.env.API_KEY;
if (!API_KEY) { console.error('API_KEY env var is required'); process.exit(1); }

const app = express();
app.set('trust proxy', 1);

// Every error looks like {"error": "<message>"}
const fail = (res, status, message) => res.status(status).json({ error: message });

// The web page and health check are public; everything else needs the key.
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));

// ---- Level 2: API key (checked before anything else, even before JSON parsing)
app.use((req, res, next) => {
  const given = Buffer.from(req.get('X-API-Key') || '');
  const want = Buffer.from(API_KEY);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want))
    return fail(res, 401, 'missing or invalid API key');
  next();
});
app.use(express.json({ limit: '5mb' }));


// ---- Level 5: 5 attempts per email per minute (failed attempts count) -----
const LIMIT = 5, WINDOW_MS = 60_000;
const attempts = new Map(); // email -> timestamps
function rateLimit(email) {
  const now = Date.now();
  const recent = (attempts.get(email) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) {
    attempts.set(email, recent);
    return Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000)); // seconds to wait
  }
  recent.push(now);
  attempts.set(email, recent);
  return 0;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (!v.some(t => now - t < WINDOW_MS)) attempts.delete(k);
}, WINDOW_MS).unref();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOOKING_COLS = 'id, slot_id, name, email, status, created_at';
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const canonical = v => JSON.stringify(v, (_k, x) =>
  isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x);

// ---- Level 1: reset --------------------------------------------------------
app.post('/api/v1/reset', async (req, res, next) => {
  try {
    const slots = isObj(req.body) ? req.body.slots : undefined;
    if (!Array.isArray(slots)) return fail(res, 400, 'slots must be an array');
    const seen = new Set(), ids = [], providers = [], starts = [], ends = [];
    for (const s of slots) {
      if (!isObj(s) || typeof s.id !== 'string' || !s.id.trim()) return fail(res, 400, 'each slot needs an id');
      if (typeof s.start !== 'string' || isNaN(Date.parse(s.start))) return fail(res, 400, 'each slot needs a valid start');
      if (typeof s.end !== 'string' || isNaN(Date.parse(s.end))) return fail(res, 400, 'each slot needs a valid end');
      if (seen.has(s.id)) return fail(res, 400, 'duplicate slot id');
      seen.add(s.id);
      ids.push(s.id); providers.push(typeof s.provider === 'string' ? s.provider : ''); starts.push(s.start); ends.push(s.end);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM idempotency_keys');
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM slots');
      if (ids.length) await client.query(
        `INSERT INTO slots (id, provider, start_time, end_time, start_raw, end_raw)
         SELECT i, p, s::timestamptz, e::timestamptz, s, e
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(i, p, s, e)`,
        [ids, providers, starts, ends]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    attempts.clear();
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Level 1: slots --------------------------------------------------------
app.get('/api/v1/slots', async (req, res, next) => {
  try {
    const provider = typeof req.query.provider === 'string' ? req.query.provider : null;
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_raw AS start, s.end_raw AS "end",
              NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed') AS available
       FROM slots s
       WHERE ($1::text IS NULL OR s.provider = $1)
       ORDER BY s.start_time, s.id`, [provider]);
    res.json({ slots: rows });
  } catch (e) { next(e); }
});

// ---- Levels 1-5: book a slot ----------------------------------------------
app.post('/api/v1/bookings', async (req, res, next) => {
  const body = isObj(req.body) ? req.body : {};
  const idemKey = req.get('Idempotency-Key') || null;
  const client = await pool.connect();
  let finished = false;
  const end = async (action, status, payload, headers) => {
    await client.query(action).catch(() => {});
    finished = true;
    if (headers) res.set(headers);
    return res.status(status).json(payload);
  };
  try {
    await client.query('BEGIN');

    // Level 4: replay a stored result for a repeated Idempotency-Key.
    // The advisory lock makes simultaneous retries wait for the first one to finish.
    if (idemKey) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [idemKey]);
      const prev = await client.query('SELECT fingerprint, status_code, body FROM idempotency_keys WHERE key = $1', [idemKey]);
      if (prev.rowCount) {
        if (prev.rows[0].fingerprint !== canonical(body))
          return await end('COMMIT', 422, { error: 'Idempotency-Key was already used with a different request body' });
        return await end('COMMIT', prev.rows[0].status_code, prev.rows[0].body);
      }
    }

    // Level 5: every attempt for an email counts, including ones that fail below.
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email) {
      const wait = rateLimit(email);
      if (wait) return await end('ROLLBACK', 429, { error: 'too many attempts, try again later' }, { 'Retry-After': String(wait) });
    }

    // Level 2: validation
    const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!slotId) return await end('ROLLBACK', 400, { error: 'slot_id is required' });
    if (!name) return await end('ROLLBACK', 400, { error: 'name is required' });
    if (!email) return await end('ROLLBACK', 400, { error: 'email is required' });
    if (!EMAIL.test(email)) return await end('ROLLBACK', 400, { error: 'email is not valid' });

    const slot = await client.query('SELECT start_time <= now() AS started FROM slots WHERE id = $1', [slotId]);
    if (!slot.rowCount) return await end('ROLLBACK', 404, { error: 'slot not found' });
    if (slot.rows[0].started) return await end('ROLLBACK', 400, { error: 'slot has already started' });

    // Level 3: the unique index on confirmed bookings decides the winner.
    const ins = await client.query(
      `INSERT INTO bookings (slot_id, name, email) VALUES ($1, $2, $3)
       ON CONFLICT (slot_id) WHERE status = 'confirmed' DO NOTHING
       RETURNING ${BOOKING_COLS}`, [slotId, name, email]);
    if (!ins.rowCount) return await end('ROLLBACK', 409, { error: 'slot already booked' });

    if (idemKey) await client.query(
      'INSERT INTO idempotency_keys (key, fingerprint, status_code, body) VALUES ($1, $2, 201, $3)',
      [idemKey, canonical(body), ins.rows[0]]);
    await end('COMMIT', 201, ins.rows[0]);
  } catch (e) {
    if (!finished) await client.query('ROLLBACK').catch(() => {});
    next(e);
  } finally { client.release(); }
});

// ---- Level 4: a person's bookings, oldest first, cursor pagination ----------
app.get('/api/v1/bookings', async (req, res, next) => {
  try {
    const { email, limit, cursor } = req.query;
    if (typeof email !== 'string' || !email.trim()) return fail(res, 400, 'email is required');
    let lim = 10;
    if (limit !== undefined) {
      if (typeof limit !== 'string' || !/^\d+$/.test(limit) || +limit < 1 || +limit > 50)
        return fail(res, 400, 'limit must be between 1 and 50');
      lim = +limit;
    }
    let after = '0';
    if (cursor !== undefined) {
      after = typeof cursor === 'string' ? Buffer.from(cursor, 'base64url').toString() : '';
      if (!/^\d{1,18}$/.test(after)) return fail(res, 400, 'invalid cursor');
    }
    const { rows } = await pool.query(
      `SELECT ${BOOKING_COLS}, seq FROM bookings
       WHERE email = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [email.trim().toLowerCase(), after, lim + 1]);
    const page = rows.slice(0, lim);
    const next_cursor = rows.length > lim ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url') : null;
    res.json({ bookings: page.map(({ seq, ...b }) => b), next_cursor });
  } catch (e) { next(e); }
});

app.get('/api/v1/bookings/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return fail(res, 404, 'booking not found');
    const { rows } = await pool.query(`SELECT ${BOOKING_COLS} FROM bookings WHERE id = $1`, [req.params.id]);
    if (!rows.length) return fail(res, 404, 'booking not found');
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ---- Level 3: cancel (frees the slot) ---------------------------------------
app.delete('/api/v1/bookings/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return fail(res, 404, 'booking not found');
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING ${BOOKING_COLS}`, [req.params.id]);
    if (!rows.length) return fail(res, 404, 'booking not found');
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.use((_req, res) => fail(res, 404, 'not found'));
app.use((e, _req, res, _next) => {
  if (e.type === 'entity.parse.failed') return fail(res, 400, 'request body is not valid JSON');
  if (e.type === 'entity.too.large') return fail(res, 413, 'request body too large');
  console.error(e);
  fail(res, 500, 'internal error');
});

const port = process.env.PORT || 3000;
init().then(() => app.listen(port, () => console.log(`Listening on ${port}`)))
  .catch(e => { console.error('Startup failed', e); process.exit(1); });

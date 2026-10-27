const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false } : false,
});

async function init() {
  const existing = await pool.query("SELECT to_regclass('public.slots') AS t");
  let fresh = !existing.rows[0].t;

  if (!fresh) {
    // An earlier version of this app used numeric slot ids: rebuild the tables.
    const col = await pool.query(
      "SELECT data_type FROM information_schema.columns WHERE table_name='slots' AND column_name='id'");
    const hasSeq = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name='bookings' AND column_name='seq'");
    if (!col.rowCount || col.rows[0].data_type !== 'text' || !hasSeq.rowCount) {
      await pool.query('DROP TABLE IF EXISTS idempotency_keys, bookings, slots CASCADE');
      fresh = true;
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT '',
      start_time TIMESTAMPTZ NOT NULL,
      end_time TIMESTAMPTZ NOT NULL,
      start_raw TEXT NOT NULL,   -- returned exactly as it was sent
      end_raw TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      seq BIGSERIAL UNIQUE,      -- stable oldest-first ordering for cursors
      slot_id TEXT NOT NULL REFERENCES slots(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL,       -- stored lower-case
      status TEXT NOT NULL DEFAULT 'confirmed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Level 3: the database guarantees one confirmed booking per slot.
    CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
      ON bookings(slot_id) WHERE status = 'confirmed';
    CREATE INDEX IF NOT EXISTS bookings_email_seq_idx ON bookings(email, seq);
    -- Level 4
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      status_code INT NOT NULL,
      body JSONB NOT NULL
    );
  `);

  if (fresh) {
    // Demo slots so the web page has something to show. POST /reset replaces them.
    await pool.query(`
      INSERT INTO slots (id, provider, start_time, end_time, start_raw, end_raw)
      SELECT 'demo-' || n, 'Dr Ade', t, t + interval '30 minutes',
             to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             to_char((t + interval '30 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      FROM (
        SELECT row_number() OVER (ORDER BY t) AS n, t
        FROM generate_series(
          date_trunc('day', now()) + interval '1 day' + interval '9 hours',
          date_trunc('day', now()) + interval '7 days' + interval '16 hours',
          interval '30 minutes') AS t
        WHERE extract(hour FROM t) BETWEEN 9 AND 15
      ) x`);
  }
}

module.exports = { pool, init };

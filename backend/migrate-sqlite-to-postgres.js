// One-off migration: copy the old local SQLite database into Postgres.
//
// Usage:
//   DATABASE_URL=postgres://... node migrate-sqlite-to-postgres.js [path/to/companion.db]
//
// Safe to run more than once: rows keep their original IDs and re-runs skip
// IDs that already exist (ON CONFLICT DO NOTHING).
//
// Uses Node's built-in sqlite module (read-only) so better-sqlite3 isn't needed.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url))
const SQLITE_PATH = process.argv[2] || path.join(BASE_DIR, '..', 'data', 'companion.db')

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL to the target Postgres connection string.')
  process.exit(1)
}

const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true })
const rows = sqlite.prepare('SELECT id, date, mood, summary, messages FROM conversations ORDER BY id').all()
sqlite.close()
console.log(`Read ${rows.length} conversation(s) from ${SQLITE_PATH}`)

const db = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 2,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
})

// The old `date` column is a local-time "YYYY-MM-DD HH:MM" string.
const toTimestamp = (s) => new Date(s.replace(' ', 'T') + ':00')

await db.query(`CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mood INTEGER,
  summary TEXT,
  messages JSONB NOT NULL
)`)

let copied = 0
for (const r of rows) {
  const result = await db.query(
    `INSERT INTO conversations (id, created_at, mood, summary, messages)
     OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [r.id, toTimestamp(r.date), r.mood, r.summary, r.messages]
  )
  copied += result.rowCount
}

// Keep the identity sequence ahead of the copied IDs so new inserts don't collide.
await db.query(
  `SELECT setval(pg_get_serial_sequence('conversations', 'id'),
                 GREATEST((SELECT COALESCE(MAX(id), 0) FROM conversations), 1))`
)

const { rows: [{ count }] } = await db.query('SELECT COUNT(*)::int AS count FROM conversations')
await db.end()
console.log(`Copied ${copied} new row(s); skipped ${rows.length - copied} already present.`)
console.log(`Postgres now has ${count} conversation(s). Done.`)

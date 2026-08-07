// One-off migration: create your account and assign all pre-account data to it.
//
// Usage:
//   DATABASE_URL=postgres://... node migrate-claim-data.js
//   (prompts for email + password; or pass them as env vars EMAIL / PASSWORD)
//
// Safe to run more than once: if the account already exists it is reused, and
// only conversations that don't yet belong to anyone (user_id IS NULL) are
// claimed.

import crypto from 'node:crypto'
import readline from 'node:readline/promises'
import bcrypt from 'bcryptjs'
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL to the Postgres connection string.')
  process.exit(1)
}

async function prompt(question, { hidden = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  if (hidden) {
    // Mask password input
    const orig = rl._writeToOutput
    rl._writeToOutput = function (str) {
      if (rl.line && str.includes(rl.line)) orig.call(rl, question + '*'.repeat(rl.line.length))
      else orig.call(rl, str)
    }
  }
  const answer = await rl.question(question)
  rl.close()
  if (hidden) process.stdout.write('\n')
  return answer
}

const email = (process.env.EMAIL || (await prompt('Email: '))).trim().toLowerCase()
const password = process.env.PASSWORD || (await prompt('Password (min 12 chars): ', { hidden: true }))

if (!/^\S+@\S+\.\S+$/.test(email)) {
  console.error('That does not look like an email address.')
  process.exit(1)
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters.')
  process.exit(1)
}

const db = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 2,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
})

// Ensure schema exists (same DDL the server runs at boot).
await db.query(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`)
await db.query(
  'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE'
)

let user = (await db.query('SELECT id, email FROM users WHERE email = $1', [email])).rows[0]
if (user) {
  console.log(`Account ${user.email} already exists (id ${user.id}) — reusing it.`)
} else {
  const hash = await bcrypt.hash(password, 12)
  user = (
    await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash]
    )
  ).rows[0]
  console.log(`Created account ${user.email} (id ${user.id}).`)
}

const { rowCount } = await db.query(
  'UPDATE conversations SET user_id = $1 WHERE user_id IS NULL',
  [user.id]
)
const { rows: [{ count }] } = await db.query(
  'SELECT COUNT(*)::int AS count FROM conversations WHERE user_id = $1', [user.id]
)
await db.end()
console.log(`Claimed ${rowCount} unowned conversation(s); the account now owns ${count}.`)
console.log('Done — you can sign in with this email and password.')

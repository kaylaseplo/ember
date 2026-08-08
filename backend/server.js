// Ember — Express backend.
//
// Endpoints:
//   POST /api/chat               stream a reply (text/plain chunks)
//   POST /api/end-session        save conversation + mood, generate summary
//   GET  /api/conversations      list past conversations
//   GET  /api/conversations/:id  full conversation
//   GET  /api/moods              mood history + trend
//   GET  /api/summaries          per-session summaries + cross-session patterns
//
// Env: ANTHROPIC_API_KEY, DATABASE_URL, SESSION_SECRET (recommended),
// INVITE_CODE (enables signup). Data lives in Postgres, scoped per user.
// Serves the built React frontend from ../frontend/dist when present.
//
// Cost instrumentation (all optional):
//   CHAT_MODEL / SUMMARY_MODEL / INSIGHTS_MODEL / DIGEST_MODEL  per-job models
//   ADMIN_EMAIL                    unlocks GET /api/admin/costs for that user
//   USER_DAILY_SPEND_LIMIT_USD     per-user daily ceiling (default 2.00)
//   GLOBAL_DAILY_SPEND_LIMIT_USD   global daily circuit breaker (default 50.00)

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Anthropic from '@anthropic-ai/sdk'
import bcrypt from 'bcryptjs'
import cors from 'cors'
import express from 'express'
import pg from 'pg'

// Per-job models, configurable without a code change. Chat and the therapy
// digest (the most reasoning-heavy output) stay on the strongest model;
// background jobs run on Haiku.
const CHAT_MODEL = process.env.CHAT_MODEL || 'claude-opus-4-8'
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'claude-haiku-4-5'
const INSIGHTS_MODEL = process.env.INSIGHTS_MODEL || 'claude-haiku-4-5'
const DIGEST_MODEL = process.env.DIGEST_MODEL || CHAT_MODEL

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || null
const USER_DAILY_SPEND_LIMIT = Number(process.env.USER_DAILY_SPEND_LIMIT_USD || 2.0)
const GLOBAL_DAILY_SPEND_LIMIT = Number(process.env.GLOBAL_DAILY_SPEND_LIMIT_USD || 50.0)
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url))
const SYSTEM_PROMPT_FILE = path.join(BASE_DIR, '..', 'SYSTEM_PROMPT.md')
const FRONTEND_DIST = path.join(BASE_DIR, '..', 'frontend', 'dist')
const PORT = process.env.PORT || 8000

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error(
    'FATAL: DATABASE_URL is not set. Ember stores its data in Postgres — set ' +
      'DATABASE_URL to a Postgres connection string (e.g. from Neon) and restart.'
  )
  process.exit(1)
}

// Signup is gated behind an invite code; with no INVITE_CODE set, signup is
// disabled entirely (existing accounts can still log in).
const INVITE_CODE = process.env.INVITE_CODE || null

let SESSION_SECRET = process.env.SESSION_SECRET
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex')
  console.warn(
    'WARNING: SESSION_SECRET is not set — generated a temporary one. Sessions ' +
      'will not survive a server restart. Set SESSION_SECRET to fix this.'
  )
}

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

const client = new Anthropic() // reads ANTHROPIC_API_KEY

// ---------- cost instrumentation ----------

// API rates in USD per million tokens, keyed by model string.
// Retrieved 7 August 2026 from https://platform.claude.com/docs/en/about-claude/pricing
// (Sonnet 5 rates take effect 1 September 2026.)
const MODEL_RATES = {
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-5': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
}

// Batch API requests are billed at 50% of the standard rates.
function estimateCost(model, { input, output, cacheRead, cacheWrite }, batch = false) {
  const rates = MODEL_RATES[model] || MODEL_RATES[Object.keys(MODEL_RATES).find((k) => model?.startsWith(k)) || '']
  if (!rates) {
    console.warn(`estimateCost: no rates configured for model "${model}" — recording cost 0`)
    return 0
  }
  const usd =
    (input * rates.input + cacheRead * rates.cacheRead + cacheWrite * rates.cacheWrite + output * rates.output) /
    1_000_000
  return batch ? usd / 2 : usd
}

// Write one api_usage row per Anthropic API call, from the usage object the
// API itself reports. Must never break a user request: any failure here is
// logged and swallowed.
async function logUsage({
  userId = null,
  jobType,
  model,
  usage,
  conversationId = null,
  durationMs = null,
  interrupted = false,
  batch = false,
}) {
  try {
    if (!usage) {
      console.warn(`api_usage: no usage reported for ${jobType} call — nothing logged`)
      return
    }
    const input = usage.input_tokens || 0
    const output = usage.output_tokens || 0
    const cacheRead = usage.cache_read_input_tokens || 0
    const cacheWrite = usage.cache_creation_input_tokens || 0
    const cost = estimateCost(model, { input, output, cacheRead, cacheWrite }, batch)
    await db.query(
      `INSERT INTO api_usage (user_id, job_type, model, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, estimated_cost_usd, conversation_id,
         duration_ms, interrupted, batch)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [userId, jobType, model, input, output, cacheRead, cacheWrite, cost, conversationId, durationMs, interrupted, batch]
    )
  } catch (e) {
    console.error('api_usage logging failed (request unaffected):', e.message)
  }
}

// Today's estimated spend in USD; userId null = everyone (global breaker).
// Fails open: a broken query must never lock users out.
async function dailySpend(userId = null) {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS spend FROM api_usage
       WHERE created_at >= date_trunc('day', now())` + (userId ? ' AND user_id = $1' : ''),
      userId ? [userId] : []
    )
    return Number(rows[0].spend)
  } catch (e) {
    console.error('daily spend check failed (failing open):', e.message)
    return 0
  }
}

// Gentle, non-punitive notices — these can land mid-conversation for someone
// having a hard day, so no alarm, no blame.
const USER_LIMIT_MESSAGE =
  "You've reached today's limit for conversations — it resets tomorrow. " +
  'Everything you shared is saved, and Ember will be right here when you come back.'
const GLOBAL_LIMIT_MESSAGE =
  'Ember is taking a short rest right now. Everything you shared is safe — ' +
  'please check back in a little while.'

// Returns the notice to show if a spend ceiling is hit, else null.
async function spendCeilingNotice(userId) {
  const [userSpend, globalSpend] = await Promise.all([dailySpend(userId), dailySpend(null)])
  if (globalSpend >= GLOBAL_DAILY_SPEND_LIMIT) {
    console.error(
      `SPEND LIMIT: global daily ceiling tripped — $${globalSpend.toFixed(2)} >= $${GLOBAL_DAILY_SPEND_LIMIT} (circuit breaker)`
    )
    return GLOBAL_LIMIT_MESSAGE
  }
  if (userSpend >= USER_DAILY_SPEND_LIMIT) {
    console.error(
      `SPEND LIMIT: user ${userId} hit the daily ceiling — $${userSpend.toFixed(2)} >= $${USER_DAILY_SPEND_LIMIT}`
    )
    return USER_LIMIT_MESSAGE
  }
  return null
}

// Merge usage fields from streaming events: message_start carries the input
// side (incl. cache reads/writes), message_delta carries cumulative output.
function mergeUsage(into, from) {
  const out = { ...into }
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (from?.[k] != null) out[k] = from[k]
  }
  return out
}

// ---------- auth ----------

const COOKIE_NAME = 'ember_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const BCRYPT_COST = 12
const MIN_PASSWORD_LENGTH = 12

const sign = (value) =>
  crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex')

// Cookie value: "<userId>.<expiresMs>.<hmac(userId.expiresMs)>"
function makeToken(userId) {
  const payload = `${userId}.${Date.now() + SESSION_TTL_MS}`
  return `${payload}.${sign(payload)}`
}

function timingSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

// Returns the authenticated user id, or null. The id comes only from the
// signed cookie — never from the request body or query string.
function authUserId(req) {
  const cookies = req.headers.cookie || ''
  const match = cookies.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`))
  if (!match) return null
  const parts = match.slice(COOKIE_NAME.length + 1).split('.')
  if (parts.length !== 3) return null
  const [userId, expires, sig] = parts
  if (!timingSafeEqual(sig, sign(`${userId}.${expires}`))) return null
  if (Number(expires) <= Date.now()) return null
  const id = Number(userId)
  return Number.isInteger(id) ? id : null
}

const SESSION_COOKIE_OPTS = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' }

function setSession(res, userId) {
  res.cookie(COOKIE_NAME, makeToken(userId), { ...SESSION_COOKIE_OPTS, maxAge: SESSION_TTL_MS })
}

// In-memory rate limit for login/signup: 10 attempts per 15 minutes per IP.
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
const authAttempts = new Map() // "route:ip" -> { count, resetAt }

function authRateLimited(route, ip) {
  const key = `${route}:${ip}`
  const now = Date.now()
  for (const [k, v] of authAttempts) if (v.resetAt <= now) authAttempts.delete(k)
  const entry = authAttempts.get(key) || { count: 0, resetAt: now + LOGIN_WINDOW_MS }
  entry.count += 1
  authAttempts.set(key, entry)
  return entry.count > LOGIN_MAX_ATTEMPTS
}

const normalizeEmail = (email) => String(email).trim().toLowerCase()

// Session-user payload shared by signup/login/me. hasConversations drives the
// one-time first-chat nudge; onboardingCompletedAt drives first-run onboarding.
async function userPayload(u) {
  const { rows } = await db.query(
    'SELECT EXISTS(SELECT 1 FROM conversations WHERE user_id = $1) AS has', [u.id]
  )
  return {
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    onboardingCompletedAt: u.onboarding_completed_at || null,
    hasConversations: rows[0].has,
  }
}

// Hash of a throwaway password, compared against when the email doesn't
// exist so both failure paths cost a bcrypt verify (no timing leak).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), BCRYPT_COST)

app.post('/api/auth/signup', async (req, res) => {
  if (authRateLimited('signup', req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a bit.' })
  }
  if (!INVITE_CODE) {
    return res.status(403).json({ error: 'Signup is closed right now.' })
  }
  const { email, password, inviteCode } = req.body || {}
  if (typeof inviteCode !== 'string' || !timingSafeEqual(inviteCode, INVITE_CODE)) {
    return res.status(403).json({ error: "That invite code isn't right." })
  }
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email.trim())) {
    return res.status(400).json({ error: "That doesn't look like an email address." })
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.` })
  }
  const hash = await bcrypt.hash(password, BCRYPT_COST)
  try {
    const { rows } = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, display_name, onboarding_completed_at',
      [normalizeEmail(email), hash]
    )
    setSession(res, rows[0].id)
    res.json({ user: await userPayload(rows[0]) })
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'That email already has an account — try signing in.' })
    }
    throw err
  }
})

app.post('/api/auth/login', async (req, res) => {
  if (authRateLimited('login', req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a bit.' })
  }
  const { email, password } = req.body || {}
  const user =
    typeof email === 'string'
      ? (await db.query(
          'SELECT id, email, password_hash, display_name, onboarding_completed_at FROM users WHERE email = $1',
          [normalizeEmail(email)]
        )).rows[0]
      : undefined
  // Same generic error (and a bcrypt verify either way) for unknown email
  // and wrong password, so the endpoint doesn't leak which emails exist.
  const ok = await bcrypt.compare(String(password ?? ''), user?.password_hash || DUMMY_HASH)
  if (!user || !ok) {
    return res.status(401).json({ error: "That email and password don't match." })
  }
  setSession(res, user.id)
  res.json({ user: await userPayload(user) })
})

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, SESSION_COOKIE_OPTS)
  res.json({ ok: true })
})

app.get('/api/auth/me', async (req, res) => {
  const userId = authUserId(req)
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  const { rows } = await db.query(
    'SELECT id, email, display_name, onboarding_completed_at FROM users WHERE id = $1', [userId]
  )
  if (rows.length === 0) return res.status(401).json({ error: 'unauthorized' })
  res.json({ user: await userPayload(rows[0]) })
})

// Everything else under /api requires a valid session; handlers use req.userId.
app.use('/api', (req, res, next) => {
  const userId = authUserId(req)
  if (!userId) return res.status(401).json({ error: 'unauthorized' })
  req.userId = userId
  next()
})

app.post('/api/onboarding/complete', async (req, res) => {
  await db.query(
    'UPDATE users SET onboarding_completed_at = now() WHERE id = $1 AND onboarding_completed_at IS NULL',
    [req.userId]
  )
  res.json({ ok: true })
})

// ---------- database ----------

// Small pool: single-user app on a free tier. SSL is required by Neon; local
// dev against a plain localhost Postgres skips it.
const db = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 4,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
})

async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    onboarding_completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ')
  await db.query(`CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    mood INTEGER,
    summary TEXT,
    messages JSONB NOT NULL
  )`)
  // Upgrade path for databases created before accounts existed. The column is
  // nullable: pre-account rows stay invisible until claimed by the one-off
  // migration script, and every query filters by user_id.
  await db.query(
    'ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE'
  )
  await db.query('CREATE INDEX IF NOT EXISTS conversations_user_id_idx ON conversations (user_id)')
  // Open/ended status. On databases from before this column existed, every row
  // was saved via End — backfill them as ended exactly once (when the column
  // is first added), so a routine boot never closes a genuinely open chat.
  const { rows: [{ exists: hadEndedAt }] } = await db.query(
    `SELECT EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_name = 'conversations' AND column_name = 'ended_at') AS exists`
  )
  await db.query('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ')
  await db.query('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()')
  if (!hadEndedAt) {
    await db.query('UPDATE conversations SET ended_at = created_at WHERE ended_at IS NULL')
  }
  await db.query(`CREATE TABLE IF NOT EXISTS therapy_sessions (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_date DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  await db.query('CREATE INDEX IF NOT EXISTS therapy_sessions_user_id_idx ON therapy_sessions (user_id)')
  await db.query(`CREATE TABLE IF NOT EXISTS digests (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    range_start DATE NOT NULL,
    range_end DATE NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, range_start, range_end)
  )`)
  await db.query('CREATE INDEX IF NOT EXISTS digests_user_id_idx ON digests (user_id)')
  // One row per Anthropic API call, with the usage the API actually reported.
  await db.query(`CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    job_type TEXT NOT NULL CHECK (job_type IN ('chat', 'summary', 'digest', 'insights')),
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
    conversation_id INTEGER,
    duration_ms INTEGER,
    interrupted BOOLEAN NOT NULL DEFAULT false,
    batch BOOLEAN NOT NULL DEFAULT false
  )`)
  await db.query('CREATE INDEX IF NOT EXISTS api_usage_user_created_idx ON api_usage (user_id, created_at)')
  await db.query('CREATE INDEX IF NOT EXISTS api_usage_created_idx ON api_usage (created_at)')
  // Cached cross-session insights, refreshed via the Batch API.
  await db.query(`CREATE TABLE IF NOT EXISTS insights (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    through_conversation_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
  // In-flight Batch API jobs, drained by the poller.
  await db.query(`CREATE TABLE IF NOT EXISTS api_batches (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_id TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    context JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)
}

// ---------- helpers ----------

function loadSystemPrompt() {
  if (fs.existsSync(SYSTEM_PROMPT_FILE)) return fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8')
  return 'You are a warm, supportive AI companion helping someone process emotions between therapy sessions.'
}

// Summaries of recent sessions, for continuity and pattern recognition.
async function recentContext(userId, n = 3) {
  const { rows } = await db.query(
    'SELECT created_at, mood, summary FROM conversations WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
    [userId, n]
  )
  if (rows.length === 0) return ''
  const lines = rows
    .reverse()
    .map((r) => {
      const mood = r.mood ? `mood ${r.mood}/10` : 'no mood recorded'
      return `- ${fmtDate(r.created_at)} (${mood}): ${r.summary || '(no summary)'}`
    })
  return (
    "\n\nContext from the person's recent sessions (use this to notice patterns " +
    "and provide continuity, but don't recite it back unprompted):\n" +
    lines.join('\n')
  )
}

function validMessages(messages) {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.every((m) => typeof m?.role === 'string' && typeof m?.content === 'string')
  )
}

// Same "YYYY-MM-DD HH:MM" display string the API has always returned.
function fmtDate(d) {
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const withDate = ({ created_at, ...row }) => ({ ...row, date: fmtDate(created_at) })

// Session summary from a finished conversation; '' if the call fails — the
// close-out must never be blocked by a failed summary.
const SUMMARY_PROMPT =
  "Summarize this support conversation in 2-3 sentences for the person's " +
  'own records: key themes, insights, and anything worth bringing to their ' +
  "therapist. Write in second person ('You explored...')."

async function generateSummary(messages, userId = null, conversationId = null) {
  if (!Array.isArray(messages) || messages.length < 2) return ''
  const started = Date.now()
  try {
    const resp = await client.messages.create({
      model: SUMMARY_MODEL,
      max_tokens: 300,
      system: SUMMARY_PROMPT,
      messages: [
        ...messages,
        { role: 'user', content: 'Please write the brief session summary now.' },
      ],
    })
    await logUsage({
      userId, jobType: 'summary', model: SUMMARY_MODEL, usage: resp.usage,
      conversationId, durationMs: Date.now() - started,
    })
    return textOf(resp)
  } catch {
    return ''
  }
}

// Mark a conversation ended; summary from whatever content it has.
async function closeConversation(convId, userId, mood) {
  const { rows } = await db.query(
    'SELECT id, messages FROM conversations WHERE id = $1 AND user_id = $2', [convId, userId]
  )
  if (rows.length === 0) return null
  const summary = await generateSummary(rows[0].messages, userId, convId)
  const { rows: [updated] } = await db.query(
    `UPDATE conversations SET ended_at = now(), updated_at = now(), mood = $3, summary = $4
     WHERE id = $1 AND user_id = $2 RETURNING id, created_at, mood, summary`,
    [convId, userId, mood, summary]
  )
  // A closed session may make the cached insights stale — refresh via batch.
  queueInsightsRefresh(userId)
  return updated
}

const textOf = (resp) =>
  resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()

// ---------- endpoints ----------

app.post('/api/chat', async (req, res) => {
  const { messages, conversationId } = req.body || {}
  if (!validMessages(messages)) {
    return res.status(400).json({ error: 'messages must not be empty' })
  }

  // Daily spend ceilings: stream a gentle notice instead of calling the model.
  // The notice is not saved as part of the conversation.
  const notice = await spendCeilingNotice(req.userId)
  if (notice) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.write(notice)
    return res.end()
  }

  const system = loadSystemPrompt() + (await recentContext(req.userId))

  // Persist the user's message before any model call: create the conversation
  // row on the first message, or sync the history onto the existing open row.
  let convId = Number.isInteger(Number(conversationId)) ? Number(conversationId) : null
  if (convId !== null) {
    const { rowCount } = await db.query(
      'UPDATE conversations SET messages = $1, updated_at = now() WHERE id = $2 AND user_id = $3 AND ended_at IS NULL',
      [JSON.stringify(messages), convId, req.userId]
    )
    if (rowCount === 0) convId = null // stale/foreign id — fall through to a new row
  }
  if (convId === null) {
    const { rows } = await db.query(
      'INSERT INTO conversations (user_id, messages) VALUES ($1, $2) RETURNING id',
      [req.userId, JSON.stringify(messages)]
    )
    convId = rows[0].id
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('X-Conversation-Id', String(convId))

  // Accumulate the reply server-side so an interrupted stream (closed tab,
  // killed connection) still saves whatever text arrived.
  let acc = ''
  let saved = false
  const saveReply = async () => {
    if (saved || !acc) return
    saved = true
    try {
      await db.query(
        'UPDATE conversations SET messages = $1, updated_at = now() WHERE id = $2 AND user_id = $3',
        [JSON.stringify([...messages, { role: 'assistant', content: acc }]), convId, req.userId]
      )
    } catch (e) {
      console.error('failed to persist assistant reply:', e.message)
    }
  }

  // Cache breakpoints: one on the system prompt (stable within a conversation
  // — recentContext only changes when a session closes) and one on the last
  // message, so each turn reads the whole prior conversation from cache.
  // Nothing per-request (timestamps, ids) may enter the prefix.
  const apiMessages = messages.map((m, i) =>
    i === messages.length - 1
      ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] }
      : m
  )

  const started = Date.now()
  let usage = null
  let interrupted = true // cleared when finalMessage resolves
  const stream = client.messages.stream({
    model: CHAT_MODEL,
    max_tokens: 2048,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    messages: apiMessages,
  })
  res.on('close', () => {
    if (!res.writableFinished) stream.controller.abort() // client went away mid-stream
  })
  try {
    // Capture usage as it arrives so an interrupted stream still gets logged
    // with whatever the API reported before the cut.
    stream.on('streamEvent', (event) => {
      if (event.type === 'message_start') usage = mergeUsage(usage, event.message.usage)
      else if (event.type === 'message_delta') usage = mergeUsage(usage, event.usage)
    })
    stream.on('text', (text) => {
      acc += text
      res.write(text)
    })
    await stream.finalMessage()
    interrupted = false
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      res.write('\n[error] Authentication failed — check ANTHROPIC_API_KEY on the server.')
    } else if (err instanceof Anthropic.RateLimitError) {
      res.write('\n[error] Rate limited — wait a moment and try again.')
    } else if (err instanceof Anthropic.APIError) {
      res.write(`\n[error] API error: ${err.message}`)
    } else if (err?.name !== 'AbortError') {
      res.write(`\n[error] ${err.message || err}`)
    }
  } finally {
    await logUsage({
      userId: req.userId, jobType: 'chat', model: CHAT_MODEL, usage,
      conversationId: convId, durationMs: Date.now() - started, interrupted,
    })
    await saveReply()
    res.end()
  }
})

// Most recent open conversation, for resuming after a reload or dropped
// session. Anything open but idle for over 24h is closed out instead.
app.get('/api/conversations/open', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, created_at, updated_at, messages FROM conversations WHERE user_id = $1 AND ended_at IS NULL ORDER BY id DESC',
    [req.userId]
  )
  const cutoff = Date.now() - 24 * 60 * 60 * 1000
  let resume = null
  for (const row of rows) {
    if (!resume && row.updated_at.getTime() >= cutoff) {
      resume = row
    } else {
      await closeConversation(row.id, req.userId, null) // stale — auto-close
    }
  }
  res.json({
    conversation: resume
      ? { id: resume.id, date: fmtDate(resume.created_at), messages: resume.messages }
      : null,
  })
})

app.post('/api/end-session', async (req, res) => {
  const { conversationId, mood: rawMood } = req.body || {}
  const convId = Number(conversationId)
  if (!Number.isInteger(convId)) {
    return res.status(400).json({ error: 'no conversation to save' })
  }
  const mood =
    Number.isInteger(rawMood) && rawMood >= 1 && rawMood <= 10 ? rawMood : null

  const closed = await closeConversation(convId, req.userId, mood)
  if (!closed) return res.status(404).json({ error: 'conversation not found' })
  res.json({ id: closed.id, date: fmtDate(closed.created_at), mood: closed.mood, summary: closed.summary })
})

app.get('/api/conversations', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, created_at, mood, summary FROM conversations WHERE user_id = $1 ORDER BY id DESC',
    [req.userId]
  )
  res.json(rows.map(withDate))
})

app.get('/api/conversations/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'conversation not found' })
  const { rows } = await db.query(
    'SELECT id, created_at, mood, summary, messages FROM conversations WHERE id = $1 AND user_id = $2',
    [id, req.userId]
  )
  if (rows.length === 0) return res.status(404).json({ error: 'conversation not found' })
  res.json(withDate(rows[0])) // messages is JSONB — already parsed
})

app.get('/api/moods', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, created_at, mood FROM conversations WHERE user_id = $1 AND mood IS NOT NULL ORDER BY id',
    [req.userId]
  )
  const entries = rows.map(withDate)
  const result = { entries, average: null, trend: null }
  const vals = entries.map((e) => e.mood)
  if (vals.length > 0) {
    result.average = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
  }
  if (vals.length >= 4) {
    const half = Math.floor(vals.length / 2)
    const early = vals.slice(0, half).reduce((a, b) => a + b, 0) / half
    const late = vals.slice(half).reduce((a, b) => a + b, 0) / (vals.length - half)
    if (late - early >= 0.5) result.trend = 'improving'
    else if (early - late >= 0.5) result.trend = 'dipping'
    else result.trend = 'steady'
  }
  res.json(result)
})

app.get('/api/summaries', async (req, res) => {
  const { rows } = await db.query(
    "SELECT id, created_at, mood, summary FROM conversations " +
      "WHERE user_id = $1 AND summary IS NOT NULL AND summary != '' ORDER BY id",
    [req.userId]
  )
  const sessions = rows.map(withDate)
  // Insights are generated asynchronously via the Batch API (50% cheaper) and
  // cached — this endpoint only reads the cache. If it's stale (or was never
  // built), kick off a refresh in the background.
  let patterns = null
  if (sessions.length >= 2) {
    const { rows: cached } = await db.query('SELECT content FROM insights WHERE user_id = $1', [req.userId])
    patterns = cached[0]?.content || null
    queueInsightsRefresh(req.userId)
  }
  res.json({ sessions: sessions.reverse(), patterns })
})

// ---------- insights via the Batch API ----------

const INSIGHTS_PROMPT =
  'You help someone review their mental-health journey between therapy ' +
  'sessions. Given their session summaries and mood ratings, identify ' +
  'recurring themes, possible triggers, and progress — written warmly ' +
  'in second person, in a form they could bring to their therapist. ' +
  'Keep it under 250 words.'

// Submit a Batch API request to refresh a user's insights, if they're stale
// and no refresh is already in flight. Safe to call often; never throws.
async function queueInsightsRefresh(userId) {
  try {
    const { rowCount: pending } = await db.query(
      "SELECT 1 FROM api_batches WHERE user_id = $1 AND job_type = 'insights'", [userId]
    )
    if (pending > 0) return
    const { rows } = await db.query(
      "SELECT id, created_at, mood, summary FROM conversations " +
        "WHERE user_id = $1 AND summary IS NOT NULL AND summary != '' ORDER BY id",
      [userId]
    )
    if (rows.length < 2) return
    const latestId = rows[rows.length - 1].id
    const { rows: cur } = await db.query(
      'SELECT through_conversation_id FROM insights WHERE user_id = $1', [userId]
    )
    if (cur.length > 0 && cur[0].through_conversation_id >= latestId) return // fresh

    const notes = rows
      .slice(-10)
      .map((r) => `- ${fmtDate(r.created_at)} (mood ${r.mood ?? '?'}/10): ${r.summary}`)
      .join('\n')
    const batch = await client.messages.batches.create({
      requests: [
        {
          custom_id: `insights-${userId}-${latestId}`,
          params: {
            model: INSIGHTS_MODEL,
            max_tokens: 600,
            system: INSIGHTS_PROMPT,
            messages: [{ role: 'user', content: `My recent session notes:\n${notes}` }],
          },
        },
      ],
    })
    await db.query(
      'INSERT INTO api_batches (batch_id, user_id, job_type, context) VALUES ($1, $2, $3, $4)',
      [batch.id, userId, 'insights', JSON.stringify({ throughConversationId: latestId })]
    )
  } catch (e) {
    console.error('insights batch enqueue failed:', e.message)
  }
}

// Drain finished batches: store results, log usage (at batch rates), clean up.
async function pollBatches() {
  try {
    const { rows } = await db.query('SELECT id, batch_id, user_id, job_type, context FROM api_batches')
    for (const row of rows) {
      let batch
      try {
        batch = await client.messages.batches.retrieve(row.batch_id)
      } catch (e) {
        console.error(`batch ${row.batch_id} retrieve failed:`, e.message)
        continue
      }
      if (batch.processing_status !== 'ended') continue
      try {
        for await (const result of await client.messages.batches.results(row.batch_id)) {
          if (result.result.type !== 'succeeded') {
            console.error(`batch ${row.batch_id} item ${result.custom_id}: ${result.result.type}`)
            continue
          }
          const msg = result.result.message
          const text = textOf(msg)
          if (row.job_type === 'insights' && text) {
            await db.query(
              `INSERT INTO insights (user_id, content, through_conversation_id, created_at)
               VALUES ($1, $2, $3, now())
               ON CONFLICT (user_id) DO UPDATE SET content = EXCLUDED.content,
                 through_conversation_id = EXCLUDED.through_conversation_id, created_at = now()`,
              [row.user_id, text, row.context?.throughConversationId ?? 0]
            )
          }
          await logUsage({
            userId: row.user_id, jobType: row.job_type, model: msg.model,
            usage: msg.usage, batch: true,
          })
        }
        await db.query('DELETE FROM api_batches WHERE id = $1', [row.id])
      } catch (e) {
        console.error(`batch ${row.batch_id} results failed:`, e.message)
      }
    }
  } catch (e) {
    console.error('batch poll failed:', e.message)
  }
}

// ---------- therapy prep ----------

// Distinct from the conversational system prompt — this one describes
// patterns across a range of sessions for the user to bring to therapy.
const DIGEST_PROMPT = `You are preparing a pre-therapy digest from someone's private journal
sessions. They will read it in a waiting room before an appointment. Write in second
person, plainly and specifically, referencing what they actually said. Rules:
- No clinical language, no diagnostic framing, no advice about what they should do.
- Describe patterns; do not interpret the person or speculate about causes.
- No exclamation marks. Short sentences. Quiet, warm, direct.

Structure the digest with exactly these four markdown sections:

## What came up most
Recurring themes, situations, and people, with a sense of how often each appeared.

## What shifted
Anything that changed across the range: a softening, a new realization, something
that got harder. If nothing clearly shifted, say so plainly.

## Mood
The trajectory in plain language, and what was going on around the lowest and
highest points. Do not just restate numbers.

## Worth raising
3 to 5 concrete things that might be useful to bring to a therapist, phrased as
observations rather than advice.`

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// GET recorded therapy dates (newest first)
app.get('/api/therapy-sessions', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, session_date FROM therapy_sessions WHERE user_id = $1 ORDER BY session_date DESC',
    [req.userId]
  )
  res.json(rows.map((r) => ({ id: r.id, date: r.session_date.toISOString().slice(0, 10) })))
})

app.post('/api/therapy-sessions', async (req, res) => {
  const { date } = req.body || {}
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' })
  }
  const { rows } = await db.query(
    'INSERT INTO therapy_sessions (user_id, session_date) VALUES ($1, $2) RETURNING id, session_date',
    [req.userId, date]
  )
  res.json({ id: rows[0].id, date: rows[0].session_date.toISOString().slice(0, 10) })
})

// Past digests, most recent first
app.get('/api/digests', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, range_start, range_end, content, created_at FROM digests WHERE user_id = $1 ORDER BY created_at DESC',
    [req.userId]
  )
  res.json(
    rows.map((r) => ({
      id: r.id,
      rangeStart: r.range_start.toISOString().slice(0, 10),
      rangeEnd: r.range_end.toISOString().slice(0, 10),
      content: r.content,
      createdAt: r.created_at.toISOString(),
    }))
  )
})

// Generate (or regenerate) a digest for a date range. Streams the digest text
// as it generates, then stores it — regenerating the same range replaces the
// stored copy.
app.post('/api/digests', async (req, res) => {
  const { rangeStart, rangeEnd } = req.body || {}
  if (
    typeof rangeStart !== 'string' || !DATE_RE.test(rangeStart) ||
    typeof rangeEnd !== 'string' || !DATE_RE.test(rangeEnd) ||
    rangeStart > rangeEnd
  ) {
    return res.status(400).json({ error: 'invalid range' })
  }

  const { rows: convos } = await db.query(
    `SELECT id, created_at, mood, summary, messages FROM conversations
     WHERE user_id = $1 AND ended_at IS NOT NULL
       AND created_at::date >= $2::date AND created_at::date <= $3::date
     ORDER BY created_at`,
    [req.userId, rangeStart, rangeEnd]
  )
  if (convos.length < 2) {
    return res.status(400).json({ error: "There isn't enough in that range yet." })
  }

  const notice = await spendCeilingNotice(req.userId)
  if (notice) return res.status(429).json({ error: notice })

  // Small ranges get full transcripts; larger ones lean on the stored
  // summaries to keep the request manageable.
  const useTranscripts = convos.length <= 6
  const sessionsText = convos
    .map((c) => {
      const head = `Session on ${fmtDate(c.created_at)}` +
        (c.mood ? ` (mood ${c.mood}/10)` : ' (no mood recorded)')
      if (useTranscripts) {
        const body = c.messages
          .map((m) => `${m.role === 'user' ? 'Them' : 'Ember'}: ${m.content}`)
          .join('\n')
        return `${head}\n${body}`
      }
      return `${head}\nSummary: ${c.summary || '(no summary saved)'}`
    })
    .join('\n\n---\n\n')

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  let acc = ''
  const started = Date.now()
  let usage = null
  let interrupted = true
  try {
    const stream = client.messages.stream({
      model: DIGEST_MODEL,
      max_tokens: 2048,
      system: DIGEST_PROMPT,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content:
          `My sessions from ${rangeStart} to ${rangeEnd}` +
          (useTranscripts ? ' (full transcripts):\n\n' : ' (session summaries):\n\n') +
          sessionsText +
          '\n\nPlease write the digest now.',
      }],
    })
    stream.on('streamEvent', (event) => {
      if (event.type === 'message_start') usage = mergeUsage(usage, event.message.usage)
      else if (event.type === 'message_delta') usage = mergeUsage(usage, event.usage)
    })
    stream.on('text', (text) => {
      acc += text
      res.write(text)
    })
    await stream.finalMessage()
    interrupted = false
    if (acc.trim()) {
      await db.query(
        `INSERT INTO digests (user_id, range_start, range_end, content)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, range_start, range_end)
         DO UPDATE SET content = EXCLUDED.content, created_at = now()`,
        [req.userId, rangeStart, rangeEnd, acc]
      )
    }
  } catch (err) {
    res.write(`\n[error] ${err instanceof Anthropic.APIError ? 'API error: ' : ''}${err.message || err}`)
  }
  await logUsage({
    userId: req.userId, jobType: 'digest', model: DIGEST_MODEL, usage,
    durationMs: Date.now() - started, interrupted,
  })
  res.end()
})

// ---------- admin cost dashboard ----------

// Only the ADMIN_EMAIL account can see this; everyone else gets a 404 (not a
// 403) so the route's existence isn't advertised.
app.get('/api/admin/costs', async (req, res) => {
  const { rows: me } = await db.query('SELECT email FROM users WHERE id = $1', [req.userId])
  if (!ADMIN_EMAIL || !me[0] || normalizeEmail(me[0].email) !== normalizeEmail(ADMIN_EMAIL)) {
    return res.status(404).json({ error: 'not found' })
  }

  const one = async (sql, params = []) => (await db.query(sql, params)).rows
  const [totals] = await one(`
    SELECT
      COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= date_trunc('day', now())), 0)   AS today,
      COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= date_trunc('week', now())), 0)  AS week,
      COALESCE(SUM(estimated_cost_usd) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS month
    FROM api_usage`)
  const byJobType = await one(`
    SELECT job_type, COUNT(*) AS calls, COALESCE(SUM(estimated_cost_usd), 0) AS cost
    FROM api_usage WHERE created_at >= date_trunc('month', now())
    GROUP BY job_type ORDER BY cost DESC`)
  const byModel = await one(`
    SELECT model, COUNT(*) AS calls, COALESCE(SUM(estimated_cost_usd), 0) AS cost
    FROM api_usage WHERE created_at >= date_trunc('month', now())
    GROUP BY model ORDER BY cost DESC`)
  const [convCost] = await one(`
    SELECT AVG(c) AS avg,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY c) AS median,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY c) AS p90
    FROM (SELECT conversation_id, SUM(estimated_cost_usd) AS c
          FROM api_usage WHERE conversation_id IS NOT NULL GROUP BY conversation_id) t`)
  const [convTokens] = await one(`
    SELECT AVG(i) AS input, AVG(o) AS output, AVG(cr) AS cache_read
    FROM (SELECT conversation_id, SUM(input_tokens) AS i, SUM(output_tokens) AS o,
                 SUM(cache_read_tokens) AS cr
          FROM api_usage WHERE conversation_id IS NOT NULL GROUP BY conversation_id) t`)
  // Cache hit rate = cache reads as a share of all input-side tokens.
  const [cache] = await one(`
    SELECT SUM(cache_read_tokens)::float
           / NULLIF(SUM(input_tokens + cache_read_tokens + cache_creation_tokens), 0) AS hit_rate
    FROM api_usage WHERE job_type = 'chat'`)
  const [turns] = await one(`
    SELECT AVG(n) AS avg FROM (
      SELECT conversation_id, COUNT(*) AS n FROM api_usage
      WHERE job_type = 'chat' AND conversation_id IS NOT NULL GROUP BY conversation_id) t`)
  const perUser = await one(`
    SELECT u.email, COUNT(*) AS calls, COALESCE(SUM(a.estimated_cost_usd), 0) AS cost
    FROM api_usage a JOIN users u ON u.id = a.user_id
    WHERE a.created_at >= date_trunc('month', now())
    GROUP BY u.email ORDER BY cost DESC`)
  const topCalls = await one(`
    SELECT id, created_at, user_id, job_type, model, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, estimated_cost_usd, duration_ms,
           interrupted, batch
    FROM api_usage ORDER BY estimated_cost_usd DESC LIMIT 20`)

  res.json({
    totals, byJobType, byModel,
    costPerConversation: convCost, tokensPerConversation: convTokens,
    cacheHitRate: cache?.hit_rate ?? null,
    avgTurnsPerConversation: turns?.avg ?? null,
    perUserMonthly: perUser, topCalls,
    limits: { userDaily: USER_DAILY_SPEND_LIMIT, globalDaily: GLOBAL_DAILY_SPEND_LIMIT },
  })
})

// Serve the built frontend (single-service deployment). Registered last so /api wins.
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST))
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'))
  })
}

await initDb()
// Drain finished Batch API jobs every minute (and once shortly after boot).
setInterval(pollBatches, 60_000)
setTimeout(pollBatches, 5_000)
app.listen(PORT, () => {
  console.log(`Ember backend listening on port ${PORT}`)
})

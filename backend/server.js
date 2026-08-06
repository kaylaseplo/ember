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
// Env: ANTHROPIC_API_KEY (required). DB lives at DATA_DIR/companion.db.
// Serves the built React frontend from ../frontend/dist when present.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Anthropic from '@anthropic-ai/sdk'
import Database from 'better-sqlite3'
import cors from 'cors'
import express from 'express'

const MODEL = 'claude-opus-4-8'
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || path.join(BASE_DIR, '..', 'data')
const DB_PATH = path.join(DATA_DIR, 'companion.db')
const SYSTEM_PROMPT_FILE = path.join(BASE_DIR, '..', 'SYSTEM_PROMPT.md')
const FRONTEND_DIST = path.join(BASE_DIR, '..', 'frontend', 'dist')
const PORT = process.env.PORT || 8000

const PASSCODE = process.env.APP_PASSCODE
if (!PASSCODE) {
  console.error(
    'FATAL: APP_PASSCODE is not set. Refusing to start unprotected — set the ' +
      'APP_PASSCODE environment variable and restart.'
  )
  process.exit(1)
}
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

// ---------- auth ----------

const COOKIE_NAME = 'ember_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const sign = (value) =>
  crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex')

function makeToken() {
  const expires = String(Date.now() + SESSION_TTL_MS)
  return `${expires}.${sign(expires)}`
}

function timingSafeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

function isAuthenticated(req) {
  const cookies = req.headers.cookie || ''
  const match = cookies.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`))
  if (!match) return false
  const [expires, sig] = match.slice(COOKIE_NAME.length + 1).split('.')
  if (!expires || !sig) return false
  if (!timingSafeEqual(sig, sign(expires))) return false
  return Number(expires) > Date.now()
}

// In-memory rate limit for /api/login: 10 attempts per 15 minutes per IP.
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_ATTEMPTS = 10
const loginAttempts = new Map() // ip -> { count, resetAt }

function loginRateLimited(ip) {
  const now = Date.now()
  for (const [k, v] of loginAttempts) if (v.resetAt <= now) loginAttempts.delete(k)
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS }
  entry.count += 1
  loginAttempts.set(ip, entry)
  return entry.count > LOGIN_MAX_ATTEMPTS
}

app.post('/api/login', (req, res) => {
  if (loginRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts — try again in a bit.' })
  }
  const { passcode } = req.body || {}
  if (typeof passcode !== 'string' || !timingSafeEqual(passcode, PASSCODE)) {
    return res.status(401).json({ error: 'wrong passcode' })
  }
  res.cookie(COOKIE_NAME, makeToken(), {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
    path: '/',
  })
  res.json({ ok: true })
})

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' })
  res.json({ ok: true })
})

app.get('/api/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) })
})

// Everything else under /api requires a valid session cookie.
app.use('/api', (req, res, next) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'unauthorized' })
  next()
})

// ---------- database ----------

fs.mkdirSync(DATA_DIR, { recursive: true })
const db = new Database(DB_PATH)
db.exec(`CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  mood INTEGER,
  summary TEXT,
  messages TEXT NOT NULL
)`)

// ---------- helpers ----------

function loadSystemPrompt() {
  if (fs.existsSync(SYSTEM_PROMPT_FILE)) return fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8')
  return 'You are a warm, supportive AI companion helping someone process emotions between therapy sessions.'
}

// Summaries of recent sessions, for continuity and pattern recognition.
function recentContext(n = 3) {
  const rows = db
    .prepare('SELECT date, mood, summary FROM conversations ORDER BY id DESC LIMIT ?')
    .all(n)
  if (rows.length === 0) return ''
  const lines = rows
    .reverse()
    .map((r) => {
      const mood = r.mood ? `mood ${r.mood}/10` : 'no mood recorded'
      return `- ${r.date} (${mood}): ${r.summary || '(no summary)'}`
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

function nowStamp() {
  const d = new Date()
  const pad = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const textOf = (resp) =>
  resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()

// ---------- endpoints ----------

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body || {}
  if (!validMessages(messages)) {
    return res.status(400).json({ error: 'messages must not be empty' })
  }
  const system = loadSystemPrompt() + recentContext()

  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 2048,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive' },
      messages,
    })
    stream.on('text', (text) => res.write(text))
    await stream.finalMessage()
    res.end()
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      res.write('\n[error] Authentication failed — check ANTHROPIC_API_KEY on the server.')
    } else if (err instanceof Anthropic.RateLimitError) {
      res.write('\n[error] Rate limited — wait a moment and try again.')
    } else if (err instanceof Anthropic.APIError) {
      res.write(`\n[error] API error: ${err.message}`)
    } else {
      res.write(`\n[error] ${err.message || err}`)
    }
    res.end()
  }
})

app.post('/api/end-session', async (req, res) => {
  const { messages, mood: rawMood } = req.body || {}
  if (!validMessages(messages)) {
    return res.status(400).json({ error: 'no conversation to save' })
  }
  const mood =
    Number.isInteger(rawMood) && rawMood >= 1 && rawMood <= 10 ? rawMood : null

  let summary = ''
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system:
        "Summarize this support conversation in 2-3 sentences for the person's " +
        'own records: key themes, insights, and anything worth bringing to their ' +
        "therapist. Write in second person ('You explored...').",
      messages: [
        ...messages,
        { role: 'user', content: 'Please write the brief session summary now.' },
      ],
    })
    summary = textOf(resp)
  } catch {
    // save the session even if the summary call fails
  }

  const date = nowStamp()
  const info = db
    .prepare('INSERT INTO conversations (date, mood, summary, messages) VALUES (?, ?, ?, ?)')
    .run(date, mood, summary, JSON.stringify(messages))
  res.json({ id: info.lastInsertRowid, date, mood, summary })
})

app.get('/api/conversations', (req, res) => {
  const rows = db
    .prepare('SELECT id, date, mood, summary FROM conversations ORDER BY id DESC')
    .all()
  res.json(rows)
})

app.get('/api/conversations/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'conversation not found' })
  res.json({ ...row, messages: JSON.parse(row.messages) })
})

app.get('/api/moods', (req, res) => {
  const entries = db
    .prepare('SELECT id, date, mood FROM conversations WHERE mood IS NOT NULL ORDER BY id')
    .all()
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
  const sessions = db
    .prepare(
      "SELECT id, date, mood, summary FROM conversations " +
        "WHERE summary IS NOT NULL AND summary != '' ORDER BY id"
    )
    .all()
  let patterns = null
  if (sessions.length >= 2) {
    const notes = sessions
      .slice(-10)
      .map((s) => `- ${s.date} (mood ${s.mood ?? '?'}/10): ${s.summary}`)
      .join('\n')
    try {
      const resp = await client.messages.create({
        model: MODEL,
        max_tokens: 600,
        system:
          'You help someone review their mental-health journey between therapy ' +
          'sessions. Given their session summaries and mood ratings, identify ' +
          'recurring themes, possible triggers, and progress — written warmly ' +
          'in second person, in a form they could bring to their therapist. ' +
          'Keep it under 250 words.',
        messages: [{ role: 'user', content: `My recent session notes:\n${notes}` }],
      })
      patterns = textOf(resp)
    } catch {
      patterns = null
    }
  }
  res.json({ sessions: sessions.reverse(), patterns })
})

// Serve the built frontend (single-service deployment). Registered last so /api wins.
if (fs.existsSync(FRONTEND_DIST)) {
  app.use(express.static(FRONTEND_DIST))
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`Ember backend listening on port ${PORT}`)
})

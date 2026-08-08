# Ember

A private support companion for processing emotions between therapy sessions —
chat with streaming responses, mood tracking with a trend chart, past entries,
and cross-session pattern insights. Warm, dark, and quiet by design. Works on
phone and desktop browsers, and can be added to an iPhone home screen (PWA).

- **Backend**: Node.js/Express + Anthropic SDK (Claude Opus 4.8) + Postgres (Neon works well)
- **Frontend**: React (Vite), mobile-first, warm dark theme by default, served by the backend

## Run locally

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export SESSION_SECRET=...     # long random string used to sign session cookies
export INVITE_CODE=...        # required to create accounts; unset = signup disabled
export DATABASE_URL=postgres://...   # Postgres connection string (required)
# For local dev without a Neon database, a throwaway Docker Postgres works:
#   docker run -d --name ember-pg -e POSTGRES_PASSWORD=ember -p 5432:5432 postgres:16
#   export DATABASE_URL=postgres://postgres:ember@localhost:5432/postgres

# backend
cd backend && npm install && npm start   # or `npm run dev` for auto-reload

# frontend (dev mode, separate terminal — proxies /api to :8000)
cd frontend && npm install && npm run dev
```

Or build the frontend once (`cd frontend && npm run build`) and just run the
backend — it serves `frontend/dist` at `/`.

## Deploy to Render

1. Push this repo to GitHub.
2. On render.com: **New → Blueprint**, pick the repo (uses `render.yaml`).
3. Set `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `DATABASE_URL`, and
   `INVITE_CODE` when prompted (the server refuses to start without the
   database URL). Done.

Data lives in an external Postgres database (`DATABASE_URL`) — a free
[Neon](https://neon.tech) database works well and survives Render's ephemeral
filesystem. The schema is created automatically on first boot. SSL is used
automatically for non-localhost connections (Neon requires it).

## Deploy to Railway

1. Push to GitHub, create a new Railway project from the repo.
2. Build command: `cd backend && npm ci && cd ../frontend && npm ci && npm run build`
3. Start command: `node backend/server.js`
4. Add `ANTHROPIC_API_KEY`, `SESSION_SECRET`, `DATABASE_URL`, and
   `INVITE_CODE`.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/signup` | Create an account (requires the invite code); logs in |
| POST | `/api/auth/login` | Email + password → 30-day session cookie |
| POST | `/api/auth/logout` | Clear the session cookie (Sign out) |
| GET | `/api/auth/me` | Current user, or 401 |
| POST | `/api/chat` | Stream a reply (send `{messages: [...]}`, receive plain-text chunks) |
| POST | `/api/end-session` | Save conversation + mood; generates a summary |
| GET | `/api/conversations` | List past conversations |
| GET | `/api/conversations/{id}` | Full conversation |
| GET | `/api/moods` | Mood history, average, trend |
| GET | `/api/summaries` | Session summaries + cross-session patterns |

All `/api/*` routes outside `/api/auth/*` require the session cookie and
return 401 without it. Every data query is scoped to the signed-in user.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API access (server-side only) |
| `SESSION_SECRET` | recommended | Signs session cookies. If unset, a random one is generated at boot (sessions won't survive restarts) |
| `INVITE_CODE` | for signup | Required in the signup form to create an account. Unset = signup disabled entirely |
| `DATABASE_URL` | yes | Postgres connection string (e.g. from Neon); the server refuses to start without it |
| `CHAT_MODEL` | no | Model for chat (default `claude-opus-4-8`) |
| `SUMMARY_MODEL` | no | Model for session summaries (default `claude-haiku-4-5`) |
| `INSIGHTS_MODEL` | no | Model for cross-session insights, run via the Batch API (default `claude-haiku-4-5`) |
| `DIGEST_MODEL` | no | Model for the therapy prep digest (default: `CHAT_MODEL`) |
| `ADMIN_EMAIL` | no | Account allowed to view the cost dashboard at `/#admin` (API: `GET /api/admin/costs`; 404 for everyone else). Unset = dashboard disabled |
| `USER_DAILY_SPEND_LIMIT_USD` | no | Per-user daily spend ceiling in USD (default `2.00`); chats past it get a gentle "resets tomorrow" notice |
| `GLOBAL_DAILY_SPEND_LIMIT_USD` | no | Global daily circuit breaker in USD (default `50.00`) |

Every Anthropic API call writes a row to the `api_usage` table (real token
counts and cache reads from the API's own `usage` report, plus an estimated
cost). Logging is fail-open: a logging failure never breaks a conversation.

Never commit real values for any of these — set them in Render/Railway's
environment settings.

## Migrating old SQLite data

If you have a `data/companion.db` from before the Postgres migration, copy it
into Postgres once with:

```bash
cd backend
DATABASE_URL=postgres://... node migrate-sqlite-to-postgres.js
```

(Optionally pass a different path to the `.db` file as an argument.) The script
preserves IDs and is safe to re-run — already-copied rows are skipped.

## Claiming pre-account data

Conversations created before accounts existed have no owner and are invisible
until claimed. Create your account and claim them with:

```bash
cd backend
DATABASE_URL=postgres://... node migrate-claim-data.js
```

It prompts for your email and password (or reads `EMAIL` / `PASSWORD` env
vars), reuses the account if it already exists, and only claims rows that
don't belong to anyone — safe to re-run.

The Anthropic API key lives only on the server (`ANTHROPIC_API_KEY` env var);
the frontend never sees it. The system prompt is `SYSTEM_PROMPT.md` at the repo
root — edit it to change the companion's persona.

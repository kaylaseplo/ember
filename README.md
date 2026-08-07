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
export APP_PASSCODE=...       # the passcode that unlocks the app (required)
export SESSION_SECRET=...     # long random string used to sign session cookies
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
3. Set `ANTHROPIC_API_KEY`, `APP_PASSCODE`, `SESSION_SECRET`, and
   `DATABASE_URL` when prompted (all must be set before deploying; the server
   refuses to start without the passcode or database URL). Done.

Data lives in an external Postgres database (`DATABASE_URL`) — a free
[Neon](https://neon.tech) database works well and survives Render's ephemeral
filesystem. The schema is created automatically on first boot. SSL is used
automatically for non-localhost connections (Neon requires it).

## Deploy to Railway

1. Push to GitHub, create a new Railway project from the repo.
2. Build command: `cd backend && npm ci && cd ../frontend && npm ci && npm run build`
3. Start command: `node backend/server.js`
4. Add `ANTHROPIC_API_KEY`, `APP_PASSCODE`, `SESSION_SECRET`, and
   `DATABASE_URL`.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/login` | Exchange the passcode for a 30-day session cookie |
| POST | `/api/logout` | Clear the session cookie (the Lock button) |
| GET | `/api/session` | `{authenticated: bool}` for the current request |
| POST | `/api/chat` | Stream a reply (send `{messages: [...]}`, receive plain-text chunks) |
| POST | `/api/end-session` | Save conversation + mood; generates a summary |
| GET | `/api/conversations` | List past conversations |
| GET | `/api/conversations/{id}` | Full conversation |
| GET | `/api/moods` | Mood history, average, trend |
| GET | `/api/summaries` | Session summaries + cross-session patterns |

All `/api/*` routes except `login`, `logout`, and `session` require the
session cookie and return 401 without it.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API access (server-side only) |
| `APP_PASSCODE` | yes | The single-user passcode; the server refuses to start without it |
| `SESSION_SECRET` | recommended | Signs session cookies. If unset, a random one is generated at boot (sessions won't survive restarts) |
| `DATABASE_URL` | yes | Postgres connection string (e.g. from Neon); the server refuses to start without it |

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

The Anthropic API key lives only on the server (`ANTHROPIC_API_KEY` env var);
the frontend never sees it. The system prompt is `SYSTEM_PROMPT.md` at the repo
root — edit it to change the companion's persona.

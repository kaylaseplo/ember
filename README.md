# AI Support Companion (web app)

A private, full-stack support companion for processing emotions between therapy
sessions — chat with streaming responses, mood tracking with a trend chart,
conversation history, and cross-session pattern insights. Works on phone and
desktop browsers.

- **Backend**: Node.js/Express + Anthropic SDK (Claude Opus 4.8) + SQLite
- **Frontend**: React (Vite), mobile-first, dark mode, served by the backend

## Run locally

```bash
export ANTHROPIC_API_KEY=sk-ant-...

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
3. Set `ANTHROPIC_API_KEY` when prompted. Done.

Note: on Render's free tier the filesystem is ephemeral — the SQLite DB resets
on redeploy. Attach a persistent disk (paid) and point `DATA_DIR` at it to keep
history across deploys.

## Deploy to Railway

1. Push to GitHub, create a new Railway project from the repo.
2. Build command: `cd backend && npm ci && cd ../frontend && npm ci && npm run build`
3. Start command: `node backend/server.js`
4. Add `ANTHROPIC_API_KEY`. Optionally mount a volume and set `DATA_DIR` to it.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/chat` | Stream a reply (send `{messages: [...]}`, receive plain-text chunks) |
| POST | `/api/end-session` | Save conversation + mood; generates a summary |
| GET | `/api/conversations` | List past conversations |
| GET | `/api/conversations/{id}` | Full conversation |
| GET | `/api/moods` | Mood history, average, trend |
| GET | `/api/summaries` | Session summaries + cross-session patterns |

The Anthropic API key lives only on the server (`ANTHROPIC_API_KEY` env var);
the frontend never sees it. The system prompt is `SYSTEM_PROMPT.md` at the repo
root — edit it to change the companion's persona.

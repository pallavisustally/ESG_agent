# Deployment — ESG Copilot

Primary deploy target: **Vercel** (`vercel.json` → `agent/src/server.js`).

## Pre-deploy checklist

1. [ ] `npm run ci` green locally
2. [ ] GitHub Actions **quality-gates** + **Deploy gate (quality gates passed)** green
3. [ ] Branch protection requires the deploy-gate check
4. [ ] Production env vars set (below)
5. [ ] `/readyz` succeeds against staging with Neon
6. [ ] `MONITORING_TOKEN` set; `/ops` accessible with token
7. [ ] Final Acceptance Testing completed ([TESTING.md](TESTING.md))

## Environment matrix

### Required (production)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `SESSION_SECRET` | Session cookie signing |
| `OPENAI_API_KEY` or `OPENROUTER_API_KEY` | LLM provider |
| `MONITORING_TOKEN` | Protect `/api/monitoring` and `/ops` |

### Strongly recommended

| Variable | Purpose |
|----------|---------|
| Firebase `FIREBASE_*` + service account | User auth / chat sessions |
| `HF_*` or `R2_*` | Public PDF hosting for citations |
| `ALLOW_SQLITE_FALLBACK=false` | Fail closed if Neon is down on Vercel |

### Common tunables

See [`.env.example`](../.env.example): `USE_EXECUTION_PLANNER`, `SQL_DOCUMENT_FALLBACK`, `EXECUTION_ENGINE_TIMEOUT_MS`, `CHAT_RATE_LIMIT_RPM`, `PDF_FETCH_TIMEOUT_MS`, eval gates.

Copy from `.env.example`; never commit `.env`.

## Vercel notes

- Entry: `agent/src/server.js` (`export default app` when `VERCEL`)
- `maxDuration`: 60s — heavy PDF + LLM paths may race this limit
- Bundled files include SQLite wasm, metadata maps, public UI (`ops.*` included)
- On startup, may copy `data/database.db` → `/tmp/database.db` (fallback only)
- **Prefer Neon** for multi-instance correctness; do not rely on bundled SQLite for production writes

### Wire deploy to CI

1. GitHub → Settings → Branches → require status check:  
   `Deploy gate (quality gates passed)`
2. Vercel → Project → Git → enable deployment only from protected branch / required checks as available

Optional pipeline eval: set repo variable `EVAL_PIPELINE_GATE=true` and secret `DATABASE_URL` (see `.github/workflows/ci.yml`).

## Probes for the platform

| Probe | URL |
|-------|-----|
| Liveness | `GET /healthz` |
| Readiness | `GET /readyz` |

## Local production-like run

```bash
export NODE_ENV=production
export DATABASE_URL=...
export SESSION_SECRET=...
export OPENAI_API_KEY=...
export MONITORING_TOKEN=...
export ALLOW_SQLITE_FALLBACK=false
npm start
curl -s localhost:3000/healthz
curl -s localhost:3000/readyz
curl -s -H "x-monitoring-token: $MONITORING_TOKEN" localhost:3000/api/monitoring
```

## Rollback

1. Revert the deploy in Vercel (previous deployment)
2. Or set kill-switch flags from [OPERATIONS.md](OPERATIONS.md) and redeploy
3. Confirm `/readyz` and a known analytics + knowledge question

## Data / preprocess ops

| Script | Use |
|--------|-----|
| `npm run preprocess` | Build/refresh structured reports (XBRL → DB) |
| `npm run migrate:postgres` | SQLite → Postgres |
| `npm run upload:hf` / `upload:r2` | Host PDFs for citation links |

Run data jobs offline; do not block request path on bulk uploads.

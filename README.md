# SusTally ESG Copilot (BRSR Agent)

Production-oriented ESG / BRSR analyst that answers sustainability questions from structured filings, report narrative, and curated framework knowledge.

## What it does

- **Analytics** — metric lookup, rankings, comparisons, trends, sector aggregates
- **Reports / PDF** — company narrative and document fallback when SQL misses
- **Knowledge / Compliance / Guidance** — ESG concepts and frameworks (BRSR, ISSB, GRI, …)
- **Recommendations** — grounded in verified analytics when available
- **Charts** — visualization for rankings and comparisons
- **Conversation memory** — follow-ups (“same company”, “previous year”)

## Architecture (short)

```text
User → server.js → agent.js → runBrsrPipeline
  → Intent + memory
  → Execution Planner → ExecutionPlan
  → Orchestrator (engines) → Response Composer → Answer Validator
  → Client (SSE)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for engine responsibilities and flow detail.

## Quick start

### Prerequisites

- Node.js 20+
- Copy `.env.example` → `.env` and fill secrets
- Prefer **Neon Postgres** (`DATABASE_URL`) for production; local SQLite works for development

### Install & run

```bash
npm install
# Optional: build/refresh local SQLite from XBRL
# npm run preprocess

npm run dev
# open http://localhost:3000
```

### Provider priority

1. `OPENAI_API_KEY` → fixed `OPENAI_MODEL`
2. else `OPENROUTER_API_KEY`
3. else local `OLLAMA_*`

### Useful URLs

| Path | Purpose |
|------|---------|
| `/` | Chat UI |
| `/ops` | Ops monitoring dashboard |
| `/healthz` | Liveness probe |
| `/readyz` | Readiness (DB) |
| `/api/status` | Reports + DB health |
| `/api/monitoring` | Metrics API (auth in production) |

## Quality gates

```bash
npm test                 # unit + regression + in-test smoke
npm run evaluate:smoke   # plan-mode smoke (100%)
npm run evaluate:ci      # all plan cases (≥95%)
npm run ci               # full local merge gate
```

GitHub Actions: `.github/workflows/ci.yml`  
Require check **Deploy gate (quality gates passed)** before deploy.

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/END_TO_END_AI_AGENT_GUIDE.md](docs/END_TO_END_AI_AGENT_GUIDE.md) | Plain-English end-to-end: folders, PDF download, BRSR → Neon, compare tools, runtime flow |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Planner → Orchestrator → Engines → Composer → Validator |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Flags, monitoring, logging, troubleshooting |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Vercel, env matrix, probes, rollback |
| [docs/TESTING.md](docs/TESTING.md) | Unit, eval, load, final acceptance |

**Source of truth for feature flags and env vars:** [`.env.example`](.env.example).

## Production readiness roadmap

Completed: CI gates, reliability (`/healthz`, soft-fail, rate limit), monitoring (`/ops`), load harness, this documentation.

**Final Acceptance Testing** (before cutover):

```bash
npm run acceptance                 # plan-mode suite (~170 cases, ≥95%)
# staging: ACCEPTANCE_CONFIRM=yes npm run acceptance:http
```

See [docs/TESTING.md](docs/TESTING.md).

## License

Private / project use unless otherwise specified.

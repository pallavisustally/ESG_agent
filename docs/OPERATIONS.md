# Operations — ESG Copilot

Runbook for monitoring, configuration, logging, and troubleshooting.

**Flag source of truth:** [`.env.example`](../.env.example) — keep this doc aligned when flags change.

## Health probes

| Endpoint | Meaning | Success |
|----------|---------|---------|
| `GET /healthz` | Process alive | `200` `{ ok: true, status: "alive" }` |
| `GET /readyz` | Modules loaded + DB ping | `200` ready / `503` not ready |
| `GET /api/status` | Reports list + DB health detail | `200` / `503` |

Use `/healthz` for liveness and `/readyz` for readiness in platform config.

## Monitoring

| Surface | Notes |
|---------|--------|
| UI | `/ops` |
| API | `GET /api/monitoring?lines=2000` (`flush=1` to persist snapshot) |

### Auth

1. Prefer `MONITORING_TOKEN` — send `Authorization: Bearer …` or `x-monitoring-token`
2. Else Firebase session cookie when auth is configured
3. Local/dev may be open; **Vercel/production requires token or session**

### Key metrics (live snapshot)

- Request volume, average latency, slowest recent requests (`SLOW_REQUEST_MS`)
- SQL success / miss rates, PDF + narrative fallbacks
- Recommendation runs / failures
- Validation warnings / failures
- Engine failures / timeouts
- `errorsByCode` distribution

### Persistence caveats

- Counters are **in-process** (reset on cold start / scale-out)
- JSONL: `data/agent_observability.jsonl`
- Snapshot: `data/agent_monitoring_metrics.json`
- On Vercel, local disk is ephemeral — treat `/ops` as instance-local unless you ship logs externally

## Feature flags (common)

| Flag | Default | Effect |
|------|---------|--------|
| `USE_EXECUTION_PLANNER` | on | Orchestrator path; `false` → legacy |
| `USE_LANGGRAPH` | on (example) | Same stages via LangGraph if package present |
| `SQL_DOCUMENT_FALLBACK` | on | SQL miss → narrative/PDF for company-scoped asks |
| `UNIFIED_ANSWER_VALIDATION` | on | Answer validator gate |
| `USE_FRAMEWORK_REGISTRY` | on | Shared BRSR/ISSB/GRI registry |
| `ALLOW_SQLITE_FALLBACK` | local on / Vercel off | Neon down → SQLite |
| `CHAT_RATE_LIMIT_RPM` | 60 | Chat rate limit; `0` disables |
| `EXECUTION_ENGINE_TIMEOUT_MS` | 45000 | Per-engine timeout |
| `ASYNC_LOGGING` | off | Buffered JSONL writes |

Eval / CI thresholds: `EVAL_SMOKE_MIN_PASS_RATE`, `EVAL_PLAN_CI_MIN_PASS_RATE`, optional `EVAL_PIPELINE_GATE`.

## Logging

| Logger | Path / sink |
|--------|-------------|
| `agent-logger.js` | `data/agent_observability.jsonl` |
| Pipeline stages | `logPipelineStage(...)` |
| Console | startup, DB retry warnings, chat receipt |

Do not commit runtime JSONL or metrics files.

## Rate limiting

`POST /api/chat` uses an in-memory token bucket (`ops/rate-limit.js`).

- Keyed by `sessionId` or client IP
- `429` + `Retry-After` when exceeded
- Raise or disable (`CHAT_RATE_LIMIT_RPM=0`) for load tests

## Graceful degradation (summary)

| Failure | Behavior |
|---------|----------|
| Analytics timeout / error | Soft fail; may trigger report/PDF fallback |
| PDF unavailable | Structured unavailable message; no invented numbers |
| Recommendation fail / timeout | Section omitted; analytics/report still returned |
| Visualization fail | Chart omitted; text kept |
| Knowledge miss | Clarification / unknown-concept reply |
| Validation ERROR | Safe failure text; LLM invent blocked where configured |
| Neon down | SQLite if allowed; else readiness fails |

## Troubleshooting

### `/readyz` returns 503

- Check `DATABASE_URL` / network to Neon
- Locally: confirm SQLite path and `ALLOW_SQLITE_FALLBACK`
- Inspect `startupError` in readiness payload

### Empty or wrong answers

1. Confirm `USE_EXECUTION_PLANNER=true`
2. Check `/ops` for SQL miss / validation / engine failures
3. Reproduce with `npm run evaluate:smoke` for routing regressions
4. Trace JSONL for `requestId` / `execution_trace` stage

### Recommendations look generic

- Grounding needs analytics (or peers/sector). No verified numbers → general-guidance banner (expected).

### Chat 429s

- Lower client concurrency or raise `CHAT_RATE_LIMIT_RPM`

### Monitoring 401

- Set `MONITORING_TOKEN` and pass it in `/ops` token field (stored in browser localStorage)

### Slow requests

- Check slowest table on `/ops`
- PDF fetch: `PDF_FETCH_TIMEOUT_MS`
- LLM: provider latency; Vercel `maxDuration` (60s) can truncate heavy paths

## Rollback switches

| Symptom | Kill switch |
|---------|-------------|
| Bad validator behavior | `UNIFIED_ANSWER_VALIDATION=false` |
| Planner issues | `USE_EXECUTION_PLANNER=false` (legacy path) |
| Registry content issues | `USE_FRAMEWORK_REGISTRY=false` |
| PDF fallback noise | `SQL_DOCUMENT_FALLBACK=false` |

After any flag change, run `npm run ci` before promote.

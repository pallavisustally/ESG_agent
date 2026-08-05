# Testing — ESG Copilot

Testing strategy for merge gates, load tests, and final acceptance before production.

## Layers

| Layer | Command | Blocks merge? |
|-------|---------|---------------|
| Unit + regression | `npm test` | Yes (CI) |
| Plan smoke eval | `npm run evaluate:smoke` | Yes (100%) |
| Plan full eval | `npm run evaluate:ci` | Yes (≥95%) |
| Category summary | `npm run ci:summary` | Yes (CI) |
| Pipeline eval | `npm run evaluate:pipeline` | Optional (`EVAL_PIPELINE_GATE`) |
| Load / stress | `npm run load-test` | No (manual / staging) |
| Final acceptance (plan) | `npm run acceptance` | Pre-cutover (≥95%, ~170 cases) |
| Final acceptance (HTTP) | `ACCEPTANCE_CONFIRM=yes npm run acceptance:http` | Staging with live server |

Local one-shot: `npm run ci`

## Evaluation framework

- Benchmarks: `agent/src/evaluation/benchmarks/*.json` (14 categories including **recommendation**)
- Runner: `agent/src/evaluation/run-evaluation.js`
- Gates: `agent/src/evaluation/quality-gates.js`
- Deterministic scorers only (no LLM judge)

Plan mode exercises classify → memory → Execution Planner (no DB).  
Pipeline mode needs DB and is opt-in for CI.

## Load testing

```bash
# Planner concurrency (safe, no server)
npm run load-test
npm run load-test:conversation

# Full HTTP path against a running server
CHAT_RATE_LIMIT_RPM=0 LOAD_TEST_CONFIRM=yes \
  npm run load-test:http -- --concurrency 5 --requests 20
```

Reports: `data/evaluation_reports/load-*.json` (gitignored).

Measure: latency percentiles, throughput, timeouts, memory, per-scenario success.

## Regression suite

`agent/src/regression/regression-suite.test.js` — table-driven cases for conversation memory, metrics, routing, charts, and fallbacks. Every fixed bug-class should land a permanent assertion here.

## Final Acceptance Testing (pre-production)

Not a PR check. Run against staging with Neon + real LLM before declaring production-ready.

### Scope (~100–200 conversations)

Cover at least:

- Analytics (lookup, multi-metric)
- Comparisons and rankings
- Trend analysis
- Sector analysis
- PDF / document fallback after SQL miss
- Report search / summary
- Memory follow-ups (same company, prior year, “and Scope 2?”)
- Knowledge and guidance questions
- Recommendations (grounded + general-banner cases)
- Charts (ranking / compare)
- Failure scenarios (unknown company, unknown concept, rate limit, engine timeout simulation)

### Verify

| Check | Pass criteria |
|-------|----------------|
| Routing | Correct strategy / engines for the ask |
| Answers | Verified numbers only from data; no invented metrics |
| Charts | Render when expected; omit cleanly on failure |
| Citations | Present when PDF/report path used |
| Memory | Follow-ups keep company/year/metric |
| Degradation | Partial answers when recommendation/viz fails |
| Latency | Acceptable p95 under staging load (record baseline) |

### Automated plan acceptance

```bash
npm run acceptance
# Suite ≈ 170 cases from benchmarks + load packs + acceptance-extra.json
# Gate: ACCEPTANCE_MIN_PASS_RATE (default 0.95)
# Report: data/evaluation_reports/acceptance-plan-*.json
```

### Staging HTTP acceptance

```bash
CHAT_RATE_LIMIT_RPM=0 ACCEPTANCE_CONFIRM=yes \
  npm run acceptance:http -- --base-url https://your-staging-host
```

Also spot-check UI for charts, citations, grounded recommendations, and failure UX.

Only after Final Acceptance Testing + green CI should the system be considered **production-ready**. Future work can then focus on new business capabilities rather than foundational infrastructure.

## Adding tests

| Change type | Add |
|-------------|-----|
| Routing / intent bug | Regression case + optional benchmark |
| Engine answer shape | Unit test in engine / capability |
| Quality threshold | Update `quality-gates.js` + `.env.example` |
| New framework term | Registry entry + knowledge/compliance test |

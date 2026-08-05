# Architecture — ESG Copilot

This document describes the **current** default runtime path. It does not invent future engines.

Feature flags and timeouts: see [`.env.example`](../.env.example).

## High-level flow

```text
Browser / API client
    │
    ▼
agent/src/server.js          POST /api/chat (SSE)
    │
    ▼
agent/src/agent.js           runAgent()
    │
    ▼
pipeline/run-pipeline.js     runBrsrPipeline()
    │  (optional LangGraph wrapper — same stages)
    ▼
Intent classify + conversation memory
    │
    ▼
execution/execution-planner.js   planExecution() → ExecutionPlan
    │  (never executes tools)
    ▼
execution/execution-orchestrator.js   executeExecutionPlan()
    │
    ├─ Phase A: parallel — knowledge, compliance, guidance, document
    ├─ Phase B: sequential — analytics → report (SQL miss may auto PDF/narrative)
    └─ Phase C: recommendation (after analytics/report data)
    │
    ▼
capability/response-composer.js   composeCapabilityResults()
    │
    ▼
validation/answer-validator.js    applyAnswerValidation()
    │  PASS | WARNING | ERROR (+ one repair attempt)
    ▼
SSE done event → client
```

If `USE_EXECUTION_PLANNER=false`, or the orchestrator path does not handle the turn, the pipeline falls back to the legacy capability / SQL / RAG branches in `pipeline-execute.js`.

## Execution Planner

**Module:** `agent/src/execution/execution-planner.js`  
**Contract:** `agent/src/execution/execution-plan.js`

Responsibilities:

- Decide **strategy** and **required engines** from intent + capability signals
- Set flags: `needsSql`, `needsReport`, `needsPdf`, `needsVisualization`, `needsRecommendation`, etc.
- Emit assumptions / clarification when entities or metrics are ambiguous
- **Does not** run SQL, PDF, or LLM tools

Capability signals are reused from `capability/capability-planner.js` (also used as legacy fallback).

## Execution Orchestrator

**Module:** `agent/src/execution/execution-orchestrator.js`

Responsibilities:

- Run engines according to the plan (parallel vs sequential)
- Enforce per-engine timeout (`EXECUTION_ENGINE_TIMEOUT_MS`, default 45s) with `AbortSignal`
- Share `priorDataText` / `analyticsData` into recommendation
- Soft-omit failed recommendation/guidance/document sections so analytics still return
- Compose + validate before returning

## Engines

| Engine | Wrapper | Capability module | Role |
|--------|---------|-------------------|------|
| Analytics | `engines/analytics-engine.js` | SQL agent / viz | Structured BRSR metrics |
| Report | `engines/report-engine.js` | narrative / PDF fallback | Company report text |
| Knowledge | `engines/knowledge-engine.js` | `knowledge-engine.js` + registry | Definitions / concepts |
| Compliance | `engines/compliance-engine.js` | frameworks via registry | BRSR principles, ISSB, GRI, … |
| Guidance | `engines/guidance-engine.js` | how-to levers | Best-practice guidance |
| Recommendation | `engines/recommendation-engine.js` | grounding + levers | Company improvement advice |
| Document | `engines/document-engine.js` | draft templates | Policy / roadmap drafts |

Visualization is **not** a separate plan engine in most paths; charts are attached by analytics/report + `visualization/*`.

## Knowledge registry

**Module:** `agent/src/knowledge/framework-registry.js`  
Flag: `USE_FRAMEWORK_REGISTRY` (default on).

Shared curated content for frameworks + concepts (`related[]`, citation URLs). Consumed by compliance and knowledge builders.

## Response Composer

**Module:** `agent/src/capability/response-composer.js`

Merges multi-engine outputs into one user-facing markdown answer. Never exposes SQL, planner labels, or internal routing.

## Answer Validator

**Module:** `agent/src/validation/answer-validator.js`  
Flag: `UNIFIED_ANSWER_VALIDATION` (default on).

Mandatory gate after engines: chart↔data checks, citation presence when required, verdict `PASS` / `WARNING` / `ERROR`.

## Observability

| Piece | Location |
|-------|----------|
| Request traces | `observability/execution-trace.js` → JSONL |
| Counters / rates | `observability/monitoring.js` |
| Engine timings | `observability/engine-timing.js` |
| Ops UI | `/ops` |

## Related docs

- [OPERATIONS.md](OPERATIONS.md) — running and troubleshooting
- [DEPLOYMENT.md](DEPLOYMENT.md) — Vercel and env matrix
- [TESTING.md](TESTING.md) — quality gates and acceptance

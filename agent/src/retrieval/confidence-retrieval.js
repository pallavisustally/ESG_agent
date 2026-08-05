/**
 * Phase 8 — Confidence-based retrieval ladder.
 *
 * Instead of blindly chaining SQL → Narrative → PDF, each stage produces a
 * confidence score. The next stage runs only when confidence is below threshold.
 *
 *   SQL (conf) → Narrative (conf) → PDF (conf) → best answer / unavailable
 */

const DEFAULT_MIN_ACCEPT = Number(process.env.RETRIEVAL_MIN_CONFIDENCE || 0.45);
const DEFAULT_PDF_MIN_SCORE = Number(process.env.MIN_METRIC_PAGE_SCORE || 18);

/**
 * Normalize a raw lexical / hit score into 0–1 confidence.
 * @param {number} raw
 * @param {{ max?: number }} [opts]
 */
export function normalizeScore(raw, { max = 40 } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, Math.min(1, n / max));
}

/**
 * Confidence for a structured SQL result.
 */
export function scoreSqlConfidence(sqlResult = null) {
  if (!sqlResult) return { confidence: 0, reason: 'no_sql_result' };
  if (!sqlResult.ok) return { confidence: 0, reason: sqlResult.reason || 'sql_not_ok' };

  const data = sqlResult.data || {};
  const rows = Array.isArray(data.rows) ? data.rows : null;

  if (rows) {
    if (!rows.length) return { confidence: 0, reason: 'empty_rows' };
    const withValues = rows.filter((r) => {
      const v = r.metric_value ?? r.value ?? r.scope1_emissions ?? r.total_emissions;
      return v != null && Number.isFinite(Number(v));
    });
    if (!withValues.length && data.metric) {
      return { confidence: 0.15, reason: 'rows_without_metric_values' };
    }
    return {
      confidence: withValues.length ? 0.95 : 0.7,
      reason: 'sql_rows',
      rowCount: rows.length,
    };
  }

  if (data.value != null || data.metric_value != null || data.count != null) {
    return { confidence: 0.95, reason: 'sql_scalar' };
  }

  if (sqlResult.text && !/not available|n\/a|no .*found|could not/i.test(sqlResult.text)) {
    return { confidence: 0.8, reason: 'sql_text' };
  }

  return { confidence: 0, reason: 'sql_weak' };
}

/**
 * Confidence for narrative / data_json chunks.
 */
export function scoreNarrativeConfidence({ chunks = [], company = null, query = '' } = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) return { confidence: 0, reason: 'no_chunks' };

  const scores = list.map((c) => Number(c.score ?? c.rank ?? c.relevance ?? 0));
  const hasExplicit = scores.some((s) => Number.isFinite(s) && s > 0);
  const avg = scores.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) / list.length;
  // Chunks without lexical scores still get a base from presence (legacy narrative path).
  let conf = hasExplicit ? normalizeScore(avg, { max: 25 }) : 0.62;

  // Explicit very low scores must continue the ladder (Phase 8).
  if (hasExplicit && avg > 0 && avg < 5) {
    conf = Math.min(conf, 0.35);
  }

  if (company) {
    const want = String(company).toLowerCase().slice(0, 10);
    const matching = list.filter((c) => {
      const name = String(c.company || c.company_name || '').toLowerCase();
      return name.includes(want) || want.includes(name.slice(0, 8));
    });
    if (!matching.length) conf *= 0.2;
    else conf = Math.min(1, conf + 0.15 * (matching.length / list.length));
  }

  // Weak lexical overlap with the query → lower confidence.
  const qTokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
  if (qTokens.length) {
    const blob = list.map((c) => String(c.text || c.snippet || c.content || '')).join(' ').toLowerCase();
    const hits = qTokens.filter((t) => blob.includes(t)).length;
    const overlap = hits / qTokens.length;
    conf *= 0.45 + 0.55 * overlap;
  }

  return {
    confidence: Math.round(conf * 1000) / 1000,
    reason: hasExplicit ? 'narrative_chunks' : 'narrative_chunks_unscored',
    chunkCount: list.length,
  };
}

/**
 * Confidence for PDF page hits.
 */
export function scorePdfConfidence({ hits = [], minScore = DEFAULT_PDF_MIN_SCORE } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return { confidence: 0, reason: 'no_pdf_hits' };

  const best = Math.max(...list.map((h) => Number(h.score ?? h.rank ?? 0)));
  // Hits may omit score when tests / older callers only provide page+snippet.
  if (!Number.isFinite(best) || best <= 0) {
    // Presence of hits that already passed searchPdf minScore → moderate confidence.
    const floor = list.length >= 1 ? 0.7 : 0;
    return {
      confidence: Math.min(1, floor + (list.length >= 2 ? 0.1 : 0)),
      reason: 'pdf_hits_unscored',
      hitCount: list.length,
    };
  }

  if (best < Math.min(8, minScore * 0.4)) {
    return { confidence: 0, reason: 'pdf_below_floor', bestScore: best };
  }

  // Map ~8 → 0.55, ~minScore → 0.75, 2× minScore → ~0.95
  const conf = normalizeScore(best, { max: Math.max(minScore * 2, 40) });
  const boosted = Math.min(1, Math.max(conf, best >= 8 ? 0.58 : 0) + (list.length >= 2 ? 0.08 : 0));
  return {
    confidence: Math.round(boosted * 1000) / 1000,
    reason: 'pdf_hits',
    bestScore: best,
    hitCount: list.length,
  };
}

/**
 * Decide whether to accept a stage result or continue the ladder.
 */
export function shouldAcceptRetrieval(confidence, {
  minAccept = DEFAULT_MIN_ACCEPT,
} = {}) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return false;
  return c >= minAccept;
}

/**
 * Pick the best stage among scored attempts (highest confidence that met
 * acceptance, else the max confidence overall).
 */
export function pickBestRetrieval(attempts = [], { minAccept = DEFAULT_MIN_ACCEPT } = {}) {
  const list = Array.isArray(attempts) ? attempts.filter(Boolean) : [];
  if (!list.length) {
    return { source: null, confidence: 0, attempt: null, accepted: false };
  }

  const accepted = list
    .filter((a) => shouldAcceptRetrieval(a.confidence, { minAccept }))
    .sort((a, b) => Number(b.confidence) - Number(a.confidence));

  if (accepted.length) {
    const best = accepted[0];
    return {
      source: best.source,
      confidence: best.confidence,
      attempt: best,
      accepted: true,
    };
  }

  const best = [...list].sort((a, b) => Number(b.confidence) - Number(a.confidence))[0];
  return {
    source: best.source,
    confidence: best.confidence,
    attempt: best,
    accepted: false,
  };
}

/**
 * Run the confidence ladder with injectable stage runners.
 *
 * @param {{
 *   runSql?: () => Promise<object|null>,
 *   runNarrative?: () => Promise<object|null>,
 *   runPdf?: () => Promise<object|null>,
 *   minAccept?: number,
 * }} opts
 */
export async function runConfidenceRetrieval({
  runSql = null,
  runNarrative = null,
  runPdf = null,
  minAccept = DEFAULT_MIN_ACCEPT,
} = {}) {
  const attempts = [];

  if (typeof runSql === 'function') {
    const sqlResult = await runSql();
    const scored = scoreSqlConfidence(sqlResult);
    attempts.push({
      source: 'sql',
      confidence: scored.confidence,
      reason: scored.reason,
      result: sqlResult,
      ...scored,
    });
    if (shouldAcceptRetrieval(scored.confidence, { minAccept })) {
      return {
        ...pickBestRetrieval(attempts, { minAccept }),
        attempts,
        stoppedAt: 'sql',
      };
    }
  }

  if (typeof runNarrative === 'function') {
    const narrativeResult = await runNarrative();
    const chunks = narrativeResult?.chunks
      || narrativeResult?.data?.chunks
      || [];
    const scored = scoreNarrativeConfidence({
      chunks,
      company: narrativeResult?.company,
      query: narrativeResult?.query || '',
    });
    attempts.push({
      source: 'narrative',
      confidence: scored.confidence,
      reason: scored.reason,
      result: narrativeResult,
      ...scored,
    });
    if (shouldAcceptRetrieval(scored.confidence, { minAccept })) {
      return {
        ...pickBestRetrieval(attempts, { minAccept }),
        attempts,
        stoppedAt: 'narrative',
      };
    }
  }

  if (typeof runPdf === 'function') {
    const pdfResult = await runPdf();
    const hits = pdfResult?.hits || pdfResult?.data?.hits || [];
    const scored = scorePdfConfidence({ hits });
    attempts.push({
      source: 'pdf',
      confidence: scored.confidence,
      reason: scored.reason,
      result: pdfResult,
      ...scored,
    });
  }

  const best = pickBestRetrieval(attempts, { minAccept });
  return {
    ...best,
    attempts,
    stoppedAt: attempts.length ? attempts[attempts.length - 1].source : null,
  };
}

export { DEFAULT_MIN_ACCEPT, DEFAULT_PDF_MIN_SCORE };

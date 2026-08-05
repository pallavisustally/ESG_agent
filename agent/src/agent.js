import dotenv from 'dotenv';
import { getReportData, getCompanyList, getAvailableReports, getDb, ensureMetricPagesIndexed, getSourceRowsForReports, resolveCompanyYear, isPostgres } from './db.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { callOllamaChat, getOllamaConfig } from './ollama-client.js';
import { enrichSqlRows, enrichCompanyReport, upgradeReportCitations } from './report-sources.js';
import { verifyAgentCitations } from './pdf-verifier.js';
import { repairResponseMedia } from './answers/response-media.js';
import { normalizeChartJson } from './visualization/index.js';
import {
  sanitizeMetricOrderQuery,
  filterRankingRows,
  detectFemaleShareRankingIntent,
  buildFemaleShareRankingSql,
  rankingLooksInvalid,
  findUnknownSqlColumns,
  listReportsColumns,
  hasUnsupportedMetricQualifier,
  detectEmissionsDataIntent,
  filterZeroEmissionRows,
  buildCarbonEmissionsOverviewSql,
} from './sql-sanitize.js';
import {
  resolveMetricAliases,
  rewriteAliasedSqlColumns,
  suggestColumnsForUnknown,
  repairFalseUnavailableAnswer,
  looksLikeFalseUnavailableRefusal,
  logMetricAliasEvent,
  maybeLogUnresolvedEsgPhrase,
} from './metric-aliases.js';
import { runBrsrPipeline } from './pipeline/run-pipeline.js';
import { validateResponse } from './validation/response-validator.js';
import { applyAnswerValidation } from './validation/answer-validator.js';
import { userFacingErrorMessage } from './errors/agent-errors.js';
import {
  explainSqlFailure,
  shouldBlockLlmFallback,
  noFabricationSystemAddon,
  STRUCTURED_SQL_INTENTS,
} from './answers/sql-failure.js';
import { logPipelineStage } from './observability/agent-logger.js';
import {
  isEmissionRankMetric,
  filterNormalizeEmissionRankingRows,
} from './sql-agent/emission-normalize.js';

dotenv.config();

const SQL_ROW_LIMIT = parseInt(process.env.AGENT_SQL_ROW_LIMIT, 10) || 15;

function truncateToolOutput(output) {
  if (!output?.rows || !Array.isArray(output.rows)) return output;
  if (output.rows.length <= SQL_ROW_LIMIT) return output;
  return {
    rows: output.rows.slice(0, SQL_ROW_LIMIT),
    truncated: true,
    total_rows: output.rows.length,
  };
}

function trimChatHistory(chatHistory, maxTurns) {
  const userAssistant = chatHistory.filter((m) => m.role === 'user' || m.role === 'assistant');
  return userAssistant.slice(-maxTurns);
}

/** User-facing status text — never expose raw SQL in the UI. */
function friendlySqlStatus(query = '', phase = 'start') {
  const q = String(query).toLowerCase();
  if (phase === 'rewrite') return 'Refining the search for accurate rankings…';
  if (phase === 'fallback') return 'Correcting the ranking to match your question…';
  if (phase === 'done') return 'Gathered the matching report data.';

  if (/female_employee_share|male_employee_share/.test(q)) return 'Comparing workforce gender share across companies…';
  if (/female_board_share/.test(q)) return 'Comparing board gender diversity…';
  if (/female_employee_count|male_employee_count|total_employee_count/.test(q)) return 'Looking up workforce diversity figures…';
  if (/scope_?1|scope_?2|scope_?3|emissions_intensity/.test(q)) return 'Looking up greenhouse gas emissions…';
  if (/renewable_energy|energy_consumption|energy_intensity/.test(q)) return 'Checking energy and renewable metrics…';
  if (/water_consumption|water_intensity/.test(q)) return 'Checking water consumption metrics…';
  if (/waste_generated|waste_intensity/.test(q)) return 'Checking waste generation metrics…';
  if (/safety_ltifr/.test(q)) return 'Looking up workplace safety metrics…';
  if (/sector|industry/.test(q)) return 'Comparing companies by sector and industry…';
  if (/order by/.test(q)) return 'Ranking companies from the BRSR reports…';
  return 'Querying BRSR sustainability reports…';
}

function dedupeToolCalls(toolCalls = []) {
  const seen = new Set();
  const unique = [];

  for (const call of toolCalls) {
    const args = typeof call.function?.arguments === 'string'
      ? call.function.arguments
      : JSON.stringify(call.function?.arguments ?? {});
    const key = `${call.function?.name}:${args}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(call);
  }

  return unique;
}

function parseToolArguments(args) {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args ?? {};
}

function ensureCompanyYearInSelect(query) {
  const trimmed = query.trim().replace(/;+\s*$/, '');
  if (/\bcompany\b/i.test(trimmed) && /\byear\b/i.test(trimmed)) {
    return trimmed;
  }
  const match = trimmed.match(/^select\s+([\s\S]+?)\s+from\s+reports\b/i);
  if (!match) return trimmed;

  const selectList = match[1].trim();
  if (/^\*\s*$/.test(selectList)) return trimmed;

  const needsCompany = !/\bcompany\b/i.test(selectList);
  const needsYear = !/\byear\b/i.test(selectList);
  if (!needsCompany && !needsYear) return trimmed;

  const additions = [
    needsCompany ? 'company' : null,
    needsYear ? 'year' : null,
  ].filter(Boolean).join(', ');

  return trimmed.replace(/^select\s+/i, `SELECT ${additions}, `);
}

/**
 * Rewrite exact company equality to fuzzy LIKE so "HDFC Bank" matches
 * "HDFC Bank Limited". Leaves existing LIKE clauses unchanged.
 */
function relaxCompanyExactMatch(query) {
  if (!query || typeof query !== 'string') return query;

  const escapeSqlLiteral = (value) => String(value).replace(/'/g, "''");

  return query.replace(
    /\bcompany\s*=\s*(?:'([^']*)'|"([^"]*)")/gi,
    (_match, singleQuoted, doubleQuoted) => {
      const raw = (singleQuoted ?? doubleQuoted ?? '').trim();
      if (!raw || raw.includes('%')) {
        return `company = '${escapeSqlLiteral(raw)}'`;
      }
      return `company LIKE '%${escapeSqlLiteral(raw)}%'`;
    },
  );
}

function extractCompanyYearHints(query) {
  const companyMatch = query.match(/company\s*(?:like|=)\s*'([^']+)'/i)
    || query.match(/company\s*(?:like|=)\s*"([^"]+)"/i);
  const yearMatch = query.match(/\byear\s*=\s*(\d{4})\b/i);
  return {
    companyHint: companyMatch?.[1]?.replace(/%/g, '').trim() || null,
    yearHint: yearMatch ? Number(yearMatch[1]) : null,
  };
}

function preferPdfBackedRows(rows, sourceRowsByKey) {
  const bestByKey = new Map();
  for (const row of rows) {
    if (!row?.company || row.year == null) continue;
    const key = `${String(row.company).toLowerCase()}|${row.year}`;
    const existing = bestByKey.get(key);
    const source = sourceRowsByKey.get(`${row.company}|${row.year}`);
    const hasPdf = Boolean(source?.pdf_url || row.report_pdf_url || row.pdf_url);
    if (!existing || (!existing.hasPdf && hasPdf)) {
      bestByKey.set(key, { row, hasPdf });
    }
  }
  return [...bestByKey.values()].map((entry) => entry.row);
}

function dedupeSourceRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    if (!row?.company || row.year == null) continue;
    const key = `${String(row.company).toLowerCase()}|${row.year}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

export async function runAgent({
  userMessage,
  chatHistory = [],
  systemInstruction = '',
  modelName = null,
  ollamaHost = null,
  onProgress = null,
  signal = null,
  sessionId = null,
}) {
  const config = getOllamaConfig({ modelName, ollamaHost });
  const url = config.host ? `${config.host}/api/chat` : null;
  const maxIterations = parseInt(process.env.AGENT_MAX_ITERATIONS, 10) || 5;
  const maxHistory = parseInt(process.env.AGENT_MAX_HISTORY, 10) || 8;
  let answerStreamingStarted = false;
  let streamedText = '';
  const seenSourceRows = [];
  const requestedYears = [...new Set([...String(userMessage).matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])))];

  // Intent → Planner → Router → deterministic BRSR SQL (list/count/rank) before LLM tools.
  let pipelineMeta = null;
  try {
    pipelineMeta = await runBrsrPipeline({
      userMessage,
      chatHistory,
      sessionId,
      onProgress,
    });
    if (pipelineMeta?.handled && pipelineMeta.text) {
      // Same chart JSON lift as the LLM path — SQL agent emits nested { data: { labels, datasets } }.
      const pipelineText = normalizeChartJson(repairResponseMedia(pipelineMeta.text));
      return {
        text: pipelineText,
        citationVerification: null,
        chatHistory: [
          ...trimChatHistory(chatHistory, maxHistory).map((m) => ({
            role: m.role,
            content: m.text ?? m.content ?? '',
          })),
          { role: 'user', content: userMessage },
          { role: 'assistant', content: pipelineText },
        ],
        pipeline: {
          intent: pipelineMeta.classification?.intent,
          mode: pipelineMeta.route?.mode,
          strategy: pipelineMeta.plan?.strategy,
          forbidLlmFallback: Boolean(pipelineMeta.forbidLlmFallback),
        },
      };
    }

    // Phase 11 safety net: structured SQL intents must never reach LLM fabrication.
    const pipeIntent = pipelineMeta?.classification?.intent;
    if (
      pipelineMeta?.forbidLlmFallback
      || (pipeIntent && STRUCTURED_SQL_INTENTS.has(pipeIntent) && shouldBlockLlmFallback(pipeIntent, { error: 'handoff_llm' }))
    ) {
      const failureText = pipelineMeta?.text || explainSqlFailure({
        intent: pipeIntent,
        error: pipelineMeta?.sqlError || 'structured_sql_unhandled',
        metric: pipelineMeta?.classification?.metric || pipelineMeta?.plan?.metric,
        companies: pipelineMeta?.classification?.entities,
        year: pipelineMeta?.classification?.filters?.years?.[0],
        sector: pipelineMeta?.classification?.filters?.sector,
      });
      return {
        text: failureText,
        citationVerification: null,
        chatHistory: [
          ...trimChatHistory(chatHistory, maxHistory).map((m) => ({
            role: m.role,
            content: m.text ?? m.content ?? '',
          })),
          { role: 'user', content: userMessage },
          { role: 'assistant', content: failureText },
        ],
        pipeline: {
          intent: pipeIntent,
          mode: pipelineMeta?.route?.mode,
          strategy: pipelineMeta?.plan?.strategy,
          forbidLlmFallback: true,
        },
      };
    }
  } catch (pipeErr) {
    console.warn('[Pipeline] Falling back to LLM tools:', userFacingErrorMessage(pipeErr));
  }

  function assertNotAborted() {
    if (signal?.aborted) {
      const err = new Error('Generation stopped');
      err.name = 'AbortError';
      err.aborted = true;
      err.partialText = streamedText;
      throw err;
    }
  }

  function combinedSignal() {
    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    if (!signal) return timeoutSignal;
    if (typeof AbortSignal.any === 'function') {
      return AbortSignal.any([signal, timeoutSignal]);
    }
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal.aborted || timeoutSignal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener('abort', forward, { once: true });
    timeoutSignal.addEventListener('abort', forward, { once: true });
    return controller.signal;
  }

  // Define tools for Ollama
  const tools = [
    {
      type: 'function',
      function: {
        name: 'get_company_report',
        description: 'Full BRSR report JSON for one company and year.',
        parameters: {
          type: 'object',
          properties: {
            company: { 
              type: 'string', 
              description: 'Company name or partial name (e.g. "HDFC Bank", "Infosys Limited"). Partial names are resolved automatically.' 
            },
            year: { 
              type: 'integer', 
              description: 'The specific reporting year (2026 for FY 2025-26, 2025 for FY 2024-25).' 
            }
          },
          required: ['company', 'year']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_companies',
        description:
          'Overview of companies in the indexed BRSR database: total count, paginated names, sector counts, and CSV export path /api/companies?format=csv. Use for discovery. When the user wants ALL names, include total + page + export link — do not invent a tiny sample.',
        parameters: {
          type: 'object',
          properties: {
            page: { type: 'number', description: '1-based page (default 1)' },
            page_size: { type: 'number', description: 'Page size (default 100, max 500)' },
            sector: { type: 'string', description: 'Optional sector filter' },
            wants_all: { type: 'boolean', description: 'True when user asked for every company name' },
          },
        },
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_company_reports',
        description: 'List all report years and filenames available for a specific company.',
        parameters: {
          type: 'object',
          properties: {
            company: { type: 'string', description: 'The company name.' }
          },
          required: ['company']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'execute_sql_query',
        description: 'Run read-only SQL SELECT on reports table. Use for rankings, comparisons, aggregates.',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Read-only SQL SELECT on reports using only real schema columns (company, year, sector, industry, scope1/2/3_emissions, energy_consumption, renewable_energy_share, water_consumption, waste_generated, *_intensity, female_employee_count/share, male_employee_count/share, female_board_count/share, safety_ltifr, total_revenue, …). Map synonyms: carbon/GHG emissions → scope1+scope2+scope3 (or SUM); carbon intensity → emissions_intensity; water use → water_consumption; women workforce % → female_employee_share; male workforce % → male_employee_share. Example: SELECT company, year, <metric> FROM reports WHERE year = 2025 AND <metric> IS NOT NULL AND <metric> > 0 ORDER BY <metric> DESC LIMIT 5. Never invent columns like carbon_emissions; if truly not in schema and no synonym mapping, do not substitute.'
            }
          },
          required: ['query']
        }
      }
    }
  ];

  // Tool executors mapping
  const toolExecutors = {
    get_company_report: async (args) => {
      let { company, year } = args;
      if (onProgress) {
        onProgress({ 
          status: 'tool_start', 
          tool: 'get_company_report', 
          message: `Fetching structured BRSR report for "${company}" in year ${year}`
        });
      }

      const resolved = await resolveCompanyYear(company, year);
      if (resolved) {
        company = resolved.company;
        year = resolved.year;
      }
      
      const data = await getReportData(company, year);
      const sourceRow = data ? await ensureMetricPagesIndexed(company, year) : null;
      if (sourceRow) seenSourceRows.push(sourceRow);
      const enriched = enrichCompanyReport(data, sourceRow);

      if (onProgress) {
        onProgress({ 
          status: 'tool_end', 
          tool: 'get_company_report', 
          message: enriched && !enriched.error ? `Retrieved structured data successfully.` : `No report found.`
        });
      }

      return enriched || { error: `No report found in the database for company "${company}" and year ${year}. Use list_company_reports to see what is available.` };
    },

    list_companies: async (args = {}) => {
      if (onProgress) {
        onProgress({ status: 'tool_start', tool: 'list_companies', message: 'Retrieving list of companies...' });
      }

      const { paginateArray } = await import('./pagination/pagination.js');
      let companies = await getCompanyList();
      const sector = args.sector ? String(args.sector).trim() : '';
      if (sector) {
        const db = await getDb();
        const rows = await db.all(
          `SELECT DISTINCT company FROM reports WHERE lower(COALESCE(sector,'')) = lower(?) ORDER BY company`,
          [sector],
        );
        companies = rows.map((r) => r.company);
      }
      const db = await getDb();
      const bySector = await db.all(
        `SELECT COALESCE(NULLIF(TRIM(sector), ''), 'Unknown') AS sector,
                COUNT(DISTINCT company) AS company_count
         FROM reports
         GROUP BY 1
         ORDER BY company_count DESC, sector ASC`,
      );

      const pageSize = args.wants_all || args.wantsAll ? (args.page_size || args.pageSize || 100) : (args.page_size || args.pageSize || 50);
      const paged = paginateArray(companies, { page: args.page || 1, pageSize });
      const exportPath = sector
        ? `/api/companies?format=csv&sector=${encodeURIComponent(sector)}`
        : '/api/companies?format=csv';

      if (onProgress) {
        onProgress({ status: 'tool_end', tool: 'list_companies', message: `Found ${companies.length} companies.` });
      }

      return {
        total: paged.total,
        page: paged.page,
        page_size: paged.pageSize,
        companies: paged.items,
        truncated: paged.hasNext,
        has_next: paged.hasNext,
        export_csv: exportPath,
        by_sector: bySector,
        hint:
          'Include the total count and this page of names. If truncated or user asked for ALL names, mention pagination (say "next") and the export_csv link. ' +
          'Do NOT ask the user for a keyword first. Do NOT invent a 3-name sample when total is large.',
      };
    },

    list_company_reports: async (args) => {
      const { company } = args;
      if (onProgress) {
        onProgress({ status: 'tool_start', tool: 'list_company_reports', message: `Checking available reports for "${company}"...` });
      }

      const allReports = await getAvailableReports();
      const needle = String(company || '').toLowerCase().trim();
      const companyReports = allReports.filter((r) => {
        const name = r.company.toLowerCase();
        return name === needle || name.includes(needle) || needle.includes(name);
      });

      if (onProgress) {
        onProgress({ status: 'tool_end', tool: 'list_company_reports', message: `Found ${companyReports.length} report(s).` });
      }

      return { 
        reports: companyReports.map(r => ({
          company: r.company,
          year: r.year,
          filename: r.filename,
          isCustom: r.isCustom === 1,
        })),
      };
    },

    execute_sql_query: async (args) => {
      const { query } = args;
      if (!query || typeof query !== 'string') {
        return { error: 'Missing or invalid SQL query argument.' };
      }
      const cleanQuery = query.trim().toLowerCase();
      
      if (!cleanQuery.startsWith('select')) {
        return { error: 'Security Restriction: Only SELECT queries are allowed.' };
      }
      
      const dangerousKeywords = ['insert', 'update', 'delete', 'drop', 'alter', 'create', 'replace'];
      for (const kw of dangerousKeywords) {
        if (cleanQuery.includes(kw)) {
          return { error: `Security Restriction: Modifying queries containing keyword "${kw}" are not allowed.` };
        }
      }
      
      if (onProgress) {
        onProgress({ 
          status: 'tool_start', 
          tool: 'execute_sql_query', 
          message: friendlySqlStatus(query, 'start'),
        });
      }
      
      try {
        // Rewrite slang/invented column names (carbon_emissions → scope1_emissions, etc.)
        const aliasedQuery = rewriteAliasedSqlColumns(query, userMessage);
        const unknownCols = findUnknownSqlColumns(aliasedQuery);
        if (unknownCols.length) {
          const suggestion = suggestColumnsForUnknown(unknownCols, userMessage);
          const metricHint = resolveMetricAliases(userMessage);
          if (suggestion) {
            logMetricAliasEvent({
              type: 'unknown_sql_column_suggested',
              userMessage,
              detail: { unknownCols, suggestion },
            });
          }
          const synonymNote = metricHint.columns.length
            ? ` This question maps to: ${metricHint.columns.join(', ')}. Re-run SQL with those columns — do NOT say the metric is unavailable.`
            : '';
          return {
            error:
              `Unknown column(s) in SQL: ${unknownCols.join(', ')}. `
              + (suggestion ? `Did you mean: ${suggestion}. ` : '')
              + `Available reports columns: ${listReportsColumns()}. `
              + (synonymNote
                || 'If the user asked for a metric not in this list and no synonym mapping applies, do NOT substitute a related column — reply in 1–2 short sentences that the metric is not available (no Executive Summary headings).'),
            unavailable_columns: unknownCols,
            suggested_columns: suggestion || null,
            available_columns: listReportsColumns().split(', '),
          };
        }

        // Block silent substitutes: e.g. "disabled female workers" → female_employee_count ranking.
        if (
          hasUnsupportedMetricQualifier(userMessage)
          && /\bfemale_employee_(count|share)\b/i.test(aliasedQuery)
          && /\b(disabled|differently|pwd|handicap|impair|permanent|temporary|contract|migrant|caste|tribal|supplier|csr|training)\b/i.test(userMessage)
        ) {
          return {
            error:
              'The user asked for a workforce/diversity slice that is not stored as its own column. '
              + 'Do NOT query female_employee_count or female_employee_share as a substitute. '
              + 'Reply in 1–2 short sentences that this metric is not available (no Executive Summary headings), '
              + 'and optionally list closest available columns (e.g. female_employee_share, female_employee_count). '
              + `Available columns: ${listReportsColumns()}`,
          };
        }

        const db = await getDb();
        const fuzzy = ensureCompanyYearInSelect(relaxCompanyExactMatch(aliasedQuery));
        let { sql: rewritten, orderColumn, orderDir, limit: rankingLimit } = sanitizeMetricOrderQuery(fuzzy, {
          postgres: isPostgres() || db.dialect === 'postgres',
          userMessage,
        });
        if (onProgress && rewritten !== query.trim().replace(/;+\s*$/, '')) {
          onProgress({
            status: 'tool_start',
            tool: 'execute_sql_query',
            message: friendlySqlStatus(rewritten, 'rewrite'),
          });
        }
        const { companyHint, yearHint } = extractCompanyYearHints(rewritten);
        let rows = await db.all(rewritten);

        let normalizedRows = rows.map((row) => ({
          ...row,
          company: row.company || companyHint || row.Company || null,
          year: row.year ?? yearHint ?? row.Year ?? null,
        })).filter((row) => {
          const effectiveYearHint = yearHint ?? (requestedYears.length === 1 ? requestedYears[0] : null);
          if (effectiveYearHint != null) return Number(row.year) === Number(effectiveYearHint);
          if (requestedYears.length > 1) return requestedYears.includes(Number(row.year));
          return true;
        });

        if (orderColumn) {
          normalizedRows = filterRankingRows(normalizedRows, orderColumn, orderDir);
          if (rankingLimit != null) {
            normalizedRows = normalizedRows.slice(0, rankingLimit);
          }
        }

        // Carbon/GHG lists must not return all-null/zero scope rows displayed as "0 tCO2e".
        if (detectEmissionsDataIntent(userMessage)) {
          const before = normalizedRows.length;
          normalizedRows = filterZeroEmissionRows(normalizedRows);
          const year = yearHint ?? (requestedYears.length === 1 ? requestedYears[0] : null);
          const mostlyZeros = before > 0 && normalizedRows.length < Math.min(3, before);
          if ((mostlyZeros || !normalizedRows.length) && year) {
            const fallbackSql = buildCarbonEmissionsOverviewSql(year, rankingLimit || 10);
            if (fallbackSql) {
              if (onProgress) {
                onProgress({
                  status: 'tool_start',
                  tool: 'execute_sql_query',
                  message: friendlySqlStatus('', 'fallback'),
                });
              }
              rows = await db.all(fallbackSql);
              orderColumn = 'total_emissions';
              orderDir = 'DESC';
              rankingLimit = rankingLimit || 10;
              normalizedRows = filterZeroEmissionRows(rows);
            }
          }

          // Unit normalize + drop parse/light-sector outliers (same guards as SQL agent rankings).
          const emissionMetric = isEmissionRankMetric(orderColumn)
            ? orderColumn
            : (orderColumn === 'total_ghg_emissions' || detectEmissionsDataIntent(userMessage)
              ? 'total_emissions'
              : null);
          if (emissionMetric && normalizedRows.some((r) => 'scope1_emissions' in (r || {}) || 'scope2_emissions' in (r || {}))) {
            const { rows: cleaned } = filterNormalizeEmissionRankingRows(normalizedRows, emissionMetric, {
              order: orderDir || 'DESC',
            });
            normalizedRows = cleaned.map((r) => ({
              ...r,
              total_ghg_emissions: r.metric_value,
              total_emissions: r.metric_value,
            }));
            orderColumn = emissionMetric;
          }

          if (rankingLimit != null) {
            normalizedRows = normalizedRows.slice(0, rankingLimit);
          }
        }

        // Hard fallback: top female *share* questions must not return count/zero junk.
        if (detectFemaleShareRankingIntent(userMessage)) {
          const year = yearHint ?? (requestedYears.length === 1 ? requestedYears[0] : null);
          const needsFallback = rankingLooksInvalid(normalizedRows, 'female_employee_share', {
            minRows: Math.min(rankingLimit || 5, 3),
          }) || orderColumn !== 'female_employee_share';
          if (needsFallback && year) {
            const fallbackSql = buildFemaleShareRankingSql(year, rankingLimit || 5);
            if (fallbackSql) {
              if (onProgress) {
                onProgress({
                  status: 'tool_start',
                  tool: 'execute_sql_query',
                  message: friendlySqlStatus('', 'fallback'),
                });
              }
              rows = await db.all(fallbackSql);
              orderColumn = 'female_employee_share';
              orderDir = 'DESC';
              rankingLimit = rankingLimit || 5;
              normalizedRows = filterRankingRows(rows, orderColumn, orderDir).slice(0, rankingLimit);
            }
          }
        }

        if (!normalizedRows.length && rows.length) {
          return {
            error: `Query returned rows, but none matched requested year(s) ${requestedYears.join(', ') || yearHint} with valid ranking values. Re-run with WHERE year = <requested year> AND <metric> IS NOT NULL AND <metric> > 0.`,
            raw_years_seen: [...new Set(rows.map((r) => r.year).filter((y) => y != null))],
          };
        }

        const sourceRowsByKey = await getSourceRowsForReports(normalizedRows);
        // For metric rankings, keep metric order — do not reshuffle toward PDF-only sparse rows.
        const preferred = orderColumn
          ? normalizedRows
          : preferPdfBackedRows(normalizedRows, sourceRowsByKey);
        for (const sourceRow of sourceRowsByKey.values()) {
          seenSourceRows.push(sourceRow);
        }
        let enrichedRows = enrichSqlRows(preferred.length ? preferred : normalizedRows, sourceRowsByKey);
        if (orderColumn) {
          enrichedRows = filterRankingRows(enrichedRows, orderColumn, orderDir);
          if (rankingLimit != null) {
            enrichedRows = enrichedRows.slice(0, rankingLimit);
          }
        }
        if (detectEmissionsDataIntent(userMessage)) {
          enrichedRows = filterZeroEmissionRows(enrichedRows);
          if (rankingLimit != null) {
            enrichedRows = enrichedRows.slice(0, rankingLimit);
          }
        }
        
        if (onProgress) {
          onProgress({ 
            status: 'tool_end', 
            tool: 'execute_sql_query', 
            message: enrichedRows.length
              ? `Found ${enrichedRows.length} matching result${enrichedRows.length === 1 ? '' : 's'}.`
              : 'No matching rows found.',
          });
        }
        
        return truncateToolOutput({ rows: enrichedRows });
      } catch (err) {
        if (onProgress) {
          onProgress({ 
            status: 'tool_end', 
            tool: 'execute_sql_query', 
            message: `Execution failed: ${err.message}`
          });
        }
        const hint = /column|does not exist|no such column/i.test(err.message)
          ? ` Available reports columns: ${listReportsColumns()}. If the asked metric is not listed, reply in 1–2 short sentences that it is not available (no Executive Summary headings) — do not substitute another metric.`
          : '';
        return { error: `SQL execution error: ${err.message}.${hint}` };
      }
    }
  };


  // Build model messages history
  const messages = [];

  const db = await getDb();
  const customCompanies = await db.all('SELECT DISTINCT company FROM reports WHERE is_custom = 1');
  let customInfo = '';
  if (customCompanies.length > 0) {
    customInfo = `\nCustom uploaded companies: ${customCompanies.map((c) => c.company).join(', ')}.`;
  }

  const metricAliases = resolveMetricAliases(userMessage);
  maybeLogUnresolvedEsgPhrase(userMessage, metricAliases);

  messages.push({
    role: 'system',
    content: (systemInstruction || SYSTEM_PROMPT) + customInfo
      + (requestedYears.length
        ? `\nUser-requested year(s): ${requestedYears.join(', ')}. Use ONLY these year values in SQL filters and citations.`
        : '')
      + (metricAliases.systemHint || '')
      + (pipelineMeta?.systemAddon || '')
      + noFabricationSystemAddon()
      + (pipelineMeta?.resolvedCompany
        ? `\nResolved company entity: ${pipelineMeta.resolvedCompany}. Prefer this exact name in SQL LIKE filters.`
        : ''),
  });

  trimChatHistory(chatHistory, maxHistory).forEach((msg) => {
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.text ?? msg.content ?? '',
    });
  });

  // Clarify synonym-mapped questions so the model does not refuse with the unavailable template.
  const userContent = metricAliases.columns.length
    ? `${userMessage}\n\n(Note: In this BRSR database, interpret that metric as column(s): ${metricAliases.columns.join(', ')}. Answer using those — do not say unavailable.)`
    : userMessage;
  messages.push({ role: 'user', content: userContent });

  let iteration = 0;

  while (iteration < maxIterations) {
    assertNotAborted();
    iteration++;

    if (onProgress) {
      onProgress({
        status: 'thinking',
        loop: iteration,
        message: `Reasoning (step ${iteration})...`,
      });
    }

    const hasToolResults = messages.some((m) => m.role === 'tool');
    // Cloud providers: non-streaming final answer avoids duplicate/partial tool-call payloads.
    const useStream = hasToolResults && config.provider === 'ollama';
    const finalIteration = iteration >= maxIterations;
    // On the last allowed iteration, force an answer (no more tools) to avoid hard failures.
    const toolsForCall = finalIteration ? undefined : tools;

    if (useStream && onProgress && !answerStreamingStarted) {
      answerStreamingStarted = true;
      onProgress({ status: 'answer_start' });
    }

    let assistantMessage;
    try {
      assistantMessage = await callOllamaChat({
        url,
        model: config.model,
        fallbackModels: config.fallbackModels,
        messages: finalIteration
          ? [
              ...messages,
              {
                role: 'user',
                content: 'Using the tool results already available, provide the final answer now. If the asked metric is unavailable or out-of-box, reply in 1–2 short sentences only (no Executive Summary / Key Findings / Analysis / Recommendation headings). Otherwise use the structured analysis format. For charts, emit a fenced ```json-chart block with chartType, title, labels, and datasets — never a markdown image like ![Emissions Trend Chart](...). Include page citations inline next to values only when tool results provide <metric>_citation / ready_citations with a real PDF URL (prefer /local-pdf/…). Never invent a Citations/Sources footer, “full report here” links, empty [here](...), or NSE archive URLs. If no citation URL is provided, show metric values only with no source links. Do not call more tools.',
              },
            ]
          : messages,
        tools: toolsForCall,
        options: finalIteration || hasToolResults
          ? {
              ...config.options,
              num_predict: config.finalNumPredict || config.options?.num_predict || 2048,
            }
          : config.options,
        keepAlive: config.keepAlive,
        stream: useStream,
        onToken: useStream
          ? (delta) => {
              streamedText += delta;
              onProgress?.({ status: 'token', delta });
            }
          : undefined,
        signal: combinedSignal(),
      });
    } catch (fetchErr) {
      if (signal?.aborted) {
        const err = new Error('Generation stopped');
        err.name = 'AbortError';
        err.aborted = true;
        err.partialText = streamedText || fetchErr?.partialText || '';
        throw err;
      }
      console.error('Fetch error calling LLM:', fetchErr);
      const providerHint = config.provider === 'openai'
        ? `OpenAI model "${config.model}" may be unavailable. Check OPENAI_API_KEY and OPENAI_MODEL in .env.`
        : config.provider === 'openrouter'
        ? `OpenRouter model "${config.model}" may be rate-limited. Try another OPENROUTER_MODEL in .env.`
        : `Ensure Ollama is running at "${config.host}" and model "${config.model}" is pulled.`;
      throw new Error(`Failed to connect to LLM provider. ${providerHint} ${fetchErr.message}`);
    }

    messages.push(assistantMessage);

    const rawToolCalls = (!finalIteration && assistantMessage.tool_calls) || [];

    if (rawToolCalls.length > 0) {
      const uniqueToolCalls = dedupeToolCalls(rawToolCalls);

      if (uniqueToolCalls.length !== rawToolCalls.length) {
        assistantMessage = { ...assistantMessage, tool_calls: uniqueToolCalls };
        messages[messages.length - 1] = assistantMessage;
      }

      const toolResults = await Promise.all(
        uniqueToolCalls.map(async (call) => {
          assertNotAborted();
          const func = call.function;
          const executor = toolExecutors[func.name];
          if (!executor) {
            return {
              role: 'tool',
              tool_call_id: call.id,
              content: JSON.stringify({ error: `Tool ${func.name} is not implemented.` }),
            };
          }
          try {
            const output = await executor(parseToolArguments(func.arguments));
            assertNotAborted();
            return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) };
          } catch (err) {
            if (err?.aborted || err?.name === 'AbortError') throw err;
            console.error(`Error executing tool "${func.name}":`, err);
            return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: err.message }) };
          }
        }),
      );

      messages.push(...toolResults);
    } else {
      let finalText = assistantMessage.content || '';
      finalText = normalizeChartJson(finalText);
      finalText = upgradeReportCitations(finalText, seenSourceRows);
      finalText = repairResponseMedia(finalText);
      finalText = normalizeChartJson(finalText);
      // Hard guard: synonym-mapped metrics must never get the "not available" template.
      if (looksLikeFalseUnavailableRefusal(finalText) && metricAliases.columns.length) {
        logMetricAliasEvent({
          type: 'false_unavailable_repaired',
          userMessage,
          detail: { columns: metricAliases.columns, matchIds: metricAliases.matches.map((m) => m.id) },
        });
      }
      finalText = repairFalseUnavailableAnswer(finalText, metricAliases);

      // Unified answer validation — reject sample lists / fabricated rankings.
      const hasToolEvidence = messages.some((m) => m.role === 'tool');
      let citationVerification = null;
      const uniqueSourceRows = dedupeSourceRows(seenSourceRows);
      const verifyCitations = process.env.VERIFY_CITATIONS !== 'false';
      if (verifyCitations && uniqueSourceRows.length > 0) {
        const verifyStarted = Date.now();
        try {
          citationVerification = await verifyAgentCitations(finalText, uniqueSourceRows);
        } catch (verifyErr) {
          console.warn('[Citation Verification] Failed:', verifyErr.message);
        }
        const verifyMs = Date.now() - verifyStarted;
        if (verifyMs > 2000) {
          console.log(`[Perf] Citation verification took ${verifyMs}ms (${uniqueSourceRows.length} source row(s))`);
        }
      }

      let sqlRepairResult = null;
      if (pipelineMeta?.classification) {
        // Pre-fetch SQL repair candidate for list incompleteness (same as before).
        const preCheck = validateResponse({
          text: finalText,
          intent: pipelineMeta.classification.intent,
          wantsAll: pipelineMeta.classification.wantsAll,
          classification: pipelineMeta.classification,
          source: 'llm',
          hasToolEvidence,
        });
        if (!preCheck.ok && /sample_instead_of_all|incomplete_list/.test(preCheck.reason || '')) {
          try {
            const { runSqlAgent } = await import('./sql-agent/sql-agent.js');
            sqlRepairResult = await runSqlAgent({
              plan: pipelineMeta.plan,
              classification: { ...pipelineMeta.classification, wantsAll: true },
              memory: pipelineMeta.memory,
            });
          } catch (repairErr) {
            console.warn('[Validator] list repair failed:', repairErr.message);
          }
        }
      }

      const applied = await applyAnswerValidation(
        {
          text: finalText,
          classification: pipelineMeta?.classification || null,
          executionPlan: null,
          engineResults: [],
          data: null,
          citations: [],
          source: 'llm',
          hasToolEvidence,
          wantsAll: pipelineMeta?.classification?.wantsAll,
          sqlResult: sqlRepairResult,
        },
        {
          sqlResult: sqlRepairResult,
          citationVerification,
        },
      );
      finalText = applied.text;
      const llmValidation = applied.validation;

      logPipelineStage('response_validate', {
        intent: pipelineMeta?.classification?.intent || null,
        mode: 'llm',
        tool: 'LLM',
        ok: llmValidation.ok,
        verdict: llmValidation.verdict,
        reason: llmValidation.reason,
        errors: llmValidation.errors,
        warnings: llmValidation.warnings,
        hasToolEvidence,
        repairActions: applied.repairActions,
      });

      logPipelineStage('response', {
        intent: pipelineMeta?.classification?.intent || null,
        mode: 'llm',
        tool: 'LLM',
        ok: true,
        hasToolEvidence,
      });

      return {
        text: finalText,
        citationVerification,
        chatHistory: messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => {
            const isLast = m.content === assistantMessage.content;
            return {
              role: m.role,
              content: isLast ? finalText : (m.content || ''),
            };
          }),
        pipeline: pipelineMeta
          ? {
              intent: pipelineMeta.classification?.intent,
              mode: pipelineMeta.route?.mode,
              strategy: pipelineMeta.plan?.strategy,
            }
          : null,
      };
    }
  }

  throw new Error('Agent failed to complete reasoning within the iteration limit.');
}

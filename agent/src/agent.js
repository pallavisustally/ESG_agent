import dotenv from 'dotenv';
import { getReportData, getCompanyList, getAvailableReports, getDb, ensureMetricPagesIndexed, getSourceRowsForReports, resolveCompanyYear, isPostgres } from './db.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { callOllamaChat, getOllamaConfig } from './ollama-client.js';
import { enrichSqlRows, enrichCompanyReport, upgradeReportCitations } from './report-sources.js';
import { verifyAgentCitations } from './pdf-verifier.js';
import {
  sanitizeMetricOrderQuery,
  filterRankingRows,
  detectFemaleShareRankingIntent,
  buildFemaleShareRankingSql,
  rankingLooksInvalid,
  findUnknownSqlColumns,
  listReportsColumns,
  hasUnsupportedMetricQualifier,
} from './sql-sanitize.js';

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

  if (/female_employee_share/.test(q)) return 'Comparing female employee share across companies…';
  if (/female_board_share/.test(q)) return 'Comparing board gender diversity…';
  if (/female_employee_count|total_employee_count/.test(q)) return 'Looking up workforce diversity figures…';
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
  onProgress = null
}) {
  const config = getOllamaConfig({ modelName, ollamaHost });
  const url = config.host ? `${config.host}/api/chat` : null;
  const maxIterations = parseInt(process.env.AGENT_MAX_ITERATIONS, 10) || 5;
  const maxHistory = parseInt(process.env.AGENT_MAX_HISTORY, 10) || 4;
  let answerStreamingStarted = false;
  const seenSourceRows = [];
  const requestedYears = [...new Set([...String(userMessage).matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1])))];

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
        description: 'List all companies currently available in the database.',
        parameters: { type: 'object', properties: {} }
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
              description: 'Read-only SQL SELECT on reports using only real schema columns (company, year, sector, industry, scope1/2/3_emissions, energy_consumption, renewable_energy_share, water_consumption, waste_generated, *_intensity, female_employee_count/share, female_board_count/share, safety_ltifr, total_revenue, …). Example pattern: SELECT company, year, <metric> FROM reports WHERE year = 2025 AND <metric> IS NOT NULL AND <metric> > 0 ORDER BY <metric> DESC LIMIT 5. Never invent columns; if the asked metric is not in the schema, do not query a substitute.'
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

    list_companies: async () => {
      if (onProgress) {
        onProgress({ status: 'tool_start', tool: 'list_companies', message: 'Retrieving list of companies...' });
      }
      
      const companies = await getCompanyList();
      
      if (onProgress) {
        onProgress({ status: 'tool_end', tool: 'list_companies', message: `Found ${companies.length} companies.` });
      }

      if (companies.length > 50) {
        return {
          error: `Too many companies (${companies.length}) to list at once. Do NOT request the full list, as it will exhaust your context. Instead, search for a company name using SQL: SELECT DISTINCT company FROM reports WHERE company LIKE '%Keyword%'`
        };
      }

      return { companies };
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
        const unknownCols = findUnknownSqlColumns(query);
        if (unknownCols.length) {
          return {
            error:
              `Unknown column(s) in SQL: ${unknownCols.join(', ')}. `
              + `Available reports columns: ${listReportsColumns()}. `
              + 'If the user asked for a metric not in this list, do NOT substitute a related column — '
              + 'reply in 1–2 short sentences that the metric is not available (no Executive Summary headings).',
            unavailable_columns: unknownCols,
            available_columns: listReportsColumns().split(', '),
          };
        }

        // Block silent substitutes: e.g. "disabled female workers" → female_employee_count ranking.
        if (
          hasUnsupportedMetricQualifier(userMessage)
          && /\bfemale_employee_(count|share)\b/i.test(query)
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
        const fuzzy = ensureCompanyYearInSelect(relaxCompanyExactMatch(query));
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

  messages.push({
    role: 'system',
    content: (systemInstruction || SYSTEM_PROMPT) + customInfo
      + (requestedYears.length
        ? `\nUser-requested year(s): ${requestedYears.join(', ')}. Use ONLY these year values in SQL filters and citations.`
        : ''),
  });

  trimChatHistory(chatHistory, maxHistory).forEach((msg) => {
    messages.push({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.text ?? msg.content ?? '',
    });
  });

  messages.push({ role: 'user', content: userMessage });

  let iteration = 0;

  while (iteration < maxIterations) {
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
                content: 'Using the tool results already available, provide the final answer now. If the asked metric is unavailable or out-of-box, reply in 1–2 short sentences only (no Executive Summary / Key Findings / Analysis / Recommendation headings). Otherwise use the structured analysis format. Include page citations and PDF links only when tool results provide <metric>_citation / ready_citations; otherwise show metric values only with no source links. Do not call more tools.',
              },
            ]
          : messages,
        tools: toolsForCall,
        options: config.options,
        keepAlive: config.keepAlive,
        stream: useStream,
        onToken: useStream
          ? (delta) => onProgress?.({ status: 'token', delta })
          : undefined,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (fetchErr) {
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
            return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) };
          } catch (err) {
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
      };
    }
  }

  throw new Error('Agent failed to complete reasoning within the iteration limit.');
}

function normalizeChartJson(text) {
  if (!text) return text;
  const chartBlockRegex = /(```json-chart\s*)([\s\S]*?)(\s*```)/g;
  return text.replace(chartBlockRegex, (match, p1, p2, p3) => {
    try {
      // Strip comments from the JSON string
      const cleanJsonString = p2
        .replace(/\/\/.*$/gm, '') // strip single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, ''); // strip block comments

      const json = JSON.parse(cleanJsonString.trim());
      let changed = false;

      // Lift "labels", "datasets", "series", "values" from nested "data" object if present
      if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
        const d = json.data;
        if (d.labels && !json.labels) {
          json.labels = d.labels;
          changed = true;
        }
        if (d.datasets && !json.datasets) {
          json.datasets = d.datasets;
          changed = true;
        }
        if (d.series && !json.datasets) {
          json.datasets = d.series;
          changed = true;
        }
        if (d.values && !json.datasets) {
          json.datasets = [
            {
              label: json.title || 'Value',
              data: d.values
            }
          ];
          changed = true;
        }
        delete json.data;
        changed = true;
      }
      
      // Map "series" to "datasets"
      if (json.series && !json.datasets) {
        json.datasets = json.series;
        delete json.series;
        changed = true;
      }

      // Map "values" (direct array of numbers) to a single dataset
      if (Array.isArray(json.values) && !json.datasets) {
        json.datasets = [
          {
            label: json.title || 'Value',
            data: json.values
          }
        ];
        delete json.values;
        changed = true;
      }

      // Map "data" (direct array of numbers) at root to a single dataset
      if (Array.isArray(json.data) && !json.datasets) {
        json.datasets = [
          {
            label: json.title || 'Value',
            data: json.data
          }
        ];
        delete json.data;
        changed = true;
      }
      
      // Map "name" to "label" inside datasets, and handle nested object arrays like [{company, value}]
      if (Array.isArray(json.datasets)) {
        let labelsFromObjects = [];
        let dataFromObjects = [];
        let objectFormatFound = false;

        json.datasets = json.datasets.map(d => {
          if (typeof d === 'object' && d !== null) {
            if (d.name && !d.label) {
              d.label = d.name;
              delete d.name;
              changed = true;
            }

            if (Array.isArray(d.data)) {
              const allObjects = d.data.every(item => typeof item === 'object' && item !== null && 'value' in item);
              if (allObjects && d.data.length > 0) {
                objectFormatFound = true;
                dataFromObjects = d.data.map(item => item.value);
                labelsFromObjects = d.data.map(item => item.company || item.name || item.label || '');
                d.data = dataFromObjects;
                changed = true;
              }
            }
          }
          return d;
        });

        if (objectFormatFound && labelsFromObjects.length > 0 && (!json.labels || json.labels.length !== labelsFromObjects.length)) {
          json.labels = labelsFromObjects;
          changed = true;
        }
      }
      
      // Ensure "type": "chart" is present
      if (!json.type) {
        json.type = 'chart';
        changed = true;
      }
      
      // Ensure "chartType" is present
      if (!json.chartType) {
        json.chartType = 'bar';
        changed = true;
      }
      
      // Re-serialize with clean formatting (comments removed)
      return `${p1}${JSON.stringify(json, null, 2)}${p3}`;
    } catch (e) {
      // If parsing fails, just return original match
    }
    return match;
  });
}

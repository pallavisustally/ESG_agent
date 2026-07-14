import dotenv from 'dotenv';
import { getReportData, getCompanyList, getAvailableReports, getDb, ensureMetricPagesIndexed, getSourceRowsForReports, resolveCompanyYear } from './db.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { callOllamaChat, getOllamaConfig } from './ollama-client.js';
import { enrichSqlRows, enrichCompanyReport, upgradeReportCitations } from './report-sources.js';
import { verifyAgentCitations } from './pdf-verifier.js';

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
              description: 'The complete read-only SQL SELECT query to run (e.g. "SELECT company, scope1_emissions FROM reports WHERE year = 2026 ORDER BY scope1_emissions DESC").'
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
          message: `Executing read-only SQL: "${query}"`
        });
      }
      
      try {
        const db = await getDb();
        const rewritten = ensureCompanyYearInSelect(relaxCompanyExactMatch(query));
        if (onProgress && rewritten !== query.trim().replace(/;+\s*$/, '')) {
          onProgress({
            status: 'tool_start',
            tool: 'execute_sql_query',
            message: `Rewrote company filter for fuzzy match: "${rewritten}"`,
          });
        }
        const { companyHint, yearHint } = extractCompanyYearHints(rewritten);
        const rows = await db.all(rewritten);

        const normalizedRows = rows.map((row) => ({
          ...row,
          company: row.company || companyHint || row.Company || null,
          year: row.year ?? yearHint ?? row.Year ?? null,
        })).filter((row) => {
          const effectiveYearHint = yearHint ?? (requestedYears.length === 1 ? requestedYears[0] : null);
          if (effectiveYearHint != null) return Number(row.year) === Number(effectiveYearHint);
          if (requestedYears.length > 1) return requestedYears.includes(Number(row.year));
          return true;
        });

        if (!normalizedRows.length && rows.length) {
          return {
            error: `Query returned rows, but none matched requested year(s) ${requestedYears.join(', ') || yearHint}. Re-run with WHERE year = <requested year>.`,
            raw_years_seen: [...new Set(rows.map((r) => r.year).filter((y) => y != null))],
          };
        }

        const sourceRowsByKey = await getSourceRowsForReports(normalizedRows);
        const preferred = preferPdfBackedRows(normalizedRows, sourceRowsByKey);
        for (const sourceRow of sourceRowsByKey.values()) {
          seenSourceRows.push(sourceRow);
        }
        const enrichedRows = enrichSqlRows(preferred.length ? preferred : normalizedRows, sourceRowsByKey);
        
        if (onProgress) {
          onProgress({ 
            status: 'tool_end', 
            tool: 'execute_sql_query', 
            message: `Retrieved ${rows.length} rows.`
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
        return { error: `SQL execution error: ${err.message}` };
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
                content: 'Using the tool results already available, provide the final structured analysis now. Include page citations and PDF links only when tool results provide <metric>_citation / ready_citations; otherwise show metric values only with no source links. Do not call more tools.',
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

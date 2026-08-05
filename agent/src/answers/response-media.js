/**
 * Repair assistant media before display:
 * - Replace fake markdown chart images with Chart.js json-chart blocks
 * - Build charts from markdown tables when the model forgot json-chart
 * - Strip invented Citations/Sources footers (inline p. N [source] is enough)
 *
 * Chart generation goes through the Visualization Engine (Dataset → visualize).
 */

import {
  visualize,
  datasetFromMarkdownTable,
  createVisualizationContext,
  toJsonChartBlock,
  planReportChart,
} from '../visualization/index.js';

function parseMarkdownTables(text) {
  const tables = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length - 1; i += 1) {
    const header = lines[i];
    const sep = lines[i + 1];
    if (!/^\s*\|.+\|\s*$/.test(header) || !/^\s*\|?\s*:?-{3,}/.test(sep)) continue;

    const headers = header
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (headers.length < 2) continue;

    const rows = [];
    let j = i + 2;
    while (j < lines.length && /^\s*\|.+\|\s*$/.test(lines[j])) {
      const cells = lines[j]
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length) rows.push(cells);
      j += 1;
    }
    if (rows.length) {
      tables.push({
        headers,
        rows,
        start: i,
        end: j - 1,
        raw: lines.slice(i, j).join('\n'),
      });
    }
    i = j - 1;
  }
  return tables;
}

function parseNumberCell(value) {
  const cleaned = String(value || '')
    .replace(/,/g, '')
    .replace(/[^\d.-]/g, '')
    .trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Convert a year×metrics markdown table into a Chart.js config.
 * Returns null when the table is not chartable.
 * Kept for tests / callers; prefers Visualization Engine when used via repair.
 */
export function chartConfigFromMarkdownTable(table, { chartType = 'line', title = 'Chart' } = {}) {
  if (!table?.headers?.length || !table?.rows?.length) return null;

  const headers = table.headers;
  const yearIdx = headers.findIndex((h) => /\byear\b/i.test(h));
  const labelIdx = yearIdx >= 0 ? yearIdx : 0;

  const metricIndexes = [];
  for (let i = 0; i < headers.length; i += 1) {
    if (i === labelIdx) continue;
    const nums = table.rows.map((r) => parseNumberCell(r[i])).filter((n) => n != null);
    if (nums.length) metricIndexes.push(i);
  }
  if (!metricIndexes.length) return null;

  const labels = table.rows.map((r) => String(r[labelIdx] || '').trim()).filter(Boolean);
  if (!labels.length) return null;

  const datasets = metricIndexes.map((idx) => ({
    label: headers[idx],
    data: table.rows.map((r) => parseNumberCell(r[idx])).map((n) => (n == null ? 0 : n)),
  }));

  return {
    chartType,
    title,
    labels,
    datasets,
  };
}

function fakeChartImageRe() {
  return /!\[[^\]]*(?:chart|trend|graph|plot|emissions)[^\]]*\]\(([^)]*)\)/gi;
}

function looksLikeFakeChartSrc(src) {
  const s = String(src || '').trim();
  if (!s) return true;
  if (/^(https?:|\/local-pdf\/|data:)/i.test(s)) return false;
  return true;
}

function chartTitleFromContext(text, fallback = 'Chart') {
  const m = String(text || '').match(/!\[[^\]]*(chart|trend|graph|plot)[^\]]*\]/i);
  if (m) {
    const alt = m[0].match(/!\[([^\]]+)\]/);
    if (alt?.[1]) return alt[1].trim();
  }
  if (/\bemissions?\s+trend\b/i.test(text)) return 'Emissions Trend Chart';
  return fallback;
}

/**
 * Run a markdown table through Dataset → Visualization Engine.
 * Falls back to a minimal config when validation rejects (repair path should still try).
 */
function planTableChart(table, text, title) {
  const dataset = datasetFromMarkdownTable(table, {
    title: title || chartTitleFromContext(text),
    source: 'markdown',
  });
  if (!dataset.metrics.length || !dataset.labels.length) return null;

  // Prefer display names from original headers
  if (dataset.metadata?.headerLabels) {
    dataset.metadata.metricLabels = {
      ...(dataset.metadata.metricLabels || {}),
      ...dataset.metadata.headerLabels,
    };
  }

  const context = createVisualizationContext({
    userMessage: text,
    title: title || chartTitleFromContext(text),
    source: 'Report table',
    includeInsights: false,
    preferredIntent: null,
    dataset,
  });

  const viz = visualize({ dataset, context, includeInsights: false });
  if (viz.ok) return viz.config;

  // Soft fallback: keep chartable table output so repair still upgrades fake images
  const raw = chartConfigFromMarkdownTable(table, {
    chartType: 'bar',
    title: title || chartTitleFromContext(text),
  });
  if (!raw) return null;
  return {
    type: 'chart',
    chartType: raw.chartType || 'bar',
    title: raw.title || 'Chart',
    labels: raw.labels,
    datasets: raw.datasets,
  };
}

/**
 * Visualize report/PDF-extracted numeric rows through the shared engine.
 */
export function visualizeReportOrPdfTable({
  rows = [],
  metrics = [],
  labelKey = 'year',
  company = null,
  year = null,
  userMessage = '',
  fromPdf = false,
  includeInsights = true,
  preferredIntent = null,
} = {}) {
  return planReportChart({
    rows,
    metrics,
    labelKey,
    company,
    year,
    userMessage,
    source: fromPdf ? 'BRSR report / PDF extract' : 'BRSR report extract',
    preferredIntent: preferredIntent || (labelKey === 'year' ? 'trend' : null),
    includeInsights,
    fromPdf,
  });
}

/**
 * Strip invented Citations / Sources footers (inline citations already cover provenance).
 */
export function stripCitationFooters(text) {
  let out = String(text || '');
  out = out.replace(/\n##\s*Sources[\s\S]*$/i, '');
  out = out.replace(/\n##\s*Citations[\s\S]*$/i, '');
  out = out.replace(/\n\*\*Citations:\*\*[\s\S]*$/i, '');
  out = out.replace(/\n\*\*Sources:\*\*[\s\S]*$/i, '');
  out = out.replace(/\nCitations:\s*\n[\s\S]*$/i, '');
  return out.trimEnd();
}

/**
 * Repair fake chart images and missing json-chart blocks using markdown tables.
 */
export function repairChartMedia(text) {
  let out = String(text || '');
  const title = chartTitleFromContext(out, 'Emissions Trend Chart');
  const tables = parseMarkdownTables(out);
  const chartable = tables
    .map((t) => {
      const config = planTableChart(t, out, title);
      return config ? { table: t, config } : null;
    })
    .filter(Boolean);

  const hasJsonChart = /```json-chart\b/i.test(out);
  let replacedImage = false;

  out = out.replace(fakeChartImageRe(), (full, src) => {
    if (!looksLikeFakeChartSrc(src) && /\.(png|jpe?g|gif|webp|svg)($|\?)/i.test(src)) {
      return full;
    }
    replacedImage = true;
    if (chartable.length) {
      return toJsonChartBlock(chartable[0].config);
    }
    return '';
  });

  // No json-chart and no image placeholder, but a chartable table + chart ask → inject chart after first table.
  if (!hasJsonChart && !replacedImage && chartable.length && /\b(chart|graph|plot|trend)\b/i.test(out)) {
    const first = chartable[0];
    const block = toJsonChartBlock(first.config);
    const idx = out.indexOf(first.table.raw);
    if (idx >= 0) {
      const insertAt = idx + first.table.raw.length;
      out = `${out.slice(0, insertAt)}\n\n${block}${out.slice(insertAt)}`;
    } else {
      out = `${out.trimEnd()}\n\n${block}`;
    }
  }

  return out;
}

/**
 * Full response media repair pipeline (safe to run on server and client).
 */
export function repairResponseMedia(text) {
  let out = stripCitationFooters(text);
  out = repairChartMedia(out);
  return out;
}

/**
 * Attach Visualization Engine charts to report/PDF narrative answers that contain
 * numeric markdown tables (same Dataset → visualize path as SQL).
 */
export function attachReportPdfVisualization(text, {
  company = null,
  year = null,
  userMessage = '',
  fromPdf = false,
  includeInsights = true,
} = {}) {
  let out = String(text || '');
  if (/```json-chart\b/i.test(out)) return out;

  const tables = parseMarkdownTables(out);
  if (!tables.length) return out;

  const title = chartTitleFromContext(out, company ? `${company} chart` : 'Report chart');
  for (const table of tables) {
    const dataset = datasetFromMarkdownTable(table, {
      title,
      source: fromPdf ? 'pdf' : 'report',
    });
    if (!dataset.metrics.length || dataset.labels.length < 2) continue;

    if (dataset.metadata?.headerLabels) {
      dataset.metadata.metricLabels = {
        ...(dataset.metadata.metricLabels || {}),
        ...dataset.metadata.headerLabels,
      };
    }
    if (company) dataset.company = company;
    if (year != null) dataset.year = year;

    const context = createVisualizationContext({
      userMessage: userMessage || out.slice(0, 240),
      company,
      year,
      title,
      source: fromPdf ? 'BRSR report / PDF extract' : 'BRSR report extract',
      preferredIntent: dataset.labelKey === 'year' ? 'trend' : null,
      includeInsights,
      dataset,
    });
    const viz = visualize({ dataset, context, includeInsights });
    if (!viz.ok || !viz.chartBlock) continue;

    const idx = out.indexOf(table.raw);
    const block = [
      viz.chartBlock,
      viz.insightMarkdown || '',
    ].filter(Boolean).join('\n');
    if (idx >= 0) {
      const insertAt = idx + table.raw.length;
      out = `${out.slice(0, insertAt)}\n\n${block}${out.slice(insertAt)}`;
    } else {
      out = `${out.trimEnd()}\n\n${block}`;
    }
    break;
  }
  return out;
}

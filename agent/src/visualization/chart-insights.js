/**
 * Deterministic Insight Engine — statistical observations only (no LLM).
 *
 * Stage 1 of chart interpretation. Stage 2 (LLM) may narrate these insights
 * but must never invent new numeric claims.
 */

/**
 * @param {import('./chart-spec.js').ChartSpec} spec
 * @returns {string[]} insight lines (plain text, no markdown bullets)
 */
export function generateChartInsights(spec) {
  if (!spec?.series?.length) return [];

  const insights = [];
  const labels = spec.labels || [];

  if (spec.chartType === 'scatter' && spec.series.length >= 2) {
    const corr = pearson(
      spec.series[0].values.map(Number),
      spec.series[1].values.map(Number),
    );
    if (corr != null) {
      const strength = Math.abs(corr) >= 0.7 ? 'strong' : Math.abs(corr) >= 0.4 ? 'moderate' : 'weak';
      const direction = corr >= 0 ? 'positive' : 'negative';
      insights.push(
        `${strength[0].toUpperCase()}${strength.slice(1)} ${direction} association between ${spec.series[0].label} and ${spec.series[1].label} (r≈${corr.toFixed(2)}).`,
      );
    }
    return dedupeInsights(insights).slice(0, 4);
  }

  for (const series of spec.series.slice(0, 3)) {
    const pairs = labels.map((label, i) => ({
      label: String(label),
      value: series.values[i] == null ? null : Number(series.values[i]),
    })).filter((p) => p.value != null && Number.isFinite(p.value));

    if (pairs.length < 1) continue;

    const stats = computeStats(pairs.map((p) => p.value));

    if (spec.intent === 'trend' || spec.chartType === 'line') {
      const first = pairs[0];
      const last = pairs[pairs.length - 1];
      if (pairs.length >= 2 && first.value !== 0) {
        const pct = ((last.value - first.value) / Math.abs(first.value)) * 100;
        const direction = pct > 0.5 ? 'increased' : pct < -0.5 ? 'decreased' : 'was largely unchanged';
        insights.push(
          `${series.label} ${direction} from ${fmt(first.value)} (${first.label}) to ${fmt(last.value)} (${last.label})${pctAbs(pct)}.`,
        );
      } else if (pairs.length >= 2) {
        insights.push(
          `${series.label} moved from ${fmt(first.value)} (${first.label}) to ${fmt(last.value)} (${last.label}).`,
        );
      }
      const peak = pairs.reduce((a, b) => (b.value > a.value ? b : a));
      const trough = pairs.reduce((a, b) => (b.value < a.value ? b : a));
      if (peak.label !== trough.label) {
        insights.push(`Peak ${fmt(peak.value)} in ${peak.label}; lowest ${fmt(trough.value)} in ${trough.label}.`);
      }
      if (stats && pairs.length >= 3) {
        insights.push(`Average ${series.label}: ${fmt(stats.mean)}${unitSuffix(series, spec)}.`);
      }
    } else if (spec.intent === 'composition' || spec.chartType === 'pie' || spec.chartType === 'doughnut') {
      const total = pairs.reduce((s, p) => s + p.value, 0);
      if (total > 0) {
        const sorted = [...pairs].sort((a, b) => b.value - a.value);
        const top = sorted[0];
        insights.push(
          `${top.label} is the largest share at ${((top.value / total) * 100).toFixed(1)}% (${fmt(top.value)}).`,
        );
        if (sorted[1]) {
          insights.push(
            `${sorted[1].label} is next at ${((sorted[1].value / total) * 100).toFixed(1)}%.`,
          );
        }
      }
    } else {
      // ranking / comparison / grouped
      const sorted = [...pairs].sort((a, b) => b.value - a.value);
      const top = sorted[0];
      const bottom = sorted[sorted.length - 1];
      insights.push(
        `${top.label} leads on ${series.label} at ${fmt(top.value)}${unitSuffix(series, spec)}.`,
      );
      if (sorted.length >= 2 && top.label !== bottom.label) {
        const gap = top.value - bottom.value;
        insights.push(
          `${bottom.label} is lowest at ${fmt(bottom.value)} (gap ${fmt(gap)}).`,
        );
      }
      if (stats && pairs.length >= 3) {
        insights.push(`Average ${fmt(stats.mean)}${unitSuffix(series, spec)}; std. dev. ${fmt(stats.stdev)}.`);
      }
      const outlier = findOutlier(pairs, stats);
      if (outlier) {
        insights.push(
          `${outlier.label} looks like an outlier at ${fmt(outlier.value)}${unitSuffix(series, spec)}.`,
        );
      }
    }
  }

  // Multi-metric cross note
  if (spec.series.length >= 2 && (spec.intent === 'comparison' || spec.chartType === 'groupedBar')) {
    insights.push(
      `Chart compares ${spec.series.map((s) => s.label).join(' and ')} across ${labels.length} categories.`,
    );
  }

  return dedupeInsights(insights).slice(0, 4);
}

/**
 * Format insights as markdown lines to append after a chart block.
 */
export function formatInsightMarkdown(insights) {
  if (!insights?.length) return '';
  return ['', '**Chart insights**', ...insights.map((i) => `- ${i}`)].join('\n');
}

/**
 * Structured statistical summary for LLM grounding / tests.
 */
export function computeSeriesStatistics(spec) {
  const labels = spec?.labels || [];
  return (spec?.series || []).map((series) => {
    const values = (series.values || [])
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const stats = computeStats(values);
    const pairs = labels.map((label, i) => ({
      label: String(label),
      value: series.values[i] == null ? null : Number(series.values[i]),
    })).filter((p) => p.value != null && Number.isFinite(p.value));
    const sorted = [...pairs].sort((a, b) => b.value - a.value);
    return {
      id: series.id,
      label: series.label,
      unit: series.unit || null,
      highest: sorted[0] || null,
      lowest: sorted[sorted.length - 1] || null,
      ...stats,
      outlier: findOutlier(pairs, stats),
    };
  });
}

function computeStats(values) {
  if (!values?.length) return null;
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = n > 1
    ? values.reduce((s, v) => s + ((v - mean) ** 2), 0) / (n - 1)
    : 0;
  const stdev = Math.sqrt(variance);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { mean, variance, stdev, min, max, count: n };
}

function findOutlier(pairs, stats) {
  if (!stats || !pairs || pairs.length < 4 || stats.stdev === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const p of pairs) {
    const z = Math.abs((p.value - stats.mean) / stats.stdev);
    if (z >= 2 && z > bestScore) {
      best = p;
      bestScore = z;
    }
  }
  return best;
}

function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  if (Number.isInteger(n)) return String(n);
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function pctAbs(pct) {
  if (!Number.isFinite(pct) || Math.abs(pct) < 0.5) return '';
  return ` (${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)`;
}

function unitSuffix(series, spec) {
  const u = series.unit || spec.meta?.unit;
  return u ? ` ${u}` : '';
}

function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 3) return null;
  const n = pairs.length;
  const meanX = pairs.reduce((s, p) => s + p[0], 0) / n;
  const meanY = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  if (denX === 0 || denY === 0) return null;
  return num / Math.sqrt(denX * denY);
}

function dedupeInsights(list) {
  const seen = new Set();
  const out = [];
  for (const line of list) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

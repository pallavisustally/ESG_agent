/**
 * Build aggregate evaluation report (JSON-serializable + markdown).
 */

export function buildEvaluationReport({
  mode = 'plan',
  tier = 'all',
  category = 'all',
  results = [],
} = {}) {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const passRate = total ? passed / total : 1;

  const byCategory = {};
  const byDimension = {};
  const dimCounts = {};

  for (const r of results) {
    if (!byCategory[r.category]) {
      byCategory[r.category] = { passed: 0, total: 0, failIds: [] };
    }
    byCategory[r.category].total += 1;
    if (r.passed) byCategory[r.category].passed += 1;
    else byCategory[r.category].failIds.push(r.id);

    for (const [dim, d] of Object.entries(r.dimensions || {})) {
      if (d.skipped) continue;
      if (!dimCounts[dim]) dimCounts[dim] = { ok: 0, total: 0 };
      dimCounts[dim].total += 1;
      if (d.ok) dimCounts[dim].ok += 1;
    }
  }

  for (const [dim, c] of Object.entries(dimCounts)) {
    byDimension[dim] = c.total ? c.ok / c.total : 1;
  }

  const failures = results
    .filter((r) => !r.passed)
    .map((r) => ({
      id: r.id,
      category: r.category,
      question: r.question,
      failedDimensions: Object.entries(r.dimensions || {})
        .filter(([, d]) => !d.skipped && !d.ok)
        .map(([name, d]) => ({ name, detail: d.detail })),
      error: r.error || r.pipelineError || null,
      actual: r.actual || null,
    }));

  const report = {
    generatedAt: new Date().toISOString(),
    mode,
    tier,
    category,
    summary: {
      total,
      passed,
      failed,
      passRate,
      byCategory,
      byDimension,
    },
    failures,
    results,
  };

  report.markdown = formatMarkdown(report);
  return report;
}

export function formatMarkdown(report) {
  const s = report.summary;
  const lines = [
    `# Evaluation Report`,
    '',
    `- Generated: ${report.generatedAt}`,
    `- Mode: ${report.mode}`,
    `- Tier: ${report.tier}`,
    `- Pass rate: **${(s.passRate * 100).toFixed(1)}%** (${s.passed}/${s.total})`,
    '',
    '## By category',
    '',
  ];

  for (const [cat, c] of Object.entries(s.byCategory).sort()) {
    const rate = c.total ? ((c.passed / c.total) * 100).toFixed(0) : '100';
    lines.push(`- **${cat}**: ${c.passed}/${c.total} (${rate}%)`);
  }

  lines.push('', '## By dimension', '');
  for (const [dim, rate] of Object.entries(s.byDimension).sort()) {
    lines.push(`- **${dim}**: ${(rate * 100).toFixed(1)}%`);
  }

  if (report.failures?.length) {
    lines.push('', '## Failures', '');
    for (const f of report.failures) {
      const dims = (f.failedDimensions || []).map((d) => d.name).join(', ') || 'error';
      lines.push(`- \`${f.id}\` (${f.category}): ${dims}`);
      if (f.error) lines.push(`  - error: ${f.error}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Persist report JSON + Markdown under data/evaluation_reports/.
 */
export async function writeEvaluationReport(report, {
  outDir = null,
  basename = null,
} = {}) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const root = outDir || join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../data/evaluation_reports',
  );
  await mkdir(root, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = basename || `eval-${report.mode}-${report.tier}-${stamp}`;
  const jsonPath = join(root, `${base}.json`);
  const mdPath = join(root, `${base}.md`);

  const { markdown, ...jsonBody } = report;
  await writeFile(jsonPath, `${JSON.stringify(jsonBody, null, 2)}\n`, 'utf8');
  await writeFile(mdPath, markdown || formatMarkdown(report), 'utf8');

  return { jsonPath, mdPath };
}

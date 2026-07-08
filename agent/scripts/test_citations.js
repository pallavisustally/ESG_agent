/**
 * Regression tests for page-number + PDF URL citations in agent answers.
 *
 * Usage:
 *   node agent/scripts/test_citations.js
 *   node agent/scripts/test_citations.js --limit 5
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { runAgent } from '../src/agent.js';
import { resolveFromProject } from '../src/paths.js';

dotenv.config();

const OUT_DIR = resolveFromProject('data', 'citation_tests');
const QUESTIONS = [
  {
    id: 1,
    q: 'What is Aarti Drugs Limited Scope 1 emissions for 2023? Cite page number and PDF link.',
    expectYear: 2023,
    expectValue: 56820,
    expectPage: 39,
  },
  {
    id: 2,
    q: 'What is Aarti Drugs Limited Scope 1 emissions for 2025? Cite page and report URL.',
    expectYear: 2025,
    expectValue: 64666,
    expectPage: 35,
  },
  {
    id: 3,
    q: 'Camlin Fine Sciences Limited Scope 1 emissions in 2022 — include page citation and PDF.',
    expectYear: 2022,
    expectValue: 92024.6,
    expectPage: 25,
  },
  {
    id: 4,
    q: 'What is CIE Automotive India Limited renewable energy share for 2023? Cite page and PDF.',
    expectYear: 2023,
  },
  {
    id: 5,
    q: 'Show KSB LIMITED Scope 1 emissions for 2023 with page number and report link.',
    expectYear: 2023,
    expectValue: 2297,
  },
  {
    id: 6,
    q: 'What is 3M INDIA LIMITED Scope 1 for 2023? Cite page and PDF URL.',
    expectYear: 2023,
    expectValue: 8790,
    expectPage: 34,
  },
  {
    id: 7,
    q: 'Deep Industries Limited Scope 1 emissions in 2022 — cite page and PDF.',
    expectYear: 2022,
    expectValue: 5828,
    expectPage: 13,
  },
  {
    id: 8,
    q: 'Compare Scope 1 for Aarti Drugs Limited 2023 vs 2025. Cite every number with page and PDF.',
    expectYears: [2023, 2025],
    expectValues: [56820, 64666],
  },
  {
    id: 9,
    q: 'CIE Automotive India Limited Scope 1 for 2022 and 2023 — cite each year with page links.',
    expectYears: [2022, 2023],
    expectValues: [18897, 9169.44],
  },
  {
    id: 10,
    q: 'Female employee share for Aarti Drugs Limited in 2023 — cite page and PDF.',
    expectYear: 2023,
  },
  {
    id: 11,
    q: 'Camlin Fine Sciences Limited Scope 1 for year 2023 only (not 2024/2025). Include citations.',
    expectYear: 2023,
    expectValue: 112203,
    expectPage: 28,
  },
  {
    id: 12,
    q: 'What is CIE Automotive India Limited Scope 1 emissions for 2024? Cite page and PDF.',
    expectYear: 2024,
    expectValue: 11006.7,
    expectPage: 42,
  },
  {
    id: 13,
    q: 'Compare female employee share for CIE Automotive India Limited 2022 vs 2023 with citations.',
    expectYears: [2022, 2023],
  },
  {
    id: 14,
    q: '3M INDIA LIMITED Scope 1 emissions for 2025 — report page and PDF link.',
    expectYear: 2025,
    expectValue: 4550,
    expectPage: 32,
  },
  {
    id: 15,
    q: 'List Scope 1 for Aarti Drugs Limited, Camlin Fine Sciences Limited, and Deep Industries Limited for 2022 or nearest available cited year. Cite each figure.',
    expectMinPdfLinks: 2,
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = QUESTIONS.length;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
  }
  return { limit };
}

function normalizeNumber(n) {
  return String(n).replace(/,/g, '');
}

function scoreAnswer(text, spec) {
  const checks = {
    hasPageCitation: /\[p\.\s*\d+\]\([^)]+\.pdf[^)]*\)/i.test(text),
    hasReportFallback: /\[report\]\([^)]+\.pdf[^)]*\)/i.test(text),
    hasPdfUrl: /https?:\/\/[^\s)]+\.pdf/i.test(text),
    hasSourcesSection: /##\s*Sources/i.test(text),
    deniesAvailability: /Unfortunately, there is no available PDF|no available PDF link|no available citations or PDF|pdf link:\s*not|page number:\s*not specified/i.test(text),
    wrongYearSubstitution: false,
    valueFound: true,
    pageFound: true,
  };

  if (spec.expectYear != null && !new RegExp(String(spec.expectYear)).test(text)) {
    checks.valueFound = false;
  }

  if (spec.expectValue != null) {
    const plain = String(spec.expectValue).replace(/,/g, '');
    const textPlain = text.replace(/,/g, '');
    checks.valueFound = textPlain.includes(plain)
      || text.includes(String(spec.expectValue))
      || textPlain.includes(String(Number(spec.expectValue)));
  }

  if (Array.isArray(spec.expectValues)) {
    checks.valueFound = spec.expectValues.every((val) => {
      const plain = String(val).replace(/,/g, '');
      const textPlain = text.replace(/,/g, '');
      return textPlain.includes(plain) || text.includes(String(val));
    });
  }

  if (spec.expectPage != null) {
    checks.pageFound = new RegExp(`\\[p\\.\\s*${spec.expectPage}\\]`, 'i').test(text);
  }

  if (spec.expectYear != null) {
    // Flag answering a different year prominently without the requested year
    const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
    if (years.length && !years.includes(spec.expectYear)) {
      checks.wrongYearSubstitution = true;
    }
  }

  const pdfLinks = [...text.matchAll(/https?:\/\/[^\s)]+\.pdf/gi)].length;
  if (spec.expectMinPdfLinks != null) {
    checks.hasPdfUrl = pdfLinks >= spec.expectMinPdfLinks;
  }

  const citationOk = checks.hasPageCitation || checks.hasReportFallback;
  const pass = citationOk
    && checks.hasPdfUrl
    && !checks.deniesAvailability
    && !checks.wrongYearSubstitution
    && checks.valueFound
    && (spec.expectPage == null || checks.pageFound);

  return { pass, checks, pdfLinks };
}

async function run() {
  const { limit } = parseArgs();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const selected = QUESTIONS.slice(0, limit);
  const results = [];

  console.log(`Running ${selected.length} citation tests...\n`);

  for (const spec of selected) {
    process.stdout.write(`Q${spec.id}: ${spec.q.slice(0, 70)}... `);
    const started = Date.now();
    try {
      const { text } = await runAgent({
        userMessage: spec.q,
        chatHistory: [],
        onProgress: null,
      });
      const scored = scoreAnswer(text || '', spec);
      const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
      results.push({
        id: spec.id,
        question: spec.q,
        pass: scored.pass,
        checks: scored.checks,
        pdfLinks: scored.pdfLinks,
        elapsedSec: Number(elapsedSec),
        responsePreview: (text || '').slice(0, 600),
        response: text || '',
      });
      console.log(scored.pass ? `PASS (${elapsedSec}s)` : `FAIL (${elapsedSec}s)`);
      if (!scored.pass) {
        console.log('  checks:', JSON.stringify(scored.checks));
      }
    } catch (err) {
      const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
      results.push({
        id: spec.id,
        question: spec.q,
        pass: false,
        error: err.message,
        elapsedSec: Number(elapsedSec),
      });
      console.log(`ERROR (${elapsedSec}s): ${err.message}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const summary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: `${((passed / results.length) * 100).toFixed(1)}%`,
    results,
  };

  const jsonPath = path.join(OUT_DIR, 'citation_test_results.json');
  const mdPath = path.join(OUT_DIR, 'citation_test_report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  let md = `# Citation Test Report\n\n`;
  md += `Pass rate: **${summary.passRate}** (${passed}/${results.length})\n\n`;
  md += `| ID | Result | Time | Question |\n|----|--------|------|----------|\n`;
  for (const r of results) {
    md += `| ${r.id} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.elapsedSec}s | ${r.question.replace(/\|/g, '/')} |\n`;
  }
  md += `\n## Failures\n\n`;
  for (const r of results.filter((x) => !x.pass)) {
    md += `### Q${r.id}\n`;
    md += `- Question: ${r.question}\n`;
    md += `- Checks: \`${JSON.stringify(r.checks || { error: r.error })}\`\n`;
    md += `- Preview:\n\n\`\`\`\n${(r.responsePreview || r.error || '').slice(0, 400)}\n\`\`\`\n\n`;
  }
  fs.writeFileSync(mdPath, md);

  console.log(`\nPass rate: ${summary.passRate}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

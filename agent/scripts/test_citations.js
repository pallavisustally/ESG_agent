/**
 * Senior-tester regression for citations:
 * 1. Agent answer contains expected values/pages/PDF links
 * 2. Cited values actually appear on the cited PDF page text
 * 3. Indexed DB metric values appear on their mapped PDF pages
 *
 * Usage:
 *   node agent/scripts/test_citations.js
 *   node agent/scripts/test_citations.js --limit 3
 *   node agent/scripts/test_citations.js --verify-only 1
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { runAgent } from '../src/agent.js';
import { resolveFromProject } from '../src/paths.js';
import { lookupNseMetadata } from '../src/report-sources.js';
import { verifyAgentCitations } from '../src/pdf-verifier.js';
import { verifyValueOnPdfPage } from '../src/page-index.js';

dotenv.config();

const OUT_DIR = resolveFromProject('data', 'citation_tests');
const QUESTIONS = [
  {
    id: 1,
    company: 'Aarti Drugs Limited',
    q: 'What is Aarti Drugs Limited Scope 1 emissions for 2023? Cite page number and PDF link.',
    expectYear: 2023,
    expectValue: 56820,
    expectPage: 39,
  },
  {
    id: 2,
    company: 'Aarti Drugs Limited',
    q: 'What is Aarti Drugs Limited Scope 1 emissions for 2025? Cite page and report URL.',
    expectYear: 2025,
    expectValue: 64666,
    expectPage: 35,
  },
  {
    id: 3,
    company: 'Camlin Fine Sciences Limited',
    q: 'Camlin Fine Sciences Limited Scope 1 emissions in 2022 — include page citation and PDF.',
    expectYear: 2022,
    expectValue: 92024.6,
    expectPage: 25,
  },
  {
    id: 4,
    company: 'CIE Automotive India Limited',
    q: 'What is CIE Automotive India Limited renewable energy share for 2023? Cite page and PDF.',
    expectYear: 2023,
  },
  {
    id: 5,
    company: 'KSB LIMITED',
    q: 'Show KSB LIMITED Scope 1 emissions for 2023 with page number and report link.',
    expectYear: 2023,
    expectValue: 2297,
  },
  {
    id: 6,
    company: '3M INDIA LIMITED',
    q: 'What is 3M INDIA LIMITED Scope 1 for 2023? Cite page and PDF URL.',
    expectYear: 2023,
    expectValue: 8790,
    expectPage: 34,
  },
  {
    id: 7,
    company: 'Deep Industries Limited',
    q: 'Deep Industries Limited Scope 1 emissions in 2022 — cite page and PDF.',
    expectYear: 2022,
    expectValue: 5828,
    expectPage: 13,
  },
  {
    id: 8,
    company: 'Aarti Drugs Limited',
    q: 'Compare Scope 1 for Aarti Drugs Limited 2023 vs 2025. Cite every number with page and PDF.',
    expectYears: [2023, 2025],
    expectValues: [56820, 64666],
  },
  {
    id: 9,
    company: 'CIE Automotive India Limited',
    q: 'CIE Automotive India Limited Scope 1 for 2022 and 2023 — cite each year with page links.',
    expectYears: [2022, 2023],
    expectValues: [18897, 9169.44],
  },
  {
    id: 10,
    company: 'Aarti Drugs Limited',
    q: 'Female employee share for Aarti Drugs Limited in 2023 — cite page and PDF.',
    expectYear: 2023,
  },
  {
    id: 11,
    company: 'Camlin Fine Sciences Limited',
    q: 'Camlin Fine Sciences Limited Scope 1 for year 2023 only (not 2024/2025). Include citations.',
    expectYear: 2023,
    expectValue: 112203,
    expectPage: 28,
  },
  {
    id: 12,
    company: 'CIE Automotive India Limited',
    q: 'What is CIE Automotive India Limited Scope 1 emissions for 2024? Cite page and PDF.',
    expectYear: 2024,
    expectValue: 11006.7,
    expectPage: 42,
  },
  {
    id: 13,
    company: 'CIE Automotive India Limited',
    q: 'Compare female employee share for CIE Automotive India Limited 2022 vs 2023 with citations.',
    expectYears: [2022, 2023],
  },
  {
    id: 14,
    company: '3M INDIA LIMITED',
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
  let verifyOnly = null;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    if (args[i] === '--verify-only' && args[i + 1]) verifyOnly = parseInt(args[++i], 10);
  }

  return { limit, verifyOnly };
}

function extractPdfUrls(text) {
  return [...new Set([...String(text).matchAll(/https?:\/\/[^\s)]+\.pdf[^\s)]*/gi)].map((m) => m[0].split('#')[0]))];
}

function scoreAnswer(text, spec) {
  const checks = {
    hasPageCitation: /p\.\s*\d+\s*\[source\]\([^)]+\)/i.test(text)
      || /\[p\.\s*\d+\]\([^)]+\.pdf[^)]*\)/i.test(text),
    hasReportFallback: /\[report\]\([^)]+\.pdf[^)]*\)/i.test(text),
    hasPdfUrl: /https?:\/\/[^\s)]+\.pdf/i.test(text),
    hasSourcesSection: /##\s*Sources/i.test(text),
    deniesAvailability: /Unfortunately, there is no available PDF|no available PDF link|no available citations or PDF|pdf link:\s*not|page number:\s*not specified/i.test(text),
    wrongYearSubstitution: false,
    valueFound: true,
    pageFound: true,
    pdfValueVerified: true,
    sourceValueVerified: true,
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
    checks.pageFound = new RegExp(`p\\.\\s*${spec.expectPage}|\\[p\\.\\s*${spec.expectPage}\\]`, 'i').test(text);
  }

  if (spec.expectYear != null) {
    const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
    if (years.length && !years.includes(spec.expectYear)) {
      checks.wrongYearSubstitution = true;
    }
  }

  const pdfLinks = extractPdfUrls(text).length;
  if (spec.expectMinPdfLinks != null) {
    checks.hasPdfUrl = pdfLinks >= spec.expectMinPdfLinks;
  }

  const citationOk = checks.hasPageCitation || checks.hasReportFallback;
  const pass = citationOk
    && checks.hasPdfUrl
    && !checks.deniesAvailability
    && !checks.wrongYearSubstitution
    && checks.valueFound
    && (spec.expectPage == null || checks.pageFound)
    && checks.pdfValueVerified
    && checks.sourceValueVerified;

  return { pass, checks, pdfLinks };
}

async function verifyExpectedAgainstPdf(text, spec) {
  if (spec.expectValue == null || spec.expectPage == null) {
    return { verified: null, status: 'not_applicable' };
  }

  const urls = extractPdfUrls(text);
  let pdfUrl = urls[0] || null;

  if (!pdfUrl && spec.company && spec.expectYear != null) {
    pdfUrl = lookupNseMetadata({ company: spec.company, year: spec.expectYear })?.pdfUrl || null;
  }

  if (!pdfUrl) {
    return { verified: null, status: 'pdf_url_missing', expectValue: spec.expectValue, expectPage: spec.expectPage };
  }

  return verifyValueOnPdfPage(pdfUrl, spec.expectPage, spec.expectValue);
}

function applyVerificationToChecks(checks, verification, expectedPdfCheck) {
  if (verification?.response?.summary?.failed > 0) {
    checks.pdfValueVerified = false;
  }
  if (verification?.sources?.some((source) => source.summary.failed > 0)) {
    checks.sourceValueVerified = false;
  }
  if (expectedPdfCheck?.verified === false) {
    checks.pdfValueVerified = false;
  }
}

async function run() {
  const { limit, verifyOnly } = parseArgs();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const selected = verifyOnly
    ? QUESTIONS.filter((q) => q.id === verifyOnly)
    : QUESTIONS.slice(0, limit);

  const results = [];

  console.log(`Running ${selected.length} citation + PDF verification tests...\n`);

  for (const spec of selected) {
    process.stdout.write(`Q${spec.id}: ${spec.q.slice(0, 70)}... `);
    const started = Date.now();
    try {
      const agentResult = await runAgent({
        userMessage: spec.q,
        chatHistory: [],
        onProgress: null,
      });
      const text = agentResult.text || '';
      const verification = agentResult.citationVerification
        || await verifyAgentCitations(text, []);
      const expectedPdfCheck = await verifyExpectedAgainstPdf(text, spec);
      const scored = scoreAnswer(text, spec);
      applyVerificationToChecks(scored.checks, verification, expectedPdfCheck);

      const pass = scored.pass
        && scored.checks.pdfValueVerified
        && scored.checks.sourceValueVerified
        && (expectedPdfCheck.verified !== false);

      const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
      results.push({
        id: spec.id,
        question: spec.q,
        pass,
        checks: scored.checks,
        pdfLinks: scored.pdfLinks,
        elapsedSec: Number(elapsedSec),
        verification,
        expectedPdfCheck,
        responsePreview: text.slice(0, 600),
        response: text,
      });
      console.log(pass ? `PASS (${elapsedSec}s)` : `FAIL (${elapsedSec}s)`);
      if (!pass) {
        console.log('  checks:', JSON.stringify(scored.checks));
        if (expectedPdfCheck?.status) {
          console.log('  expectedPdfCheck:', JSON.stringify(expectedPdfCheck));
        }
        if (verification?.summary) {
          console.log('  verification:', JSON.stringify(verification.summary));
        }
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

  let md = `# Citation + PDF Verification Report\n\n`;
  md += `Pass rate: **${summary.passRate}** (${passed}/${results.length})\n\n`;
  md += `| ID | Result | Time | PDF Verified | Source Verified | Question |\n`;
  md += `|----|--------|------|--------------|-----------------|----------|\n`;
  for (const r of results) {
    const pdfVerified = r.verification?.summary?.responseFailed === 0 ? 'yes' : (r.verification ? 'no' : 'n/a');
    const sourceVerified = r.verification?.summary?.sourceFailed === 0 ? 'yes' : (r.verification ? 'no' : 'n/a');
    md += `| ${r.id} | ${r.pass ? 'PASS' : 'FAIL'} | ${r.elapsedSec}s | ${pdfVerified} | ${sourceVerified} | ${r.question.replace(/\|/g, '/')} |\n`;
  }

  md += `\n## Failures\n\n`;
  for (const r of results.filter((x) => !x.pass)) {
    md += `### Q${r.id}\n`;
    md += `- Question: ${r.question}\n`;
    md += `- Checks: \`${JSON.stringify(r.checks || { error: r.error })}\`\n`;
    if (r.expectedPdfCheck) {
      md += `- Expected PDF check: \`${JSON.stringify(r.expectedPdfCheck)}\`\n`;
    }
    if (r.verification?.response?.checks?.length) {
      md += `- Parsed citation checks:\n`;
      for (const check of r.verification.response.checks) {
        md += `  - value=${check.value}, page=${check.page}, verified=${check.verified}, status=${check.status}\n`;
      }
    }
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

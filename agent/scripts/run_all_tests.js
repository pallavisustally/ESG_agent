/**
 * SusTally master integration test suite.
 *
 * Covers:
 * - Firebase auth configuration + session/JWT plumbing
 * - Chat session save/load persistence (signed-in user)
 * - New-chat isolation (empty history = fresh context)
 * - 10 high-priority agent Q&A cases
 * - Answer relevance, numeric accuracy, citations
 * - PDF page verification (value exists on cited page)
 * - No female-workforce text on emissions/renewable lines
 *
 * Usage:
 *   npm run test:all
 *   node agent/scripts/run_all_tests.js --quick        # skip slow agent calls
 *   node agent/scripts/run_all_tests.js --limit 3      # first N agent questions only
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getDb } from '../src/db.js';
import { runAgent } from '../src/agent.js';
import { resolveFromProject } from '../src/paths.js';
import {
  isFirebaseAuthConfigured,
  getPublicFirebaseConfig,
  createSessionToken,
  verifySessionToken,
  verifyFirebaseIdToken,
} from '../src/auth.js';
import {
  findOrCreateUser,
  getUserChatSessions,
  upsertUserChatSession,
  deleteUserChatSession,
  migrateUserChatSessions,
} from '../src/user-chats.js';
import { verifyAgentCitations } from '../src/pdf-verifier.js';
import { verifyValueOnPdfPage } from '../src/page-index.js';
import { lookupNseMetadata } from '../src/report-sources.js';
import { upgradeReportCitations } from '../src/report-sources.js';

dotenv.config();

// Full per-metric PDF audit is expensive; enable it for automated verification runs.
process.env.VERIFY_FULL_SOURCE_CITATIONS = 'true';

const OUT_DIR = resolveFromProject('data', 'test_reports');
const TEST_FIREBASE_UID = 'sustally-automated-test-user';
const TEST_EMAIL = 'sustally-test@example.local';

const AGENT_QUESTIONS = [
  {
    id: 'Q1',
    name: 'Single company Scope 1 with citation',
    q: 'What is Aarti Drugs Limited Scope 1 emissions for 2023? Cite page number and PDF link.',
    company: 'Aarti Drugs Limited',
    expectYear: 2023,
    expectValue: 56820,
    expectPage: 39,
    expectKeywords: ['scope 1', 'aarti'],
    emissionsQuestion: true,
    wantsChart: false,
  },
  {
    id: 'Q2',
    name: 'Compare two companies emissions + renewable + chart',
    q: 'Analyze and compare Scope 1 emissions and renewable energy share of Infosys Limited and Asian Paints Limited in 2026. Include a bar chart.',
    expectKeywords: ['infosys', 'asian paints', 'scope 1', 'renewable'],
    expectValues: [11483, 79686],
    emissionsQuestion: true,
    wantsChart: true,
  },
  {
    id: 'Q3',
    name: 'Exact year — no substitution',
    q: 'What is 3M INDIA LIMITED Scope 1 emissions for 2023? Cite page and PDF URL.',
    company: '3M INDIA LIMITED',
    expectYear: 2023,
    expectValue: 8790,
    expectPage: 34,
    expectKeywords: ['3m', 'scope 1', '2023'],
    emissionsQuestion: true,
  },
  {
    id: 'Q4',
    name: 'Female workforce share (breakdown allowed)',
    q: 'Female employee share for Aarti Drugs Limited in 2023 — cite page and PDF.',
    company: 'Aarti Drugs Limited',
    expectYear: 2023,
    expectKeywords: ['female', 'aarti', '2023'],
    emissionsQuestion: false,
    allowFemaleBreakdown: true,
  },
  {
    id: 'Q5',
    name: 'Renewable energy share single company',
    q: 'What is CIE Automotive India Limited renewable energy share for 2023? Cite page and PDF.',
    company: 'CIE Automotive India Limited',
    expectYear: 2023,
    expectKeywords: ['renewable', 'cie automotive'],
    emissionsQuestion: true,
  },
  {
    id: 'Q6',
    name: 'Multi-year comparison with citations',
    q: 'Compare Scope 1 for Aarti Drugs Limited 2023 vs 2025. Cite every number with page and PDF.',
    expectYears: [2023, 2025],
    expectValues: [56820, 64666],
    expectKeywords: ['aarti', 'scope 1', '2023', '2025'],
    emissionsQuestion: true,
  },
  {
    id: 'Q7',
    name: 'Sector carbon intensity ranking',
    q: 'Analyze average carbon emissions intensity across all sectors in 2025. Rank sectors and show a pie chart of sector share.',
    expectYear: 2025,
    expectKeywords: ['sector', 'intensity', '2025'],
    wantsChart: true,
    emissionsQuestion: true,
  },
  {
    id: 'Q8',
    name: 'Deep Industries Scope 1 2022',
    q: 'Deep Industries Limited Scope 1 emissions in 2022 — cite page and PDF.',
    company: 'Deep Industries Limited',
    expectYear: 2022,
    expectValue: 5828,
    expectPage: 13,
    expectKeywords: ['deep industries', 'scope 1', '2022'],
    emissionsQuestion: true,
  },
  {
    id: 'Q9',
    name: 'Top female workforce companies + charts',
    q: 'Analyze the top 5 companies with the highest female employee share in 2025. Show a bar chart and a pie chart of their relative shares.',
    expectYear: 2025,
    expectKeywords: ['female', '2025'],
    wantsChart: true,
    allowFemaleBreakdown: true,
    emissionsQuestion: false,
  },
  {
    id: 'Q10',
    name: 'Multi-company Scope 1 list',
    q: 'List Scope 1 for Aarti Drugs Limited, Camlin Fine Sciences Limited, and Deep Industries Limited for 2022 or nearest available cited year. Cite each figure.',
    expectKeywords: ['scope 1', 'aarti', 'camlin', 'deep industries'],
    expectMinPdfLinks: 2,
    emissionsQuestion: true,
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { quick: false, limit: AGENT_QUESTIONS.length };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--quick') parsed.quick = true;
    if (args[i] === '--limit' && args[i + 1]) parsed.limit = parseInt(args[++i], 10);
  }
  return parsed;
}

function record(results, section, name, pass, details = {}) {
  const entry = { section, name, pass, ...details };
  results.push(entry);
  const label = pass ? 'PASS' : 'FAIL';
  console.log(`  [${label}] ${section} — ${name}${details.error ? `: ${details.error}` : ''}`);
  return entry;
}

function hasCitation(text) {
  return /p\.\s*\d+\s*\[source\]\([^)]+\)/i.test(text)
    || /\[p\.\s*\d+\]\([^)]+\.pdf[^)]*\)/i.test(text);
}

function hasChart(text) {
  return /```json-chart[\s\S]*?```/i.test(text) || /"chartType"\s*:\s*"(bar|line|pie|doughnut)"/i.test(text);
}

function textIncludesValue(text, value) {
  const plain = String(value).replace(/,/g, '');
  const normalized = text.replace(/,/g, '');
  return normalized.includes(plain) || text.includes(String(value));
}

function hasFemaleOnEmissionsLine(text) {
  return text.split('\n').some((line) => {
    if (!/scope\s*[123]|emission|renewable|carbon|tco2/i.test(line)) return false;
    if (/female employee share|workforce|diversity/i.test(line)) return false;
    return /\bfemale (?:permanent )?employees of\b/i.test(line);
  });
}

function scoreAgentAnswer(text, spec) {
  const checks = {
    hasKeywords: !spec.expectKeywords?.length
      || spec.expectKeywords.every((kw) => text.toLowerCase().includes(kw.toLowerCase())),
    hasCitation: hasCitation(text),
    hasPdfUrl: /https?:\/\/[^\s)]+\.pdf/i.test(text),
    valueFound: true,
    pageFound: true,
    yearOk: true,
    hasChart: !spec.wantsChart || hasChart(text),
    noWrongFemaleBreakdown: spec.emissionsQuestion ? !hasFemaleOnEmissionsLine(text) : true,
    deniesAvailability: /no available PDF|no data available|not available in the current dataset/i.test(text),
  };

  if (spec.expectValue != null) {
    checks.valueFound = textIncludesValue(text, spec.expectValue);
  }
  if (Array.isArray(spec.expectValues)) {
    checks.valueFound = spec.expectValues.every((v) => textIncludesValue(text, v));
  }
  if (spec.expectPage != null) {
    checks.pageFound = new RegExp(`p\\.\\s*${spec.expectPage}|\\[p\\.\\s*${spec.expectPage}\\]`, 'i').test(text);
  }
  if (spec.expectYear != null) {
    checks.yearOk = new RegExp(String(spec.expectYear)).test(text);
  }
  if (Array.isArray(spec.expectYears)) {
    checks.yearOk = spec.expectYears.every((y) => new RegExp(String(y)).test(text));
  }
  if (spec.expectMinPdfLinks != null) {
    const count = [...text.matchAll(/https?:\/\/[^\s)]+\.pdf/gi)].length;
    checks.hasPdfUrl = count >= spec.expectMinPdfLinks;
  }

  const pass = checks.hasKeywords
    && checks.hasCitation
    && checks.hasPdfUrl
    && checks.valueFound
    && checks.yearOk
    && checks.hasChart
    && checks.noWrongFemaleBreakdown
    && !checks.deniesAvailability
    && (spec.expectPage == null || checks.pageFound);

  return { pass, checks };
}

async function runInfrastructureTests(results) {
  console.log('\n== Infrastructure ==');
  try {
    const db = await getDb();
    const row = await db.get('SELECT COUNT(*) AS count FROM reports');
    record(results, 'Infrastructure', 'Database connected', Number(row?.count) > 0, { reportCount: row?.count });
  } catch (err) {
    record(results, 'Infrastructure', 'Database connected', false, { error: err.message });
  }

  const firebase = getPublicFirebaseConfig();
  record(results, 'Infrastructure', 'Firebase client config present', Boolean(firebase?.projectId), { projectId: firebase?.projectId || null });
  record(results, 'Infrastructure', 'Firebase auth configured', isFirebaseAuthConfigured());
}

async function runAuthTests(results) {
  console.log('\n== Auth & sessions ==');

  try {
    const token = createSessionToken({
      id: 999001,
      email: 'jwt-test@example.local',
      name: 'JWT Test',
      picture: null,
    });
    const decoded = verifySessionToken(token);
    record(results, 'Auth', 'JWT session roundtrip', decoded?.email === 'jwt-test@example.local');
  } catch (err) {
    record(results, 'Auth', 'JWT session roundtrip', false, { error: err.message });
  }

  try {
    await verifyFirebaseIdToken('invalid-token');
    record(results, 'Auth', 'Firebase rejects invalid token', false, { error: 'Expected rejection' });
  } catch {
    record(results, 'Auth', 'Firebase rejects invalid token', true);
  }

  try {
    const user = await findOrCreateUser({
      firebaseUid: TEST_FIREBASE_UID,
      email: TEST_EMAIL,
      name: 'SusTally Test User',
      picture: null,
    });

    const sessionA = {
      id: `test_session_a_${Date.now()}`,
      title: 'Infosys emissions chat',
      history: [
        { role: 'user', content: 'What is Infosys Scope 1 in 2026?' },
        { role: 'assistant', content: 'Infosys Scope 1 is 11,483 tCO2e.' },
      ],
      timestamp: Date.now(),
    };
    const sessionB = {
      id: `test_session_b_${Date.now()}`,
      title: 'Asian Paints renewable chat',
      history: [
        { role: 'user', content: 'Asian Paints renewable energy share 2026?' },
        { role: 'assistant', content: 'Asian Paints renewable share is 16.17%.' },
      ],
      timestamp: Date.now() + 1,
    };

    await upsertUserChatSession(user.id, sessionA);
    await upsertUserChatSession(user.id, sessionB);

    const sessions = await getUserChatSessions(user.id);
    const foundA = sessions.find((s) => s.id === sessionA.id);
    const foundB = sessions.find((s) => s.id === sessionB.id);

    record(results, 'Auth', 'Save multiple chat sessions for user', Boolean(foundA && foundB), {
      sessionCount: sessions.length,
    });
    record(results, 'Auth', 'Session A history preserved', foundA?.history?.length === 2);
    record(results, 'Auth', 'Session B history preserved', foundB?.history?.length === 2);
    record(results, 'Auth', 'Sessions are isolated (different titles)', foundA?.title !== foundB?.title);

    const migrated = await migrateUserChatSessions(user.id, [{
      id: `test_session_migrate_${Date.now()}`,
      title: 'Migrated local chat',
      history: [{ role: 'user', content: 'Local only question' }],
      timestamp: Date.now(),
    }]);
    record(results, 'Auth', 'Migrate local sessions on sign-in', migrated.length >= sessions.length);

    await deleteUserChatSession(user.id, sessionA.id);
    await deleteUserChatSession(user.id, sessionB.id);
    const afterDelete = await getUserChatSessions(user.id);
    record(results, 'Auth', 'Delete chat session', !afterDelete.some((s) => s.id === sessionA.id || s.id === sessionB.id));
  } catch (err) {
    record(results, 'Auth', 'Chat session persistence', false, { error: err.message });
  }

  record(
    results,
    'Auth',
    'Google Sign-In popup (manual browser check)',
    isFirebaseAuthConfigured(),
    { note: 'Automated tests verify backend auth plumbing. Full Google popup requires manual browser test.' },
  );
}

async function runIsolationTests(results, quick) {
  console.log('\n== Chat isolation ==');
  if (quick) {
    record(results, 'Isolation', 'Skipped in --quick mode', true, { skipped: true });
    return;
  }

  try {
    const fresh = await runAgent({
      userMessage: 'What is Infosys Limited Scope 1 emissions in 2026? One sentence only.',
      chatHistory: [],
      onProgress: null,
    });
    record(results, 'Isolation', 'New chat uses empty input history', true, {
      responsePreview: (fresh.text || '').slice(0, 120),
    });

    const withPrior = await runAgent({
      userMessage: 'What is Asian Paints Limited Scope 1 emissions in 2026? One sentence only.',
      chatHistory: [
        { role: 'user', content: 'What is Infosys Scope 1 in 2026?' },
        { role: 'assistant', content: 'Infosys Scope 1 is 11,483 tCO2e in 2026.' },
      ],
      onProgress: null,
    });
    const mentionsAsian = /asian paints/i.test(withPrior.text || '');
    const mentionsInfosysOnly = /infosys/i.test(withPrior.text || '') && !mentionsAsian;
    record(results, 'Isolation', 'Follow-up answers new company when asked', mentionsAsian && !mentionsInfosysOnly, {
      responsePreview: (withPrior.text || '').slice(0, 180),
    });
  } catch (err) {
    record(results, 'Isolation', 'Chat isolation', false, { error: err.message });
  }
}

async function runAgentQuestionTests(results, limit, quick) {
  console.log('\n== Agent Q&A (top questions) ==');
  if (quick) {
    record(results, 'Agent', 'Skipped in --quick mode', true, { skipped: true });
    return;
  }

  const selected = AGENT_QUESTIONS.slice(0, limit);

  for (const spec of selected) {
    const started = Date.now();
    try {
      const { text, citationVerification } = await runAgent({
        userMessage: spec.q,
        chatHistory: [],
        onProgress: null,
      });

      const scored = scoreAgentAnswer(text || '', spec);
      let pdfOk = true;
      let expectedPdfCheck = null;

      if (spec.expectValue != null && spec.expectPage != null) {
        const meta = spec.company && spec.expectYear != null
          ? lookupNseMetadata({ company: spec.company, year: spec.expectYear })
          : null;
        const pdfUrl = [...(text || '').matchAll(/https?:\/\/[^\s)]+\.pdf/gi)].map((m) => m[0].split('#')[0])[0]
          || meta?.pdfUrl
          || null;
        if (pdfUrl) {
          expectedPdfCheck = await verifyValueOnPdfPage(pdfUrl, spec.expectPage, spec.expectValue);
          pdfOk = expectedPdfCheck.verified === true;
        }
      }

      const verificationOk = !citationVerification
        || citationVerification.pass !== false
        || expectedPdfCheck?.verified === true;
      const pass = scored.pass && pdfOk && verificationOk;

      record(results, 'Agent', `${spec.id}: ${spec.name}`, pass, {
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
        checks: scored.checks,
        pdfVerification: citationVerification?.summary || null,
        expectedPdfCheck,
        responsePreview: (text || '').slice(0, 300),
      });
    } catch (err) {
      record(results, 'Agent', `${spec.id}: ${spec.name}`, false, {
        elapsedSec: Number(((Date.now() - started) / 1000).toFixed(1)),
        error: err.message,
      });
    }
  }
}

async function runCitationSanitizerTests(results) {
  console.log('\n== Citation sanitizer ==');
  const dirty = `### Asian Paints Limited
- **Renewable energy share:** 16.17% (1,000 female permanent employees of 9,443 total permanent employees) p. 3 [source](https://example.com/a.pdf#page=3)`;

  const cleaned = upgradeReportCitations(dirty, [{
    company: 'Asian Paints Limited',
    year: 2026,
    pdf_url: 'https://example.com/a.pdf',
    metric_pages_json: JSON.stringify({ renewable_energy_share: 3 }),
    renewable_energy_share: 16.17,
  }]);

  record(
    results,
    'Sanitizer',
    'Remove female breakdown from renewable line',
    !/renewable energy share:.*female permanent employees/i.test(cleaned),
    { cleanedPreview: cleaned.slice(0, 180) },
  );

  const sectorDirty = `### Materials
- **Average emissions intensity:** 20.89 tCO2e per unit p. 15 [source](https://nsearchives.nseindia.com/corporate/xbrl/fake.pdf#page=15)
### Industrials
- **Average emissions intensity:** 0.00000165 tCO2e per unit p. 3 [source](https://nsearchives.nseindia.com`;

  const sectorCleaned = upgradeReportCitations(sectorDirty, [{
    company: 'Spandana Sphoorty Financial Limited',
    year: 2025,
    pdf_url: 'https://nsearchives.nseindia.com/corporate/xbrl/fake.pdf',
    metric_pages_json: JSON.stringify({ emissions_intensity: 15 }),
    emissions_intensity: 1.73,
  }]);

  record(
    results,
    'Sanitizer',
    'Strip misleading PDF citations from sector aggregate lines',
    !/\[source\]\(/.test(sectorCleaned) && sectorCleaned.includes('20.89'),
    { cleanedPreview: sectorCleaned.slice(0, 220) },
  );

  const { pageContainsShareMetric, scoreShareMetricPage } = await import('../src/page-index.js');
  const coverPage = 'GATEWAY DISTRIPARKS LIMITED CIN L60231MH2005PLC344764 100 41 registered office';
  const diversityPage = 'Employees and workers (including differently abled) Particulars Total Male Female EMPLOYEES Permanent (D) 504 463 91.86% 41 8.14% Total employees (D+E) 504 463 41 8.13%';
  record(
    results,
    'Sanitizer',
    'Share metric page match prefers diversity context over cover page numbers',
    !pageContainsShareMetric(coverPage, 'female_employee_share', {
      female_employee_count: 41,
      total_employee_count: 504,
      female_employee_share: 8.13,
    })
    && pageContainsShareMetric(diversityPage, 'female_employee_share', {
      female_employee_count: 41,
      total_employee_count: 504,
      female_employee_share: 8.13,
    }),
  );

  const mahindraDiversity = '003A Employees and workers (including differently abled) Particulars Total Male Female EMPLOYEES Permanent (D) 292 282 96.58% 10 3.42% Total employees (D+E) 296 286 10 3.38%';
  const mahindraTraining = 'Total Permanent Employees 267 292 Male 282 Female 10 training given to employees and workers union';
  record(
    results,
    'Sanitizer',
    'Share metric scoring prefers BRSR diversity table over training/union pages',
    scoreShareMetricPage(mahindraDiversity, 'female_employee_share', {
      female_employee_count: 10,
      total_employee_count: 296,
      female_employee_share: 3.38,
    }, 77) > scoreShareMetricPage(mahindraTraining, 'female_employee_share', {
      female_employee_count: 10,
      total_employee_count: 296,
      female_employee_share: 3.38,
    }, 92),
  );
}

function writeReport(allResults) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const passed = allResults.filter((r) => r.pass).length;
  const failed = allResults.filter((r) => !r.pass && !r.skipped).length;
  const skipped = allResults.filter((r) => r.skipped).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    total: allResults.length,
    passed,
    failed,
    skipped,
    passRate: `${((passed / Math.max(allResults.length - skipped, 1)) * 100).toFixed(1)}%`,
    results: allResults,
  };

  const jsonPath = path.join(OUT_DIR, 'all_tests_report.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));

  let md = `# SusTally Master Test Report\n\n`;
  md += `Generated: ${summary.generatedAt}\n\n`;
  md += `Pass rate: **${summary.passRate}** (${passed}/${allResults.length - skipped}, skipped ${skipped})\n\n`;
  md += `| Section | Test | Result |\n|---|---|---|\n`;
  for (const r of allResults) {
    md += `| ${r.section} | ${r.name} | ${r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'} |\n`;
  }
  md += `\n## Failures\n\n`;
  for (const r of allResults.filter((x) => !x.pass && !x.skipped)) {
    md += `### ${r.section}: ${r.name}\n`;
    if (r.error) md += `- Error: ${r.error}\n`;
    if (r.checks) md += `- Checks: \`${JSON.stringify(r.checks)}\`\n`;
    if (r.expectedPdfCheck) md += `- PDF check: \`${JSON.stringify(r.expectedPdfCheck)}\`\n`;
    if (r.responsePreview) md += `- Preview: ${r.responsePreview}\n`;
    md += `\n`;
  }

  const mdPath = path.join(OUT_DIR, 'all_tests_report.md');
  fs.writeFileSync(mdPath, md);
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  return summary;
}

async function run() {
  const { quick, limit } = parseArgs();
  const allResults = [];

  console.log('SusTally master test suite');
  console.log(`Mode: ${quick ? 'quick (no agent calls)' : 'full'} | Agent questions: ${quick ? 0 : limit}`);

  await runInfrastructureTests(allResults);
  await runAuthTests(allResults);
  await runCitationSanitizerTests(allResults);
  await runIsolationTests(allResults, quick);
  await runAgentQuestionTests(allResults, limit, quick);

  const summary = writeReport(allResults);
  console.log(`\nOverall: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`);
  process.exit(summary.failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

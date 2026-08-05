/**
 * PDF citation URL resolution — prefer local files; never expose dead NSE links.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePdfUrlForRow,
  findLocalPdfForReport,
  upgradeReportCitations,
  LOCAL_PDF_MOUNT,
} from './report-sources.js';

describe('local PDF resolution for Infosys', () => {
  it('finds 2025 Infosys local PDF even when DB pdf_url basename is wrong', () => {
    const local = findLocalPdfForReport({
      year: 2025,
      symbol: 'INFY',
      // Wrong basename (2026 filing) — still present on some DB rows.
      pdfUrl: 'https://nsearchives.nseindia.com/corporate/BRSR_500209_10062026191217.pdf',
      altPdfUrls: [
        'https://nsearchives.nseindia.com/corporate/Infosys_03072025215225_Infosys_Integrated_Annual_Report_2024-25.pdf',
      ],
    });
    assert.ok(local);
    assert.match(local, /Infosys_03072025215225_Infosys_Integrated_Annual_Report_2024-25\.pdf$/i);
  });

  it('resolvePdfUrlForRow returns /local-pdf for Infosys 2025', () => {
    const url = resolvePdfUrlForRow({
      company: 'Infosys Limited',
      year: 2025,
      filename: 'BRSR_1477079_03072025095250_WEB.xml',
      pdf_url: 'https://nsearchives.nseindia.com/corporate/BRSR_500209_10062026191217.pdf',
    });
    assert.ok(url);
    assert.ok(url.startsWith(LOCAL_PDF_MOUNT));
    assert.match(url, /INFY/i);
    assert.doesNotMatch(url, /nsearchives\.nseindia\.com/i);
  });

  it('resolvePdfUrlForRow returns /local-pdf for Infosys 2026', () => {
    const url = resolvePdfUrlForRow({
      company: 'Infosys Limited',
      year: 2026,
      filename: 'BRSR_500209_1062026191217_BRSR_WebXMLFile_20260610_191246055.xml',
      pdf_url: 'https://nsearchives.nseindia.com/corporate/BRSR_500209_10062026191217.pdf',
    });
    assert.ok(url);
    assert.ok(url.startsWith(`${LOCAL_PDF_MOUNT}/2026/`));
    assert.match(url, /BRSR_500209_10062026191217\.pdf/i);
  });

  it('strips invented full-report-here CTA when upgrading citations', () => {
    const pdfUrl = resolvePdfUrlForRow({
      company: 'Infosys Limited',
      year: 2026,
      filename: 'BRSR_500209_1062026191217_BRSR_WebXMLFile_20260610_191246055.xml',
      pdf_url: 'https://nsearchives.nseindia.com/corporate/BRSR_500209_10062026191217.pdf',
      metric_pages_json: JSON.stringify({ scope1_emissions: 164 }),
      scope1_emissions: 11483,
    });
    const text = [
      'Scope 1 Emissions: 11,483 tons p. 164 [source](' + pdfUrl + '#page=164)',
      '',
      'For further details, you can refer to the full report [here](https://nsearchives.nseindia.com/corporate/BRSR_500209_10062026191217.pdf).',
    ].join('\n');
    const out = upgradeReportCitations(text, [{
      company: 'Infosys Limited',
      year: 2026,
      pdf_url: 'https://nsearchives.nseindia.com/corporate/BRSR_500209_10062026191217.pdf',
      filename: 'BRSR_500209_1062026191217_BRSR_WebXMLFile_20260610_191246055.xml',
      metric_pages_json: JSON.stringify({ scope1_emissions: 164 }),
      scope1_emissions: 11483,
    }]);
    assert.doesNotMatch(out, /For further details/i);
    assert.doesNotMatch(out, /\[here\]/i);
    assert.match(out, /\[source\]\(\/local-pdf\//i);
  });
});

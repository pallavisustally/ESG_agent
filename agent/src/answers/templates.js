/**
 * Answer templates for ChatGPT-like fluency while staying BRSR-grounded.
 */

export function templateLookup({ company, year, metric, value, unit = '', pdfUrl = null, note = '' }) {
  const lines = [
    `### ${company}${year ? ` (${year})` : ''}`,
    '',
    `**${metric}:** ${value}${unit ? ` ${unit}` : ''}`,
  ];
  if (note) lines.push('', note);
  if (pdfUrl) lines.push('', `Source PDF: [report](${pdfUrl})`);
  lines.push('', '_From the structured BRSR `reports` table._');
  return lines.join('\n');
}

export function templateRankIntro({ metricLabel, year, n }) {
  return `### Top ${n} by ${metricLabel}${year ? ` (${year})` : ''}\n`;
}

export function templateCompareIntro({ year }) {
  return `### Company comparison${year ? ` (${year})` : ''}\n`;
}

export function templateQualitativeShell({ company, year, bullets, pdfUrl }) {
  const lines = [
    `### ${company || 'BRSR'} ESG narrative${year ? ` (${year})` : ''}`,
    '',
    'Here is what the indexed BRSR disclosures say:',
    '',
    ...bullets.map((b) => `- ${b}`),
  ];
  if (pdfUrl) lines.push('', `PDF: [source](${pdfUrl})`);
  lines.push('', '_Grounded in BRSR database fields — not general web knowledge._');
  return lines.join('\n');
}

/** System addon for fluent final LLM synthesis (facts already retrieved). */
export function fluencySystemAddon({ intent, hasEvidence }) {
  return [
    '',
    '### Answer style (Week 4)',
    '- Write clearly in short paragraphs or bullets; lead with the answer.',
    '- Use only numbers/facts from tool results or retrieved BRSR snippets.',
    '- If evidence is incomplete, say what is missing — never invent.',
    hasEvidence
      ? '- Evidence is already retrieved; synthesize it; do not call unnecessary tools.'
      : '- If evidence is missing, say so briefly.',
    intent ? `- Intent: ${intent}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Follow-up polish: "compare first two", "only healthcare", ordinal picks from memory list.
 */
export function resolveFollowUpEntities(userMessage, memory) {
  const text = String(userMessage || '').trim();
  const lower = text.toLowerCase();
  const fromList = memory?.lastPageItems || memory?.lastList?.items || [];

  if (/compare\s+(the\s+)?first\s+two/i.test(text) && fromList.length >= 2) {
    return { entities: fromList.slice(0, 2), intentHint: 'COMPARE_COMPANIES' };
  }
  if (/compare\s+(the\s+)?first\s+three/i.test(text) && fromList.length >= 3) {
    return { entities: fromList.slice(0, 3), intentHint: 'COMPARE_COMPANIES' };
  }

  const ordinal = lower.match(/\b(?:the\s+)?(first|second|third|#?(\d+))\b/);
  if (ordinal && fromList.length) {
    const map = { first: 0, second: 1, third: 2 };
    const idx = ordinal[2] ? Number(ordinal[2]) - 1 : map[ordinal[1]];
    if (idx >= 0 && idx < fromList.length) {
      return { entities: [fromList[idx]], intentHint: null };
    }
  }

  if (/^only\s+/i.test(text) && memory?.lastIntent) {
    return { sectorOnly: true, intentHint: memory.lastIntent };
  }

  return null;
}

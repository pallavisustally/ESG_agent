/**
 * Stage-2 LLM explanation — narrate only verified statistical insights.
 * Never invent numeric observations beyond the provided insight list.
 */

/**
 * Build a grounded explanation prompt from ChartSpec + deterministic insights.
 * @param {{ spec?: object, insights?: string[], userMessage?: string }} input
 * @returns {{ system: string, user: string } | null}
 */
export function buildInsightExplanationPrompt({
  spec = null,
  insights = [],
  userMessage = '',
} = {}) {
  if (!insights?.length) return null;

  const title = spec?.meta?.title || 'Chart';
  const chartType = spec?.chartType || 'chart';
  const system = [
    'You explain ESG chart insights for analysts.',
    'Use ONLY the verified statistical insights provided.',
    'Do not invent numbers, trends, rankings, or companies not listed.',
    'Do not contradict the insights.',
    'Write 1–3 short sentences in plain language.',
    'No markdown headings. No bullet lists unless necessary.',
  ].join(' ');

  const user = [
    userMessage ? `User question: ${userMessage}` : null,
    `Chart: ${title} (${chartType})`,
    'Verified insights:',
    ...insights.map((line, i) => `${i + 1}. ${line}`),
    'Explain these insights briefly for the user.',
  ].filter(Boolean).join('\n');

  return { system, user };
}

/**
 * Format LLM output as an Observations section, or return empty when unsafe/empty.
 * @param {string} text
 * @param {string[]} insights - used to soft-check the explanation stays grounded
 */
export function formatObservationMarkdown(text, insights = []) {
  const cleaned = String(text || '')
    .replace(/^```[\s\S]*?```$/g, '')
    .replace(/\*\*Observations?\*\*/gi, '')
    .trim();
  if (!cleaned) return '';

  // Soft guard: reject if explanation introduces many digits not present in insights.
  if (insights.length && looksUngrounded(cleaned, insights)) {
    return '';
  }

  return ['**Observations**', cleaned].join('\n');
}

/**
 * Explain insights with an injected chat function.
 * @param {Object} opts
 * @param {(args: { messages: Array<{role:string,content:string}> }) => Promise<{ content?: string }|string>} opts.chatFn
 * @returns {Promise<string>} observation markdown (may be empty)
 */
export async function explainInsightsWithLlm({
  spec = null,
  insights = [],
  userMessage = '',
  chatFn = null,
} = {}) {
  if (typeof chatFn !== 'function' || !insights?.length) return '';

  const prompt = buildInsightExplanationPrompt({ spec, insights, userMessage });
  if (!prompt) return '';

  try {
    const result = await chatFn({
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    });
    const content = typeof result === 'string'
      ? result
      : (result?.content || result?.message?.content || '');
    return formatObservationMarkdown(content, insights);
  } catch {
    return '';
  }
}

function looksUngrounded(explanation, insights) {
  const insightText = insights.join(' ');
  const insightNums = new Set((insightText.match(/\d+(?:\.\d+)?/g) || []));
  const explNums = explanation.match(/\d+(?:\.\d+)?/g) || [];
  // Allow small counts / percentages already in insights; flag many novel numbers.
  let novel = 0;
  for (const n of explNums) {
    if (!insightNums.has(n)) novel += 1;
  }
  return novel >= 3;
}

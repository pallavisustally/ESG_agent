/**
 * Structured citations extracted from assistant markdown (page links, PDF sources).
 */

export function extractAnswerCitations(text = '') {
  const citations = [];
  const seen = new Set();
  const body = String(text || '');
  const re = /\[([^\]]{1,120})\]\((https?:[^)\s]+)\)/gi;
  let match = re.exec(body);
  while (match) {
    const url = String(match[2] || '').trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      const pageMatch = /[?#]page=(\d+)/i.exec(url) || /\bp\.?\s*(\d+)\b/i.exec(match[1] || '');
      citations.push({
        label: String(match[1] || 'source').trim(),
        url,
        page: pageMatch ? Number(pageMatch[1]) : null,
      });
    }
    match = re.exec(body);
  }
  return citations;
}

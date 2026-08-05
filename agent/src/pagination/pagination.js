/**
 * Pagination helpers for large BRSR result sets (companies, filtered lists).
 * Never silently truncate when the user asked for ALL — expose page + export.
 */

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;

/**
 * @param {number|string} page
 * @param {number|string} pageSize
 */
export function normalizePageParams(page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  let size = parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE;
  size = Math.min(MAX_PAGE_SIZE, Math.max(1, size));
  const offset = (p - 1) * size;
  return { page: p, pageSize: size, offset };
}

/**
 * @template T
 * @param {T[]} items
 * @param {{ page?: number, pageSize?: number }} opts
 */
export function paginateArray(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  const { page, pageSize, offset } = normalizePageParams(opts.page, opts.pageSize);
  const total = list.length;
  const slice = list.slice(offset, offset + pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    items: slice,
    page,
    pageSize,
    offset,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    nextPage: page < totalPages ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  };
}

/** Format a company list page for chat (explicit completeness). */
export function formatCompanyPageMarkdown({
  items,
  page,
  pageSize,
  total,
  totalPages,
  hasNext,
  sector = null,
  exportPath = '/api/companies?format=csv',
  wantsAll = false,
}) {
  const scope = sector ? ` in sector **${sector}**` : '';
  const lines = [];
  lines.push(`There are **${total}** companies${scope} with BRSR reports in the database.`);
  if (wantsAll) {
    lines.push('');
    lines.push(`Showing page **${page}** of **${totalPages}** (${items.length} of ${total} names).`);
    lines.push(`Download the complete list: [${exportPath}](${exportPath})`);
  } else {
    lines.push('');
    lines.push(`Sample / page **${page}** (${items.length} names). Total: **${total}**.`);
    if (total > items.length) {
      lines.push(`Ask for “all company names”, “next”, or download: [${exportPath}](${exportPath})`);
    }
  }
  lines.push('');
  for (const name of items) {
    lines.push(`- ${name}`);
  }
  if (hasNext) {
    lines.push('');
    lines.push(`_Say **next** for page ${page + 1}, or open the CSV download for every name._`);
  }
  return lines.join('\n');
}

export function toCsv(rows, columns) {
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map(escape).join(',');
  const body = rows.map((row) => columns.map((c) => escape(row[c])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

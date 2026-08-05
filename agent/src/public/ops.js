(() => {
  const statusLine = document.getElementById('statusLine');
  const kpiGrid = document.getElementById('kpiGrid');
  const errorCodes = document.getElementById('errorCodes');
  const slowBody = document.getElementById('slowBody');
  const historical = document.getElementById('historical');
  const tokenInput = document.getElementById('tokenInput');
  const refreshBtn = document.getElementById('refreshBtn');
  const flushBtn = document.getElementById('flushBtn');

  const TOKEN_KEY = 'esg_ops_monitoring_token';
  tokenInput.value = localStorage.getItem(TOKEN_KEY) || '';

  function headers() {
    const h = { Accept: 'application/json' };
    const t = tokenInput.value.trim();
    if (t) h['x-monitoring-token'] = t;
    return h;
  }

  function pct(rate) {
    if (rate == null || Number.isNaN(rate)) return '—';
    return `${(Number(rate) * 100).toFixed(1)}%`;
  }

  function kpi(label, value, tone = '') {
    const el = document.createElement('div');
    el.className = `kpi ${tone}`.trim();
    el.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
    return el;
  }

  function toneForRate(rate, warnAt = 0.1, badAt = 0.25) {
    if (rate == null) return '';
    if (rate >= badAt) return 'bad';
    if (rate >= warnAt) return 'warn';
    return '';
  }

  function render(live) {
    kpiGrid.innerHTML = '';
    const items = [
      ['Requests', live.requests ?? 0],
      ['Avg latency', live.averageLatencyMs != null ? `${live.averageLatencyMs} ms` : '—'],
      ['SQL success', pct(live.sqlSuccessRate), toneForRate(1 - (live.sqlSuccessRate ?? 1), 0.15, 0.35)],
      ['SQL miss', pct(live.sqlMissRate), toneForRate(live.sqlMissRate)],
      ['PDF fallback', pct(live.pdfFallbackRate), toneForRate(live.pdfFallbackRate)],
      ['Report lookups', live.narrativeFallbacks + live.pdfFallbacks],
      ['Recommendations', live.recommendationRuns ?? 0],
      ['Rec failures', live.recommendationFailures ?? 0, (live.recommendationFailures || 0) > 0 ? 'warn' : ''],
      ['Val warnings', live.responseValidationWarnings ?? 0, (live.responseValidationWarnings || 0) > 0 ? 'warn' : ''],
      ['Val failures', live.responseValidationFailures ?? 0, (live.responseValidationFailures || 0) > 0 ? 'bad' : ''],
      ['Engine fails', live.engineFailures ?? 0, (live.engineFailures || 0) > 0 ? 'bad' : ''],
      ['Engine timeouts', live.engineTimeouts ?? 0, (live.engineTimeouts || 0) > 0 ? 'warn' : ''],
      ['Slow (≥ threshold)', live.slowRequestCount ?? 0, (live.slowRequestCount || 0) > 0 ? 'warn' : ''],
      ['Clarifications', live.clarifications ?? 0],
    ];
    for (const [label, value, tone] of items) {
      kpiGrid.appendChild(kpi(label, value, tone || ''));
    }

    const codes = live.errorsByCode || {};
    errorCodes.textContent = Object.keys(codes).length
      ? JSON.stringify(codes, null, 2)
      : 'No error codes recorded yet.';

    slowBody.innerHTML = '';
    const rows = live.slowestRequests || [];
    if (!rows.length) {
      slowBody.innerHTML = '<tr><td colspan="6">No latency samples yet.</td></tr>';
    } else {
      for (const r of rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="${r.slow ? 'slow' : ''}">${r.latencyMs} ms</td>
          <td>${r.slow ? 'yes' : 'no'}</td>
          <td>${r.intent || '—'}</td>
          <td>${r.strategy || '—'}</td>
          <td>${r.requestId || '—'}</td>
          <td>${r.ts ? new Date(r.ts).toLocaleString() : '—'}</td>
        `;
        slowBody.appendChild(tr);
      }
    }
  }

  async function load(flush = false) {
    statusLine.className = 'status';
    statusLine.textContent = 'Loading…';
    localStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
    try {
      const qs = new URLSearchParams({ lines: '2000' });
      if (flush) qs.set('flush', '1');
      const res = await fetch(`/api/monitoring?${qs}`, { headers: headers() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        statusLine.className = 'status error';
        statusLine.textContent = data.error || `HTTP ${res.status}`;
        return;
      }
      render(data.live || {});
      historical.textContent = JSON.stringify({
        events: data.historical?.events,
        averageLatencyMs: data.historical?.averageLatencyMs,
        byStage: data.historical?.byStage,
        recommendationRuns: data.historical?.recommendationRuns,
        recommendationFailures: data.historical?.recommendationFailures,
        responseValidationWarnings: data.historical?.responseValidationWarnings,
        pdfFallbackRate: data.historical?.pdfFallbackRate,
        clarificationRate: data.historical?.clarificationRate,
      }, null, 2);
      statusLine.className = 'status ok';
      statusLine.textContent = `Updated ${data.live?.ts || new Date().toISOString()} · auth ${res.headers.get('x-monitoring-auth') || 'ok'}`;
    } catch (err) {
      statusLine.className = 'status error';
      statusLine.textContent = String(err?.message || err);
    }
  }

  refreshBtn.addEventListener('click', () => load(false));
  flushBtn.addEventListener('click', () => load(true));
  tokenInput.addEventListener('change', () => load(false));
  load(false);
  setInterval(() => load(false), 15000);
})();

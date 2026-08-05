/**
 * Normalize ```json-chart``` fences in assistant markdown to the canonical flat shape
 * expected by the Chart.js renderer.
 */

import { chartSpecFromLegacyConfig } from './chart-spec.js';
import { buildChartConfig } from './chart-builder.js';
import { validateChartSpec } from './chart-validate.js';

/**
 * Walk markdown text and normalize every json-chart block.
 * Invalid charts are removed (rejected) rather than left misleading.
 */
export function normalizeChartJson(text) {
  if (!text) return text;
  const chartBlockRegex = /(```json-chart\s*)([\s\S]*?)(\s*```)/g;
  return text.replace(chartBlockRegex, (match, p1, p2, p3) => {
    try {
      const cleanJsonString = p2
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');

      const json = JSON.parse(cleanJsonString.trim());
      const legacyNormalized = liftLegacyShape(json);
      const spec = chartSpecFromLegacyConfig(legacyNormalized);
      if (!spec) return '';

      const validation = validateChartSpec(spec);
      if (!validation.ok) return '';

      const config = buildChartConfig(spec);
      return `${p1}${JSON.stringify(config, null, 2)}${p3}`;
    } catch {
      return match;
    }
  });
}

/** In-place lift of nested/legacy keys (mirrors prior agent.js behavior). */
export function liftLegacyShape(json) {
  if (!json || typeof json !== 'object') return json;
  const out = { ...json };

  if (out.data && typeof out.data === 'object' && !Array.isArray(out.data)) {
    const d = out.data;
    if (d.labels && !out.labels) out.labels = d.labels;
    if (d.datasets && !out.datasets) out.datasets = d.datasets;
    if (d.series && !out.datasets) out.datasets = d.series;
    if (d.values && !out.datasets) {
      out.datasets = [{ label: out.title || 'Value', data: d.values }];
    }
    delete out.data;
  }

  if (out.series && !out.datasets) {
    out.datasets = out.series;
    delete out.series;
  }

  if (Array.isArray(out.values) && !out.datasets) {
    out.datasets = [{ label: out.title || 'Value', data: out.values }];
    delete out.values;
  }

  if (Array.isArray(out.data) && !out.datasets) {
    out.datasets = [{ label: out.title || 'Value', data: out.data }];
    delete out.data;
  }

  if (Array.isArray(out.datasets)) {
    let labelsFromObjects = [];
    let objectFormatFound = false;

    out.datasets = out.datasets.map((d) => {
      if (typeof d !== 'object' || d == null) return d;
      const copy = { ...d };
      if (copy.name && !copy.label) {
        copy.label = copy.name;
        delete copy.name;
      }
      if (Array.isArray(copy.data)) {
        const allObjects = copy.data.every(
          (item) => typeof item === 'object' && item !== null && 'value' in item,
        );
        if (allObjects && copy.data.length > 0) {
          objectFormatFound = true;
          labelsFromObjects = copy.data.map(
            (item) => item.company || item.name || item.label || '',
          );
          copy.data = copy.data.map((item) => item.value);
        }
      }
      return copy;
    });

    if (
      objectFormatFound
      && labelsFromObjects.length > 0
      && (!out.labels || out.labels.length !== labelsFromObjects.length)
    ) {
      out.labels = labelsFromObjects;
    }
  }

  if (!out.type) out.type = 'chart';
  if (!out.chartType) {
    out.chartType = out.type && out.type !== 'chart' ? out.type : 'bar';
  }
  if (out.type !== 'chart' && out.type !== undefined) {
    // Keep chartType; normalize type marker
    if (!['bar', 'line', 'pie', 'doughnut', 'scatter'].includes(out.type)) {
      out.type = 'chart';
    } else {
      out.chartType = out.chartType || out.type;
      out.type = 'chart';
    }
  }

  return out;
}

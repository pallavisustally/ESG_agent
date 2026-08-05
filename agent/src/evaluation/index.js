/**
 * Evaluation framework public API.
 */

export {
  BENCHMARK_CATEGORIES,
  BENCHMARK_TIERS,
  SCORE_DIMENSIONS,
  normalizeBenchmarkCase,
  validateBenchmarkFile,
} from './benchmark-schema.js';

export { loadBenchmarks, loadSmokeBenchmarks, BENCHMARKS_DIR } from './load-benchmarks.js';
export { scoreBenchmarkCase } from './scorers/index.js';
export { runEvaluation, observePlan, observePipeline } from './run-evaluation.js';
export {
  buildEvaluationReport,
  formatMarkdown,
  writeEvaluationReport,
} from './evaluation-report.js';

export {
  QUALITY_GATES,
  resolveMinPassRate,
  assertPassRate,
} from './quality-gates.js';

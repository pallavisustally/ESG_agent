/**
 * Execution Planner public API (Phase 2).
 *
 * Plan-only: no SQL / report / PDF / chart / answer execution.
 */

export {
  createExecutionPlan,
  validateExecutionPlan,
  deriveRequiredEngines,
  EXECUTION_STRATEGIES,
  EXECUTION_ENGINES,
} from './execution-plan.js';

export {
  planExecution,
  buildExecutionPlan,
} from './execution-planner.js';

export {
  compareExecutionPlanToLegacy,
  isExecutionPlanCompareEnabled,
  isExecutionPlannerDispatchEnabled,
} from './execution-plan-compare.js';

export {
  createEngineResponse,
  mergeEngineResponses,
  mergeEngineMemoryUpdates,
  hasExplicitCompanyMemory,
} from './engine-response.js';

export { toolPlanFromExecutionPlan } from './tool-plan-from-execution.js';

export { executeExecutionPlan } from './execution-orchestrator.js';

export {
  runAnalyticsEngine,
  runReportEngine,
  runKnowledgeEngine,
  runGuidanceEngine,
  runComplianceEngine,
  runRecommendationEngine,
  runDocumentEngine,
} from './engines/index.js';

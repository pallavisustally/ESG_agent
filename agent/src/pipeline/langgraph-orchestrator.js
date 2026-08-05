/**
 * Phase 15 — Optional LangGraph orchestration.
 *
 * Graph:
 * START → preprocess → intent → entities → planner → router
 *      → prepare_context → execute → finalize → END
 *
 * Nodes only call existing stages / SQL / RAG / validators.
 * Enable with USE_LANGGRAPH=true (requires optionalDependency @langchain/langgraph).
 */

import {
  stagePreprocess,
  stageIntent,
  stageNormalizeEntities,
  stagePlanValidate,
  stageRouter,
  stagePrepareAnswerContext,
} from './pipeline-stages.js';
import { executeRoutedBranches } from './pipeline-execute.js';
import { logPipelineStage } from '../observability/agent-logger.js';
import { isLangGraphEnabled } from './langgraph-config.js';

let compiledGraph = null;

async function loadLangGraph() {
  try {
    return await import('@langchain/langgraph');
  } catch (err) {
    const error = new Error(
      'LangGraph package missing. Install with: npm i @langchain/langgraph',
    );
    error.code = 'LANGGRAPH_UNAVAILABLE';
    error.cause = err;
    throw error;
  }
}

/**
 * Build (and memoize) the compiled BRSR StateGraph.
 */
export async function getBrsrLangGraph() {
  if (compiledGraph) return compiledGraph;

  const { StateGraph, Annotation, START, END } = await loadLangGraph();

  // Single mergeable context bag — keeps node code simple.
  const GraphState = Annotation.Root({
    ctx: Annotation({
      reducer: (prev, next) => ({ ...(prev || {}), ...(next || {}) }),
      default: () => ({}),
    }),
  });

  const wrap = (name, fn) => async (state) => {
    const next = await fn(state.ctx || {});
    logPipelineStage('langgraph_node', { node: name, intent: next.classification?.intent, ok: true });
    return { ctx: next };
  };

  const graph = new StateGraph(GraphState)
    .addNode('preprocess', wrap('preprocess', async (ctx) => stagePreprocess(ctx)))
    .addNode('intent', wrap('intent', stageIntent))
    .addNode('entities', wrap('entities', stageNormalizeEntities))
    .addNode('planner', wrap('planner', async (ctx) => stagePlanValidate(ctx)))
    .addNode('router', wrap('router', async (ctx) => stageRouter(ctx)))
    .addNode('prepare_context', wrap('prepare_context', async (ctx) => stagePrepareAnswerContext(ctx)))
    .addNode('execute', wrap('execute', async (ctx) => {
      const result = await executeRoutedBranches({ ...ctx, orchestrator: 'langgraph' });
      return { ...ctx, result, stages: [...(ctx.stages || []), 'execute'] };
    }))
    .addNode('finalize', wrap('finalize', async (ctx) => {
      logPipelineStage('response', {
        intent: ctx.result?.classification?.intent || ctx.classification?.intent,
        mode: ctx.result?.route?.mode || ctx.route?.mode,
        tool: ctx.result?.orchestrator || 'langgraph',
        ok: true,
        handled: ctx.result?.handled,
        stages: ctx.stages,
      });
      return { ...ctx, stages: [...(ctx.stages || []), 'finalize'] };
    }))
    .addEdge(START, 'preprocess')
    .addEdge('preprocess', 'intent')
    .addEdge('intent', 'entities')
    .addEdge('entities', 'planner')
    .addEdge('planner', 'router')
    .addEdge('router', 'prepare_context')
    .addEdge('prepare_context', 'execute')
    .addEdge('execute', 'finalize')
    .addEdge('finalize', END);

  compiledGraph = graph.compile();
  return compiledGraph;
}

/**
 * Run the optional LangGraph pipeline. Returns the same shape as runBrsrPipeline.
 */
export async function runLangGraphPipeline({
  userMessage,
  chatHistory = [],
  sessionId = null,
  onProgress = null,
} = {}) {
  const app = await getBrsrLangGraph();
  const finalState = await app.invoke({
    ctx: {
      userMessage,
      chatHistory,
      sessionId,
      onProgress,
      orchestrator: 'langgraph',
    },
  });

  const result = finalState?.ctx?.result;
  if (!result) {
    throw new Error('LangGraph pipeline produced no result');
  }
  return {
    ...result,
    orchestrator: 'langgraph',
    stages: finalState?.ctx?.stages || result.stages,
  };
}

export { isLangGraphEnabled };

/**
 * Phase 15 — LangGraph is optional orchestration only.
 *
 * Default: off (imperative Intent→Plan→Route→Execute pipeline).
 * Enable with USE_LANGGRAPH=true after `npm i` (optionalDependency).
 *
 * LangGraph must not replace SQL templates, validators, or DB logic.
 */

export function isLangGraphEnabled() {
  const flag = process.env.USE_LANGGRAPH;
  return flag === '1' || /^true$/i.test(flag || '');
}

export function langgraphStatus() {
  return {
    enabled: isLangGraphEnabled(),
    env: process.env.USE_LANGGRAPH || null,
    note: 'When enabled, @langchain/langgraph orchestrates existing pipeline stages only.',
  };
}

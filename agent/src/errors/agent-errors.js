/**
 * Normalized error handling for BRSR agent / API.
 */

export class AgentError extends Error {
  constructor(code, message, { status = 500, retryable = false, details = null } = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

/** Stable error codes used in traces / monitoring. */
export const ERROR_CODES = Object.freeze({
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  DB_FAILURE: 'DB_FAILURE',
  UNKNOWN: 'UNKNOWN',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  ENGINE_FAILURE: 'ENGINE_FAILURE',
  CLARIFICATION: 'CLARIFICATION',
});

export function mapProviderError(err) {
  if (err instanceof AgentError) return err;
  const msg = String(err?.message || err || '');
  if (/rate limit|429/i.test(msg)) {
    return new AgentError(ERROR_CODES.RATE_LIMIT, 'The AI provider rate-limited this request. Please retry shortly.', {
      status: 429,
      retryable: true,
      details: msg,
    });
  }
  if (/timeout|ETIMEDOUT|aborted|_timeout_/i.test(msg)) {
    return new AgentError(ERROR_CODES.TIMEOUT, 'The request timed out while querying BRSR data or the model.', {
      status: 504,
      retryable: true,
      details: msg,
    });
  }
  if (/Failed to connect to LLM|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
    return new AgentError(ERROR_CODES.LLM_UNAVAILABLE, 'The language model provider is unavailable.', {
      status: 503,
      retryable: true,
      details: msg,
    });
  }
  if (/no such table|database|SQLITE|postgres/i.test(msg)) {
    return new AgentError(ERROR_CODES.DB_FAILURE, 'The BRSR database could not be queried.', {
      status: 500,
      retryable: false,
      details: msg,
    });
  }
  return new AgentError(ERROR_CODES.UNKNOWN, msg || 'Unexpected agent error', { status: 500, retryable: false });
}

/**
 * Map any thrown value / engine error string to a stable code for traces.
 */
export function toErrorCode(err, { validation = null, clarification = false } = {}) {
  if (clarification) return ERROR_CODES.CLARIFICATION;
  if (validation?.verdict === 'ERROR' || validation?.ok === false) {
    return ERROR_CODES.VALIDATION_FAILED;
  }
  if (err instanceof AgentError) return err.code;
  const msg = String(err?.message || err?.error || err || '');
  if (!msg || msg === 'null' || msg === 'undefined') return null;
  if (/_not_required$/i.test(msg)) return null; // soft skip, not a failure
  if (/_timeout_|timeout/i.test(msg)) return ERROR_CODES.TIMEOUT;
  if (/unknown_engine|engine/i.test(msg)) return ERROR_CODES.ENGINE_FAILURE;
  const mapped = mapProviderError(err?.message != null ? err : new Error(msg));
  if (mapped.code !== ERROR_CODES.UNKNOWN) return mapped.code;
  return ERROR_CODES.ENGINE_FAILURE;
}

export function userFacingErrorMessage(err) {
  if (err instanceof AgentError) return err.message;
  const mapped = mapProviderError(err);
  return mapped.message;
}

export function emptySearchMessage({ company = null, sector = null } = {}) {
  if (company) return `No BRSR report matched **${company}** in the indexed database.`;
  if (sector) return `No companies found for sector **${sector}** in the BRSR reports table.`;
  return 'No matching BRSR records were found for that request.';
}

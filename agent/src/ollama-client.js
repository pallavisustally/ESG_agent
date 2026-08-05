import dotenv from 'dotenv';

dotenv.config();

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 3;

function useOpenAI() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function useOpenRouter() {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

function isOpenRouterModelName(model) {
  return typeof model === 'string' && model.includes('/');
}

function resolveOpenAIModel(requestedModel) {
  // Fixed production model: always use OPENAI_MODEL from env (ignore client overrides).
  const envModel = process.env.OPENAI_MODEL?.trim();
  if (envModel) return envModel;
  // Only fall back to a requested name if env is unset (local experimentation).
  if (requestedModel && !isOpenRouterModelName(requestedModel)) return requestedModel;
  return 'gpt-4o-mini';
}

function resolveOpenRouterModel(requestedModel) {
  const envModel = process.env.OPENROUTER_MODEL?.trim();
  if (requestedModel && isOpenRouterModelName(requestedModel)) return requestedModel;
  if (envModel) return envModel;
  return 'openai/gpt-4o-mini';
}

function getOpenRouterFallbackModels(primaryModel) {
  const fromEnv = process.env.OPENROUTER_FALLBACK_MODELS?.split(',')
    .map((m) => m.trim())
    .filter(Boolean) ?? [];

  const defaults = ['openai/gpt-4o-mini', 'meta-llama/llama-3.1-8b-instruct', 'qwen/qwen-2.5-7b-instruct'];

  return [...new Set([primaryModel, ...fromEnv, ...defaults])].slice(0, 3);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getOllamaConfig(overrides = {}) {
  const toolPredict = parseInt(process.env.OLLAMA_NUM_PREDICT, 10) || 1024;
  // Longer budget for final synthesis (Week 4 fluency) — does not apply to tool-call turns unless forced.
  const finalPredict = parseInt(process.env.AGENT_FINAL_NUM_PREDICT, 10)
    || parseInt(process.env.OLLAMA_NUM_PREDICT_FINAL, 10)
    || Math.max(toolPredict, 2048);
  const useFinalBudget = Boolean(overrides.finalAnswer);
  const cloudOptions = {
    keepAlive: process.env.OLLAMA_KEEP_ALIVE || '30m',
    options: {
      num_ctx: parseInt(process.env.OLLAMA_NUM_CTX, 10) || 8192,
      num_predict: useFinalBudget ? finalPredict : toolPredict,
      temperature: parseFloat(process.env.OLLAMA_TEMPERATURE) || 0.2,
    },
    finalNumPredict: finalPredict,
    timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 90000,
  };

  if (useOpenAI()) {
    const model = resolveOpenAIModel(overrides.modelName);
    return {
      model,
      host: null,
      provider: 'openai',
      fallbackModels: [],
      ...cloudOptions,
    };
  }

  if (useOpenRouter()) {
    const model = resolveOpenRouterModel(overrides.modelName);
    const explicitModel = overrides.modelName && isOpenRouterModelName(overrides.modelName);
    return {
      model,
      host: null,
      provider: 'openrouter',
      fallbackModels: explicitModel ? [model] : getOpenRouterFallbackModels(model),
      ...cloudOptions,
    };
  }

  return {
    model: overrides.modelName || process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct',
    host: (overrides.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, ''),
    provider: 'ollama',
    fallbackModels: [],
    keepAlive: process.env.OLLAMA_KEEP_ALIVE || '30m',
    options: {
      num_ctx: parseInt(process.env.OLLAMA_NUM_CTX, 10) || 8192,
      num_predict: toolPredict,
      temperature: parseFloat(process.env.OLLAMA_TEMPERATURE) || 0.2,
    },
    finalNumPredict: finalPredict,
    timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 90000,
  };
}

function toOpenRouterMessages(messages) {
  return messages.map((msg) => {
    const out = { role: msg.role, content: msg.content ?? '' };
    if (msg.tool_calls?.length) {
      out.tool_calls = msg.tool_calls;
      if (!out.content) out.content = null;
    }
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    if (msg.name) out.name = msg.name;
    return out;
  });
}

/** OpenAI requires every assistant tool_call_id to have a matching tool response. */
function sanitizeToolCallPairing(messages) {
  const out = [...messages];
  const insertions = [];

  for (let i = 0; i < out.length; i += 1) {
    const msg = out[i];
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;

    const ids = msg.tool_calls.map((tc) => tc.id).filter(Boolean);
    if (!ids.length) continue;

    const responded = new Set();
    for (let j = i + 1; j < out.length; j += 1) {
      const next = out[j];
      if (next.role === 'tool' && next.tool_call_id) responded.add(next.tool_call_id);
      else if (next.role === 'assistant' || next.role === 'user') break;
    }

    const stubs = ids
      .filter((id) => !responded.has(id))
      .map((id) => ({
        role: 'tool',
        tool_call_id: id,
        content: JSON.stringify({ error: 'Tool call was deduplicated or skipped.' }),
      }));

    if (stubs.length) insertions.push({ index: i + 1, stubs });
  }

  for (const { index, stubs } of insertions.sort((a, b) => b.index - a.index)) {
    out.splice(index, 0, ...stubs);
  }

  return out;
}

function dedupeToolCalls(toolCalls = []) {
  const seen = new Set();
  const unique = [];

  for (const call of toolCalls) {
    const args = typeof call.function?.arguments === 'string'
      ? call.function.arguments
      : JSON.stringify(call.function?.arguments ?? {});
    const key = `${call.function?.name}:${args}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(call);
  }

  return unique;
}

function mergeStreamingToolCalls(accumulated, deltaCalls) {
  if (!deltaCalls?.length) return accumulated;

  const next = [...(accumulated ?? [])];
  for (const delta of deltaCalls) {
    const index = delta.index ?? next.length;
    if (!next[index]) {
      next[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    }
    if (delta.id) next[index].id = delta.id;
    if (delta.type) next[index].type = delta.type;
    if (delta.function?.name) next[index].function.name += delta.function.name;
    if (delta.function?.arguments) next[index].function.arguments += delta.function.arguments;
  }
  return next;
}

function formatApiError(provider, status, errText) {
  let detail = errText;
  try {
    const parsed = JSON.parse(errText);
    detail = parsed?.error?.metadata?.raw || parsed?.error?.message || errText;
  } catch {
    // keep raw text
  }

  if (status === 429) {
    const modelHint = provider === 'OpenAI'
      ? 'set OPENAI_MODEL to another model in .env.'
      : 'set OPENROUTER_MODEL to another model in .env.';
    return `${provider} rate limit reached. Wait a moment and retry, or ${modelHint} ${detail}`;
  }
  return `${provider} returned HTTP ${status}: ${detail}`;
}

function formatOpenRouterError(status, errText) {
  return formatApiError('OpenRouter', status, errText);
}

function formatOpenAIError(status, errText) {
  return formatApiError('OpenAI', status, errText);
}

async function fetchOpenRouterResponse(body, signal) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.');

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
        'X-OpenRouter-Title': process.env.OPENROUTER_APP_NAME || 'SusTally BRSR Agent',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (response.ok) return response;

    const errText = await response.text();
    lastError = new Error(formatOpenRouterError(response.status, errText));

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_RETRIES) {
      throw lastError;
    }

    const delayMs = Math.min(1000 * (2 ** attempt), 8000);
    console.warn(`OpenRouter ${response.status} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delayMs);
  }

  throw lastError ?? new Error('OpenRouter request failed.');
}

async function fetchOpenAIResponse(body, signal) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set.');

  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (response.ok) return response;

    const errText = await response.text();
    lastError = new Error(formatOpenAIError(response.status, errText));

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_RETRIES) {
      throw lastError;
    }

    const delayMs = Math.min(1000 * (2 ** attempt), 8000);
    console.warn(`OpenAI ${response.status} — retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
    await sleep(delayMs);
  }

  throw lastError ?? new Error('OpenAI request failed.');
}

async function callCompatibleChat({ fetchResponse, providerName, model, fallbackModels = [], messages, tools, options, stream, onToken, signal }) {
  const body = {
    model,
    messages: toOpenRouterMessages(sanitizeToolCallPairing(messages)),
    stream: Boolean(stream),
    temperature: options?.temperature,
    max_tokens: options?.num_predict,
  };

  if (fallbackModels.length > 1) {
    body.models = fallbackModels.slice(0, 3);
    body.route = 'fallback';
  }

  if (tools?.length) body.tools = tools;

  const response = await fetchResponse(body, signal);

  if (!stream) {
    const result = await response.json();
    const choice = result.choices?.[0];
    if (!choice?.message) {
      throw new Error(`${providerName} returned an empty response.`);
    }
    const message = { ...choice.message };
    if (!message.tool_calls?.length) delete message.tool_calls;
    return message;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const message = { role: 'assistant', content: '', tool_calls: undefined };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      let chunk;
      try {
        chunk = JSON.parse(trimmed.slice(6));
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        message.content += delta.content;
        onToken?.(delta.content);
      }
      if (delta.tool_calls) {
        message.tool_calls = mergeStreamingToolCalls(message.tool_calls, delta.tool_calls);
      }
    }
  }

  if (!message.tool_calls?.length) delete message.tool_calls;
  return message;
}

async function callOpenAIChat(params) {
  return callCompatibleChat({
    ...params,
    fetchResponse: fetchOpenAIResponse,
    providerName: 'OpenAI',
    fallbackModels: [],
  });
}

async function callOpenRouterChat(params) {
  return callCompatibleChat({
    ...params,
    fetchResponse: fetchOpenRouterResponse,
    providerName: 'OpenRouter',
  });
}

/**
 * Call Ollama /api/chat with optional streaming.
 * When OPENAI_API_KEY or OPENROUTER_API_KEY is set, routes to that cloud provider (local Ollama is not used).
 */
export async function callOllamaChat({ url, model, fallbackModels = [], messages, tools, options, keepAlive, stream, onToken, signal }) {
  if (useOpenAI()) {
    return callOpenAIChat({ model, fallbackModels, messages, tools, options, stream, onToken, signal });
  }

  if (useOpenRouter()) {
    return callOpenRouterChat({ model, fallbackModels, messages, tools, options, stream, onToken, signal });
  }

  const body = {
    model,
    messages,
    stream: Boolean(stream),
    keep_alive: keepAlive,
    options,
  };
  if (tools?.length) body.tools = tools;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama returned HTTP ${response.status}: ${errText}`);
  }

  if (!stream) {
    const result = await response.json();
    return result.message ?? { role: 'assistant', content: '' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const message = { role: 'assistant', content: '', tool_calls: undefined };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }

      const part = chunk.message;
      if (part?.content) {
        message.content += part.content;
        onToken?.(part.content);
      }
      if (part?.tool_calls?.length) {
        message.tool_calls = part.tool_calls;
      }
      if (chunk.done && chunk.message) {
        if (chunk.message.content) message.content = chunk.message.content;
        if (chunk.message.tool_calls) message.tool_calls = chunk.message.tool_calls;
      }
    }
  }

  if (!message.tool_calls?.length) delete message.tool_calls;
  return message;
}

/** Optional warm-up — disabled for cloud providers by default to avoid extra API calls. */
export async function warmOllamaModel(config = getOllamaConfig()) {
  if (useOpenAI()) {
    if (process.env.OPENAI_WARMUP !== 'true') {
      console.log(`OpenAI ready (model: ${config.model}, no warm-up)`);
      return;
    }

    try {
      await callOpenAIChat({
        model: config.model,
        messages: [{ role: 'user', content: 'hi' }],
        options: { ...config.options, num_predict: 1 },
        stream: false,
        signal: AbortSignal.timeout(120000),
      });
      console.log(`OpenAI model warmed: ${config.model}`);
    } catch (err) {
      console.warn(`OpenAI warm-up skipped: ${err.message}`);
    }
    return;
  }

  if (useOpenRouter()) {
    if (process.env.OPENROUTER_WARMUP !== 'true') {
      console.log(`OpenRouter ready (model: ${config.model}, no warm-up)`);
      return;
    }

    try {
      await callOpenRouterChat({
        model: config.model,
        fallbackModels: config.fallbackModels,
        messages: [{ role: 'user', content: 'hi' }],
        options: { ...config.options, num_predict: 1 },
        stream: false,
        signal: AbortSignal.timeout(120000),
      });
      console.log(`OpenRouter model warmed: ${config.model}`);
    } catch (err) {
      console.warn(`OpenRouter warm-up skipped: ${err.message}`);
    }
    return;
  }

  const url = `${config.host}/api/chat`;
  try {
    await callOllamaChat({
      url,
      model: config.model,
      messages: [{ role: 'user', content: 'hi' }],
      options: { ...config.options, num_predict: 1 },
      keepAlive: config.keepAlive,
      stream: false,
      signal: AbortSignal.timeout(120000),
    });
    console.log(`Ollama model warmed: ${config.model}`);
  } catch (err) {
    console.warn(`Ollama warm-up skipped: ${err.message}`);
  }
}

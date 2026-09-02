import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyMemory,
  hydrateMemoryFromChatHistory,
  mergeMemoryLayers,
  memoryHasFollowUpSlots,
  serializeMemoryForStorage,
  memoryFromStorage,
} from './conversation-memory.js';
import { extractAnswerCitations } from '../answers/citations.js';
import { composeCapabilityResults } from '../capability/response-composer.js';
import { CAPABILITIES } from '../capability/capabilities.js';

describe('hydrateMemoryFromChatHistory', () => {
  it('rebuilds company, metric, and year from prior user turns', () => {
    const memory = hydrateMemoryFromChatHistory([
      { role: 'user', content: 'Infosys Scope 1 emissions in 2024' },
      { role: 'assistant', content: 'I found Scope 1 for Infosys.' },
    ]);
    assert.ok(memoryHasFollowUpSlots(memory));
    assert.ok(memory.lastCompanies.some((c) => /infosys/i.test(c)));
    assert.equal(memory.lastMetric, 'scope1_emissions');
    assert.equal(memory.lastYear, 2024);
  });

  it('uses latest user turn for year follow-ups', () => {
    const memory = hydrateMemoryFromChatHistory([
      { role: 'user', content: 'TCS Scope 2 in 2023' },
      { role: 'assistant', content: 'Here is TCS Scope 2.' },
      { role: 'user', content: 'how about 2024' },
    ]);
    assert.ok(memory.lastCompanies.some((c) => /tcs/i.test(c)));
    assert.equal(memory.lastYear, 2024);
  });
});

describe('mergeMemoryLayers', () => {
  it('prefers stored slots on cold start when live map is empty', () => {
    const stored = serializeMemoryForStorage({
      ...createEmptyMemory(),
      lastCompanies: ['Wipro Limited'],
      lastMetric: 'scope1_emissions',
      lastYear: 2025,
      updatedAt: 50,
    });
    const merged = mergeMemoryLayers({
      stored,
      live: createEmptyMemory(),
      chatHistory: [{ role: 'user', content: 'and Scope 2?' }],
    });
    assert.deepEqual(merged.lastCompanies, ['Wipro Limited']);
    assert.equal(merged.lastMetric, 'scope1_emissions');
  });

  it('round-trips memory JSON', () => {
    const src = {
      ...createEmptyMemory(),
      lastCompanies: ['Infosys Limited'],
      lastMetric: 'water_consumption',
      lastYear: 2024,
    };
    const again = memoryFromStorage(JSON.stringify(serializeMemoryForStorage(src)));
    assert.deepEqual(again.lastCompanies, ['Infosys Limited']);
    assert.equal(again.lastMetric, 'water_consumption');
    assert.equal(again.lastYear, 2024);
  });
});

describe('extractAnswerCitations', () => {
  it('pulls markdown source links and page numbers', () => {
    const citations = extractAnswerCitations(
      'See [source p.42](https://example.com/tcs.pdf#page=42) and [filing](https://example.com/tcs.pdf#page=42).',
    );
    assert.equal(citations.length, 1);
    assert.equal(citations[0].page, 42);
    assert.match(citations[0].url, /tcs\.pdf/);
  });
});

describe('response composer one writer', () => {
  it('does not join hybrid answers with horizontal rules', () => {
    const out = composeCapabilityResults([
      { capability: CAPABILITIES.COMPANY_ANALYTICS, text: '### Infosys\n\nScope 1: 1000 tCO2e' },
      { capability: CAPABILITIES.RECOMMENDATION, text: '### Recommendations\n\n1. Increase renewables' },
    ]);
    assert.doesNotMatch(out.text, /\n---\n/);
    assert.match(out.text, /combined view/i);
    assert.match(out.text, /Scope 1/);
    assert.match(out.text, /Increase renewables/);
  });
});

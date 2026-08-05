/**
 * Phase 6 — Framework registry tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTRY,
  lookupRegistry,
  getRegistryEntry,
  formatRegistryAnswer,
  useFrameworkRegistry,
} from './framework-registry.js';
import { buildComplianceAnswer } from '../capability/compliance-engine.js';
import { buildKnowledgeAnswer, lookupKnowledge } from '../capability/knowledge-engine.js';
import { isComplianceQuestion } from '../capability/capability-planner.js';

describe('framework-registry', () => {
  it('is enabled by default', () => {
    assert.equal(useFrameworkRegistry(), true);
  });

  it('has unique ids and required fields', () => {
    const ids = new Set();
    for (const e of REGISTRY) {
      assert.ok(e.id && e.family && e.kind && e.title && e.body && e.match);
      assert.equal(ids.has(e.id), false, `duplicate id ${e.id}`);
      ids.add(e.id);
    }
    assert.ok(ids.size >= 20);
  });

  it('looks up frameworks and concepts', () => {
    assert.equal(lookupRegistry('Explain GRI 305', { kind: 'framework' })?.id, 'gri-305');
    assert.equal(lookupRegistry('What is ISSB?', { kind: 'framework' })?.id, 'issb');
    assert.equal(lookupRegistry('What is IFRS S2?', { kind: 'framework' })?.id, 'issb');
    assert.equal(lookupRegistry('What is Scope 1?', { kind: 'concept' })?.id, 'scope-1');
    assert.equal(lookupRegistry('What is BRSR?', { knowledgeSurface: true })?.id, 'brsr');
  });

  it('resolves related ids', () => {
    const gri = getRegistryEntry('gri-305');
    assert.ok(gri.related.includes('brsr-p6') || gri.related.includes('gri'));
  });

  it('formats citations when present', () => {
    const issb = getRegistryEntry('issb');
    const text = formatRegistryAnswer(issb);
    assert.match(text, /Sources/i);
    assert.match(text, /ifrs\.org/i);
    assert.match(text, /Also see/i);
  });
});

describe('registry-backed engines', () => {
  it('compliance answers GRI 305 with registry content', () => {
    const text = buildComplianceAnswer('Explain GRI 305');
    assert.match(text, /GRI 305/i);
    assert.match(text, /Scope 1/i);
    assert.match(text, /compliance \/ framework/i);
  });

  it('knowledge answers ESG and BRSR without routing BRSR to compliance', () => {
    assert.equal(isComplianceQuestion('What is BRSR?'), false);
    assert.equal(isComplianceQuestion('What is CDP?'), true);
    assert.equal(isComplianceQuestion('What is NGRBC?'), true);

    const esg = buildKnowledgeAnswer('What is ESG?');
    assert.match(esg, /Environmental, Social, and Governance/i);

    const brsr = buildKnowledgeAnswer('What is BRSR?');
    assert.match(brsr, /SEBI/i);
    assert.match(brsr, /Also see/i);

    const hit = lookupKnowledge('What is Net Zero?');
    assert.equal(hit.known, true);
    assert.equal(hit.source, 'registry');
  });

  it('crosswalk: ISSB mentions BRSR/TCFD related', () => {
    const text = buildComplianceAnswer('What is ISSB?');
    assert.match(text, /IFRS S2/i);
    assert.match(text, /Also see/i);
  });
});

/**
 * Phase 5 — Recommendation grounding + answer tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRecommendationGrounding,
  factsFromAnalyticsData,
  attachSectorBenchmarks,
  groundedLeverFromFact,
  formatFactsSummary,
  GENERAL_GUIDANCE_BANNER,
} from './recommendation-grounding.js';
import { buildRecommendationAnswer } from './recommendation-engine.js';

describe('recommendation-grounding', () => {
  it('extracts facts from single-company analytics lookup', () => {
    const facts = factsFromAnalyticsData({
      resolvedCompany: 'Infosys Limited',
      metric: 'scope1_emissions',
      value: 12000,
      year: 2024,
    }, { companies: ['Infosys Limited'], metric: 'scope1_emissions' });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].companyValue, 12000);
    assert.equal(facts[0].topic, 'carbon');
  });

  it('attaches sector benchmarks and direction', () => {
    const facts = factsFromAnalyticsData({
      resolvedCompany: 'Infosys Limited',
      metric: 'scope1_emissions',
      value: 20000,
      year: 2024,
    });
    const withSector = attachSectorBenchmarks(facts, {
      sector: 'Technology',
      avg: 10000,
      metric: 'scope1_emissions',
    });
    assert.equal(withSector[0].benchmarkType, 'sector_avg');
    assert.equal(withSector[0].direction, 'above');
    assert.match(groundedLeverFromFact(withSector[0]), /Technology average/i);
  });

  it('buildRecommendationGrounding marks companySpecific', () => {
    const g = buildRecommendationGrounding({
      analyticsData: {
        rows: [
          { company: 'Infosys Limited', metric_value: 10, year: 2024 },
          { company: 'Wipro Limited', metric_value: 20, year: 2024 },
        ],
        metric: 'scope1_emissions',
        year: 2024,
      },
      companies: ['Infosys Limited', 'Wipro Limited'],
      metric: 'scope1_emissions',
    });
    assert.equal(g.companySpecific, true);
    assert.ok(g.facts.length >= 1);
    assert.ok(formatFactsSummary(g.facts));
  });

  it('returns empty grounding without analytics', () => {
    const g = buildRecommendationGrounding({
      companies: ['Infosys Limited'],
      metric: 'scope1_emissions',
    });
    assert.equal(g.companySpecific, false);
    assert.equal(g.facts.length, 0);
  });
});

describe('recommendation-engine answer', () => {
  it('shows general guidance banner when no verified data', async () => {
    const built = await buildRecommendationAnswer(
      'How can Infosys improve ESG?',
      {
        companies: ['Infosys Limited'],
        metric: null,
        analyticsData: null,
        fetchSector: false,
      },
    );
    assert.match(built.text, /general sustainability best practice/i);
    assert.ok(built.assumptions.some((a) => /general/i.test(a)));
    assert.equal(built.grounding.companySpecific, false);
  });

  it('grounds levers when analytics values exist', async () => {
    const built = await buildRecommendationAnswer(
      'Recommend improvements for Infosys Scope 1',
      {
        companies: ['Infosys Limited'],
        metric: 'scope1_emissions',
        analyticsData: {
          resolvedCompany: 'Infosys Limited',
          metric: 'scope1_emissions',
          value: 15000,
          year: 2024,
        },
        sectorData: {
          sector: 'Technology',
          avg: 8000,
          metric: 'scope1_emissions',
          year: 2024,
        },
        fetchSector: false,
      },
    );
    assert.match(built.text, /Verified BRSR figures/i);
    assert.match(built.text, /15,000|15000/);
    assert.doesNotMatch(built.text, new RegExp(GENERAL_GUIDANCE_BANNER.slice(0, 40)));
    assert.equal(built.grounding.companySpecific, true);
  });
});

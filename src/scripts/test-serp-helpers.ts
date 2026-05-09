/**
 * Sprint 18 unit tests for the SERP rendering helpers.
 *
 * Pure-function tests : take a fixture EnrichedTopQuery[] and assert the
 * markdown shape of fmtSerpCompetitiveLandscape (diagnostic v10) and
 * fmtSerpTop3ForFixGen (fix-gen v3 with SERP).
 *
 * Run with: npm run test:serp
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtSerpCompetitiveLandscape } from '../prompts/diagnostic.v1.js';
import { fmtSerpTop3ForFixGen } from '../prompts/fix-generation.v1.js';
import type { EnrichedTopQuery } from '../pipeline/context-enrichment.js';
import type { SerpSnapshot } from '../lib/dataforseo.js';

const baseQuery: EnrichedTopQuery = {
  query: 'durée garde à vue',
  impressions: 1200,
  ctr: 0.045,
  position: 4.5,
  monthly_volume_fr: 880,
  cpc: 1.2,
  share_of_voice_pct: 45.5,
};

const sampleSerp: SerpSnapshot = {
  keyword: 'durée garde à vue',
  organic: [
    {
      type: 'organic',
      rank_group: 1,
      rank_absolute: 1,
      title: 'Garde à vue : règles, durée, droits',
      url: 'https://www.service-public.fr/particuliers/...',
      domain: 'service-public.fr',
      description: 'La garde à vue est une mesure privative de liberté, prise par un officier de police judiciaire, qui peut durer 24 heures...',
    },
    {
      type: 'organic',
      rank_group: 2,
      rank_absolute: 3,
      title: 'Garde à vue — Wikipédia',
      url: 'https://fr.wikipedia.org/wiki/Garde_%C3%A0_vue',
      domain: 'fr.wikipedia.org',
      description: 'En France, la garde à vue est une mesure de privation de liberté ordonnée par un officier de police judiciaire...',
    },
    {
      type: 'organic',
      rank_group: 3,
      rank_absolute: 4,
      title: 'Tout savoir sur la garde à vue — Cabinet X',
      url: 'https://www.cabinet-x.fr/garde-a-vue',
      domain: 'cabinet-x.fr',
      description: 'Notre cabinet vous accompagne lors de votre garde à vue...',
    },
  ],
  features: {
    has_ai_overview: false,
    has_featured_snippet: true,
    has_people_also_ask: true,
    has_knowledge_graph: false,
    has_local_pack: false,
    has_video: false,
  },
  fetched_at: '2026-05-10T12:00:00Z',
};

// ============================================================================
// fmtSerpCompetitiveLandscape (diagnostic v10)
// ============================================================================

test('fmtSerpCompetitiveLandscape: empty rows → "indisponible" message', () => {
  const out = fmtSerpCompetitiveLandscape([]);
  assert.match(out, /SERP indisponible/);
});

test('fmtSerpCompetitiveLandscape: rows without serp field → "indisponible"', () => {
  const out = fmtSerpCompetitiveLandscape([baseQuery]);
  assert.match(out, /SERP indisponible/);
});

test('fmtSerpCompetitiveLandscape: rows with empty organic → skipped', () => {
  const emptySerp: SerpSnapshot = { ...sampleSerp, organic: [] };
  const out = fmtSerpCompetitiveLandscape([{ ...baseQuery, serp: emptySerp }]);
  assert.match(out, /SERP indisponible/);
});

test('fmtSerpCompetitiveLandscape: 1 query with 3 organic + 2 features → renders table + feature badges', () => {
  const out = fmtSerpCompetitiveLandscape([{ ...baseQuery, serp: sampleSerp }]);
  // Section header
  assert.match(out, /### "durée garde à vue"/);
  // Feature badges (Featured Snippet + PAA, no AI Overview)
  assert.match(out, /📌 Featured Snippet/);
  assert.match(out, /❓ People Also Ask/);
  assert.doesNotMatch(out, /🤖 AI Overview/);
  // Table header
  assert.match(out, /\| pos \| domaine \| title \| snippet \|/);
  // Top 1 = service-public.fr
  assert.match(out, /\| 1 \| service-public\.fr \| Garde à vue : règles, durée, droits \|/);
  // Top 2 = wikipedia (rank_group=2)
  assert.match(out, /\| 2 \| fr\.wikipedia\.org \|/);
  // Top 3 = cabinet-x
  assert.match(out, /\| 3 \| cabinet-x\.fr \|/);
});

test('fmtSerpCompetitiveLandscape: snippet truncated to 100 chars', () => {
  const longDescSerp: SerpSnapshot = {
    ...sampleSerp,
    organic: [{
      ...sampleSerp.organic[0]!,
      description: 'a'.repeat(200),
    }],
  };
  const out = fmtSerpCompetitiveLandscape([{ ...baseQuery, serp: longDescSerp }]);
  // The snippet cell should not contain >100 'a' chars
  const match = out.match(/\| (a+) \|/);
  assert.ok(match, 'should find the truncated snippet cell');
  assert.equal(match![1]!.length, 100, `snippet should be 100 chars, got ${match![1]!.length}`);
});

test('fmtSerpCompetitiveLandscape: AI Overview badge appears when feature present', () => {
  const aiSerp: SerpSnapshot = {
    ...sampleSerp,
    features: { ...sampleSerp.features, has_ai_overview: true },
  };
  const out = fmtSerpCompetitiveLandscape([{ ...baseQuery, serp: aiSerp }]);
  assert.match(out, /🤖 AI Overview/);
});

test('fmtSerpCompetitiveLandscape: 2 queries → 2 sections separated by blank line', () => {
  const q2 = { ...baseQuery, query: '24h garde à vue', serp: sampleSerp };
  const out = fmtSerpCompetitiveLandscape([{ ...baseQuery, serp: sampleSerp }, q2]);
  // Both sections present
  assert.match(out, /### "durée garde à vue"/);
  assert.match(out, /### "24h garde à vue"/);
  // Separated by \n\n (blank line between markdown sections)
  assert.match(out, /\n\n### /);
});

// ============================================================================
// fmtSerpTop3ForFixGen (fix-gen)
// ============================================================================

test('fmtSerpTop3ForFixGen: empty → "indisponible"', () => {
  assert.match(fmtSerpTop3ForFixGen([]), /SERP indisponible/);
  assert.match(fmtSerpTop3ForFixGen([baseQuery]), /SERP indisponible/);
});

test('fmtSerpTop3ForFixGen: 1 query with 3 organic → top 3 listed compact + feature badges', () => {
  const out = fmtSerpTop3ForFixGen([{ ...baseQuery, serp: sampleSerp }]);
  assert.match(out, /\*\*"durée garde à vue"\*\*/);
  // Compact feature badges (FS + PAA, no AI)
  assert.match(out, /\[📌FS·❓PAA\]/);
  // Top 3 lines
  assert.match(out, /1\. \*\*service-public\.fr\*\*/);
  assert.match(out, /2\. \*\*fr\.wikipedia\.org\*\*/);
  assert.match(out, /3\. \*\*cabinet-x\.fr\*\*/);
});

test('fmtSerpTop3ForFixGen: only top 3 even if SERP has more', () => {
  const sixOrganic = {
    ...sampleSerp,
    organic: [
      ...sampleSerp.organic,
      { ...sampleSerp.organic[0]!, domain: 'd4.com', rank_group: 4 },
      { ...sampleSerp.organic[0]!, domain: 'd5.com', rank_group: 5 },
      { ...sampleSerp.organic[0]!, domain: 'd6.com', rank_group: 6 },
    ],
  };
  const out = fmtSerpTop3ForFixGen([{ ...baseQuery, serp: sixOrganic }]);
  assert.doesNotMatch(out, /d4\.com/);
  assert.doesNotMatch(out, /d5\.com/);
  assert.doesNotMatch(out, /d6\.com/);
});

test('fmtSerpTop3ForFixGen: title truncated to 70 chars', () => {
  const longTitle: SerpSnapshot = {
    ...sampleSerp,
    organic: [
      { ...sampleSerp.organic[0]!, title: 't'.repeat(150) },
      sampleSerp.organic[1]!,
      sampleSerp.organic[2]!,
    ],
  };
  const out = fmtSerpTop3ForFixGen([{ ...baseQuery, serp: longTitle }]);
  // Find the truncated title in quotes
  const match = out.match(/"(t+)"/);
  assert.ok(match, 'should find the truncated title');
  assert.equal(match![1]!.length, 70, `title should be 70 chars, got ${match![1]!.length}`);
});

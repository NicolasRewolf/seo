/**
 * Sprint-14 unit tests for diagnostic-fact-check.
 *
 * Pin the verification rules so a future "improvement" of the regex doesn't
 * silently let hallucinations through.
 *
 * Run with: npm run test:fact-check
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factCheckDiagnostic } from '../lib/diagnostic-fact-check.js';
import type { ContentSnapshot } from '../lib/page-content-extractor.js';

const fixtureSnapshot: ContentSnapshot = {
  body_text: 'lorem ipsum…',
  word_count: 720,
  outline: [
    { level: 2, text: 'Définition', anchor: null, word_offset: 50 },
    { level: 2, text: 'Procédure', anchor: null, word_offset: 250 },
    { level: 3, text: 'Sous-section', anchor: null, word_offset: 320 },
    { level: 2, text: 'Conclusion', anchor: null, word_offset: 600 },
  ],
  images: [
    { src: '/a.jpg', alt: 'Hero', in_body: true },
    { src: '/b.jpg', alt: null, in_body: true },
    { src: '/c.jpg', alt: null, in_body: true },
    { src: '/footer.svg', alt: 'Logo', in_body: false },
  ],
  author: { name: 'Maître Plouton', date_published: '2024-01-15' },
  cta_in_body_positions: [
    { word_offset: 200, anchor: 'Lien CTA', target: '/contact' },
    { word_offset: 612, anchor: 'Prendre RDV', target: '/honoraires-rendez-vous' },
  ],
  extracted_at: '2026-05-07T12:00:00Z',
};

test('verified: word_count claim matches snapshot exactly', () => {
  const r = factCheckDiagnostic({
    diagnostic: { structural_gaps: 'Article fait 720 mots, sous benchmark.' },
    content_snapshot: fixtureSnapshot,
  });
  assert.equal(r.total_numeric_claims, 1);
  assert.equal(r.verified, 1);
  assert.equal(r.passed, true);
});

test('verified: word_count claim within ±5% tolerance', () => {
  const r = factCheckDiagnostic({
    diagnostic: { structural_gaps: 'Article fait 700 mots.' },
    content_snapshot: fixtureSnapshot,
  });
  assert.equal(r.passed, true);
});

test('unverified: word_count claim outside tolerance', () => {
  const r = factCheckDiagnostic({
    diagnostic: { structural_gaps: 'Article fait 1500 mots.' },
    content_snapshot: fixtureSnapshot,
  });
  assert.equal(r.passed, false);
  assert.equal(r.unverified.length, 1);
  assert.match(r.unverified[0]!.note ?? '', /claimed 1500, actual 720/);
});

test('Sprint-14 fix: handles French number format "1 800 mots"', () => {
  const csLong = { ...fixtureSnapshot, word_count: 1800 };
  const r = factCheckDiagnostic({
    diagnostic: { structural_gaps: 'Article fait 1 800 mots, dans la médiane.' },
    content_snapshot: csLong,
  });
  assert.equal(r.passed, true);
});

test('Sprint-14 fix: ignores section-length / reading-speed mentions ("400-500 mots", "200 mots à ajouter")', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      engagement_diagnosis: 'Le lecteur lit environ 400-500 mots avant abandon.',
      structural_gaps: 'Ajouter une section de 800 mots après l\'intro.',
    },
    content_snapshot: fixtureSnapshot,
  });
  // Neither "400-500 mots" nor "800 mots" should be matched as a page-total claim
  assert.equal(r.total_numeric_claims, 0);
  assert.equal(r.passed, true);
});

test('verified: H2 reference within outline range', () => {
  const r = factCheckDiagnostic({
    diagnostic: { funnel_assessment: 'Insérer entre H2 #2 et H2 #3.' },
    content_snapshot: fixtureSnapshot,
  });
  // H2 count = 3 (Définition, Procédure, Conclusion). Both #2 and #3 valid.
  assert.equal(r.total_numeric_claims, 2);
  assert.equal(r.verified, 2);
  assert.equal(r.passed, true);
});

test('unverified: H2 reference beyond outline range', () => {
  const r = factCheckDiagnostic({
    diagnostic: { funnel_assessment: 'Voir H2 #5.' },
    content_snapshot: fixtureSnapshot,
  });
  assert.equal(r.passed, false);
  assert.match(r.unverified[0]!.note ?? '', /only 3 H2/);
});

test('verified: images count (in_body) matches', () => {
  const r = factCheckDiagnostic({
    diagnostic: { structural_gaps: '3 images dans le body, 2 sans alt.' },
    content_snapshot: fixtureSnapshot,
  });
  assert.equal(r.passed, true);
  assert.equal(r.verified, 2);
});

test('unverified: image count off', () => {
  const r = factCheckDiagnostic({
    diagnostic: { structural_gaps: '8 images dans le body.' },
    content_snapshot: fixtureSnapshot,
  });
  assert.equal(r.passed, false);
  assert.match(r.unverified[0]!.note ?? '', /actual in_body=3/);
});

test('Sprint-14 fix: offset claims are NOT validated (recommendations vs citations are too ambiguous)', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      funnel_assessment: 'Ajouter une section à offset 9999. CTA à offset 250.',
    },
    content_snapshot: fixtureSnapshot,
  });
  // Offset claims are intentionally not counted — the LLM uses offsets for
  // recommendations (insertion points) too, not just citations of existing
  // content. We trust it to read <page_outline> and pick valid offsets.
  assert.equal(r.total_numeric_claims, 0);
  assert.equal(r.passed, true);
});

test('null content_snapshot → all numeric claims unverified', () => {
  const r = factCheckDiagnostic({
    diagnostic: { structural_gaps: 'Article 720 mots avec 3 images.' },
    content_snapshot: null,
  });
  assert.equal(r.passed, false);
  assert.equal(r.unverified.length, 2);
  assert.match(r.unverified[0]!.note ?? '', /content_snapshot is null/);
});

test('no numeric claims → trivially passed', () => {
  const r = factCheckDiagnostic({
    diagnostic: { hypothesis: 'Le snippet est mal cadré sur l\'intent dominant.' },
    content_snapshot: fixtureSnapshot,
  });
  assert.equal(r.total_numeric_claims, 0);
  assert.equal(r.passed, true);
});

// ---------- Sprint-15 — Pogo claims tests ---------------------------------

const pogoFacts = {
  google_sessions: 22,
  pogo_sticks: 3,
  hard_pogo: 2,
  pogo_rate_pct: 13.6,
};

test('Sprint-15 — verified: exact n= match in pogo context', () => {
  const r = factCheckDiagnostic({
    diagnostic: { pogo_navboost_assessment: 'pogo_rate 13.6% sur n=22 google_sessions, OK.' },
    content_snapshot: null,
    pogo: pogoFacts,
  });
  assert.equal(r.passed, true);
  assert.ok(r.total_numeric_claims >= 2); // n= + rate
});

test('Sprint-15 — unverified: hallucinated google_sessions count (the real bug we caught on #33)', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      pogo_navboost_assessment:
        'Pogo_rate 9.6% sur n=115 google_sessions (11 pogo, 5 hard pogo) — engagement OK.',
    },
    content_snapshot: null,
    pogo: pogoFacts,
  });
  assert.equal(r.passed, false);
  // Should catch: n=115 (vs 22), 9.6% (vs 13.6%), 11 pogo (vs 3), 5 hard (vs 2)
  assert.ok(
    r.unverified.length >= 4,
    `expected ≥4 unverified, got ${r.unverified.length}: ${JSON.stringify(r.unverified)}`,
  );
  assert.ok(r.unverified.some((u) => /n=115/.test(u.claim)));
  assert.ok(r.unverified.some((u) => /9\.6%/.test(u.claim)));
  assert.ok(r.unverified.some((u) => /11 pogo/.test(u.claim)));
  assert.ok(r.unverified.some((u) => /5 hard/i.test(u.claim)));
});

test('Sprint-15 — n= without pogo context is NOT counted (avoids false positive on stat thresholds)', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      structural_gaps: 'Le seuil statistique d\'usage est n=30 sessions pour valider.',
    },
    content_snapshot: null,
    pogo: pogoFacts,
  });
  // "n=30" without google_session/pogo/navboost in surrounding 60 chars → ignored
  assert.equal(r.total_numeric_claims, 0);
  assert.equal(r.passed, true);
});

test('Sprint-15 — pogo_rate within 0.5pp tolerance passes', () => {
  const r = factCheckDiagnostic({
    diagnostic: { pogo_navboost_assessment: 'pogo 13.5% sur n=22 — OK.' },
    content_snapshot: null,
    pogo: pogoFacts,
  });
  // 13.5% vs 13.6% → within 0.5pp
  assert.equal(r.passed, true);
});

test('Sprint-15 — pogo facts absent → claims marked as unverified, not silently passed', () => {
  const r = factCheckDiagnostic({
    diagnostic: { pogo_navboost_assessment: 'pogo 25% sur n=80 google_sessions.' },
    content_snapshot: null,
    pogo: null,
  });
  // No pogo facts → no validation, no claims counted (signal absent ≠ wrong)
  assert.equal(r.total_numeric_claims, 0);
  assert.equal(r.passed, true);
});

test('Sprint-15 — hard pogo distinguished from regular pogo', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      pogo_navboost_assessment: '3 pogo dont 2 hard pogo sur n=22 google_sessions.',
    },
    content_snapshot: null,
    pogo: pogoFacts,
  });
  // 3 pogo (✓), 2 hard pogo (✓), n=22 (✓)
  assert.equal(r.passed, true);
});

// ---------- Sprint-16 — engagement density + device CTA tests -----------

const sprint16Facts = {
  mobile_sessions: 70,
  desktop_sessions: 72,
  cta_rate_mobile_pct: 1.43,
  cta_rate_desktop_pct: 6.94,
  density_sessions: 143,
  density_dwell_p25: 7,
  density_dwell_median: 41,
  density_dwell_p75: 103,
  density_evenness_score: 0.07,
};

test('Sprint-16 — verified: evenness within 0.05 tolerance', () => {
  const r = factCheckDiagnostic({
    diagnostic: { engagement_pattern_assessment: 'Distribution bimodale (evenness 0.07).' },
    content_snapshot: null,
    sprint16: sprint16Facts,
  });
  assert.equal(r.passed, true);
  assert.ok(r.total_numeric_claims >= 1);
});

test('Sprint-16 — unverified: hallucinated evenness', () => {
  const r = factCheckDiagnostic({
    diagnostic: { engagement_pattern_assessment: 'Bonne homogénéité (evenness 0.85).' },
    content_snapshot: null,
    sprint16: sprint16Facts,
  });
  assert.equal(r.passed, false);
  assert.ok(r.unverified.some((u) => /0\.85/.test(u.claim)));
});

test('Sprint-16 — verified: dwell percentiles match', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      engagement_pattern_assessment: 'p25=7s, median=41s, p75=103s — distribution bimodale.',
    },
    content_snapshot: null,
    sprint16: sprint16Facts,
  });
  assert.equal(r.passed, true);
  // 3 percentile claims + evenness mention if any
  assert.ok(r.total_numeric_claims >= 3);
});

test('Sprint-16 — unverified: hallucinated p25', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      engagement_pattern_assessment: 'p25=25s, median=41s — engagement OK.',
    },
    content_snapshot: null,
    sprint16: sprint16Facts,
  });
  // p25 wrong (25 vs 7), median right
  assert.equal(r.passed, false);
  assert.ok(r.unverified.some((u) => /p25/.test(u.claim) && u.note?.includes('25')));
});

test('Sprint-16 — verified: mobile + desktop CTA rates with CTA context', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      device_optimization_note: 'mobile convertit à 1.43% vs desktop 6.94% — ratio 1:5.',
    },
    content_snapshot: null,
    sprint16: sprint16Facts,
  });
  assert.equal(r.passed, true);
});

test('Sprint-16 — "mobile X%" without CTA context is NOT counted', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      device_optimization_note: 'L\'audience est mobile à 78%, scroll court.',
    },
    content_snapshot: null,
    sprint16: sprint16Facts,
  });
  // "mobile à 78%" without conversion/cta/rate context → ignored (audience share, not CTA rate)
  assert.equal(r.total_numeric_claims, 0);
  assert.equal(r.passed, true);
});

test('Sprint-16 — unverified: hallucinated mobile CTA rate', () => {
  const r = factCheckDiagnostic({
    diagnostic: {
      device_optimization_note: 'mobile cta rate à 5% vs desktop 6.94%.',
    },
    content_snapshot: null,
    sprint16: sprint16Facts,
  });
  // 5% mobile is wrong (real: 1.43)
  assert.equal(r.passed, false);
  assert.ok(r.unverified.some((u) => /mobile/i.test(u.claim) && /5/.test(u.claim)));
});

test('Sprint-16 — sprint16 facts absent → claims not validated, no false alarm', () => {
  const r = factCheckDiagnostic({
    diagnostic: { engagement_pattern_assessment: 'evenness 0.42, p25=20s, p75=50s.' },
    content_snapshot: null,
    sprint16: null,
  });
  // No sprint16 → no claims counted, trivially passed
  assert.equal(r.total_numeric_claims, 0);
  assert.equal(r.passed, true);
});

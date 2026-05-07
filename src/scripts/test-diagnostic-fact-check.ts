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

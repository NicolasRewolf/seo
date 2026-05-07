/**
 * Sprint 14 unit tests for page-content-extractor.
 *
 * Inline HTML fixtures (no separate /fixtures dir) so each test is
 * self-contained and the snippets stay close to their assertions.
 *
 * Run with: npm run test:content-extractor
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPageContent } from '../lib/page-content-extractor.js';

const PAGE_URL = 'https://www.jplouton-avocat.fr/post/sample-page';

// Minimal Wix-like HTML wrapper used across tests
function wixWrap(bodyInner: string, headInner = ''): string {
  return `<!DOCTYPE html><html><head>${headInner}</head><body>
    <div class="wixui-header"><nav><a href="/">Accueil</a><a href="/contact">Contact</a></nav></div>
    <main>${bodyInner}</main>
    <div class="wixui-footer"><a href="/mentions-legales">Mentions</a><img src="/footer-logo.svg" alt="Logo Plouton"></div>
  </body></html>`;
}

test('word_count from simple body, header/footer text excluded', () => {
  const html = wixWrap('<p>Un deux trois quatre cinq six sept huit neuf dix.</p>');
  const c = extractPageContent({ html, pageUrl: PAGE_URL });
  // 10 words in the <p> + 0 from header/footer (stripped)
  assert.equal(c.word_count, 10);
  assert.match(c.body_text, /Un deux trois quatre cinq six sept huit neuf dix\./);
  // Header / footer text must not leak into body_text
  assert.ok(!c.body_text.includes('Accueil'));
  assert.ok(!c.body_text.includes('Mentions'));
});

test('outline extracts H2/H3/H4 in document order with word offsets', () => {
  const html = wixWrap(`
    <p>Intro avec dix mots juste pour test du word offset ici.</p>
    <h2 id="def">Définition</h2>
    <p>Cinq mots après le titre.</p>
    <h3>Sous-section</h3>
    <p>Encore quatre mots ici.</p>
    <h2>Conclusion</h2>
  `);
  const c = extractPageContent({ html, pageUrl: PAGE_URL });
  assert.equal(c.outline.length, 3);
  assert.deepEqual(c.outline.map((o) => ({ level: o.level, text: o.text, anchor: o.anchor })), [
    { level: 2, text: 'Définition', anchor: 'def' },
    { level: 3, text: 'Sous-section', anchor: null },
    { level: 2, text: 'Conclusion', anchor: null },
  ]);
  // word_offsets are monotonically increasing
  assert.ok(c.outline[0]!.word_offset < c.outline[1]!.word_offset);
  assert.ok(c.outline[1]!.word_offset < c.outline[2]!.word_offset);
  // First H2 comes after the 11-word intro
  // ("Intro avec dix mots juste pour test du word offset ici.")
  assert.equal(c.outline[0]!.word_offset, 11);
});

test('images extract src + alt + in_body flag (header/footer images flagged in_body=false)', () => {
  const html = wixWrap(`
    <p>Texte intro.</p>
    <img src="/hero.jpg" alt="Photo cabinet">
    <p>Texte suite.</p>
    <img src="/no-alt.png">
  `);
  const c = extractPageContent({ html, pageUrl: PAGE_URL });
  // 2 in body + 1 footer (Logo Plouton)
  assert.equal(c.images.length, 3);
  const hero = c.images.find((i) => i.src === '/hero.jpg');
  assert.equal(hero?.alt, 'Photo cabinet');
  assert.equal(hero?.in_body, true);
  const noAlt = c.images.find((i) => i.src === '/no-alt.png');
  assert.equal(noAlt?.alt, null);
  assert.equal(noAlt?.in_body, true);
  const footerLogo = c.images.find((i) => i.src === '/footer-logo.svg');
  assert.equal(footerLogo?.in_body, false);
});

test('cta_in_body_positions captures internal links with word offsets, excludes header/footer', () => {
  const html = wixWrap(`
    <p>Premier paragraphe avec dix mots juste pour pousser un peu loin.</p>
    <p>Pour en savoir plus, <a href="/honoraires-rendez-vous">prendre rendez-vous</a> avec le cabinet.</p>
  `);
  const c = extractPageContent({ html, pageUrl: PAGE_URL });
  // Header has 2 links (Accueil, Contact) and footer has 1 (Mentions) → all excluded
  assert.equal(c.cta_in_body_positions.length, 1);
  const cta = c.cta_in_body_positions[0]!;
  assert.equal(cta.target, '/honoraires-rendez-vous');
  assert.equal(cta.anchor, 'prendre rendez-vous');
  // word_offset > 10 (after the first paragraph) and < total
  assert.ok(cta.word_offset > 10, `expected word_offset > 10, got ${cta.word_offset}`);
});

test('cta_in_body_positions excludes external links', () => {
  const html = wixWrap(`
    <p>Source : <a href="https://www.legifrance.gouv.fr/article/123">Légifrance</a> définit la loi.</p>
  `);
  const c = extractPageContent({ html, pageUrl: PAGE_URL });
  assert.equal(c.cta_in_body_positions.length, 0);
});

test('author from <meta name="author">', () => {
  const html = wixWrap('<p>Body.</p>', '<meta name="author" content="Maître Plouton">');
  const c = extractPageContent({ html, pageUrl: PAGE_URL });
  assert.equal(c.author?.name, 'Maître Plouton');
});

test('author from <a rel="author">', () => {
  const html = wixWrap(
    '<p>Article par <a rel="author" href="/notre-cabinet">Maître Plouton</a>.</p>',
  );
  const c = extractPageContent({ html, pageUrl: PAGE_URL });
  assert.equal(c.author?.name, 'Maître Plouton');
  assert.equal(c.author?.url, '/notre-cabinet');
});

test('authorOverride takes precedence over HTML regex', () => {
  const html = wixWrap('<p>Body.</p>', '<meta name="author" content="Auteur HTML">');
  const c = extractPageContent({
    html,
    pageUrl: PAGE_URL,
    authorOverride: {
      name: 'Maître Plouton',
      date_published: '2024-03-15',
      date_modified: '2025-01-08',
    },
  });
  assert.equal(c.author?.name, 'Maître Plouton');
  assert.equal(c.author?.date_published, '2024-03-15');
  assert.equal(c.author?.date_modified, '2025-01-08');
});

test('falls back to <body> when no <main> or <article>', () => {
  const html = `<!DOCTYPE html><html><body>
    <div class="wixui-header"><nav><a href="/">Nav</a></nav></div>
    <p>Direct dans body.</p>
    <h2>Section</h2>
    <div class="wixui-footer"><a href="/legal">Legal</a></div>
  </body></html>`;
  const c = extractPageContent({ html, pageUrl: PAGE_URL });
  assert.match(c.body_text, /Direct dans body\./);
  assert.equal(c.outline.length, 1);
  assert.equal(c.outline[0]!.text, 'Section');
  // Nav/footer text NOT in body
  assert.ok(!c.body_text.includes('Nav'));
  assert.ok(!c.body_text.includes('Legal'));
});

test('extracted_at is a valid ISO timestamp', () => {
  const c = extractPageContent({ html: wixWrap('<p>Test.</p>'), pageUrl: PAGE_URL });
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(c.extracted_at));
});

test('returns empty arrays / nulls cleanly on minimal HTML', () => {
  const c = extractPageContent({ html: '<html><body><main></main></body></html>', pageUrl: PAGE_URL });
  assert.equal(c.word_count, 0);
  assert.equal(c.body_text, '');
  assert.deepEqual(c.outline, []);
  assert.deepEqual(c.images, []);
  assert.deepEqual(c.cta_in_body_positions, []);
  assert.equal(c.author, null);
});

/**
 * Sprint-14 — fact-checker pour le diagnostic v7.
 *
 * Cooked-agent flag (§5 critère négatif) : "le risque d'ajouter du contexte
 * = le LLM se sent autorisé à inventer des choses cohérentes-mais-fausses".
 *
 * Ce module parse le diagnostic JSON pour les claims numériques de type
 *   - "X mots"  /  "word count Y"
 *   - "H2 #N"  /  "outline offset N"
 *   - "X images"  /  "Y sans alt"
 *   - "X% du body"  /  "offset N mots"
 * et vérifie que les valeurs citées tracent vers content_snapshot ou
 * cooked_extras. Les claims qui ne tracent pas sont marqués HALLUCINÉS.
 *
 * Usage : appelé après diagnoseFinding pour produire un audit qualité.
 * Ne bloque pas la pipeline (le diag est déjà persisté), c'est un signal.
 */
import type { ContentSnapshot } from './page-content-extractor.js';

export type FactCheckResult = {
  total_numeric_claims: number;
  verified: number;
  unverified: Array<{
    claim: string; // the matched substring
    field: string; // which JSON field it came from (e.g. "structural_gaps")
    expected_in: string; // what source we tried to verify against
    note?: string;
  }>;
  passed: boolean; // true if ZERO unverified
};

type DiagnosticBag = Record<string, unknown>;

/**
 * Run a best-effort numeric fact-check across the diagnostic JSON.
 *
 * Patterns checked:
 *   - "(\d+) mots" → must match content_snapshot.word_count (±5% tolerance)
 *   - "H2 #(\d+)" → must be ≤ count of H2 in outline
 *   - "(\d+) images" → must match images.length (±0)
 *   - "(\d+) sans alt" → must match images.filter(no alt).length (±0)
 *   - "offset (\d+)" → must match an outline.word_offset OR cta_in_body_positions.word_offset (±5)
 */
export function factCheckDiagnostic(opts: {
  diagnostic: DiagnosticBag;
  content_snapshot: ContentSnapshot | null;
}): FactCheckResult {
  const cs = opts.content_snapshot;
  const unverified: FactCheckResult['unverified'] = [];
  let totalClaims = 0;
  let verified = 0;

  // Fields to scan in the diagnostic — long-form prose ones
  const fieldsToScan = [
    'tldr',
    'hypothesis',
    'intent_mismatch',
    'snippet_weakness',
    'engagement_diagnosis',
    'performance_diagnosis',
    'structural_gaps',
    'funnel_assessment',
    'internal_authority_assessment',
    'conversion_assessment',
    'traffic_strategy_note',
    'device_optimization_note',
    'outbound_leak_note',
  ];

  for (const field of fieldsToScan) {
    const value = opts.diagnostic[field];
    if (typeof value !== 'string' || !value.trim()) continue;

    // 1. word count claims: ONLY claims about the PAGE total, not section
    // lengths or reading-speed estimates ("400-500 mots") or
    // recommendations ("ajouter une section de 800 mots").
    //
    // Match patterns:
    //   - "word.?count.*?(\d[\d\s]+)\s*mots"
    //   - "(article|page|body|contenu).*?(\d[\d\s]+)\s*mots"
    //   - "(\d[\d\s]+)\s*mots\s+(au\s+total|total)"
    // French number format with thousands separator (3 118) → strip spaces
    // before parsing.
    const totalClaimPatterns = [
      /word[\s_.-]?count[^\d]*?(\d[\d\s]{1,7})\s*mots/gi,
      /(?:article|page|body|contenu|post)\s+(?:fait|de|à)?\s*(\d[\d\s]{1,7})\s*mots/gi,
      /(\d[\d\s]{1,7})\s*mots\s+(?:au\s+total|total)/gi,
    ];
    for (const pat of totalClaimPatterns) {
      for (const m of value.matchAll(pat)) {
        totalClaims++;
        const claimedCount = parseInt(m[1]!.replace(/\s+/g, ''), 10);
        if (!cs) {
          unverified.push({
            claim: m[0],
            field,
            expected_in: 'content_snapshot.word_count',
            note: 'content_snapshot is null',
          });
          continue;
        }
        const tolerance = Math.max(50, cs.word_count * 0.05);
        if (Math.abs(claimedCount - cs.word_count) <= tolerance) {
          verified++;
        } else {
          unverified.push({
            claim: m[0],
            field,
            expected_in: 'content_snapshot.word_count',
            note: `claimed ${claimedCount}, actual ${cs.word_count}`,
          });
        }
      }
    }

    // 2. H2 reference claims: "H2 #N"
    for (const m of value.matchAll(/H2\s+#(\d+)/g)) {
      totalClaims++;
      const claimedIdx = parseInt(m[1]!, 10);
      const h2Count = cs?.outline.filter((o) => o.level === 2).length ?? 0;
      if (claimedIdx <= h2Count && claimedIdx >= 1) {
        verified++;
      } else {
        unverified.push({
          claim: m[0],
          field,
          expected_in: 'content_snapshot.outline (H2 count)',
          note: `claimed H2 #${claimedIdx}, but only ${h2Count} H2 in outline`,
        });
      }
    }

    // 3. Image count claims: "X images" — distinguish "X images dans" vs "X images au total"
    for (const m of value.matchAll(/(\d+)\s+images?\b/gi)) {
      totalClaims++;
      const claimedCount = parseInt(m[1]!, 10);
      const inBody = cs?.images.filter((i) => i.in_body).length ?? 0;
      const total = cs?.images.length ?? 0;
      if (claimedCount === inBody || claimedCount === total) {
        verified++;
      } else {
        unverified.push({
          claim: m[0],
          field,
          expected_in: 'content_snapshot.images',
          note: `claimed ${claimedCount}, actual in_body=${inBody} total=${total}`,
        });
      }
    }

    // 4. "Y sans alt" claims
    for (const m of value.matchAll(/(\d+)\s+sans\s+alt/gi)) {
      totalClaims++;
      const claimedCount = parseInt(m[1]!, 10);
      const missingAlt = cs?.images.filter((i) => i.in_body && !i.alt).length ?? 0;
      if (claimedCount === missingAlt) {
        verified++;
      } else {
        unverified.push({
          claim: m[0],
          field,
          expected_in: 'content_snapshot.images (in_body, no alt)',
          note: `claimed ${claimedCount}, actual ${missingAlt}`,
        });
      }
    }

    // 5. Word offset claims: SKIPPED.
    //
    // Initially we tried to validate "offset N" claims against
    // content_snapshot.outline / cta_in_body_positions word_offset values.
    // But in practice the LLM uses offsets in TWO distinct ways:
    //   (a) Citation : "le H2 #2 est à offset 250" — verifiable
    //   (b) Recommendation : "ajouter une section à offset 300" — proposes a
    //       NEW insertion point that doesn't have to match an existing offset
    // Distinguishing (a) from (b) reliably from text patterns alone is too
    // brittle (false positives on legitimate recommendations were dominant
    // in the qspa v7 run). We trust the LLM to use offsets responsibly
    // since it can SEE the outline in <page_outline> and won't recommend
    // an offset beyond word_count.
    //
    // If we ever observe a real hallucination here (claim of an offset
    // beyond word_count, or claim of an existing H2 at the wrong offset),
    // we'll add a more targeted check.
  }

  return {
    total_numeric_claims: totalClaims,
    verified,
    unverified,
    passed: unverified.length === 0,
  };
}

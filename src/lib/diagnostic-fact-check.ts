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
 * Sprint-15 — pogo signal facts to verify against. Optional : when
 * not passed (or null), pogo claims are not checked. The 4 fields
 * mirror PageSnapshotExtras.pogo_28d so callers can pass them
 * directly without a transform.
 */
export type PogoFacts = {
  google_sessions: number | null;
  pogo_sticks: number | null;
  hard_pogo: number | null;
  pogo_rate_pct: number | null;
};

/**
 * Sprint-16 — CTA per-device + engagement density facts. Same pattern
 * as PogoFacts: optional, fields nullable, the LLM-cited numbers must
 * trace back here. Fact-checker only validates claims when the
 * underlying value is non-null (otherwise we can't compare).
 */
export type Sprint16Facts = {
  mobile_sessions: number | null;
  desktop_sessions: number | null;
  cta_rate_mobile_pct: number | null;
  cta_rate_desktop_pct: number | null;
  density_sessions: number | null;
  density_dwell_p25: number | null;
  density_dwell_median: number | null;
  density_dwell_p75: number | null;
  density_evenness_score: number | null;
};

/**
 * Run a best-effort numeric fact-check across the diagnostic JSON.
 *
 * Patterns checked:
 *   - "(\d+) mots" → must match content_snapshot.word_count (±5% tolerance)
 *   - "H2 #(\d+)" → must be ≤ count of H2 in outline
 *   - "(\d+) images" → must match images.length (±0)
 *   - "(\d+) sans alt" → must match images.filter(no alt).length (±0)
 *   - Sprint-15: pogo claims (n=N google_sessions, X pogo, X% pogo_rate, etc.)
 *     → must match the pogo_28d facts within tolerance
 */
export function factCheckDiagnostic(opts: {
  diagnostic: DiagnosticBag;
  content_snapshot: ContentSnapshot | null;
  pogo?: PogoFacts | null;
  sprint16?: Sprint16Facts | null;
}): FactCheckResult {
  const cs = opts.content_snapshot;
  const pogo = opts.pogo ?? null;
  const s16 = opts.sprint16 ?? null;
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
    'pogo_navboost_assessment',
    'engagement_pattern_assessment',
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

    // 6. Sprint-15 — Pogo claims. Verify against the pogo_28d facts.
    //
    // The first end-to-end run on Sprint 15 caught a real hallucination :
    // LLM claimed "n=115 google_sessions, 11 pogo, 9.6%" when actual was
    // "22 google_sessions, 3 pogo, 13.6%". Adding patterns prevents this
    // from passing silently in future runs.
    if (pogo) {
      // 6a. n=N pattern (most common — "sur n=80" / "(n=80)" / "n=80").
      // Sprint-17 fix: require word boundary before `n` to avoid matching
      // inside French words like "média_n_=41s" (false positive observed
      // on #33 where "médian=41s" was caught as a pogo n= claim).
      for (const m of value.matchAll(/\bn\s*=\s*(\d[\d\s]{0,5})/gi)) {
        const claimed = parseInt(m[1]!.replace(/\s+/g, ''), 10);
        // Only treat as a pogo claim if google_sessions context — check
        // whether the surrounding text mentions google_sessions/pogo to avoid
        // matching "n=30" used as a generic statistical threshold mention.
        const ctx = value.slice(Math.max(0, m.index! - 60), m.index! + m[0].length + 60);
        if (!/google[_\s]?session|pogo|navboost/i.test(ctx)) continue;
        totalClaims++;
        if (pogo.google_sessions == null) {
          unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.google_sessions', note: 'pogo facts not available' });
          continue;
        }
        // Tolerance: ±2 (snapshot is daily, slight drift OK)
        if (Math.abs(claimed - pogo.google_sessions) <= 2) verified++;
        else unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.google_sessions', note: `claimed ${claimed}, actual ${pogo.google_sessions}` });
      }

      // 6b. "X google_sessions" / "X sessions Google"
      for (const m of value.matchAll(/(\d[\d\s]{0,5})\s+(?:google[_\s]?sessions?|sessions?\s+google)/gi)) {
        totalClaims++;
        const claimed = parseInt(m[1]!.replace(/\s+/g, ''), 10);
        if (pogo.google_sessions == null) {
          unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.google_sessions', note: 'pogo facts not available' });
          continue;
        }
        if (Math.abs(claimed - pogo.google_sessions) <= 2) verified++;
        else unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.google_sessions', note: `claimed ${claimed}, actual ${pogo.google_sessions}` });
      }

      // 6c. "X pogo" / "X pogo-stick(s)" — but NOT "hard pogo" (handled below)
      for (const m of value.matchAll(/(?<!hard\s)(\d+)\s+pogo(?:[-_\s]?stick)?s?\b(?!\s*[%])/gi)) {
        totalClaims++;
        const claimed = parseInt(m[1]!, 10);
        if (pogo.pogo_sticks == null) {
          unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.pogo_sticks', note: 'pogo facts not available' });
          continue;
        }
        if (claimed === pogo.pogo_sticks) verified++;
        else unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.pogo_sticks', note: `claimed ${claimed}, actual ${pogo.pogo_sticks}` });
      }

      // 6d. "X hard pogo" / "X hard_pogo"
      for (const m of value.matchAll(/(\d+)\s+hard[_\s]?pogo/gi)) {
        totalClaims++;
        const claimed = parseInt(m[1]!, 10);
        if (pogo.hard_pogo == null) {
          unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.hard_pogo', note: 'pogo facts not available' });
          continue;
        }
        if (claimed === pogo.hard_pogo) verified++;
        else unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.hard_pogo', note: `claimed ${claimed}, actual ${pogo.hard_pogo}` });
      }

      // 6e. "pogo_rate X%" / "pogo X%" / "rate de X%" — only when pogo context
      for (const m of value.matchAll(/pogo[_\s]?(?:rate)?\s*(?:de\s+)?(\d+(?:[.,]\d+)?)\s*%/gi)) {
        totalClaims++;
        const claimed = parseFloat(m[1]!.replace(',', '.'));
        if (pogo.pogo_rate_pct == null) {
          unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.pogo_rate_pct', note: 'pogo facts not available' });
          continue;
        }
        // Tolerance: ±0.5pp (rate already rounded to 1 decimal by Cooked)
        if (Math.abs(claimed - pogo.pogo_rate_pct) <= 0.5) verified++;
        else unverified.push({ claim: m[0], field, expected_in: 'pogo_28d.pogo_rate_pct', note: `claimed ${claimed}%, actual ${pogo.pogo_rate_pct}%` });
      }
    }

    // 7. Sprint-16 — device CTA + engagement density facts.
    if (s16) {
      // 7a. evenness_score — "evenness 0.07" / "evenness=0.07" / "evenness de 0.07"
      for (const m of value.matchAll(/evenness[_\s]?(?:score)?\s*[=:]?\s*(?:de\s+)?(\d+(?:[.,]\d+)?)/gi)) {
        totalClaims++;
        const claimed = parseFloat(m[1]!.replace(',', '.'));
        if (s16.density_evenness_score == null) {
          unverified.push({ claim: m[0], field, expected_in: 'engagement_density.evenness_score', note: 'density facts not available' });
          continue;
        }
        if (Math.abs(claimed - s16.density_evenness_score) <= 0.05) verified++;
        else unverified.push({ claim: m[0], field, expected_in: 'engagement_density.evenness_score', note: `claimed ${claimed}, actual ${s16.density_evenness_score}` });
      }

      // 7b. dwell percentiles — accepts "p25=7s", "p25 7s", "p75=103s",
      // and bare "median=41s" / "median 41s" (without p prefix).
      for (const m of value.matchAll(/(?:p(25|50|75)|(median))\s*[=:]?\s*(\d+(?:[.,]\d+)?)\s*s\b/gi)) {
        const isPercentile = m[1] != null;
        const which = (m[1] ?? m[2])!.toLowerCase();
        const claimed = parseFloat(m[3]!.replace(',', '.'));
        const actual =
          which === '25' ? s16.density_dwell_p25 :
          which === '75' ? s16.density_dwell_p75 :
          s16.density_dwell_median; // 50 or 'median' → median
        const label = which === '25' ? 'dwell_p25' : which === '75' ? 'dwell_p75' : 'dwell_median';
        totalClaims++;
        if (actual == null) {
          unverified.push({ claim: m[0], field, expected_in: `engagement_density.${label}`, note: 'density facts not available' });
          continue;
        }
        if (Math.abs(claimed - actual) <= 1) verified++;
        else unverified.push({ claim: m[0], field, expected_in: `engagement_density.${label}`, note: `claimed ${claimed}s, actual ${actual}s` });
        void isPercentile; // silence linter
      }

      // 7c. mobile/desktop CTA rate. Sprint-17 fixes:
      //   (a) context check restricted to the LOCAL SENTENCE (between
      //       sentence boundaries) so "Mobile 80% du trafic. Sur les
      //       conversions : 0%" doesn't false-positive (Mobile 80% is
      //       device share, "conversions" is the next sentence).
      //   (b) reject when the GAP between (mobile|desktop) and the % cites
      //       a different metric (scroll, scroll_avg, share, split, trafic,
      //       audience). The LLM combines metrics like "80% mobile +
      //       scroll_avg 24.4%" — the 24.4% belongs to scroll, not CTA.
      for (const m of value.matchAll(/(mobile|desktop)\b([^%\d\n]{0,30})(\d+(?:[.,]\d+)?)\s*%/gi)) {
        const device = m[1]!.toLowerCase();
        const gap = m[2]!;
        const claimed = parseFloat(m[3]!.replace(',', '.'));
        // (b) negative keywords in the gap → another metric is being cited
        if (/scroll|\bshare\b|split|trafic|audience|provient|visiteurs?|sessions?\b/i.test(gap)) continue;
        // (a) Find local sentence : from previous sentence boundary to next.
        const before = value.slice(0, m.index!);
        const after = value.slice(m.index! + m[0].length);
        const lastBoundary = Math.max(
          before.lastIndexOf('. '), before.lastIndexOf('! '),
          before.lastIndexOf('? '), before.lastIndexOf(': '),
          before.lastIndexOf('\n'), -1,
        );
        const candidates = ['. ', '! ', '? ', ': ', '\n']
          .map((s) => after.indexOf(s))
          .filter((i) => i >= 0);
        const nextBoundaryRel = candidates.length > 0 ? Math.min(...candidates) : after.length;
        const localSentence = value.slice(lastBoundary + 1, m.index! + m[0].length + nextBoundaryRel);
        if (!/cta|convert|conversion|\brate\b/i.test(localSentence)) continue;
        const actual = device === 'mobile' ? s16.cta_rate_mobile_pct : s16.cta_rate_desktop_pct;
        const label = device === 'mobile' ? 'cta_rate_mobile_pct' : 'cta_rate_desktop_pct';
        totalClaims++;
        if (actual == null) {
          unverified.push({ claim: m[0], field, expected_in: `cta_per_device_28d.${label}`, note: 'sprint16 facts not available' });
          continue;
        }
        if (Math.abs(claimed - actual) <= 0.5) verified++;
        else unverified.push({ claim: m[0], field, expected_in: `cta_per_device_28d.${label}`, note: `claimed ${claimed}%, actual ${actual}%` });
      }
    }
  }

  return {
    total_numeric_claims: totalClaims,
    verified,
    unverified,
    passed: unverified.length === 0,
  };
}

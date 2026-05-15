# ✅ Eval run — prompt v12 (claude-opus-4-7)

- **Cases** : 5/5 passed
- **Assertions** : 27/27 passed
- **Duration** : 238.4s
- **Started** : 2026-05-15T22:18:32.369Z

---

## ✅ `arse-pos8-pogo-stick` — 6/6

> Pos 7.78, pps 0.95, scroll 1.37%, evenness 0.07 bimodal, LCP Poor 4258ms, page is THIN (0 H2, 0 image, 0 outbound link). Tests recognition of structural thinness as #1 cause + pogo signal interpretation with caveat on small n=7 + competing institutional authorities (dalloz/.gouv).

_LLM call: 90.9s_

<details><summary>Passed assertions</summary>

- ✅ `tldr` [min_length] — Substantive synthesis required.
- ✅ `snippet_weakness` [must_contain_any] — Top 3 SERP is dalloz / .gouv — diagnosing snippet weakness without naming the institutional competition produces wrong fixes.
- ✅ `engagement_diagnosis` [must_contain_any] — scroll 1.37% + bimodal dwell distribution (p25=6s, p75=80s, evenness 0.07) is THE engagement story — must surface at least one of these signals.
- ✅ `engagement_diagnosis` [must_not_contain_any] — Worst engagement profile in the corpus — calling it satisfaisant would invalidate the diagnostic.
- ✅ `structural_gaps` [must_contain_any] — Page literally has 0 H2 sections + 0 images on a YMYL legal topic — structural gap is the #1 fixable cause and must appear as a structural finding.
- ✅ `conversion_assessment` [must_contain_any] — 0 outbound + 0 conversions on 11 sessions = total dead-end — must surface as funnel finding.

</details>

---

## ✅ `gav-duree-pos5-volume` — 6/6

> Pos 4.52, 115k impr, snippet gap modéré (CTR 4.67% vs 7.22% expected). Tests prompt restraint when ranking is already strong + competitor recognition (service-public.gouv.fr top 1) + scroll-based engagement diagnosis when scroll_complete is catastrophic (0.9%) but dwell is OK.

_LLM call: 80.9s_

<details><summary>Passed assertions</summary>

- ✅ `tldr` [min_length] — tldr must be a substantive synthesis, not a one-liner — 80 chars is the minimum for a useful one-sentence diagnosis.
- ✅ `snippet_weakness` [must_contain_any] — service-public.gouv.fr holds #1 with institutional authority — diagnosing snippet weakness without naming the dominant competitor is generic and useless for action.
- ✅ `snippet_weakness` [must_contain_any] — Snippet weakness must point at a surface-level lever (title/meta/angle) since the page already ranks pos 4.52 — content rewrite is not the right action.
- ✅ `engagement_diagnosis` [must_contain_any] — scroll_avg 23.8% / scroll_complete 0.9% on a 2588-word article is the dominant engagement signal — a diagnosis that ignores it is asleep at the wheel.
- ✅ `engagement_diagnosis` [must_not_contain_any] — Engagement is mixed (good dwell, bad scroll) — alarmist wording would over-call the verdict and trigger wrong fixes.
- ✅ `conversion_assessment` [must_contain_any] — 0 conversions on 219 sessions with a CTA buried below scroll_avg is the actionable funnel finding — must surface it.

</details>

---

## ✅ `premeditation-pos5-snippet-gap` — 6/6

> Pos 5, CTR halved (1.42% vs 3.64% expected), scroll 3.35%. SERP locked by definitional sources (Légifrance/Wikipedia/Larousse/CNRTL). Tests joint snippet + above-fold engagement diagnosis + recognition that competing on definitional intent is hopeless.

_LLM call: 88.6s_

<details><summary>Passed assertions</summary>

- ✅ `tldr` [min_length] — Substantive synthesis required.
- ✅ `snippet_weakness` [must_contain_any] — The SERP is dominated by definitional/institutional sources — a snippet diagnosis that doesn't recognize this proposes the wrong fix (rewriting title for definitional intent is futile against Larousse).
- ✅ `engagement_diagnosis` [must_contain_any] — scroll_avg 3.35% with 0% reaching 100% is the dominant engagement signal — the page loses readers above the fold.
- ✅ `engagement_diagnosis` [must_not_contain_any] — scroll 3.35% is unambiguously bad — calling engagement satisfaisant would mask the core issue.
- ✅ `pogo_navboost_assessment` [must_contain_any] — Only n=10 google_sessions captured — must caveat that pogo_rate 10% is non-conclusive at this sample size, otherwise the LLM hallucinates a NavBoost verdict.
- ✅ `conversion_assessment` [must_contain_any] — 0 internal links + 0 conversions is the funnel-mort signal — must propose injecting a CTA / internal link.

</details>

---

## ✅ `trafic-stups-pos12-silo` — 5/5

> Pos 12.18, silo expertise page /défense-pénale/trafic-de-stupéfiant (not /post/). SERP saturated with COMPETITOR LAW FIRMS (Gabeaud, Paganelli, Zerbib, DCH) — pure commercial intent, zero institutional sources. Tests silo treatment + recognition that the page must compete on lawyer expertise differentiation, not on definitional content.

_LLM call: 69.7s_

<details><summary>Passed assertions</summary>

- ✅ `tldr` [min_length] — Substantive synthesis required.
- ✅ `intent_mismatch` [must_contain_any] — Top 5 SERP positions all held by lawyer firms — the page faces commercial-intent SERP, not informational. A diagnosis that misses this proposes content/definitional fixes when the real lever is positioning differentiation.
- ✅ `snippet_weakness` [must_contain_any] — Naming at least one lawyer-competitor anchors the snippet diagnosis in real differentiation work — generic 'meilleur snippet' advice without competitive context is useless.
- ✅ `snippet_weakness` [must_contain_any] — Must point at a surface-level lever (title/meta/angle) — page is silo expertise so structural changes are not the right action vs snippet rewrite.
- ✅ `conversion_assessment` [must_contain_any] — Commercial intent + 81s dwell + 0 conversion = CTA placement is the funnel lever — diagnosis must propose CTA work.

</details>

---

## ✅ `vc-feminicides-pos14-thin` — 4/4

> Pos 13.94, low impr (1.5k), meta description TRUNCATED at 'd' (incomplete in SERP). YMYL emotional + Bordeaux-local intent. Tests recognition of a broken meta as #1 fix + emotional-victim intent + caveat on tiny pogo sample (n=2).

_LLM call: 77.8s_

<details><summary>Passed assertions</summary>

- ✅ `tldr` [min_length] — Substantive synthesis required.
- ✅ `snippet_weakness` [must_contain_any] — The meta description is literally broken — truncated mid-word at 'd'. This is the highest-ROI fix and must be flagged. Missing it = the diagnostic leaves the most obvious bug untouched.
- ✅ `intent_mismatch` [must_contain_any] — Intent is YMYL emotional + local — diagnosis must recognize the user state (victim seeking immediate reassurance) to drive the right tonal/CTA fixes.
- ✅ `pogo_navboost_assessment` [must_contain_any] — n=2 google_sessions is laughably small — pogo_rate 50% is meaningless without the caveat. A diagnostic that conclues NavBoost from this would be a hallucination.

</details>

---

🟢 **All cases passed.** No regressions detected against the assertion set.
# 11 — Eval framework (Vague 3)

## WHAT

A regression test for the diagnostic LLM. **6 frozen golden cases** (real prod
findings captured at a specific moment) are replayed against the current
prompt + Claude model, scored against ~33 hand-curated assertions, and a pass /
fail report is produced.

It catches the kind of silent regression you'd otherwise only notice weeks
later in a generated GitHub issue : the LLM stops naming competitors, or
calls bad engagement "satisfaisant", or drops the sample-size caveat on
n=2 pogo data.

## WHY

The diagnostic prompt is at v12 and growing — every bump (~2 / month)
risks degrading some axis of quality silently. Without this eval :

- A wording change in `<engagement_diagnosis>` instructions that makes the
  LLM stop mentioning scroll → 0 visible signal until the next manual
  review of an issue.
- A new XML block that crowds out the SERP-competitor analysis → CTR-gap
  diagnostics suddenly become generic.
- An Anthropic Claude minor version bump (Opus 4.7 → 4.8) → behavioral
  drift detectable nowhere else in the stack.

The 5 cases were chosen to span the diagnostic surface area :

| Slug | Position bucket | Killer signal | Tests |
|---|---|---|---|
| `gav-duree-pos5-volume` | 4-10 (4.52) | Snippet gap modéré, scroll terrible mais dwell OK | Restraint near top + competitor recognition + mixed-signal engagement reading |
| `premeditation-pos5-snippet-gap` | 4-10 (5.17) | SERP locked by Légifrance/Wikipedia | Recognition that competing on definitional intent is hopeless |
| `arse-pos8-pogo-stick` | 4-10 (7.78) | Page is THIN (0 H2, 0 image, 0 outbound) | Structural-thinness diagnosis + small-n caveat |
| `trafic-stups-pos12-silo` | 11-20 (12.18) | Silo expertise page, lawyer-saturated SERP | Commercial intent recognition + competitor differentiation |
| `vc-feminicides-pos14-thin` | 11-20 (13.94) | Meta description literally TRUNCATED at 'd' | Recognition of broken meta as #1 fix + tiny-n caveat |
| `premeditation-commodity` | 4-10 (5.25) | Page définitionnelle pure face à autorités institutionnelles | **Sprint-23** : nouveau champ `unique_pov_assessment` — la page doit être identifiée comme COMMODITY et le diag doit recommander un POV non-commodity (cas, plaidoirie, angle expert) |

Coverage gap : no case currently exercises CWV / LCP-Poor diagnosis (no
finding in the corpus has populated `lcp_p75_ms`). To add later when
populated.

## HOW

### Run the eval (against current prompt v12)

```bash
npm run eval                            # all 5 cases, concurrency 2
npm run eval -- --cases=gav-duree-pos5-volume,vc-feminicides-pos14-thin
npm run eval -- --concurrency=3
```

Outputs : `eval/results/<timestamp>-<summary>/` (gitignored)
- `report.md` — paste-friendly summary, what failed and why
- `report.json` — machine-readable
- `<case-id>-output.json` — full LLM output per case

Exit code is `1` if any case fails. Total cost ~ $0.50-$1 per run.

### Add a new golden case

1. **Pick a finding** from prod that fills a coverage gap (a position bucket
   you don't have, an engagement profile you haven't covered, a CWV-Poor
   case once those exist).

2. **Capture the inputs** (queries Cooked / GSC / link graph live and
   freezes the resulting `DiagnosticPromptInputs` to disk) :
   ```bash
   npm run eval:capture -- \
     --finding=<uuid> \
     --case=<kebab-slug> \
     --what="One-line description of what this case tests"
   ```

3. **Edit `eval/cases/<slug>/assertions.json`**. The capture writes a
   stub with a single `tldr min_length` assertion — replace it with
   3-7 real assertions. See "Writing assertions" below.

4. **Run the eval** to confirm the new case passes against current prompt :
   ```bash
   npm run eval -- --cases=<slug>
   ```

5. **Commit** `eval/cases/<slug>/{inputs.json, assertions.json, meta.json}`
   to git. The frozen inputs are the contract — if you re-capture from the
   same finding later, prod data may have drifted and the eval would
   conflate prompt-quality regression with data drift.

### Writing assertions

The DSL has 7 kinds (see `src/lib/eval-assertions.ts`):

- `must_contain_any` / `must_contain_all` — substring match (case-insensitive
  by default, set `case_sensitive: true` to override)
- `must_not_contain_any` — forbidden terms
- `regex` / `regex_not` — when substring isn't enough
- `min_length` / `max_length` — structural bounds (e.g. tldr ≥ 80 chars)

Each assertion **MUST** include a `why` field. It surfaces in the failure
report so whoever's debugging knows what claim was being locked.

Pattern lists work as OR within `must_contain_any` (any one match passes)
and AND within `must_contain_all` (all must match). For "this concept
should appear", list the synonyms : `["scroll", "défilement"]` — both
French and English, both formal and casual variants the LLM might use.

**Don't over-specify.** If the assertion fails on minor wording changes
(a synonym, a slight rephrasing), it's flaky and will erode trust. The
sweet spot is 3-7 assertions per case, each pinning a HIGH-VALUE claim
that distinguishes a competent diagnosis from a generic one.

### Workflow : bumping the prompt v12 → v13

1. Make your prompt changes in `src/prompts/diagnostic.v1.ts`.
2. Bump `DIAGNOSTIC_PROMPT_VERSION` constant (currently 12).
3. Run `npm run eval` locally. Read `eval/results/.../report.md`.
4. **If all 5 cases still pass** : ship. The prompt change is regression-free.
5. **If 1+ cases fail**, look at each failure :
   - **Real regression** (the new prompt is genuinely worse on this axis)
     → revert / iterate the prompt.
   - **Better diagnosis, different vocabulary** (the LLM now uses synonyms
     not in your `must_contain_any` patterns) → update the assertion to
     accept the new vocab. Document why in the assertion's `why` field.
   - **Assertion was too strict** → loosen it.
6. Commit the prompt + any assertion updates together. Eval CI run on
   workflow_dispatch validates.

### Workflow : Anthropic ships a new Claude model

Same as above but step 1 is "update `ANTHROPIC_MODEL` in env / CI secret
and run `npm run smoke` to confirm the new model is reachable", then
proceed to step 3. Failures here are model-drift regressions, treat them
exactly like prompt-bump regressions.

## WHERE

Code :
- `src/lib/eval-assertions.ts` — the DSL + scorer (pure functions, 21 tests)
- `src/lib/eval-report.ts` — markdown + JSON renderer
- `src/scripts/run-eval.ts` — replay-all driver
- `src/scripts/run-eval-capture.ts` — capture-finding-to-disk driver
- `src/scripts/test-eval-assertions.ts` — unit tests for the DSL

Cases (committed to git) :
- `eval/cases/<slug>/inputs.json` — frozen DiagnosticPromptInputs
- `eval/cases/<slug>/assertions.json` — the locked claims
- `eval/cases/<slug>/meta.json` — provenance (source finding, captured_at, prompt v at capture)

Results (gitignored, per-run) :
- `eval/results/<timestamp>-<summary>/` — report.md + report.json + per-case outputs

CI :
- `.github/workflows/eval.yml` — workflow_dispatch only (cost-gated)

## VERIFY

```bash
# Framework sanity (zero LLM cost — pure unit tests on the DSL)
npm run test:eval-assertions

# Full eval (~5 LLM calls, ~$0.50-$1)
npm run eval

# Smoke a single case
npm run eval -- --cases=gav-duree-pos5-volume
```

A healthy run looks like :
```
[eval] running 5 case(s) at concurrency=2…
[eval] cases 5/5 passed, assertions 27/27 passed
[eval] report → eval/results/2026-05-15T22-03-46-5of5-pass
```

## LIMITES

- **No CWV / LCP-Poor case** : prod corpus has no finding with
  populated `lcp_p75_ms` yet. Add when available.
- **5 cases is small.** Real regression coverage probably wants 10-15.
  Add cases as new failure modes are encountered in prod issues.
- **Cost** : each run is ~$0.50-$1. Don't put it on every push — it's
  workflow_dispatch only. Run before bumping prompt or when Anthropic
  ships a new model.
- **Assertions are claim-level, not output-level.** The DSL pins
  individual claims ("must mention service-public.gouv.fr") but doesn't
  diff the full output JSON across runs. If you want to inspect drift in
  the full text, compare the per-case `<case-id>-output.json` between two
  results dirs (TODO : add a `npm run eval:diff <run1> <run2>` helper
  later if this becomes a need).
- **No baseline-snapshot mode.** Every run scores against assertions; we
  don't compare run N against run N-1 to flag "these 3 fields changed".
  If we need that, add an `eval:diff` script that diffs the per-case
  output JSONs.

## Baseline reference

`eval/baseline/v<N>-*` contains the most recent green-run snapshot per
prompt version. Use it as the gold for textual diffing :

```bash
diff eval/baseline/v12-gav-duree-pos5-volume-output.json \
     eval/results/<latest>/gav-duree-pos5-volume-output.json
```

The current baseline is **prompt v12, 5/5 cases, 27/27 assertions, run
2026-05-15** (see `eval/baseline/v12-report.md`). When bumping to v13 :
- Run `npm run eval`. If 5/5 still pass : promote the new run by copying
  its outputs over `eval/baseline/v13-*`.
- If any case fails : decide between real regression (revert / iterate)
  or assertion drift (loosen the assertion + commit). Promote v13 baseline
  only when 5/5 pass again.

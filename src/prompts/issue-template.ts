/**
 * GitHub issue Markdown template — ROADMAP §9.
 *
 * Pure renderer: takes a fully-loaded IssueInputs object and returns
 * { title, body, labels }. No DB / API access here so the template can be
 * unit-tested in isolation and previewed without touching GitHub.
 */
import { addDays, format } from 'date-fns';

export type IssueProposedFix = {
  fix_type:
    | 'title'
    | 'meta_description'
    | 'h1'
    | 'intro'
    | 'schema'
    | 'internal_links'
    | 'content_addition';
  current_value: string | null;
  proposed_value: string;
  rationale: string;
};

export type IssueDiagnostic = {
  intent_mismatch: string;
  snippet_weakness: string;
  hypothesis: string;
  engagement_diagnosis: string;
  top_queries_analysis: Array<{
    query: string;
    impressions: number;
    ctr: number;
    position: number;
    intent_match: 'yes' | 'partial' | 'no';
    note?: string;
  }>;
};

export type IssueInputs = {
  // Identifiers
  finding_id: string;
  audit_run_id: string;
  page: string;

  // Metrics
  avg_position: number;
  position_drift: number | null;
  impressions: number; // total over the analysis window
  audit_period_months: number;
  ctr_actual: number;
  ctr_expected: number;
  ctr_gap: number; // 0..1
  priority_score: number;
  priority_tier: 1 | 2 | 3;
  group_assignment: 'treatment' | 'control';

  // Engagement
  pages_per_session: number | null;
  avg_session_duration_seconds: number | null;
  scroll_depth_avg: number | null;

  // Current SEO state (used for fix "current" values when missing on the fix itself)
  current_title: string;
  current_meta: string;
  current_intro: string;

  // LLM payload
  diagnostic: IssueDiagnostic;
  fixes: IssueProposedFix[];

  // Cycle dates
  baseline_date: string; // yyyy-MM-dd

  // Optional links to external dashboards
  supabase_finding_url?: string;
};

function pct(n: number, digits = 2): string {
  return (n * 100).toFixed(digits);
}

function shortPath(url: string, max = 60): string {
  try {
    const u = new URL(url);
    // WHATWG URL re-encodes non-ASCII pathnames; decode for human readability.
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep encoded if invalid escapes
    }
    return p.length > max ? p.slice(0, max - 1) + '…' : p;
  } catch {
    return url.length > max ? url.slice(0, max - 1) + '…' : url;
  }
}

export function renderIssueTitle(i: IssueInputs): string {
  const path = shortPath(i.page, 60);
  return `[SEO-P${i.priority_tier}] ${path} — CTR ${pct(i.ctr_actual)}% vs ${pct(i.ctr_expected)}% en pos. ${i.avg_position.toFixed(1)}`;
}

export function renderIssueLabels(i: IssueInputs): string[] {
  return [
    'seo-audit',
    `priority-${i.priority_tier}`,
    i.group_assignment,
    'status:proposed',
  ];
}

function fmtNumOrNA(n: number | null | undefined, suffix = '', digits = 2): string {
  if (n == null) return 'n/a';
  return `${typeof n === 'number' ? n.toFixed(digits) : n}${suffix}`;
}

function ppsInterpretation(n: number | null): string {
  if (n == null) return 'pas de données';
  if (n < 1.3) return '⚠️ rebond rapide (< 1.3)';
  if (n < 2.0) return 'standard';
  return '✅ navigation profonde';
}
function durationInterpretation(s: number | null): string {
  if (s == null) return 'pas de données';
  if (s < 30) return '⚠️ pogo-stick (< 30s)';
  if (s < 90) return 'court mais lu';
  return '✅ session longue';
}
function scrollInterpretation(p: number | null): string {
  if (p == null) return 'pas de données';
  if (p < 50) return '⚠️ scroll superficiel (< 50%)';
  if (p < 75) return 'lecture partielle';
  return '✅ scroll profond';
}

function fmtDriftCell(drift: number | null): string {
  if (drift == null) return 'n/a (premier audit)';
  if (drift > 0) return `+${drift.toFixed(1)} positions sur 3 mois`;
  return `${drift.toFixed(1)} positions sur 3 mois`;
}

function findFix(fixes: IssueProposedFix[], type: IssueProposedFix['fix_type']): IssueProposedFix | null {
  return fixes.find((f) => f.fix_type === type) ?? null;
}

function fmtFixSection(opts: {
  ordinal: number;
  label: string;
  fix: IssueProposedFix | null;
  fallbackCurrent?: string;
  blockquoteCurrent?: boolean;
}): string {
  if (!opts.fix) return '';
  const cur = opts.fix.current_value ?? opts.fallbackCurrent ?? '(empty)';
  const fmt = opts.blockquoteCurrent
    ? `> ${cur.replace(/\n/g, '\n> ')}`
    : '```\n' + cur + '\n```';
  const proposedFmt = opts.blockquoteCurrent
    ? `> ${opts.fix.proposed_value.replace(/\n/g, '\n> ')}`
    : '```\n' + opts.fix.proposed_value + '\n```';
  return [
    `### ${opts.ordinal}. ${opts.label}`,
    ``,
    `**Actuel** :`,
    fmt,
    ``,
    `**Proposé** :`,
    proposedFmt,
    ``,
    `**Pourquoi** : ${opts.fix.rationale}`,
    ``,
    `---`,
    ``,
  ].join('\n');
}

function fmtTopQueries(rows: IssueDiagnostic['top_queries_analysis'], limit = 5): string {
  const subset = rows.slice(0, limit);
  if (subset.length === 0) return '_(pas de données de requêtes)_';
  const lines = ['| Requête | Impressions | CTR | Position | Intent match |', '|---|---|---|---|---|'];
  for (const r of subset) {
    const ctrPct = (r.ctr * 100).toFixed(2);
    lines.push(
      `| ${r.query} | ${r.impressions} | ${ctrPct}% | ${r.position.toFixed(1)} | ${r.intent_match} |`,
    );
  }
  return lines.join('\n');
}

export function renderIssueBody(i: IssueInputs): string {
  const monthlyImp = Math.round(i.impressions / i.audit_period_months);
  const baselineDate = i.baseline_date;
  const baseline = new Date(`${baselineDate}T00:00:00Z`);
  const t30 = format(addDays(baseline, 30), 'yyyy-MM-dd');
  const t60 = format(addDays(baseline, 60), 'yyyy-MM-dd');

  const titleFix = findFix(i.fixes, 'title');
  const metaFix = findFix(i.fixes, 'meta_description');
  const introFix = findFix(i.fixes, 'intro');
  const linksFix = findFix(i.fixes, 'internal_links');

  const linksSection = linksFix
    ? [
        `### 4. Maillage interne`,
        ``,
        linksFix.proposed_value,
        ``,
        `**Pourquoi** : ${linksFix.rationale}`,
        ``,
        `---`,
        ``,
      ].join('\n')
    : '';

  return [
    `## 📊 Diagnostic`,
    ``,
    `| Métrique | Valeur |`,
    `|---|---|`,
    `| **Page** | [${i.page}](${i.page}) |`,
    `| **Position moyenne (${i.audit_period_months} mois)** | ${i.avg_position.toFixed(1)} |`,
    `| **Drift** | ${fmtDriftCell(i.position_drift)} |`,
    `| **Impressions/mois** | ${monthlyImp.toLocaleString('fr-FR')} |`,
    `| **CTR actuel** | ${pct(i.ctr_actual)}% |`,
    `| **CTR attendu (benchmark site)** | ${pct(i.ctr_expected)}% |`,
    `| **Gap** | **${(i.ctr_gap * 100).toFixed(1)}%** sous benchmark |`,
    `| **Priority score** | ${i.priority_score.toFixed(2)} (tier ${i.priority_tier}) |`,
    `| **Groupe expérimental** | \`${i.group_assignment}\` |`,
    ``,
    `### Engagement (GA4, ${i.audit_period_months} mois)`,
    ``,
    `| Signal | Valeur | Interprétation |`,
    `|---|---|---|`,
    `| Pages/session | ${fmtNumOrNA(i.pages_per_session)} | ${ppsInterpretation(i.pages_per_session)} |`,
    `| Durée moyenne | ${fmtNumOrNA(i.avg_session_duration_seconds, 's', 0)} | ${durationInterpretation(i.avg_session_duration_seconds)} |`,
    `| Scroll depth | ${fmtNumOrNA(i.scroll_depth_avg, '%', 1)} | ${scrollInterpretation(i.scroll_depth_avg)} |`,
    ``,
    `---`,
    ``,
    `## 🔍 Hypothèse principale`,
    ``,
    `> ${i.diagnostic.hypothesis}`,
    ``,
    `### Intent mismatch détecté`,
    ``,
    i.diagnostic.intent_mismatch,
    ``,
    `### Faiblesse du snippet`,
    ``,
    i.diagnostic.snippet_weakness,
    ``,
    `### Diagnostic engagement`,
    ``,
    i.diagnostic.engagement_diagnosis,
    ``,
    `---`,
    ``,
    `## 🔎 Top 5 requêtes`,
    ``,
    fmtTopQueries(i.diagnostic.top_queries_analysis, 5),
    ``,
    `---`,
    ``,
    `## 🛠 Fixes proposés`,
    ``,
    i.group_assignment === 'control'
      ? `> ⚠️ **Groupe contrôle** : ne pas appliquer ces fixes pendant 4 semaines minimum (mesure d'impact via différence treatment vs contrôle).`
      : `> 🟢 **Groupe traitement** : à appliquer après revue.`,
    ``,
    fmtFixSection({ ordinal: 1, label: 'Title', fix: titleFix, fallbackCurrent: i.current_title }),
    fmtFixSection({ ordinal: 2, label: 'Meta description', fix: metaFix, fallbackCurrent: i.current_meta }),
    fmtFixSection({
      ordinal: 3,
      label: 'Intro (first screen, ≤100 mots)',
      fix: introFix,
      fallbackCurrent: i.current_intro,
      blockquoteCurrent: true,
    }),
    linksSection,
    `## 📅 Cycle de mesure`,
    ``,
    `- **T0 (baseline)** : ${baselineDate}`,
    `- **T+30 mesure 1** : prévue le ${t30}`,
    `- **T+60 mesure 2** : prévue le ${t60}`,
    ``,
    `## 🏷 Workflow`,
    ``,
    `- [ ] Reviewed (cocher pour valider les fixes proposés)`,
    `- [ ] Applied (cocher après push Wix)`,
    `- [ ] Measured T+30`,
    `- [ ] Measured T+60`,
    ``,
    `## 🔗 Refs`,
    ``,
    `- Audit run ID : \`${i.audit_run_id}\``,
    `- Finding ID : \`${i.finding_id}\``,
    i.supabase_finding_url ? `- Supabase : [voir le finding](${i.supabase_finding_url})` : '',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

export type RenderedIssue = { title: string; body: string; labels: string[] };

export function renderIssue(i: IssueInputs): RenderedIssue {
  return {
    title: renderIssueTitle(i),
    body: renderIssueBody(i),
    labels: renderIssueLabels(i),
  };
}

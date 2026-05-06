/**
 * Plouton site URL catalog — categorized list of REAL internal pages so the
 * LLM stops hallucinating link targets like /post/licenciement-faute-grave
 * (which doesn't exist).
 *
 * Source: https://www.jplouton-avocat.fr/pages-sitemap.xml fetched 2026-05-06.
 * If the site structure changes, regenerate via the same sitemap URL.
 *
 * The role labels match the cabinet's funnel logic stated by Nicolas:
 *   - "expertise"  → métier landing pages (target of inbound recommendations)
 *   - "cta"        → conversion pages (rendezvous, contact)
 *   - "trust"      → equipe, affaires, mentions
 *   - "blog_root"  → blog landing
 *   - "homepage"
 *   - "legal"
 */
export type CatalogRole =
  | 'expertise'
  | 'cta'
  | 'trust'
  | 'blog_root'
  | 'homepage'
  | 'legal';

export type CatalogEntry = {
  url: string;
  role: CatalogRole;
  topic?: string; // human-readable topic for expertise pages
};

export const SITE_CATALOG: CatalogEntry[] = [
  { url: 'https://www.jplouton-avocat.fr', role: 'homepage' },

  // Defense pénale (expertise tree)
  { url: 'https://www.jplouton-avocat.fr/defense-penale', role: 'expertise', topic: 'Défense pénale (racine)' },
  { url: 'https://www.jplouton-avocat.fr/defense-penale/droit-penal', role: 'expertise', topic: 'Droit pénal général' },
  { url: 'https://www.jplouton-avocat.fr/defense-penale/proces-criminel', role: 'expertise', topic: 'Procès criminels (cour d\'assises)' },
  { url: 'https://www.jplouton-avocat.fr/defense-penale/violences-conjugales-et-feminicides', role: 'expertise', topic: 'Violences conjugales et féminicides' },
  { url: 'https://www.jplouton-avocat.fr/defense-penale/trafic-de-stupefiant', role: 'expertise', topic: 'Trafic de stupéfiants' },
  { url: 'https://www.jplouton-avocat.fr/defense-penale/droit-penal-des-affaires', role: 'expertise', topic: 'Droit pénal des affaires' },

  // Indemnisation des victimes (expertise tree)
  { url: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes', role: 'expertise', topic: 'Indemnisation des victimes (racine)' },
  { url: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/accidents-de-la-vie-courante', role: 'expertise', topic: 'Accidents de la vie courante' },
  { url: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/victimes-de-delits-ou-crimes', role: 'expertise', topic: 'Victimes de délits ou crimes' },
  { url: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/accidents-et-erreurs-medicales', role: 'expertise', topic: 'Accidents et erreurs médicales' },
  { url: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/droit-et-accidents-du-travail', role: 'expertise', topic: 'Droit et accidents du travail' },
  { url: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/accidents-de-la-route', role: 'expertise', topic: 'Accidents de la route' },

  // Droit des contrats et des personnes (expertise tree)
  { url: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes', role: 'expertise', topic: 'Droit des contrats et des personnes (racine)' },
  { url: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes/defense-des-consommateurs', role: 'expertise', topic: 'Défense des consommateurs' },
  { url: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes/droit-assurances-particuliers-professionnels', role: 'expertise', topic: 'Droit des assurances' },
  { url: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes/droit-de-la-famille', role: 'expertise', topic: 'Droit de la famille' },
  { url: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes/droit-de-la-famille/avocat-divorce-bordeaux', role: 'expertise', topic: 'Divorce (Bordeaux)' },

  // CTA + trust
  { url: 'https://www.jplouton-avocat.fr/honoraires-rendez-vous', role: 'cta', topic: 'Honoraires & prise de rendez-vous' },
  { url: 'https://www.jplouton-avocat.fr/notre-cabinet', role: 'trust', topic: 'Présentation du cabinet' },
  { url: 'https://www.jplouton-avocat.fr/nos-affaires', role: 'trust', topic: 'Affaires emblématiques' },

  // Blog roots / utility
  { url: 'https://www.jplouton-avocat.fr/blog', role: 'blog_root' },
  { url: 'https://www.jplouton-avocat.fr/comprendre-le-droit', role: 'blog_root' },
  { url: 'https://www.jplouton-avocat.fr/mentions-legales', role: 'legal' },
];

/**
 * Group catalog entries by role for compact rendering in the LLM prompt.
 */
export function catalogByRole(): Record<CatalogRole, CatalogEntry[]> {
  const out = {
    expertise: [] as CatalogEntry[],
    cta: [] as CatalogEntry[],
    trust: [] as CatalogEntry[],
    blog_root: [] as CatalogEntry[],
    homepage: [] as CatalogEntry[],
    legal: [] as CatalogEntry[],
  };
  for (const e of SITE_CATALOG) out[e.role].push(e);
  return out;
}

/**
 * Wix blog category → role mapping. Used to attach a "funnel role" to the
 * article being analyzed so the LLM knows whether it's a knowledge-brick
 * (Ressources) that should funnel to expertise, or a topic-cluster article
 * already aligned with an expertise category.
 */
export type CategoryRole =
  | 'knowledge_brick' // Article ressource → funnel toward expertise + CTA
  | 'topic_expertise' // Tied to a specific expertise — nudge toward the matching landing page
  | 'press' // Médias / revue de presse → trust signal, low transactional intent
  | 'unknown';

export type CategoryInfo = {
  id: string;
  label: string;
  role: CategoryRole;
  /** Default expertise URL to recommend if the article fits this category. */
  funnelTo?: string;
};

export const WIX_CATEGORIES: Record<string, CategoryInfo> = {
  '8dad2d49-d0e2-40c3-be1c-02baaf57e3cd': { id: '8dad2d49-d0e2-40c3-be1c-02baaf57e3cd', label: 'Droit Pénal', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/defense-penale/droit-penal' },
  'c730402c-de41-413e-be71-88fc00a0f741': { id: 'c730402c-de41-413e-be71-88fc00a0f741', label: 'Procès criminels', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/defense-penale/proces-criminel' },
  '857f17e1-837b-4665-a80a-2f3baa9c5262': { id: '857f17e1-837b-4665-a80a-2f3baa9c5262', label: 'Violences Conjugales et féminicides', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/defense-penale/violences-conjugales-et-feminicides' },
  'bfd9c9df-cddc-4a53-b903-c98c089c8523': { id: 'bfd9c9df-cddc-4a53-b903-c98c089c8523', label: 'Trafic de stupéfiants', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/defense-penale/trafic-de-stupefiant' },
  'd504fbe1-e1c9-4df1-9189-963e0856e816': { id: 'd504fbe1-e1c9-4df1-9189-963e0856e816', label: 'Droit pénal des affaires', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/defense-penale/droit-penal-des-affaires' },
  'a755253f-65a6-49cc-b89e-e10e83840a75': { id: 'a755253f-65a6-49cc-b89e-e10e83840a75', label: 'Victimes de délits ou crimes', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/victimes-de-delits-ou-crimes' },
  '0c769ec1-307b-413a-bcce-7b4e5d546c4b': { id: '0c769ec1-307b-413a-bcce-7b4e5d546c4b', label: 'Accidents et erreurs médicales', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/accidents-et-erreurs-medicales' },
  '34cbb933-76d6-4a2e-8048-7624dcbe738d': { id: '34cbb933-76d6-4a2e-8048-7624dcbe738d', label: 'Accidents de la route', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/accidents-de-la-route' },
  'ed75e638-104d-42ec-8e85-7ddb79e0928b': { id: 'ed75e638-104d-42ec-8e85-7ddb79e0928b', label: 'Droit et accidents du travail', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/droit-et-accidents-du-travail' },
  '8bc927f8-b437-4bcd-939b-b31f17f23c08': { id: '8bc927f8-b437-4bcd-939b-b31f17f23c08', label: 'Accidents de la vie courante', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/indemnisation-des-victimes/accidents-de-la-vie-courante' },
  'edd6c343-05a3-4bf9-929e-527fad068557': { id: 'edd6c343-05a3-4bf9-929e-527fad068557', label: 'Droit des assurances', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes/droit-assurances-particuliers-professionnels' },
  '93bcfb5b-f451-4804-9d43-ec04e287b44d': { id: '93bcfb5b-f451-4804-9d43-ec04e287b44d', label: 'Défense des consommateurs', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes/defense-des-consommateurs' },
  '5151e5b0-01a7-4622-838b-cf615dcd6ce4': { id: '5151e5b0-01a7-4622-838b-cf615dcd6ce4', label: 'Droit de la famille', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes/droit-de-la-famille' },
  'b1875264-aae1-4bf7-944e-b4f4d470e0f2': { id: 'b1875264-aae1-4bf7-944e-b4f4d470e0f2', label: 'Divorce', role: 'topic_expertise', funnelTo: 'https://www.jplouton-avocat.fr/droit-des-contrats-et-des-personnes/droit-de-la-famille/avocat-divorce-bordeaux' },

  '9477320f-5902-40e9-ace3-b0e3b6b8b51f': { id: '9477320f-5902-40e9-ace3-b0e3b6b8b51f', label: 'Ressources et notions juridiques', role: 'knowledge_brick' },
  '2e58be46-ca41-44df-a489-6ae3e0ce47ee': { id: '2e58be46-ca41-44df-a489-6ae3e0ce47ee', label: 'Médias', role: 'press' },
};

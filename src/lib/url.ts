/**
 * URL canonicalization — single source of truth for the join surface
 * between every snapshot/graph/finding table.
 *
 * Originally lived in src/pipeline/snapshot.ts; extracted in Sprint 9 so
 * the new internal_link_graph crawler can normalize source_path /
 * target_path the same way snapshot.ts normalizes GSC and Cooked URLs.
 * Without this share, `'/post/foo'` and `'/post/foo/'` would land as two
 * distinct nodes in the graph and silently corrupt inbound counts.
 *
 * Behavior:
 *   - decode percent-escapes so "/dur%C3%A9e-…" stores as "/durée-…"
 *   - lowercase host + path
 *   - drop trailing slash on path (except the root "/")
 *   - drop query string + hash
 *   - decodeURIComponent throws on malformed inputs → wrapped in try
 */
export function canonicalUrl(input: string): string {
  if (!input) return input;
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    // keep original if it has invalid escapes
  }
  const url = (() => {
    try {
      return new URL(decoded);
    } catch {
      return null;
    }
  })();
  if (url) {
    const host = url.host.toLowerCase();
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
    // url.pathname is always re-encoded by the WHATWG URL parser; decode it
    // back so the stored key reads naturally (e.g. "/durée-de-la-garde…"
    // instead of "/dur%C3%A9e-de-la-garde…"). Drop search + hash entirely.
    let decodedPath = path;
    try {
      decodedPath = decodeURIComponent(path);
    } catch {
      // keep as-is if invalid escape
    }
    return `${url.protocol}//${host}${decodedPath}`.toLowerCase();
  }
  return decoded.toLowerCase();
}

/**
 * Extract just the path portion from a canonical URL (or any URL). Used by
 * the link-graph code where we store `source_path` / `target_path` as
 * absolute paths (not full URLs) to keep the table compact and joinable
 * against `gsc_page_snapshots.page` regardless of host.
 */
export function pathOf(input: string): string {
  try {
    const u = new URL(input);
    let p = u.pathname;
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep as-is
    }
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
    return p.toLowerCase();
  } catch {
    return input.toLowerCase();
  }
}

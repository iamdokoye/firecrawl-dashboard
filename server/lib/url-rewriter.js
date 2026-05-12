import {
  getFirecrawlUrl, getSetting, getProxyTrustForwardedFor,
} from './settings.js';

/**
 * Rewrite top-level URL fields in Firecrawl JSON responses so async-job
 * polling and pagination stay on the proxy instead of leaking to the
 * upstream Firecrawl host.
 *
 * Background
 * ----------
 * Firecrawl emits absolute URLs on async-job envelopes:
 *   POST /v[12]/crawl              → { id, url }                  (status URL)
 *   POST /v[12]/batch/scrape       → { id, url }                  (status URL)
 *   GET  /v[12]/crawl/:id          → { ..., next }                (pagination URL)
 *   GET  /v[12]/batch/scrape/:id   → { ..., next }                (pagination URL)
 *
 * The official JS SDK reads `statusData.next` and passes it verbatim into
 * its HTTP client without re-deriving the path from the configured
 * apiUrl — so if `next` points to the upstream host, the SDK bypasses the
 * proxy on every paginated fetch. We rewrite those URLs to point back at
 * the proxy's public base.
 *
 * Surgical scope
 * --------------
 * Operation-gated and field-level: only the named top-level fields on the
 * four async-job operations are touched. The recursive shapes — `data[]`,
 * `links[]`, `metadata.*`, `sources[]`, `errors[]`, scraped `markdown` —
 * are never walked. This is essential: if a user scrapes a page that
 * literally mentions `api.firecrawl.dev` (the Firecrawl docs, for
 * instance), a blanket string-replace would corrupt the scraped content.
 *
 * Anything not in the table is byte-identical passthrough.
 */

const FIELDS_BY_OPERATION = {
  crawl_create:  ['url'],
  batch_scrape:  ['url'],
  crawl_status:  ['next'],
  batch_status:  ['next'],
};

function stripTrailingSlash(s) {
  return typeof s === 'string' ? s.replace(/\/+$/, '') : s;
}

/**
 * Resolve the proxy's public base URL — the prefix that should appear in
 * rewritten response URLs. Priority order:
 *   1. proxy_public_url setting (explicit operator override)
 *   2. X-Forwarded-Proto / X-Forwarded-Host  (only when proxy_trust_forwarded_for=1)
 *   3. req.protocol + req.headers.host       (direct connection)
 *
 * Returns null when no Host can be determined (e.g. an HTTP/1.0 request
 * without a Host header); the caller treats that as "no rewrite possible".
 */
function computePublicBase(db, req) {
  const override = getSetting(db, 'proxy_public_url');
  if (override) return stripTrailingSlash(override);

  const trust = getProxyTrustForwardedFor(db);
  const proto =
    (trust && req.headers['x-forwarded-proto']) ||
    req.protocol ||
    'http';
  const host =
    (trust && req.headers['x-forwarded-host']) ||
    req.headers.host;
  if (!host) return null;
  return `${proto}://${host}`;
}

export function rewriteResponseBody(db, req, operationType, upstream) {
  const fields = FIELDS_BY_OPERATION[operationType];
  if (!fields) return upstream.body;

  const ct = (upstream.headers?.['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) return upstream.body;

  if (!upstream.body || upstream.body.length === 0) return upstream.body;

  const upstreamBase = stripTrailingSlash(getFirecrawlUrl(db));
  const publicBase = computePublicBase(db, req);
  if (!publicBase || publicBase === upstreamBase) return upstream.body;

  let body;
  try {
    body = JSON.parse(upstream.body.toString('utf8'));
  } catch (_) {
    return upstream.body;
  }
  if (!body || typeof body !== 'object') return upstream.body;

  let mutated = false;
  for (const field of fields) {
    const v = body[field];
    if (typeof v === 'string' && v.startsWith(upstreamBase)) {
      body[field] = publicBase + v.slice(upstreamBase.length);
      mutated = true;
    }
  }
  if (!mutated) return upstream.body;

  return Buffer.from(JSON.stringify(body), 'utf8');
}

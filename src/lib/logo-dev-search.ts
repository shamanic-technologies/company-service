/**
 * logo.dev Search API — authoritative company-name lookup.
 *
 * `brands.name` is a display name shown to the customer at the highest-anxiety
 * moment of onboarding, so the FIRST source is an authoritative company index
 * rather than heuristics on the customer's own HTML (a `Home | Acme` title
 * yields "Home"; a site with no metadata yields a titlecased domain).
 *
 *   GET https://api.logo.dev/search?q=<company-name-or-domain-label>&strategy=match
 *   Authorization: Bearer <logo.dev SECRET key>
 *   -> [{ name, domain, logo_url }, ...]   (up to 10 candidates)
 *
 * `strategy=match` ranks exact name matches first (`suggest`, the default,
 * favours popular prefix matches and is meant for typeahead). The endpoint is
 * metered on the monthly REQUEST POOL, not on the Brand API credit grant, so it
 * is safe to call on every brand create. No LLM, no run, no declared cost.
 *
 * MATCH DISCIPLINE: the endpoint is name-to-domain and returns fuzzy neighbours
 * ("Sweet Green Hotel" for "sweetgreen"), so a candidate is only trustworthy
 * when its `domain` IS the brand's own domain. A name hit on a different domain
 * is rejected, never used.
 *
 * The secret key is resolved at call time from key-service as a platform key
 * under the provider `logo-dev-secret`. NOTE the existing `logo-dev` provider
 * holds the PUBLISHABLE token (`pk_...`) used to build img.logo.dev URLs — it
 * does NOT authenticate this endpoint.
 *
 * This is one link of an explicit priority funnel (index -> page HTML ->
 * titlecased domain) with a guaranteed terminal fallback, so EVERY failure mode
 * — key absent, network error, non-2xx, unparseable body, no domain match —
 * logs loudly and returns null so the next link runs. That is a documented
 * fall-through, not a swallowed error: nothing downstream is silently degraded,
 * the caller always ends up with a name.
 */

import { getPlatformKey } from './keys-service';

const LOGO_DEV_SEARCH_URL = 'https://api.logo.dev/search';
/** The SECRET key (`sk_...`). `logo-dev` is the publishable token — wrong key here. */
const LOGO_DEV_SECRET_PROVIDER = 'logo-dev-secret';
const SEARCH_TIMEOUT_MS = 3000;

interface LogoDevSearchCandidate {
  name?: unknown;
  domain?: unknown;
}

/** Lowercase, drop a leading `www.` and a trailing dot so domains compare byte-equal. */
function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

/** The leading label of a domain — `sweetgreen` for `www.sweetgreen.com`. */
function domainLabel(domain: string): string {
  return normalizeDomain(domain).split('.')[0] ?? '';
}

/**
 * Look up a company's real display name in the logo.dev index by its domain.
 *
 * Returns the indexed name ONLY when a candidate's domain is the brand's own
 * domain; returns null on every miss or failure so the caller falls through to
 * the next source in the funnel.
 */
export async function searchBrandNameByDomain(domain: string): Promise<string | null> {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;

  let secretKey: string;
  try {
    secretKey = await getPlatformKey(LOGO_DEV_SECRET_PROVIDER, {
      method: 'POST',
      path: '/orgs/brands',
    });
  } catch (err: unknown) {
    // The key ships separately and may not be registered yet. Loud, not fatal:
    // the caller falls through to the page-HTML / titlecased-domain sources.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[brand-service] logo.dev search: platform key "${LOGO_DEV_SECRET_PROVIDER}" unavailable (${message}); falling through to page-HTML name derivation`,
    );
    return null;
  }

  // The index is keyed on company names, so query the full domain first (exact,
  // unambiguous) and retry on the bare label ("sweetgreen") when the domain form
  // returns no candidate on our own domain. Domain equality is enforced either
  // way, so the wider query cannot introduce a wrong match.
  const label = domainLabel(normalized);
  const queries = label && label !== normalized ? [normalized, label] : [normalized];

  for (const q of queries) {
    const candidates = await fetchCandidates(q, secretKey);
    if (candidates === null) return null; // hard failure — no point retrying the label

    const match = candidates.find(
      (c) =>
        typeof c.domain === 'string' &&
        normalizeDomain(c.domain) === normalized &&
        typeof c.name === 'string' &&
        c.name.trim().length > 0,
    );

    if (match) return (match.name as string).trim();
  }

  console.log(
    `[brand-service] logo.dev search: no indexed company on domain ${normalized}; falling through to page-HTML name derivation`,
  );
  return null;
}

/** Returns the candidate array, or null when the request failed outright. */
async function fetchCandidates(
  q: string,
  secretKey: string,
): Promise<LogoDevSearchCandidate[] | null> {
  const url = `${LOGO_DEV_SEARCH_URL}?q=${encodeURIComponent(q)}&strategy=match&is_profane=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(
        `[brand-service] logo.dev search: q="${q}" returned ${res.status}; falling through to page-HTML name derivation`,
      );
      return null;
    }

    const body: unknown = await res.json();
    if (!Array.isArray(body)) {
      console.warn(
        `[brand-service] logo.dev search: q="${q}" returned a non-array body; falling through to page-HTML name derivation`,
      );
      return null;
    }

    return body as LogoDevSearchCandidate[];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[brand-service] logo.dev search: q="${q}" failed (${message}); falling through to page-HTML name derivation`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

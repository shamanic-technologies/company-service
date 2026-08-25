/**
 * Brand CRUD utilities.
 *
 * brands.name is derived through ONE priority chain — NO LLM, Firecrawl,
 * chat-service, run, or cost anywhere in it:
 *
 *   1. the logo.dev company index (authoritative, domain-matched — see
 *      lib/logo-dev-search.ts)
 *   2. the landing page HTML (og:site_name / <title> / JSON-LD)
 *   3. the titlecased domain — the guaranteed non-empty terminal fallback
 *
 * The chain runs at CREATE (getOrCreateBrand) so the onboarding header has a
 * real name immediately, but the create path never WAITS on the customer's own
 * website: only the index lookup is awaited, and an index miss returns the
 * titlecased domain right away while the page-HTML derivation runs in the
 * background and upgrades that provisional value in place.
 *
 * ensureBrandName remains the read-path (getBrandDetail) safety net for rows
 * created before this — it runs the same chain and guarantees a non-null name.
 */

import { eq, and, sql, isNull } from 'drizzle-orm';
import { db, brands, orgBrands, brandClickDestinations, brandWhatsappLinks, brandColors } from '../db';
import { normalizeUrl, extractDomain } from '../lib/url-utils';
import { Caller, OrgCaller } from '../lib/chat-client';
import { buildLogoDevUrl } from '../lib/logo-dev';
import { searchBrandNameByDomain } from '../lib/logo-dev-search';
import { getBrandCheckoutStatus } from '../lib/client-client';
import { rewriteBrandReferences } from './brandMergeService';
import { enqueueBrandColors, forgetBrandColors, resetBrandColorsForNewDomain } from './brandColorsService';

interface Brand {
  id: string;
  // NULLABLE — a no-website brand has neither url nor domain (identified by name).
  url: string | null;
  name: string | null;
  domain: string | null;
}

export interface BrandDetail {
  id: string;
  // NULLABLE — a no-website brand has no domain / url. Consumers must handle null
  // (the brand is identified by `name`, which is always non-null here).
  domain: string | null;
  url: string | null;
  name: string;
  // NULLABLE — the deterministic logo.dev fill needs a domain; a no-website brand
  // (domain null) has no logo, so this stays null.
  logoUrl: string | null;
  // Page outreach clicks should land on. Defaults to the brand's own landing URL
  // (`url`) when the brand has no saved override, so a website brand's
  // `.clickDestinationUrl` is always a valid href. NULLABLE only for a no-website
  // brand (url null) with no override set — there is no landing URL to fall back
  // to. The default is computed on read (free), not persisted — the
  // click-destinations row's presence remains the "user-set" signal. Per-brand
  // config, mirrors sales-economics scoping — never on the brand identity row.
  clickDestinationUrl: string | null;
  // The brand's WhatsApp link — the click destination for the "maximize
  // WhatsApp conversations" goal. `null` when unset: unlike clickDestinationUrl
  // there is no sensible default (a brand may have no WhatsApp), so the row's
  // presence is the only "set" signal. Per-brand config, mirrors
  // click-destination scoping — never on the brand identity row.
  whatsAppLink: string | null;
  // The brand's OWN colour palette, provider-ordered hex strings, exactly as
  // logo.dev's Brand API reports them (`["#000103","#ce2e36","#003366"]`). The
  // consumer does its own selection, so nothing is pre-filtered or ranked.
  //
  // `null` is a FIRST-CLASS answer meaning "we have no colours for this brand"
  // — the domain is not indexed by the provider yet, the retrieval has not run,
  // or the provider has no palette for it. A consumer falls back to its own
  // charter on null, so a wrong or invented colour would be worse than none:
  // nothing here defaults, guesses, or derives a colour from the logo, the
  // name, or the domain. Retrieval is a decoupled cadence, never a read — see
  // services/brandColorsService.ts.
  colors: string[] | null;
  createdAt: string;
  updatedAt: string;
}

const inFlightBrandNameFills = new Map<string, Promise<string>>();

// Plain-fetch landing scrape used by the deterministic name fill. A normal
// browser User-Agent is sent because some sites 403 unknown agents; the meta
// tags we parse are absent from Firecrawl markdown, so we fetch raw HTML.
const BRAND_NAME_FETCH_TIMEOUT_MS = 5000;
const BRAND_NAME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export { extractDomain as extractDomainFromUrl };

export async function getBrand(brandId: string): Promise<Brand | null> {
  const result = await db
    .select({
      id: brands.id,
      url: brands.url,
      name: brands.name,
      domain: brands.domain,
    })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);

  return result[0] || null;
}

export async function getBrandDetail(
  brandId: string,
  caller: Caller,
): Promise<BrandDetail | null> {
  const [row] = await db
    .select({
      id: brands.id,
      domain: brands.domain,
      url: brands.url,
      name: brands.name,
      logoUrl: brands.logoUrl,
      clickDestinationUrl: brandClickDestinations.clickDestinationUrl,
      whatsAppLink: brandWhatsappLinks.whatsappLink,
      colors: brandColors.colors,
      createdAt: brands.createdAt,
      updatedAt: brands.updatedAt,
    })
    .from(brands)
    .leftJoin(
      brandClickDestinations,
      eq(brandClickDestinations.brandId, brands.id)
    )
    .leftJoin(
      brandWhatsappLinks,
      eq(brandWhatsappLinks.brandId, brands.id)
    )
    // Colours are brand IDENTITY (one palette per domain), so this joins on the
    // brand alone — no org scoping, same as name and logo.
    .leftJoin(
      brandColors,
      eq(brandColors.brandId, brands.id)
    )
    .where(eq(brands.id, brandId))
    .limit(1);

  if (!row) return null;

  const name = row.name ?? (await ensureBrandName(row.id, caller));
  // Logo fill is deterministic from the domain; a no-website brand (domain null)
  // has no logo, so it stays null rather than fabricating one.
  const logoUrl = row.logoUrl ?? (row.domain ? await ensureBrandLogoUrl(row.id) : null);

  return {
    id: row.id,
    domain: row.domain,
    url: row.url,
    name,
    logoUrl,
    // Website brands fall back to their own landing URL so the click destination
    // is never empty. A no-website brand (url null) with no override has no
    // sensible landing fallback → null.
    clickDestinationUrl: row.clickDestinationUrl ?? row.url,
    // No sensible default (a brand may have no WhatsApp) — null when unset.
    whatsAppLink: row.whatsAppLink ?? null,
    // Null until the provider actually answers with a palette. A pending or
    // given-up retrieval reads exactly like a brand nobody ever asked about,
    // which is correct: in all three cases we have no colours to serve.
    colors: row.colors ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Guarantee brands.name is non-null for the given brandId.
 *
 * If brands.name is already set, returns it as-is. Otherwise derives the name
 * deterministically from the landing page HTML (og:site_name / <title> /
 * JSON-LD, falling back to the titlecased domain) and persists it. No LLM,
 * Firecrawl, chat-service, run, or cost is involved, so the return value is
 * always a non-empty string.
 *
 * @param caller — retained for signature stability (callers pass the route's
 *   tier). The deterministic fill does not use it.
 */
export async function ensureBrandName(
  brandId: string,
  caller?: Caller,
): Promise<string> {
  const row = await getBrandNameRow(brandId);

  if (!row) throw new Error(`Brand not found: ${brandId}`);
  if (row.name) return row.name;

  // A no-website brand (url null) always has a user-provided name set at create,
  // so it returns above. If we reach here with no name AND no URL, there is no
  // source to derive a name from — fail loud rather than fabricate one.
  if (!row.url) {
    throw new Error(
      `Cannot derive name for brand ${brandId}: no stored name and no website URL to extract one from`,
    );
  }

  // Test environments bypass the network fetch. Persist domain as name so
  // callers still receive a non-null value deterministically.
  if (process.env.NODE_ENV === 'test') {
    const fallback = row.domain ?? extractDomain(row.url);
    await persistBrandName(brandId, fallback);
    return fallback;
  }

  const inFlight = inFlightBrandNameFills.get(brandId);
  if (inFlight) return inFlight;

  const fillPromise = fillBrandName(brandId).finally(() => {
    inFlightBrandNameFills.delete(brandId);
  });
  inFlightBrandNameFills.set(brandId, fillPromise);
  return fillPromise;
}

async function getBrandNameRow(brandId: string): Promise<Brand | null> {
  const [row] = await db
    .select({
      id: brands.id,
      name: brands.name,
      domain: brands.domain,
      url: brands.url,
    })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);

  return row ?? null;
}

async function persistBrandName(brandId: string, name: string): Promise<void> {
  await db
    .update(brands)
    .set({ name, updatedAt: sql`NOW()` })
    .where(eq(brands.id, brandId));
}

/**
 * Persist `name` ONLY while brands.name is still NULL, and return the name the
 * row actually ends up with. A name that is already stored is never re-derived
 * nor overwritten (that includes a user-set name and a name another concurrent
 * fill just wrote).
 */
async function persistBrandNameIfAbsent(brandId: string, name: string): Promise<string> {
  const [updated] = await db
    .update(brands)
    .set({ name, updatedAt: sql`NOW()` })
    .where(and(eq(brands.id, brandId), isNull(brands.name)))
    .returning({ name: brands.name });

  if (updated?.name) return updated.name;

  // Somebody else won the race — keep their value.
  const row = await getBrandNameRow(brandId);
  return row?.name ?? name;
}

/**
 * Resolve brands.name at CREATE time, so the onboarding header shows a real
 * company name on the very next screen instead of waiting for the first read.
 *
 * Awaits ONLY the logo.dev index lookup (our own vendor, bounded, cheap). On an
 * index miss it returns the titlecased domain immediately and kicks off the
 * page-HTML derivation in the BACKGROUND — the create call never waits on a
 * fetch of the customer's own website, and a later read never has to pay for it
 * either.
 *
 * Always returns a non-empty name.
 */
export async function fillBrandNameOnCreate(
  brandId: string,
  url: string,
  domain: string,
): Promise<string> {
  const provisional = titlecaseDomain(domain);

  // Test environments bypass the network entirely (index + landing fetch) and
  // land straight on the terminal fallback, so creates stay deterministic.
  if (process.env.NODE_ENV === 'test') {
    return persistBrandNameIfAbsent(brandId, provisional);
  }

  const indexed = await searchBrandNameByDomain(domain);
  if (indexed) {
    const stored = await persistBrandNameIfAbsent(brandId, indexed);
    console.log(`[brand-service] fillBrandNameOnCreate: resolved name "${stored}" from the company index for brand ${brandId} (${domain})`);
    return stored;
  }

  const stored = await persistBrandNameIfAbsent(brandId, provisional);

  // Only upgrade the placeholder WE just wrote. If the row already carried a
  // name, there is nothing provisional to replace.
  if (stored === provisional) {
    void upgradeProvisionalBrandName(brandId, url, domain, provisional).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[brand-service] fillBrandNameOnCreate: background name upgrade failed for brand ${brandId}: ${message}`);
    });
  }

  return stored;
}

/**
 * Background half of the create-time fill: derive the name from the landing
 * page and replace the titlecased-domain placeholder in place.
 *
 * The UPDATE is conditioned on the name still BEING that placeholder, so a real
 * name stored meanwhile (user edit, concurrent fill) is never clobbered. A page
 * that yields nothing better resolves to the same placeholder and writes
 * nothing.
 */
async function upgradeProvisionalBrandName(
  brandId: string,
  url: string,
  domain: string,
  provisional: string,
): Promise<void> {
  const derived = await deriveBrandNameFromPage(url, domain);
  if (derived === provisional) return;

  const [updated] = await db
    .update(brands)
    .set({ name: derived, updatedAt: sql`NOW()` })
    .where(and(eq(brands.id, brandId), eq(brands.name, provisional)))
    .returning({ name: brands.name });

  if (updated) {
    console.log(`[brand-service] upgradeProvisionalBrandName: brand ${brandId} "${provisional}" -> "${derived}"`);
  }
}

async function fillBrandName(brandId: string): Promise<string> {
  const row = await getBrandNameRow(brandId);

  if (!row) throw new Error(`Brand not found: ${brandId}`);
  if (row.name) return row.name;

  if (!row.url) {
    throw new Error(
      `Cannot derive name for brand ${brandId}: no stored name and no website URL to extract one from`,
    );
  }

  const domainFallback = row.domain ?? extractDomain(row.url);

  if (process.env.NODE_ENV === 'test') {
    await persistBrandName(brandId, domainFallback);
    return domainFallback;
  }

  console.log(`[brand-service] ensureBrandName: deriving name for brand ${brandId} (${row.url})`);

  const name = await deriveBrandName(row.url, domainFallback);
  await persistBrandName(brandId, name);

  console.log(`[brand-service] ensureBrandName: persisted name "${name}" for brand ${brandId}`);
  return name;
}

/**
 * Derive a brand display name with no LLM / run / cost. Priority chain:
 *   1. the logo.dev company index (domain-matched)
 *   2. the landing page HTML
 *   3. the titlecased domain
 * Always returns a non-empty string.
 */
async function deriveBrandName(url: string, domain: string): Promise<string> {
  const indexed = await searchBrandNameByDomain(domain);
  if (indexed) return indexed;

  return deriveBrandNameFromPage(url, domain);
}

/**
 * Links 2 and 3 of the chain: the landing page HTML, then the titlecased
 * domain. Split out so the create path can run it in the BACKGROUND (it is
 * bounded by a fetch of the customer's own site) after the index misses.
 */
async function deriveBrandNameFromPage(url: string, domain: string): Promise<string> {
  const html = await fetchLandingHtml(url);
  if (html === null) return titlecaseDomain(domain);
  return parseBrandNameFromHtml(html, domain);
}

async function fetchLandingHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRAND_NAME_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': BRAND_NAME_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      console.warn(`[brand-service] fillBrandName: fetch ${url} returned ${res.status}; using domain fallback`);
      return null;
    }
    return await res.text();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[brand-service] fillBrandName: fetch ${url} failed (${message}); using domain fallback`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Titlecase a bare domain into a human-ish name. Strips `www.` and the TLD
 * (everything from the first dot), splits the leading label on `-`/`_`, and
 * titlecases each token. Always returns a non-empty string.
 * e.g. "my-cool-brand.com" → "My Cool Brand", "acme.io" → "Acme".
 */
export function titlecaseDomain(domain: string): string {
  const label = domain.replace(/^www\./i, '').split('.')[0] ?? '';
  const name = label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .trim();
  return name || domain;
}

/**
 * Derive a brand display name from raw landing-page HTML. Priority:
 *   1. og:site_name meta
 *   2. <title> (trailing " | tagline" / " – tagline" suffix trimmed)
 *   3. JSON-LD Organization / WebSite `.name`
 *   4. titlecased domain fallback (always non-empty)
 */
export function parseBrandNameFromHtml(html: string, domain: string): string {
  const ogSiteName = matchMetaContent(html, 'og:site_name');
  if (ogSiteName) return ogSiteName;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const title = decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    // Sites format titles as "Brand | Tagline" / "Brand – Tagline"; take the
    // leading segment when a spaced separator is present.
    const firstSegment = title.split(/\s*[|–—]\s+|\s+-\s+|:\s+/)[0]?.trim();
    if (firstSegment) return firstSegment;
    if (title) return title;
  }

  const jsonLdName = parseJsonLdName(html);
  if (jsonLdName) return jsonLdName;

  return titlecaseDomain(domain);
}

function matchMetaContent(html: string, key: string): string | null {
  const tagRe = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const prop = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (prop !== key) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const decoded = content ? decodeEntities(content).trim() : '';
    if (decoded) return decoded;
  }
  return null;
}

function parseJsonLdName(html: string): string | null {
  const scriptRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    const name = findOrgName(parsed);
    if (name) return name;
  }
  return null;
}

function findOrgName(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findOrgName(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) {
      const found = findOrgName(obj['@graph']);
      if (found) return found;
    }
    const rawType = obj['@type'];
    const types = (Array.isArray(rawType) ? rawType : [rawType]).map((t) => String(t ?? ''));
    const isOrgOrSite = types.some(
      (t) => t === 'Organization' || t === 'WebSite' || t === 'Corporation' || t === 'LocalBusiness',
    );
    if (isOrgOrSite && typeof obj.name === 'string' && obj.name.trim()) {
      return decodeEntities(obj.name).trim();
    }
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

/**
 * Guarantee brands.logo_url is non-null for the given brandId.
 *
 * If brands.logo_url is already set, returns it as-is.
 * Otherwise computes a deterministic logo.dev URL from the brand's domain,
 * persists it, and returns it. logo.dev returns a logo image for any domain;
 * no network call is required to compute the URL.
 */
export async function ensureBrandLogoUrl(brandId: string): Promise<string> {
  const [row] = await db
    .select({ id: brands.id, logoUrl: brands.logoUrl, domain: brands.domain })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);

  if (!row) throw new Error(`Brand not found: ${brandId}`);
  if (row.logoUrl) return row.logoUrl;
  // The logo.dev URL is derived from the domain; a no-website brand (domain null)
  // has no logo. Callers must gate on `domain` before invoking this — fail loud
  // rather than fabricate a logo for a domain-less brand.
  if (!row.domain) {
    throw new Error(`Cannot build logo URL for brand ${brandId}: brand has no domain`);
  }

  // Test environments bypass key-service. Persist a deterministic stub URL so
  // tests can verify the lazy-fill code path without a live key-service.
  const logoUrl = process.env.NODE_ENV === 'test'
    ? `https://img.logo.dev/${encodeURIComponent(row.domain)}?token=test-logo-dev-token&size=256&format=png`
    : await buildLogoDevUrl(row.domain);

  await db
    .update(brands)
    .set({ logoUrl, updatedAt: sql`NOW()` })
    .where(eq(brands.id, brandId));

  console.log(`[brand-service] ensureBrandLogoUrl: persisted logo.dev URL for brand ${brandId} (${row.domain})`);
  return logoUrl;
}

/**
 * Resolve a domain (or URL) to its GLOBAL silver brand identity, creating the
 * brand row if absent — WITHOUT claiming it for any org and WITHOUT scraping.
 *
 * Unlike `getOrCreateBrand`, this does NOT write `org_brands` membership and
 * does NOT call `ensureBrandName` (no Firecrawl / LLM). The returned `name` is
 * whatever is stored on the row — `null` until populated elsewhere. Used for
 * bulk-labelling org-agnostic reference data (e.g. competitor domains) where a
 * stable brandId is needed but a claim/scrape would be wrong.
 *
 * Throws `InvalidUrlError` / `UrlRequiredError` for unparseable input — the
 * caller is expected to catch and omit invalid entries from a batch.
 */
export async function resolveBrandByDomain(
  input: string,
): Promise<{ id: string; domain: string; name: string | null }> {
  const normalizedUrl = normalizeUrl(input);
  const domain = extractDomain(normalizedUrl);

  // CASE 1: brand already exists for this domain — return stored identity as-is.
  const existing = await db
    .select({ id: brands.id, domain: brands.domain, name: brands.name })
    .from(brands)
    .where(eq(brands.domain, domain))
    .limit(1);
  // `domain` is a real, non-null domain here (derived from the input), so the
  // stored row's domain is non-null too — return the const to satisfy the type.
  if (existing.length > 0) return { id: existing[0].id, domain, name: existing[0].name };

  // CASE 2: create the global brand row. Race-safe via ON CONFLICT on the
  // unique domain index; re-fetch on conflict (a concurrent insert won).
  const inserted = await db
    .insert(brands)
    .values({ url: normalizedUrl, domain })
    .onConflictDoNothing({ target: brands.domain })
    .returning({ id: brands.id, domain: brands.domain, name: brands.name });
  if (inserted.length > 0) return { id: inserted[0].id, domain, name: inserted[0].name };

  const [refetched] = await db
    .select({ id: brands.id, domain: brands.domain, name: brands.name })
    .from(brands)
    .where(eq(brands.domain, domain))
    .limit(1);
  return { id: refetched.id, domain, name: refetched.name };
}

/**
 * Find the silver brand row for a normalized domain or create it, then
 * ensure `org_brands` membership exists for `(orgId, brand.id)` and
 * lazy-fill the brand name.
 *
 * The brand row itself is global (no org column). Membership tracking lives
 * in the `org_brands` gold table.
 */
export async function getOrCreateBrand(
  orgId: string,
  url: string,
  caller: OrgCaller,
): Promise<Brand> {
  const normalizedUrl = normalizeUrl(url);
  const domain = extractDomain(normalizedUrl);

  // CASE 1: brand already exists for this domain.
  const existing = await db
    .select({
      id: brands.id,
      url: brands.url,
      name: brands.name,
      domain: brands.domain,
    })
    .from(brands)
    .where(eq(brands.domain, domain))
    .limit(1);

  let brand: Brand;
  if (existing.length > 0) {
    brand = existing[0];
    if (brand.url !== normalizedUrl) {
      await db.update(brands).set({ url: normalizedUrl, updatedAt: sql`NOW()` }).where(eq(brands.id, brand.id));
      brand.url = normalizedUrl;
    }
    console.log(`[brand-service] Found existing brand by domain ${domain}: ${brand.id}`);
  } else {
    // CASE 2: create new brand. Race-safe insert via ON CONFLICT on the unique domain index.
    const inserted = await db
      .insert(brands)
      .values({ url: normalizedUrl, domain })
      .onConflictDoNothing({ target: brands.domain })
      .returning({
        id: brands.id,
        url: brands.url,
        name: brands.name,
        domain: brands.domain,
      });

    if (inserted.length > 0) {
      brand = inserted[0];
      console.log(`[brand-service] Created NEW brand for domain ${domain}: ${brand.id}`);
    } else {
      const [refetched] = await db
        .select({ id: brands.id, url: brands.url, name: brands.name, domain: brands.domain })
        .from(brands)
        .where(eq(brands.domain, domain))
        .limit(1);
      brand = refetched;
      console.log(`[brand-service] Re-fetched brand after conflict for domain ${domain}: ${brand.id}`);
    }
  }

  // Upsert org_brands membership. Idempotent on (orgId, brandId).
  await db
    .insert(orgBrands)
    .values({ orgId, brandId: brand.id })
    .onConflictDoNothing({ target: [orgBrands.orgId, orgBrands.brandId] });

  // Resolve the display name here so the onboarding header has a real company
  // name on the very next screen. Only the logo.dev index lookup is awaited;
  // an index miss returns the titlecased domain immediately and derives from
  // the landing page in the background, so the create never waits on a fetch of
  // the customer's own website. A brand that already has a name is untouched.
  if (!brand.name && brand.url && brand.domain) {
    brand.name = await fillBrandNameOnCreate(brand.id, brand.url, brand.domain);
  }

  // Put the brand in line for colour retrieval. Local insert only — the metered
  // logo.dev Brand call happens later on its own cadence, because that endpoint
  // answers 202 for a domain it has not indexed and only carries the palette on
  // a LATER call. Idempotent, so an existing brand is untouched.
  if (brand.domain) {
    await enqueueBrandColors(brand.id);
  }

  return brand;
}

/**
 * Machine-readable reason a domain could NOT be attached, so a UI can render
 * distinct copy per case. Both mean "someone paid on the brand holding this
 * domain" — they differ only in WHO, which drives completely different user
 * guidance ("switch to your existing brand" vs "this domain isn't yours").
 */
export type DomainConflictCode =
  /** The caller's OWN org already checked out on another brand holding this domain. */
  | 'DOMAIN_OWNED_BY_YOUR_PAID_BRAND'
  /** A DIFFERENT org checked out on the brand holding this domain. */
  | 'DOMAIN_OWNED_BY_ANOTHER_ORG';

/**
 * Thrown when adding a website to a brand collides with a domain held by a brand
 * somebody has ALREADY CHECKED OUT on. A domain held by a never-paid brand is not
 * a conflict — it is taken over (see `updateBrandWebsite`).
 */
export class BrandDomainConflictError extends Error {
  constructor(
    readonly code: DomainConflictCode,
    readonly domain: string,
    readonly conflictingBrandId: string,
  ) {
    super(
      code === 'DOMAIN_OWNED_BY_YOUR_PAID_BRAND'
        ? `Your organization already has a paid brand on domain "${domain}"`
        : `Domain "${domain}" belongs to a paid brand of another organization`,
    );
    this.name = 'BrandDomainConflictError';
  }
}

/**
 * Create a brand that has NO website — identified by a user-provided display
 * `name` instead of a URL. `url` and `domain` are left null; the extraction
 * source is the pasted business context (brand_business_context), not a scrape.
 *
 * There is no domain to dedup on, so identity is `(orgId, lower(name))`:
 * re-running the same create for the same org RETURNS the existing brand instead
 * of minting another row. Without this, a user who restarts onboarding stacks a
 * fresh brand every time (that is how one org ended up with three rows for one
 * business). Two DIFFERENT names for one org stay genuinely distinct brands, and
 * two orgs with the same name stay distinct (no cross-org reuse — there is no
 * shared domain identity to justify it).
 */
export async function createBrandWithoutWebsite(
  orgId: string,
  name: string,
): Promise<{ brand: Brand; created: boolean }> {
  // Reuse this org's existing no-website brand of the same name (case-insensitive).
  const [existing] = await db
    .select({
      id: brands.id,
      url: brands.url,
      name: brands.name,
      domain: brands.domain,
    })
    .from(orgBrands)
    .innerJoin(brands, eq(brands.id, orgBrands.brandId))
    .where(
      and(
        eq(orgBrands.orgId, orgId),
        isNull(brands.domain),
        sql`lower(${brands.name}) = lower(${name})`,
      ),
    )
    .limit(1);

  if (existing) {
    console.log(`[brand-service] Reusing existing no-website brand "${name}" for org ${orgId}: ${existing.id}`);
    return { brand: existing, created: false };
  }

  const [inserted] = await db
    .insert(brands)
    .values({ name, url: null, domain: null })
    .returning({
      id: brands.id,
      url: brands.url,
      name: brands.name,
      domain: brands.domain,
    });

  await db
    .insert(orgBrands)
    .values({ orgId, brandId: inserted.id })
    .onConflictDoNothing({ target: [orgBrands.orgId, orgBrands.brandId] });

  console.log(`[brand-service] Created NEW no-website brand "${name}": ${inserted.id}`);
  return { brand: inserted, created: true };
}

/**
 * Attach a website to an existing brand (e.g. a no-website brand whose user later
 * adds their site). Normalizes the URL, derives the domain, and persists both on
 * the brand identity row.
 *
 * The extraction source-switch is automatic and rides the EXISTING field cache:
 * `extractFields` reads `brands.url` fresh on every call, so once the URL is set,
 * the next post-cache-expiry extraction re-sources from the site — no new
 * TTL/cron.
 *
 * DOMAIN OWNERSHIP RULE (owner decision, 2026-07-29): a domain belongs to
 * whoever has CHECKED OUT on it. When another brand row already holds the derived
 * domain, client-service (the single source of truth for checkout) decides:
 *
 * - nobody ever checked out on the holder  → the domain is up for grabs: it is
 *   MOVED onto `brandId`, and the holder is left as a no-website brand so any
 *   other org still pointing at it keeps a working identity.
 * - the CALLER's org checked out on it     → `DOMAIN_OWNED_BY_YOUR_PAID_BRAND`
 * - ANOTHER org checked out on it          → `DOMAIN_OWNED_BY_ANOTHER_ORG`
 *
 * Both refusals are 409 `BrandDomainConflictError` with a distinct `code` so a UI
 * can render distinct copy. A failure to reach client-service throws (502) — it
 * is never treated as "nobody paid", which would let a domain be taken from a
 * paying org.
 *
 * Cleanup: when the never-paid holder belongs to the CALLER's own org, its child
 * rows are merged onto `brandId` (target always wins on conflict) and the org's
 * membership row is dropped, so the abandoned shell stops polluting their brand
 * list. Holders belonging to OTHER orgs are never unlinked or stripped.
 */
export async function updateBrandWebsite(
  brandId: string,
  url: string,
  callerOrgId: string,
): Promise<Brand> {
  const normalizedUrl = normalizeUrl(url);
  const domain = extractDomain(normalizedUrl);

  // Another brand row may already hold this domain (the unique index would 23505
  // anyway; resolve it first so the outcome is a takeover or a clean 409).
  const [holder] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(eq(brands.domain, domain))
    .limit(1);

  if (holder && holder.id !== brandId) {
    // Throws when client-service can't answer — never assume "nobody paid".
    const checkout = await getBrandCheckoutStatus(holder.id);

    if (checkout.checkedOut) {
      throw new BrandDomainConflictError(
        checkout.orgIds.includes(callerOrgId)
          ? 'DOMAIN_OWNED_BY_YOUR_PAID_BRAND'
          : 'DOMAIN_OWNED_BY_ANOTHER_ORG',
        domain,
        holder.id,
      );
    }

    await takeOverDomain({ holderBrandId: holder.id, targetBrandId: brandId, callerOrgId, domain });
  }

  const [updated] = await db
    .update(brands)
    .set({ url: normalizedUrl, domain, updatedAt: sql`NOW()` })
    .where(eq(brands.id, brandId))
    .returning({
      id: brands.id,
      url: brands.url,
      name: brands.name,
      domain: brands.domain,
    });

  if (!updated) throw new Error(`Brand not found: ${brandId}`);

  // The brand now stands for a DIFFERENT domain, so any palette we hold is
  // another business's colours. Drop it and queue the new domain.
  await resetBrandColorsForNewDomain(brandId);

  console.log(`[brand-service] Attached website ${normalizedUrl} (domain ${domain}) to brand ${brandId}`);
  return updated;
}

/**
 * Release `domain` from a never-paid holder brand so the caller's brand can take
 * it, and absorb the holder when it belongs to the caller's own org.
 *
 * Runs BEFORE the target's domain is written: the unique index on `brands.domain`
 * means the holder must be cleared first. The reference merge runs before the
 * clear so a failure leaves the domain exactly where it was (and both steps are
 * idempotent, so a retry converges).
 */
async function takeOverDomain(params: {
  holderBrandId: string;
  targetBrandId: string;
  callerOrgId: string;
  domain: string;
}): Promise<void> {
  const { holderBrandId, targetBrandId, callerOrgId, domain } = params;

  const [callerClaimsHolder] = await db
    .select({ brandId: orgBrands.brandId })
    .from(orgBrands)
    .where(and(eq(orgBrands.orgId, callerOrgId), eq(orgBrands.brandId, holderBrandId)))
    .limit(1);

  if (callerClaimsHolder) {
    // The abandoned holder is the caller's own row — absorb its data into the
    // brand that is taking the domain (target wins on every conflict).
    const merged = await rewriteBrandReferences(holderBrandId, targetBrandId);
    console.log(
      `[brand-service] Domain takeover merge ${holderBrandId} -> ${targetBrandId}: ${JSON.stringify(merged)}`,
    );
  }

  // Release the domain. The holder survives as a no-website brand so any OTHER
  // org still claiming it keeps a working (if website-less) identity.
  await db
    .update(brands)
    .set({ domain: null, url: null, updatedAt: sql`NOW()` })
    .where(eq(brands.id, holderBrandId));

  // The holder has no domain left to derive colours from. Forget its palette
  // rather than keep serving the colours of a domain it no longer holds.
  await forgetBrandColors(holderBrandId);

  if (callerClaimsHolder) {
    // Stop the emptied shell from polluting the caller's brand list. Other orgs'
    // memberships are left untouched.
    await db
      .delete(orgBrands)
      .where(and(eq(orgBrands.orgId, callerOrgId), eq(orgBrands.brandId, holderBrandId)));
  }

  console.log(
    `[brand-service] Domain "${domain}" taken from never-paid brand ${holderBrandId} for brand ${targetBrandId} (org ${callerOrgId}, absorbed=${Boolean(callerClaimsHolder)})`,
  );
}

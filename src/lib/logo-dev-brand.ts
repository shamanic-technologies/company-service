/**
 * logo.dev Brand API — a brand's own colour palette.
 *
 *   GET https://api.logo.dev/brand/<domain>
 *   Authorization: Bearer <logo.dev SECRET key>
 *   -> { name, domain, description, logo, colors: [{ r, g, b, hex }, ...], ... }
 *
 * Three properties of this endpoint drive every decision here, all measured
 * against production on 2026-08-25:
 *
 * 1. IT IS ASYNCHRONOUS. A domain logo.dev has not indexed answers
 *    `202 {"msg":"not found, looking up"}` and is QUEUED for indexing; the
 *    palette can only be read on a LATER call. Six of our seven live domains
 *    answered 202, and were still 202 on a re-poll two minutes later. So a
 *    caller that requests and reads in the same run stores nothing, forever —
 *    the retrieval MUST be retried on a cadence of its own. See
 *    services/brandColorsService.ts.
 * 2. IT IS METERED ON A SEPARATE PREPAID CREDIT GRANT (~100 calls/month on
 *    Community), NOT the monthly request pool the Search endpoint uses. It hard
 *    -fails 402 when the grant is exhausted and exposes NO quota header, so the
 *    volume has to be bounded by us — never per brand-read, never per request.
 * 3. IT AUTHENTICATES WITH THE SECRET KEY (`sk_...`, platform provider
 *    `logo-dev-secret`). The publishable `pk_...` token under `logo-dev` signs
 *    img.logo.dev URLs and does NOT authenticate this endpoint.
 *
 * Every outcome is explicit and named. Nothing here throws, nothing is
 * swallowed: each failure mode logs loudly and resolves to an outcome the
 * caller records, so "we have no colours for this brand" is always a decision
 * somebody can read back out of the ledger rather than a silence.
 */

const LOGO_DEV_BRAND_URL = 'https://api.logo.dev/brand';
const BRAND_TIMEOUT_MS = 8000;

/** A hex colour exactly as the provider spells it — `#rgb`, `#rrggbb`, `#rrggbbaa`. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export type LogoDevBrandOutcome =
  /** The provider answered with a palette. `colors` is non-empty, provider-ordered. */
  | { outcome: 'colors'; colors: string[]; httpStatus: number }
  /** 202 — the domain is not indexed YET and is now queued. Retry later. */
  | { outcome: 'pending'; httpStatus: number; detail: string }
  /** The provider knows the domain and reports no usable palette. Terminal. */
  | { outcome: 'no_colors'; httpStatus: number; detail: string }
  /** 402 — the prepaid Brand-API grant is spent. Stop calling. */
  | { outcome: 'exhausted'; httpStatus: number; detail: string }
  /** Network error, non-2xx, unparseable body. Retryable. */
  | { outcome: 'failed'; httpStatus: number | null; detail: string };

interface LogoDevBrandColor {
  hex?: unknown;
}

/** Lowercase, drop a leading `www.` and a trailing dot so domains compare byte-equal. */
export function normalizeBrandDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

/**
 * Read the provider's `colors` array as an ordered list of hex strings.
 *
 * The provider ships `[{ r, g, b, hex }]`; a bare string array is accepted too
 * because the only thing we store is the hex. NOTHING is filtered, ranked or
 * de-duplicated — the consumer does its own selection, so the order the
 * provider gave is the order we keep. An entry without a well-formed hex is
 * dropped (it carries no colour we could honestly store); a payload that yields
 * no colour at all is `no_colors`, never an empty palette.
 */
export function parseLogoDevColors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const colors: string[] = [];
  for (const entry of raw) {
    const hex =
      typeof entry === 'string'
        ? entry
        : entry && typeof entry === 'object' && typeof (entry as LogoDevBrandColor).hex === 'string'
          ? ((entry as LogoDevBrandColor).hex as string)
          : null;
    if (hex && HEX_COLOR.test(hex.trim())) colors.push(hex.trim());
  }
  return colors;
}

/**
 * Spend ONE metered Brand-API call on `domain`.
 *
 * The caller owns the budget and the cadence; this function makes exactly one
 * request and reports what came back.
 */
export async function fetchBrandColorsFromLogoDev(
  domain: string,
  secretKey: string,
): Promise<LogoDevBrandOutcome> {
  const normalized = normalizeBrandDomain(domain);
  if (!normalized) {
    return { outcome: 'failed', httpStatus: null, detail: 'empty domain' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRAND_TIMEOUT_MS);

  try {
    const res = await fetch(`${LOGO_DEV_BRAND_URL}/${encodeURIComponent(normalized)}`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        Accept: 'application/json',
      },
    });

    const text = await res.text();

    // 402 — the prepaid grant is spent. Loud, and the caller must STOP: every
    // further call this month would 402 too.
    if (res.status === 402) {
      console.error(
        `[brand-service] logo.dev brand: PREPAID BRAND-API GRANT EXHAUSTED (402) on ${normalized}. No colours will be retrieved until the grant is topped up. Body: ${text.slice(0, 200)}`,
      );
      return { outcome: 'exhausted', httpStatus: 402, detail: text.slice(0, 200) };
    }

    // 202 — not indexed yet, now queued. This is the NORMAL first answer for a
    // domain logo.dev has never seen, and the whole reason retrieval is retried
    // on its own cadence instead of read in the run that asked for it.
    if (res.status === 202) {
      console.log(
        `[brand-service] logo.dev brand: ${normalized} not indexed yet (202, queued by the provider); will retry on the colour-refresh cadence`,
      );
      return { outcome: 'pending', httpStatus: 202, detail: text.slice(0, 200) };
    }

    if (!res.ok) {
      console.warn(
        `[brand-service] logo.dev brand: ${normalized} returned ${res.status}; no colours stored. Body: ${text.slice(0, 200)}`,
      );
      return { outcome: 'failed', httpStatus: res.status, detail: text.slice(0, 200) };
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      console.warn(
        `[brand-service] logo.dev brand: ${normalized} returned an unparseable body; no colours stored. Body: ${text.slice(0, 200)}`,
      );
      return { outcome: 'failed', httpStatus: res.status, detail: 'unparseable JSON body' };
    }

    const colors = parseLogoDevColors((body as { colors?: unknown } | null)?.colors);
    if (colors.length === 0) {
      console.warn(
        `[brand-service] logo.dev brand: ${normalized} is indexed but carries no usable colour; recording "no colours" rather than inventing one`,
      );
      return { outcome: 'no_colors', httpStatus: res.status, detail: 'indexed, empty palette' };
    }

    console.log(
      `[brand-service] logo.dev brand: ${normalized} -> ${colors.length} colour(s) ${colors.join(' ')}`,
    );
    return { outcome: 'colors', colors, httpStatus: res.status };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[brand-service] logo.dev brand: ${normalized} failed (${message}); no colours stored`,
    );
    return { outcome: 'failed', httpStatus: null, detail: message };
  } finally {
    clearTimeout(timer);
  }
}

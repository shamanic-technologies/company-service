/**
 * A brand's colour palette: enqueue, retrieve on a cadence of its own, serve.
 *
 * WHY THIS IS A QUEUE AND NOT A FETCH. The logo.dev Brand endpoint is
 * ASYNCHRONOUS for any domain it has not indexed: it answers `202 {"msg":"not
 * found, looking up"}` and queues the domain on its side, so the palette only
 * exists on a LATER call. Measured 2026-08-25 across our seven live domains,
 * ONE answered 200 with colours and six answered 202 — still 202 two minutes
 * later. Any design that requests the palette and reads the result in the SAME
 * run therefore stores nothing and never retries, and the brand keeps an empty
 * value forever. So the RETRIEVAL runs on its own cadence, decoupled from
 * whatever write first enqueued the brand. This is the single most important
 * property of the feature — do not collapse the enqueue and the fetch back into
 * one call.
 *
 * WHY THE VOLUME IS BOUNDED HERE. That endpoint is metered on a SEPARATE
 * prepaid credit grant (~100 calls/month on Community), hard-fails 402 when
 * exhausted, and exposes NO quota header — we cannot read the remaining
 * balance, so we bound the spend ourselves:
 *
 *   - the work list is a QUEUE (`brand_colors` rows at status 'pending'), never
 *     a sweep of the `brands` table — a sweep of 156 rows would blow a month's
 *     grant in one pass, and 149 of those brands are not live;
 *   - a brand costs at most MAX_ATTEMPTS calls, ever, then goes 'unavailable';
 *   - a run costs at most PER_RUN_LIMIT calls;
 *   - a CALENDAR MONTH costs at most MONTHLY_CALL_BUDGET calls across all
 *     brands, counted off the `logo_dev_brand_calls` ledger (the meter the
 *     vendor does not give us);
 *   - a 402 stops the run on the spot.
 *
 * NOTHING here reads or fetches per request: `getBrandDetail` and the org brand
 * list join the stored palette, and that is the only read path.
 *
 * ABSENCE IS AN ANSWER. A brand with no row, a row still pending, or a row that
 * went 'unavailable' all serve `colors: null` — cleanly distinguishable from a
 * brand that carries a palette. No colour is invented, defaulted, or derived
 * from anything other than the provider.
 */

import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db, brandColors, brands, logoDevBrandCalls } from '../db';
import { getPlatformKey } from '../lib/keys-service';
import { fetchBrandColorsFromLogoDev, LogoDevBrandOutcome } from '../lib/logo-dev-brand';
import { nextBrandColorsState } from '../lib/brand-colors-plan';

/** The SECRET key (`sk_...`). `logo-dev` holds the publishable token — wrong key here. */
const LOGO_DEV_SECRET_PROVIDER = 'logo-dev-secret';

/**
 * Metered calls a single brand may ever cost. A domain logo.dev never indexes
 * would otherwise be retried forever; after this many the row goes
 * 'unavailable' and the brand renders on the consumer's own fallback.
 */
export const MAX_ATTEMPTS = 8;

/** Metered calls one refresh pass may spend. */
export const PER_RUN_LIMIT = 5;

/**
 * Metered calls a CALENDAR MONTH may spend, across every brand. Deliberately
 * well under the ~100/month Community grant so the headroom absorbs anything
 * that calls the endpoint outside this cadence.
 */
export const MONTHLY_CALL_BUDGET = 60;

export interface RefreshBrandColorsSummary {
  considered: number;
  called: number;
  resolved: number;
  stillPending: number;
  unavailable: number;
  failed: number;
  /** Set when the pass stopped early: the month's budget, or a provider 402. */
  stoppedReason: 'monthly_budget' | 'grant_exhausted' | 'key_unavailable' | null;
}

/**
 * Put a brand in line for colour retrieval. Cheap and local — NO metered call
 * happens here, which is exactly what lets this sit on the brand-create path.
 * Idempotent: a brand already queued or already resolved is left alone.
 */
export async function enqueueBrandColors(brandId: string): Promise<void> {
  await db
    .insert(brandColors)
    .values({ brandId, status: 'pending', attempts: 0 })
    .onConflictDoNothing({ target: brandColors.brandId });
}

/**
 * A brand's domain CHANGED, so whatever palette we hold describes a different
 * business — drop it and queue the new domain. Colours are derived from the
 * domain, so keeping them across a domain change would serve one company's
 * colours for another's.
 */
export async function resetBrandColorsForNewDomain(brandId: string): Promise<void> {
  await db
    .insert(brandColors)
    .values({ brandId, status: 'pending', attempts: 0 })
    .onConflictDoUpdate({
      target: brandColors.brandId,
      set: {
        colors: null,
        status: 'pending',
        attempts: 0,
        lastAttemptAt: null,
        resolvedAt: null,
        updatedAt: sql`NOW()`,
      },
    });
}

/**
 * A brand LOST its domain (the domain-takeover path leaves the never-paid
 * holder as a no-website brand). It has no domain to derive colours from, so
 * the row goes away entirely rather than serving a stale palette.
 */
export async function forgetBrandColors(brandId: string): Promise<void> {
  await db.delete(brandColors).where(eq(brandColors.brandId, brandId));
}

/** Metered Brand-API calls already spent this calendar month. */
export async function callsThisMonth(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(logoDevBrandCalls)
    .where(gte(logoDevBrandCalls.calledAt, sql`date_trunc('month', NOW())`));
  return row?.n ?? 0;
}

/**
 * One pass of the retrieval cadence: spend up to PER_RUN_LIMIT metered calls on
 * the oldest un-answered brands, and record what each one said.
 *
 * Candidate order is fewest-attempts-first, then longest-unattempted, so a
 * brand that just arrived from signup is served before a domain that has
 * already been asked about six times.
 */
export interface RefreshBrandColorsOptions {
  /**
   * Restrict the pass to these brands. Omitted, the pass takes the whole queue
   * — which is the cadence's normal behaviour. Naming brands is for a targeted
   * re-drive (an operator pushing one customer's colours through, a test
   * asserting one brand's transitions without racing the rest of the queue);
   * it narrows the work list and changes nothing else, budget included.
   */
  brandIds?: string[];
}

export async function refreshPendingBrandColors(
  options: RefreshBrandColorsOptions = {},
): Promise<RefreshBrandColorsSummary> {
  const summary: RefreshBrandColorsSummary = {
    considered: 0,
    called: 0,
    resolved: 0,
    stillPending: 0,
    unavailable: 0,
    failed: 0,
    stoppedReason: null,
  };

  const spent = await callsThisMonth();
  const remaining = MONTHLY_CALL_BUDGET - spent;
  if (remaining <= 0) {
    console.warn(
      `[brand-service] brand colours: monthly Brand-API budget spent (${spent}/${MONTHLY_CALL_BUDGET}); no colours retrieved until next month`,
    );
    summary.stoppedReason = 'monthly_budget';
    return summary;
  }

  const limit = Math.min(PER_RUN_LIMIT, remaining);

  const candidates = await db
    .select({ brandId: brandColors.brandId, domain: brands.domain, attempts: brandColors.attempts })
    .from(brandColors)
    .innerJoin(brands, eq(brands.id, brandColors.brandId))
    .where(
      and(
        eq(brandColors.status, 'pending'),
        lt(brandColors.attempts, MAX_ATTEMPTS),
        isNotNull(brands.domain),
        ...(options.brandIds ? [inArray(brandColors.brandId, options.brandIds)] : []),
      ),
    )
    .orderBy(
      brandColors.attempts,
      sql`${brandColors.lastAttemptAt} ASC NULLS FIRST`,
    )
    .limit(limit);

  summary.considered = candidates.length;
  if (candidates.length === 0) return summary;

  // Resolved once per pass, not per brand. A key we cannot read is a loud stop,
  // not a silent no-op: without it nothing can be retrieved at all.
  let secretKey: string;
  try {
    secretKey = await getPlatformKey(LOGO_DEV_SECRET_PROVIDER, {
      method: 'GET',
      path: '/internal/brand-colors/refresh',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[brand-service] brand colours: platform key "${LOGO_DEV_SECRET_PROVIDER}" unavailable (${message}); ${candidates.length} brand(s) stay without colours this pass`,
    );
    summary.stoppedReason = 'key_unavailable';
    return summary;
  }

  for (const candidate of candidates) {
    const result = await fetchBrandColorsFromLogoDev(candidate.domain!, secretKey);
    summary.called += 1;

    await recordCall(candidate.domain!, result);

    if (result.outcome === 'exhausted') {
      // The grant is spent — every further call this month answers 402 too.
      // The brand keeps its attempt count untouched: it did not get an answer.
      summary.called -= 1;
      summary.stoppedReason = 'grant_exhausted';
      break;
    }

    await applyOutcome(candidate.brandId, candidate.attempts, result, summary);
  }

  console.log(
    `[brand-service] brand colours: pass done ${JSON.stringify(summary)} (month ${spent + summary.called}/${MONTHLY_CALL_BUDGET})`,
  );
  return summary;
}

async function recordCall(domain: string, result: LogoDevBrandOutcome): Promise<void> {
  await db.insert(logoDevBrandCalls).values({
    domain,
    outcome: result.outcome,
    httpStatus: result.httpStatus ?? null,
    detail: result.outcome === 'colors' ? `${result.colors.length} colour(s)` : result.detail,
  });
}

async function applyOutcome(
  brandId: string,
  attemptsBefore: number,
  result: LogoDevBrandOutcome,
  summary: RefreshBrandColorsSummary,
): Promise<void> {
  const next = nextBrandColorsState(
    attemptsBefore,
    result.outcome,
    result.outcome === 'colors' ? result.colors : [],
    MAX_ATTEMPTS,
  );

  await db
    .update(brandColors)
    .set({
      colors: next.colors,
      status: next.status,
      attempts: next.attempts,
      lastAttemptAt: sql`NOW()`,
      resolvedAt: next.status === 'resolved' ? sql`NOW()` : undefined,
      updatedAt: sql`NOW()`,
    })
    .where(eq(brandColors.brandId, brandId));

  if (next.status === 'resolved') {
    summary.resolved += 1;
    return;
  }

  if (result.outcome === 'failed') summary.failed += 1;

  if (next.status === 'unavailable') {
    summary.unavailable += 1;
    if (result.outcome !== 'no_colors') {
      console.warn(
        `[brand-service] brand colours: brand ${brandId} gave up after ${next.attempts} attempt(s) (last: ${result.outcome}); it renders on the consumer's own fallback`,
      );
    }
    return;
  }

  if (result.outcome === 'pending') summary.stillPending += 1;
}

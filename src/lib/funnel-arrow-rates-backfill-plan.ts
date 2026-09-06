/**
 * What the one-time arrow-rate backfill will write, computed as a pure function
 * of what a brand has already stated.
 *
 * Every rate a brand has stated so far lives in a NAMED column on
 * `brand_sales_funnels` — one column per arrow the catalogue happens to contain.
 * Each of those columns IS the rate of a specific arrow of a specific funnel,
 * and the catalogue already says which: `funnelArrows` maps a funnel's steps
 * onto its legs, which is exactly the correspondence that lets the named set
 * answer per-arrow questions today. This walks that mapping in the other
 * direction and makes the same statement readable in the arrow vocabulary.
 *
 * IT MOVES NO FIGURE. The number written for an arrow is the number the named
 * column already holds, at the same precision and scale, and the named column is
 * left exactly where it is. A brand's economics before and after are identical:
 * the statement gains a second shape, it is not restated.
 *
 * IT INVENTS NOTHING. Only a named column that HOLDS a number produces an arrow.
 * An arrow no brand has stated a rate for — a leg left blank, an arrow the
 * catalogue does not name — gets no row: no default, no average, no zero.
 *
 * It lives here, apart from the script that runs it, so the plan is testable
 * without a database and so the dry run and the real run compute the IDENTICAL
 * plan — a dry run that reasons differently from the write is not a dry run.
 */

import {
  funnelArrows,
  isSalesFunnelKey,
  salesFunnelByKey,
  type SalesFunnelKey,
  type SalesFunnelRateKey,
} from '../services/salesFunnelCatalogue';

/**
 * One funnel declaration, with the named rates it holds.
 *
 * A rate is `null` when the brand never stated it, which is the only "not
 * stated" the named columns can express — and the only one this reads.
 */
export interface ArrowRatesBackfillCandidate {
  orgId: string;
  brandId: string;
  /**
   * The offer this declaration prices. NULL on a row the offer migration has
   * not reached; the arrow table requires one, so such a row is skipped rather
   * than written under a guessed offer.
   */
  offerId: string | null;
  funnelKey: string;
  namedRates: Partial<Record<SalesFunnelRateKey, number | null>>;
}

/** One arrow to write: the two steps it connects and the rate already stated. */
export interface PlannedArrowRate {
  orgId: string;
  brandId: string;
  offerId: string;
  funnelKey: SalesFunnelKey;
  fromStep: string;
  toStep: string;
  ratePct: number;
  /** The named column this rate was read from. Reported, never stored. */
  rateKey: SalesFunnelRateKey;
}

/** Why a candidate produced no arrows. Counted and printed, never silent. */
export type ArrowRatesBackfillSkipReason =
  /** The stored funnel key names no funnel in the catalogue. Never guessed at. */
  | 'unrecognised_funnel_key'
  /** The declaration predates the offer migration, and an arrow needs an offer. */
  | 'no_offer'
  /** Every named column on the declaration is empty: the brand stated nothing. */
  | 'nothing_stated';

export interface ArrowRatesBackfillSkip {
  candidate: ArrowRatesBackfillCandidate;
  reason: ArrowRatesBackfillSkipReason;
}

export interface ArrowRatesBackfillPlan {
  rows: PlannedArrowRate[];
  skipped: ArrowRatesBackfillSkip[];
  /**
   * The declarations the plan actually reads arrows out of, which is what the
   * idempotency marker is stamped on. A declaration that produced no arrow is
   * NOT here: nothing was written from it, so nothing claims it was.
   */
  declarations: { orgId: string; brandId: string; funnelKey: SalesFunnelKey; offerId: string }[];
}

/**
 * The arrows one declaration states: its funnel's own arrows, intersected with
 * the named columns that hold a number.
 *
 * The catalogue owns which arrows a funnel has and which named rate covers each
 * one, so neither is guessed here. An arrow whose named column is null, or whose
 * column this declaration does not carry, is simply absent from the result.
 */
export function arrowsForDeclaration(
  candidate: ArrowRatesBackfillCandidate & { offerId: string; funnelKey: SalesFunnelKey }
): PlannedArrowRate[] {
  const out: PlannedArrowRate[] = [];
  for (const arrow of funnelArrows(salesFunnelByKey(candidate.funnelKey))) {
    const stated = candidate.namedRates[arrow.rateKey];
    if (stated === null || stated === undefined) continue;
    out.push({
      orgId: candidate.orgId,
      brandId: candidate.brandId,
      offerId: candidate.offerId,
      funnelKey: candidate.funnelKey,
      fromStep: arrow.fromStep,
      toStep: arrow.toStep,
      ratePct: stated,
      rateKey: arrow.rateKey,
    });
  }
  return out;
}

export function planArrowRatesBackfill(
  candidates: ArrowRatesBackfillCandidate[]
): ArrowRatesBackfillPlan {
  const rows: PlannedArrowRate[] = [];
  const skipped: ArrowRatesBackfillSkip[] = [];
  const declarations: ArrowRatesBackfillPlan['declarations'] = [];

  for (const candidate of candidates) {
    if (!isSalesFunnelKey(candidate.funnelKey)) {
      skipped.push({ candidate, reason: 'unrecognised_funnel_key' });
      continue;
    }
    if (candidate.offerId === null) {
      skipped.push({ candidate, reason: 'no_offer' });
      continue;
    }
    const arrows = arrowsForDeclaration({
      ...candidate,
      offerId: candidate.offerId,
      funnelKey: candidate.funnelKey,
    });
    if (arrows.length === 0) {
      skipped.push({ candidate, reason: 'nothing_stated' });
      continue;
    }
    rows.push(...arrows);
    declarations.push({
      orgId: candidate.orgId,
      brandId: candidate.brandId,
      funnelKey: candidate.funnelKey,
      offerId: candidate.offerId,
    });
  }

  return { rows, skipped, declarations };
}

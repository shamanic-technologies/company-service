/**
 * What the one-time economics backfill will write onto the funnel declarations
 * the goal→funnel backfill created, computed as a pure function of what the
 * database holds.
 *
 * A brand that priced its business BEFORE the funnel model existed stated its
 * conversion rates and its lifetime revenue on `brand_sales_economics`, which is
 * BRAND-WIDE: one set of numbers, no funnel. The goal→funnel backfill then gave
 * that brand the declaration its goal meant, carrying the funnel key and its
 * provenance and NOTHING ELSE — so Settings renders every rate field and the
 * lifetime revenue field empty on a funnel the customer had already priced.
 * This moves those numbers from the model they were stated in onto the model
 * that replaced them. It is a migration of what the customer already told us,
 * not a defaulting layer: nothing is derived on read, and a brand that stated
 * nothing keeps reading as absent.
 *
 * It lives here, apart from the script that runs it, so the plan is testable
 * without a database and so the dry run and the real run compute the IDENTICAL
 * plan — a dry run that reasons differently from the write is not a dry run.
 *
 * TWO RULES DECIDE EVERY VALUE, and both are about not inventing one:
 *
 *  1. A rate is copied ONLY onto a leg of the funnel's OWN funnel, and only when
 *     `brand_sales_economics` holds a column of that exact name. The catalogue
 *     owns the funnels, so which legs a funnel has is never guessed here.
 *     `meetingBookedToAttendedPct` — the meeting show-up rate — exists only on
 *     the funnel table and was never stated anywhere, so it stays NULL. That is
 *     the whole of the mapping: same name, same number, nothing else.
 *  2. Only a funnel that holds no number AT ALL is filled. A funnel a human
 *     priced is never touched, not even on a column they left empty — the
 *     numbers on it are the ones they chose to state, and half-filling it from a
 *     brand-wide record would put a value they did not enter beside the ones
 *     they did. Note what this rule does NOT say: it does not ask who declared
 *     the funnel. It once did, and the provenance clause turned out to hide the
 *     brands most in need of it — the ones who declared a funnel by hand and
 *     left it blank, priced until now by the brand-wide record that is being
 *     retired underneath them.
 */

import {
  funnelRateKeys,
  salesFunnelByKey,
  type SalesFunnelKey,
  type SalesFunnelRateKey,
} from '../services/salesFunnelCatalogue';

/**
 * The brand-wide numbers, as `brand_sales_economics` stores them.
 *
 * Every rate there is NOT NULL, so a row exists only because a caller wrote one:
 * the brand went through the economics form and stated these. Absence of the ROW
 * is the only "never stated" this table can express, and it is handled by the
 * candidate never being produced.
 */
export interface StatedEconomics {
  lifetimeRevenueUsd: number;
  replyToMeetingPct: number;
  visitToMeetingPct: number;
  meetingToClosePct: number;
  visitToSignupPct: number;
  signupToPaidClientPct: number;
  visitToFormSubmissionPct: number;
  formSubmissionToPaidClientPct: number;
}

/**
 * The economics columns a funnel leg can be filled from — the seven legs whose
 * name `brand_sales_economics` shares. A leg absent from here was never stated
 * anywhere and is left NULL.
 */
const STATED_RATE_KEYS = [
  'replyToMeetingPct',
  'visitToMeetingPct',
  'meetingToClosePct',
  'visitToSignupPct',
  'signupToPaidClientPct',
  'visitToFormSubmissionPct',
  'formSubmissionToPaidClientPct',
] as const satisfies readonly SalesFunnelRateKey[];

type StatedRateKey = (typeof STATED_RATE_KEYS)[number];

function isStatedRateKey(key: SalesFunnelRateKey): key is StatedRateKey {
  return (STATED_RATE_KEYS as readonly string[]).includes(key);
}

/** One unpriced backfilled declaration, beside the numbers its brand stated. */
export interface EconomicsBackfillCandidate {
  orgId: string;
  brandId: string;
  funnelKey: SalesFunnelKey;
  economics: StatedEconomics;
}

export interface PlannedEconomicsFill {
  orgId: string;
  brandId: string;
  funnelKey: SalesFunnelKey;
  lifetimeRevenueUsd: number;
  /** Only the legs of this funnel's funnel that the brand actually stated. */
  rates: Partial<Record<SalesFunnelRateKey, number>>;
}

/** Why a candidate produced no fill. Counted and printed, never silent. */
export type EconomicsBackfillSkipReason =
  /** The stored funnel key names no funnel in the catalogue. Never guessed at. */
  'unrecognised_funnel_key';

export interface EconomicsBackfillSkip {
  candidate: EconomicsBackfillCandidate;
  reason: EconomicsBackfillSkipReason;
}

export interface EconomicsBackfillPlan {
  rows: PlannedEconomicsFill[];
  skipped: EconomicsBackfillSkip[];
}

/**
 * The rates to write onto one funnel: its own funnel, intersected with what the
 * brand stated. A leg the brand never stated is simply absent from the result —
 * it is never written as 0 and never borrowed from another leg.
 */
export function ratesForFunnel(
  funnelKey: SalesFunnelKey,
  economics: StatedEconomics
): Partial<Record<SalesFunnelRateKey, number>> {
  const rates: Partial<Record<SalesFunnelRateKey, number>> = {};
  for (const leg of funnelRateKeys(salesFunnelByKey(funnelKey))) {
    if (isStatedRateKey(leg)) rates[leg] = economics[leg];
  }
  return rates;
}

export function planEconomicsBackfill(
  candidates: EconomicsBackfillCandidate[]
): EconomicsBackfillPlan {
  const rows: PlannedEconomicsFill[] = [];
  const skipped: EconomicsBackfillSkip[] = [];

  for (const candidate of candidates) {
    let rates: Partial<Record<SalesFunnelRateKey, number>>;
    try {
      rates = ratesForFunnel(candidate.funnelKey, candidate.economics);
    } catch {
      skipped.push({ candidate, reason: 'unrecognised_funnel_key' });
      continue;
    }
    rows.push({
      orgId: candidate.orgId,
      brandId: candidate.brandId,
      funnelKey: candidate.funnelKey,
      lifetimeRevenueUsd: candidate.economics.lifetimeRevenueUsd,
      rates,
    });
  }

  return { rows, skipped };
}

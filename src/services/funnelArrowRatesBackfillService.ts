/**
 * The database half of the one-time arrow-rate backfill: which declarations are
 * candidates, and the write that makes their named rates readable per arrow.
 *
 * It lives here rather than inside the script so the thing that RUNS in
 * production is the thing the tests exercise. The script is a CLI around these
 * two functions and nothing else.
 *
 * WHAT THE PREDICATES MEAN:
 *  - `arrow_rates_backfilled_at IS NULL` is the whole of idempotency. A second
 *    run produces no candidate at all, so it writes nothing — and, less
 *    obviously, it cannot resurrect an arrow the customer DELETED after the
 *    first run, which a "insert whatever is missing" rule would do every time.
 *  - the insert conflicts away on the natural key `(offer_id, funnel_key,
 *    from_step, to_step)`, so an arrow the brand had already stated arrow-first
 *    is left exactly as they stated it. Precedence is untouched: the stated
 *    arrow was already winning and keeps winning, with its own number.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { brandSalesFunnels, brandSalesFunnelArrowRates } from '../db/schema';
import {
  type ArrowRatesBackfillCandidate,
  type ArrowRatesBackfillPlan,
} from '../lib/funnel-arrow-rates-backfill-plan';
import { SALES_FUNNEL_RATE_KEYS, type SalesFunnelRateKey } from './salesFunnelCatalogue';

/** The named rate columns, as `brand_sales_funnels` spells them. */
const RATE_COLUMN_BY_KEY: Record<SalesFunnelRateKey, string> = {
  replyToMeetingPct: 'reply_to_meeting_pct',
  visitToMeetingPct: 'visit_to_meeting_pct',
  meetingBookedToAttendedPct: 'meeting_booked_to_attended_pct',
  meetingToClosePct: 'meeting_to_close_pct',
  visitToSignupPct: 'visit_to_signup_pct',
  signupToPaidClientPct: 'signup_to_paid_client_pct',
  visitToFormSubmissionPct: 'visit_to_form_submission_pct',
  formSubmissionToPaidClientPct: 'form_submission_to_paid_client_pct',
  replyToPaidClientPct: 'reply_to_paid_client_pct',
  adClickToMeetingPct: 'ad_click_to_meeting_pct',
  adClickToLeadFormPct: 'ad_click_to_lead_form_pct',
  leadFormToPaidClientPct: 'lead_form_to_paid_client_pct',
};

/**
 * Every declaration the backfill has not processed, with the named rates it
 * holds. A declaration that states nothing is returned too — the plan counts it
 * as skipped rather than the read hiding it, so the printed totals account for
 * every row the run looked at.
 */
export async function readArrowRatesBackfillCandidates(): Promise<ArrowRatesBackfillCandidate[]> {
  const rows = await db.execute<Record<string, string | null>>(sql`
    SELECT org_id,
           brand_id,
           offer_id,
           funnel_key,
           reply_to_meeting_pct,
           visit_to_meeting_pct,
           meeting_booked_to_attended_pct,
           meeting_to_close_pct,
           visit_to_signup_pct,
           signup_to_paid_client_pct,
           visit_to_form_submission_pct,
           form_submission_to_paid_client_pct,
           reply_to_paid_client_pct,
           ad_click_to_meeting_pct,
           ad_click_to_lead_form_pct,
           lead_form_to_paid_client_pct
      FROM brand_sales_funnels
     WHERE arrow_rates_backfilled_at IS NULL
     ORDER BY brand_id, funnel_key
  `);

  return [...rows].map((r) => {
    const namedRates: Partial<Record<SalesFunnelRateKey, number | null>> = {};
    for (const key of SALES_FUNNEL_RATE_KEYS) {
      const raw = r[RATE_COLUMN_BY_KEY[key]];
      namedRates[key] = raw === null || raw === undefined ? null : Number(raw);
    }
    return {
      orgId: r.org_id as string,
      brandId: r.brand_id as string,
      offerId: r.offer_id,
      funnelKey: r.funnel_key as string,
      namedRates,
    };
  });
}

/**
 * Write the plan: the arrows first, then the marker that says the declaration
 * they came from has been read.
 *
 * The marker is stamped LAST and only on the declarations the plan actually
 * produced arrows from, so a run interrupted halfway leaves the rest of the work
 * still visible to the next one.
 *
 * Returns the stamp it wrote, which is what identifies these rows afterwards.
 */
export async function applyArrowRatesBackfill(plan: ArrowRatesBackfillPlan): Promise<string> {
  const stamp = new Date().toISOString();

  for (const row of plan.rows) {
    await db
      .insert(brandSalesFunnelArrowRates)
      .values({
        orgId: row.orgId,
        brandId: row.brandId,
        offerId: row.offerId,
        funnelKey: row.funnelKey,
        fromStep: row.fromStep,
        toStep: row.toStep,
        ratePct: row.ratePct,
        backfilledAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
      })
      // An arrow the brand stated arrow-first already answers for this arrow and
      // outranks the named column it duplicates. Copying over it would replace
      // what the customer said with what they said BEFORE.
      .onConflictDoNothing({
        target: [
          brandSalesFunnelArrowRates.offerId,
          brandSalesFunnelArrowRates.funnelKey,
          brandSalesFunnelArrowRates.fromStep,
          brandSalesFunnelArrowRates.toStep,
        ],
      });
  }

  for (const declaration of plan.declarations) {
    await db
      .update(brandSalesFunnels)
      .set({ arrowRatesBackfilledAt: stamp })
      .where(
        and(
          eq(brandSalesFunnels.orgId, declaration.orgId),
          eq(brandSalesFunnels.brandId, declaration.brandId),
          eq(brandSalesFunnels.offerId, declaration.offerId),
          eq(brandSalesFunnels.funnelKey, declaration.funnelKey),
          sql`${brandSalesFunnels.arrowRatesBackfilledAt} IS NULL`
        )
      );
  }

  return stamp;
}

/**
 * The database half of the one-time economics backfill: which declarations are
 * candidates, and the write that fills them.
 *
 * It lives here rather than inside the script so the thing that RUNS in
 * production is the thing the tests exercise. The script is a CLI around these
 * two functions and nothing else.
 *
 * What the two rules mean in SQL:
 *  - the INNER JOIN onto `brand_sales_economics` is what keeps a brand that
 *    stated nothing absent — no stated numbers, no candidate, nothing written;
 *  - the "every value column IS NULL" predicate is what keeps a funnel a human
 *    priced untouched, and it is repeated in the UPDATE so a row priced between
 *    the read and the write is left exactly as the user left it.
 *
 * PROVENANCE IS NOT ONE OF THE RULES, and it used to be. The first run also
 * required `backfilled_from_goal IS NOT NULL`, so it only ever saw declarations
 * the goal→funnel backfill had made. That was harmless while the brand-wide
 * record still PRICED a brand whose funnels held nothing: the numbers were
 * reachable either way. They are not any more — a brand's rates and lifetime
 * revenue belong to the funnel that earns them, and the brand-wide record is
 * being reduced to a legacy fallthrough and a prefill. A funnel a human declared
 * BY HAND and left blank is therefore in exactly the position this backfill
 * exists to repair, and the provenance clause was the only thing hiding it.
 *
 * Dropping that clause widens nothing else: the two rules above are what protect
 * a brand that stated nothing (no economics row, no candidate) and a funnel
 * somebody priced (any value present, no candidate). Measured in production when
 * this shipped, it moves exactly one brand's two declarations.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { brandSalesFunnels } from '../db/schema';
import {
  type EconomicsBackfillCandidate,
  type EconomicsBackfillPlan,
} from '../lib/funnel-economics-backfill-plan';
import { isSalesFunnelKey } from './salesFunnelCatalogue';

/** Every value column on a declaration. "All null" is what "unpriced" means. */
const VALUE_COLUMNS = [
  brandSalesFunnels.lifetimeRevenueUsd,
  brandSalesFunnels.replyToMeetingPct,
  brandSalesFunnels.visitToMeetingPct,
  brandSalesFunnels.meetingBookedToAttendedPct,
  brandSalesFunnels.meetingToClosePct,
  brandSalesFunnels.visitToSignupPct,
  brandSalesFunnels.signupToPaidClientPct,
  brandSalesFunnels.visitToFormSubmissionPct,
  brandSalesFunnels.formSubmissionToPaidClientPct,
] as const;

/**
 * Declarations that hold no number at all, whatever declared them, beside the
 * numbers their brand stated on the brand-wide record.
 */
export async function readEconomicsBackfillCandidates(): Promise<EconomicsBackfillCandidate[]> {
  const rows = await db.execute<{
    org_id: string;
    brand_id: string;
    funnel_key: string;
    lifetime_revenue_usd: number;
    reply_to_meeting_pct: string;
    visit_to_meeting_pct: string;
    meeting_to_close_pct: string;
    visit_to_signup_pct: string;
    signup_to_paid_client_pct: string;
    visit_to_form_submission_pct: string;
    form_submission_to_paid_client_pct: string;
  }>(sql`
    SELECT f.org_id,
           f.brand_id,
           f.funnel_key,
           e.lifetime_revenue_usd,
           e.reply_to_meeting_pct,
           e.visit_to_meeting_pct,
           e.meeting_to_close_pct,
           e.visit_to_signup_pct,
           e.signup_to_paid_client_pct,
           e.visit_to_form_submission_pct,
           e.form_submission_to_paid_client_pct
      FROM brand_sales_funnels f
      JOIN brand_sales_economics e
        ON e.org_id = f.org_id AND e.brand_id = f.brand_id
     WHERE f.economics_backfilled_at IS NULL
       AND f.lifetime_revenue_usd IS NULL
       AND f.reply_to_meeting_pct IS NULL
       AND f.visit_to_meeting_pct IS NULL
       AND f.meeting_booked_to_attended_pct IS NULL
       AND f.meeting_to_close_pct IS NULL
       AND f.visit_to_signup_pct IS NULL
       AND f.signup_to_paid_client_pct IS NULL
       AND f.visit_to_form_submission_pct IS NULL
       AND f.form_submission_to_paid_client_pct IS NULL
     ORDER BY f.brand_id, f.funnel_key
  `);

  return [...rows].map((r) => {
    if (!isSalesFunnelKey(r.funnel_key)) {
      // The column carries a CHECK on the four canonical keys, so this cannot
      // happen — and if it ever did, guessing a funnel for it is the one thing
      // that must not happen here.
      throw new Error(`Stored funnel key names no funnel: ${r.funnel_key}`);
    }
    return {
      orgId: r.org_id,
      brandId: r.brand_id,
      funnelKey: r.funnel_key,
      economics: {
        lifetimeRevenueUsd: Number(r.lifetime_revenue_usd),
        replyToMeetingPct: Number(r.reply_to_meeting_pct),
        visitToMeetingPct: Number(r.visit_to_meeting_pct),
        meetingToClosePct: Number(r.meeting_to_close_pct),
        visitToSignupPct: Number(r.visit_to_signup_pct),
        signupToPaidClientPct: Number(r.signup_to_paid_client_pct),
        visitToFormSubmissionPct: Number(r.visit_to_form_submission_pct),
        formSubmissionToPaidClientPct: Number(r.form_submission_to_paid_client_pct),
      },
    };
  });
}

/**
 * Write the plan. One UPDATE per row — each funnel fills a different set of
 * columns, so there is nothing to batch — each one re-asserting that the row
 * still holds no number and has not already been filled.
 *
 * Returns the stamp it wrote, which is what identifies these rows afterwards.
 */
export async function applyEconomicsBackfill(plan: EconomicsBackfillPlan): Promise<string> {
  const stamp = new Date().toISOString();

  for (const row of plan.rows) {
    await db
      .update(brandSalesFunnels)
      .set({
        lifetimeRevenueUsd: row.lifetimeRevenueUsd,
        ...row.rates,
        economicsBackfilledAt: stamp,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(brandSalesFunnels.orgId, row.orgId),
          eq(brandSalesFunnels.brandId, row.brandId),
          eq(brandSalesFunnels.funnelKey, row.funnelKey),
          sql`${brandSalesFunnels.economicsBackfilledAt} IS NULL`,
          ...VALUE_COLUMNS.map((column) => sql`${column} IS NULL`)
        )
      );
  }

  return stamp;
}

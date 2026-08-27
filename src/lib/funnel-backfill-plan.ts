/**
 * What the one-time goal→funnel backfill will write, computed as a pure
 * function of what the database holds.
 *
 * It lives here, apart from the script that runs it, so the plan is testable
 * without a database and so the dry run and the real run compute the IDENTICAL
 * plan — a dry run that reasons differently from the write is not a dry run.
 *
 * The mapping itself is `funnelKeysForRetiredGoal`, the same one the write
 * acceptors apply, so a brand reaches the same declaration whichever way its
 * goal arrived and the two can never drift.
 */

import {
  funnelKeysForRetiredGoal,
  isRetiredGoal,
  type RetiredGoal,
} from './goal-vocabulary';
import { salesFunnelByKey, type SalesFunnelKey } from '../services/salesFunnelCatalogue';

/** One (org, brand) that carries a goal and has declared no funnel at all. */
export interface BackfillCandidate {
  orgId: string;
  brandId: string;
  currentGoal: string;
  /** A website-led funnel cannot be declared for a brand with no website. */
  hasDomain: boolean;
  /** The one signal that tells the two meeting funnels apart. */
  hasClickDestination: boolean;
}

export interface PlannedDeclaration {
  orgId: string;
  brandId: string;
  funnelKey: SalesFunnelKey;
  /** Provenance, written to the row: what makes the backfill reversible. */
  backfilledFromGoal: RetiredGoal;
}

/** Why a candidate produced no declaration. Counted and printed, never silent. */
export type BackfillSkipReason =
  /** `whatsappConversation` — the catalogue has no funnel it could mean. */
  | 'goal_names_no_funnel'
  /** A stored word that names no goal at all. Never guessed at. */
  | 'unrecognised_goal'
  /** The funnel starts with a click onto a site the brand does not have. */
  | 'website_led_funnel_without_website';

export interface BackfillSkip {
  candidate: BackfillCandidate;
  reason: BackfillSkipReason;
  funnelKey?: SalesFunnelKey;
}

export interface BackfillPlan {
  rows: PlannedDeclaration[];
  skipped: BackfillSkip[];
}

/**
 * Turn the candidates into the rows to write.
 *
 * A funnel a brand cannot hold is SKIPPED and reported, never coerced onto a
 * different one: declaring a website-led funnel for a brand with no website
 * would state something the brand cannot do, and substituting another funnel
 * would put words in its mouth. The OTHER funnels of the same goal are still
 * written — a `combinedSales` brand with no website keeps its conversation
 * funnel and loses only the half it cannot run.
 */
export function planBackfill(candidates: BackfillCandidate[]): BackfillPlan {
  const rows: PlannedDeclaration[] = [];
  const skipped: BackfillSkip[] = [];

  for (const candidate of candidates) {
    if (!isRetiredGoal(candidate.currentGoal)) {
      skipped.push({ candidate, reason: 'unrecognised_goal' });
      continue;
    }
    const goal: RetiredGoal = candidate.currentGoal;
    const keys = funnelKeysForRetiredGoal(goal, {
      hasClickDestination: candidate.hasClickDestination,
    });
    if (keys.length === 0) {
      skipped.push({ candidate, reason: 'goal_names_no_funnel' });
      continue;
    }
    for (const funnelKey of keys) {
      if (salesFunnelByKey(funnelKey).requiresWebsite && !candidate.hasDomain) {
        skipped.push({ candidate, reason: 'website_led_funnel_without_website', funnelKey });
        continue;
      }
      rows.push({
        orgId: candidate.orgId,
        brandId: candidate.brandId,
        funnelKey,
        backfilledFromGoal: goal,
      });
    }
  }

  return { rows, skipped };
}

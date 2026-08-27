/**
 * What the one-time brand→offer migration will create, computed as a pure
 * function of what the database holds.
 *
 * Every brand that already sells something — it has at least one sales-funnel
 * row, or at least one confirmed user-field, or both — gets exactly ONE offer
 * carrying all of it. Nothing is lost, nothing is defaulted, nothing is
 * invented: the funnel rows and the field rows are STAMPED with the new offer's
 * id and are otherwise untouched, so what a customer stated reads back
 * byte-for-byte through the same brand-scoped routes it always did.
 *
 * It lives here, apart from the script that runs it, so the plan is testable
 * without a database and so the dry run and the real run compute the IDENTICAL
 * plan — a dry run that reasons differently from the write is not a dry run.
 *
 * TWO RULES, and both are about not inventing anything:
 *
 *  1. ONE OFFER PER (org, brand), never per funnel and never per field. A brand
 *     selling through three funnels today is a brand selling ONE thing three
 *     ways — splitting it would state that it sells three, which nobody told us.
 *     Whoever wants a second offer creates it, and prices it themselves.
 *  2. A candidate is a (org, brand) pair whose rows still hold NO offer. That
 *     predicate is the whole of the idempotence: after a run there are none, so
 *     a second run plans nothing. It is also why the ROWS carry the marker that
 *     matters — a timestamp window would re-plan a brand whose rows a later
 *     write had already moved.
 *
 * The NAME is deliberately absent from this file. It is generated from what the
 * brand actually sells, which is an LLM call and cannot be a pure function of a
 * row; the plan says WHICH brands need one, and the service names them.
 */

/** What one un-migrated (org, brand) pair holds, and what it can be named from. */
export interface OfferMigrationCandidate {
  orgId: string;
  brandId: string;
  /** The brand's own identity, for the naming prompt. Both are nullable. */
  brandName: string | null;
  brandDomain: string | null;
  /** The funnels this brand sells through, canonical keys, in stored order. */
  funnelKeys: string[];
  /**
   * The confirmed value proposition, key → value as stored. This is the richest
   * signal for the name: `services` and `dreamOutcome` say what is being sold.
   */
  userFields: Record<string, unknown>;
}

/** One offer to create, and the rows it will adopt. */
export interface PlannedOffer {
  orgId: string;
  brandId: string;
  /** How many funnel rows this offer will take over. Reported, never assumed. */
  funnelRowCount: number;
  /** How many confirmed-field rows this offer will take over. */
  userFieldRowCount: number;
  candidate: OfferMigrationCandidate;
}

/** Why a candidate produced no offer. Counted and printed, never silent. */
export type OfferMigrationSkipReason =
  /**
   * The pair holds neither a funnel nor a confirmed field. It sells nothing yet,
   * so there is nothing for an offer to carry and no words to name one from.
   * Its first offer arrives when it first states something.
   */
  'brand_states_nothing';

export interface OfferMigrationSkip {
  candidate: OfferMigrationCandidate;
  reason: OfferMigrationSkipReason;
}

export interface OfferMigrationPlan {
  offers: PlannedOffer[];
  skipped: OfferMigrationSkip[];
}

/**
 * Turn the candidates into the offers to create.
 *
 * One per pair, in the order the reader produced them, so a dry run and a run
 * list the same brands in the same order and the two logs can be diffed.
 */
export function planOfferMigration(
  candidates: OfferMigrationCandidate[]
): OfferMigrationPlan {
  const offers: PlannedOffer[] = [];
  const skipped: OfferMigrationSkip[] = [];

  for (const candidate of candidates) {
    const funnelRowCount = candidate.funnelKeys.length;
    const userFieldRowCount = Object.keys(candidate.userFields).length;

    if (funnelRowCount === 0 && userFieldRowCount === 0) {
      skipped.push({ candidate, reason: 'brand_states_nothing' });
      continue;
    }

    offers.push({
      orgId: candidate.orgId,
      brandId: candidate.brandId,
      funnelRowCount,
      userFieldRowCount,
      candidate,
    });
  }

  return { offers, skipped };
}

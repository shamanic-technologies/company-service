/**
 * THE RETIRED GOAL VOCABULARY. This module exists to keep OLD WRITES WORKING,
 * and for nothing else. Nothing here is ever emitted on a read.
 *
 * brand-service used to answer "what does this brand sell through?" twice: once
 * with a sales funnel, and once with a goal. The funnel is strictly the richer
 * word — `sales_meetings_from_conversation` and `sales_meetings_from_website`
 * both mapped onto one `meetingBooked`, so a meeting won from a reply and one
 * won on the website were the same thing to every consumer and could not be
 * priced apart. Keeping both meant every consumer carried a translation layer
 * for the poorer of the two, so the goal set is retired: the funnel is the only
 * vocabulary brand-service emits (`src/services/salesFunnelCatalogue.ts`).
 *
 * What survives, and why:
 *
 *   - `ACCEPTED_OPTIMIZATION_GOALS` — every goal spelling the fleet has ever
 *     sent, ACCEPTED ON WRITE FOREVER. A caller sending yesterday's word keeps
 *     working; that is what made the emission switch safe to make in one repo,
 *     with no consumer changing in lockstep. Never delete an entry.
 *   - `funnelKeysForRetiredGoal` — what a goal MEANT, expressed as the funnel(s)
 *     it names. This is the mapping the write acceptors apply and the mapping
 *     the one-time backfill inverted.
 *
 * There is no read path here, no goal on any response, and no third store of the
 * concept. If you are adding one, you are re-creating what this file retires.
 */

import type { SalesFunnelKey } from '../services/salesFunnelCatalogue';

/**
 * The eight goal tokens the fleet used before the retirement. INPUT ONLY — they
 * are accepted on write and resolved to funnels; none is ever emitted.
 *
 * They stay listed because a caller still sends them, and because the backfill's
 * mapping is only readable next to the words it maps.
 */
export const RETIRED_GOALS = [
  'signup',
  'meetingBooked',
  'websitePurchase',
  'combinedSales',
  'websiteVisit',
  'positiveReply',
  'formSubmission',
  'whatsappConversation',
] as const;

export type RetiredGoal = (typeof RETIRED_GOALS)[number];

export function isRetiredGoal(value: string): value is RetiredGoal {
  return (RETIRED_GOALS as readonly string[]).includes(value);
}

/**
 * Every OTHER spelling a caller may still send. Accepted forever, same as above.
 *
 * `purchase` is here because it was canonical until the `websitePurchase`
 * rename; `sales` has meant WEBSITE PURCHASE in every stored row since the goal
 * existed and can never be re-pointed at the combined goal.
 */
export const LEGACY_OPTIMIZATION_GOALS = [
  'signups',
  'booked_meetings',
  // The dashboard's own local spelling of the booked-meeting goal.
  'sales_meetings',
  // The legacy wire spelling of WEBSITE PURCHASE — never the combined goal.
  'sales',
  'website_purchase',
  'combined_sales',
  'website_visits',
  'positive_replies',
  'form_submissions',
  'whatsapp_conversations',
  // The pre-rename canonical spelling of `websitePurchase`.
  'purchase',
] as const;

export type LegacyOptimizationGoal = (typeof LEGACY_OPTIMIZATION_GOALS)[number];

/** Every goal spelling accepted on write. */
export type AcceptedOptimizationGoal = RetiredGoal | LegacyOptimizationGoal;

export const ACCEPTED_OPTIMIZATION_GOALS = [
  ...RETIRED_GOALS,
  ...LEGACY_OPTIMIZATION_GOALS,
] as const;

/**
 * Resolve any accepted spelling to the retired token it names.
 *
 * Exhaustive by construction — the switch has one case per accepted value and
 * `tsc` fails when a value is added to either list without a case here. There is
 * no default branch and no default goal: a spelling we cannot name must never
 * quietly become a different goal.
 */
export function toRetiredGoal(goal: AcceptedOptimizationGoal): RetiredGoal {
  switch (goal) {
    case 'signup':
    case 'signups':
      return 'signup';
    case 'meetingBooked':
    case 'booked_meetings':
    case 'sales_meetings':
      return 'meetingBooked';
    case 'websitePurchase':
    case 'sales':
    case 'website_purchase':
    case 'purchase':
      return 'websitePurchase';
    case 'combinedSales':
    case 'combined_sales':
      return 'combinedSales';
    case 'websiteVisit':
    case 'website_visits':
      return 'websiteVisit';
    case 'positiveReply':
    case 'positive_replies':
      return 'positiveReply';
    case 'formSubmission':
    case 'form_submissions':
      return 'formSubmission';
    case 'whatsappConversation':
    case 'whatsapp_conversations':
      return 'whatsappConversation';
  }
}

/** What a caller has to be able to tell us about the brand to resolve a goal. */
export interface RetiredGoalContext {
  /**
   * Whether this org has set a click destination for this brand. It is the ONE
   * signal that tells the two meeting funnels apart for a brand whose goal only
   * ever said `meetingBooked`: a brand sending outreach clicks to a page of its
   * own site is booking meetings FROM THE WEBSITE.
   */
  hasClickDestination: boolean;
}

/**
 * The funnel(s) a retired goal MEANT. Owner-approved mapping, applied both by
 * the write acceptors and by the one-time backfill, so a brand reaches the same
 * declaration whichever way its goal arrived.
 *
 * Two entries are not one-to-one, and both are deliberate:
 *
 *   - `meetingBooked` is the reason the goal is being retired at all. It names
 *     BOTH meeting funnels, so the goal alone cannot say which. A brand that set
 *     a click destination is sending outreach onto its own site, so its meetings
 *     come from the website; every other brand's come from the conversation.
 *   - `combinedSales` becomes TWO declarations rather than a lossy pick. The
 *     model is multi-funnel, so a combined goal is expressible without loss and
 *     choosing one of its halves would throw away what the brand said.
 *
 * `whatsappConversation` maps to NOTHING: the catalogue has no whatsapp funnel,
 * so there is no funnel it could mean. No brand in production carries it. The
 * empty list is the honest answer and the caller fails loud on it rather than
 * declaring a funnel the goal never named.
 */
export function funnelKeysForRetiredGoal(
  goal: RetiredGoal,
  context: RetiredGoalContext
): SalesFunnelKey[] {
  switch (goal) {
    case 'meetingBooked':
      return [
        context.hasClickDestination
          ? 'sales_meetings_from_website'
          : 'sales_meetings_from_conversation',
      ];
    case 'positiveReply':
      return ['sales_meetings_from_conversation'];
    case 'combinedSales':
      return ['sales_meetings_from_conversation', 'website_purchases'];
    case 'websitePurchase':
    case 'signup':
    case 'websiteVisit':
      return ['website_purchases'];
    case 'formSubmission':
      return ['form_magnet'];
    case 'whatsappConversation':
      return [];
  }
}

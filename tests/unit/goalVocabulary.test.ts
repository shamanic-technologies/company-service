import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_OPTIMIZATION_GOALS,
  RETIRED_GOALS,
  LEGACY_OPTIMIZATION_GOALS,
  funnelKeysForRetiredGoal,
  isRetiredGoal,
  toRetiredGoal,
  type AcceptedOptimizationGoal,
  type RetiredGoal,
} from '../../src/lib/goal-vocabulary';
import { SALES_FUNNEL_KEYS } from '../../src/services/salesFunnelCatalogue';
import { OptimizationGoalSchema } from '../../src/schemas';

/**
 * THE GOAL VOCABULARY IS RETIRED. It used to be the fleet's second answer to
 * "what does this brand sell through?", pinned byte-equal across three repos;
 * this file used to be the alarm that stopped it moving in a single-repo PR.
 *
 * It moved. The funnel is strictly the richer word — both meeting funnels
 * collapsed onto one `meetingBooked`, so no consumer could price a meeting won
 * from a reply apart from one won on the website — so the goal is no longer
 * emitted anywhere. What these tests now pin is the ONE thing that survives:
 * every spelling still WRITES, forever, and each one resolves to the funnel(s)
 * it meant.
 */
describe('the retired goal vocabulary is input-only', () => {
  it('still names the eight tokens, so an old caller is still understood', () => {
    expect([...RETIRED_GOALS]).toEqual([
      'signup',
      'meetingBooked',
      'websitePurchase',
      'combinedSales',
      'websiteVisit',
      'positiveReply',
      'formSubmission',
      'whatsappConversation',
    ]);
  });

  it('has no duplicate token', () => {
    expect(new Set(RETIRED_GOALS).size).toBe(RETIRED_GOALS.length);
  });

  it('is not exported as anything a response can be built from', async () => {
    // The alarm, inverted: there is no goal schema on any read any more. A
    // `CurrentGoal` schema coming back is a goal re-entering the wire.
    const schemas = await import('../../src/schemas');
    expect('CurrentGoalSchema' in schemas).toBe(false);
    expect('UpdateCurrentGoalResponseSchema' in schemas).toBe(false);
  });
});

describe('every legacy spelling still writes, and lands on the right goal', () => {
  // Each of these is a spelling some caller has sent. None may ever stop working.
  const legacy: Array<[AcceptedOptimizationGoal, RetiredGoal]> = [
    ['signups', 'signup'],
    ['booked_meetings', 'meetingBooked'],
    ['sales_meetings', 'meetingBooked'],
    ['sales', 'websitePurchase'],
    ['website_purchase', 'websitePurchase'],
    // The pre-rename canonical spelling. A caller still PUTting it must land on
    // websitePurchase rather than be rejected.
    ['purchase', 'websitePurchase'],
    ['combined_sales', 'combinedSales'],
    ['website_visits', 'websiteVisit'],
    ['positive_replies', 'positiveReply'],
    ['form_submissions', 'formSubmission'],
    ['whatsapp_conversations', 'whatsappConversation'],
  ];

  it.each(legacy)('accepts %s and resolves it to %s', (wire, retired) => {
    expect(OptimizationGoalSchema.safeParse(wire).success).toBe(true);
    expect(toRetiredGoal(wire)).toBe(retired);
  });

  it('covers every legacy spelling the vocabulary declares', () => {
    expect(legacy.map(([wire]) => wire).sort()).toEqual([...LEGACY_OPTIMIZATION_GOALS].sort());
  });

  it('accepts every retired token on write too', () => {
    for (const goal of RETIRED_GOALS) {
      expect(OptimizationGoalSchema.safeParse(goal).success).toBe(true);
      expect(toRetiredGoal(goal)).toBe(goal);
    }
  });

  it('accepts nothing beyond those two lists — an unknown goal fails loud', () => {
    expect([...OptimizationGoalSchema.options].sort()).toEqual(
      [...ACCEPTED_OPTIMIZATION_GOALS].sort()
    );
    expect(OptimizationGoalSchema.safeParse('telepathy').success).toBe(false);
    // No default branch, no default goal: an unmappable value is never quietly
    // turned into a different one.
    expect(toRetiredGoal('telepathy' as AcceptedOptimizationGoal)).toBeUndefined();
  });

  it('recognises a retired token and rejects a legacy spelling of one', () => {
    expect(isRetiredGoal('websitePurchase')).toBe(true);
    expect(isRetiredGoal('sales')).toBe(false);
  });
});

describe('what a retired goal MEANT, as funnels', () => {
  const withoutClickDestination = { hasClickDestination: false };
  const withClickDestination = { hasClickDestination: true };

  it('names only funnels that exist in the catalogue', () => {
    for (const goal of RETIRED_GOALS) {
      for (const context of [withClickDestination, withoutClickDestination]) {
        for (const key of funnelKeysForRetiredGoal(goal, context)) {
          expect(SALES_FUNNEL_KEYS).toContain(key);
        }
      }
    }
  });

  it('tells the two meeting funnels apart, which the goal alone could not', () => {
    // The whole reason the goal is retired: one word, two funnels. A brand that
    // set a click destination is sending outreach onto its own site, so its
    // meetings come from the website.
    expect(funnelKeysForRetiredGoal('meetingBooked', withClickDestination)).toEqual([
      'sales_meetings_from_website',
    ]);
    expect(funnelKeysForRetiredGoal('meetingBooked', withoutClickDestination)).toEqual([
      'sales_meetings_from_conversation',
    ]);
  });

  it('turns the combined goal into TWO declarations rather than a lossy pick', () => {
    expect(funnelKeysForRetiredGoal('combinedSales', withoutClickDestination)).toEqual([
      'sales_meetings_from_conversation',
      'website_purchases',
    ]);
  });

  it('maps every remaining goal to the funnel the owner named', () => {
    expect(funnelKeysForRetiredGoal('websitePurchase', withoutClickDestination)).toEqual([
      'website_purchases',
    ]);
    expect(funnelKeysForRetiredGoal('signup', withoutClickDestination)).toEqual([
      'website_purchases',
    ]);
    expect(funnelKeysForRetiredGoal('websiteVisit', withoutClickDestination)).toEqual([
      'website_purchases',
    ]);
    expect(funnelKeysForRetiredGoal('positiveReply', withoutClickDestination)).toEqual([
      'sales_meetings_from_conversation',
    ]);
    expect(funnelKeysForRetiredGoal('formSubmission', withoutClickDestination)).toEqual([
      'form_magnet',
    ]);
  });

  it('answers NOTHING for whatsappConversation, which names no funnel', () => {
    // Not a substitute funnel and not the click funnel: the catalogue has no
    // whatsapp funnel, so the empty list is the honest answer and the caller
    // fails loud on it.
    expect(funnelKeysForRetiredGoal('whatsappConversation', withClickDestination)).toEqual([]);
    expect(funnelKeysForRetiredGoal('whatsappConversation', withoutClickDestination)).toEqual([]);
  });

  it('is total — every retired goal is answered without a default branch', () => {
    for (const goal of RETIRED_GOALS) {
      expect(Array.isArray(funnelKeysForRetiredGoal(goal, withoutClickDestination))).toBe(true);
    }
  });
});

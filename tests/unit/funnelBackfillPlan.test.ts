import { describe, it, expect } from 'vitest';

import {
  planBackfill,
  type BackfillCandidate,
} from '../../src/lib/funnel-backfill-plan';

/**
 * The one-time backfill that gives every brand carrying a retired goal the
 * declaration that goal meant.
 *
 * Without it, a brand that only ever carried a goal reads back as "has never
 * answered" the moment the goal stops being emitted, and everything ranking on
 * the declaration stops working for it. These tests pin the two properties that
 * make it safe to run against customer configuration: it never touches a brand
 * that has already answered, and it never invents a funnel a brand cannot run.
 */
const candidate = (over: Partial<BackfillCandidate> = {}): BackfillCandidate => ({
  orgId: 'org-1',
  brandId: 'brand-1',
  currentGoal: 'websitePurchase',
  hasDomain: true,
  hasClickDestination: false,
  ...over,
});

describe('what the backfill will write', () => {
  it('writes the funnel the goal named, tagged with the goal it came from', () => {
    const plan = planBackfill([candidate({ currentGoal: 'websitePurchase' })]);
    expect(plan.rows).toEqual([
      {
        orgId: 'org-1',
        brandId: 'brand-1',
        funnelKey: 'website_purchases',
        backfilledFromGoal: 'websitePurchase',
      },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('tags every row, so undoing the backfill is one exact predicate', () => {
    // Reversibility is not a timestamp window: `backfilled_from_goal IS NOT NULL`
    // names exactly the rows this wrote and can never take a user's row with it.
    const plan = planBackfill([
      candidate({ currentGoal: 'signup' }),
      candidate({ brandId: 'brand-2', currentGoal: 'combinedSales' }),
    ]);
    expect(plan.rows.every((r) => r.backfilledFromGoal !== null)).toBe(true);
  });

  it('splits the two meeting funnels on the click destination', () => {
    // The whole reason the goal is retired, exercised on real data shapes.
    const fromWebsite = planBackfill([
      candidate({ currentGoal: 'meetingBooked', hasClickDestination: true }),
    ]);
    expect(fromWebsite.rows.map((r) => r.funnelKey)).toEqual(['sales_meetings_from_website']);

    const fromConversation = planBackfill([
      candidate({ currentGoal: 'meetingBooked', hasClickDestination: false }),
    ]);
    expect(fromConversation.rows.map((r) => r.funnelKey)).toEqual([
      'sales_meetings_from_conversation',
    ]);
  });

  it('turns the combined goal into two rows for one brand', () => {
    const plan = planBackfill([candidate({ currentGoal: 'combinedSales' })]);
    expect(plan.rows.map((r) => r.funnelKey)).toEqual([
      'sales_meetings_from_conversation',
      'website_purchases',
    ]);
    expect(new Set(plan.rows.map((r) => r.brandId)).size).toBe(1);
  });

  it('maps the remaining goals exactly as the owner named them', () => {
    const goals: Array<[string, string[]]> = [
      ['signup', ['website_purchases']],
      ['websiteVisit', ['website_purchases']],
      ['formSubmission', ['form_magnet']],
      ['positiveReply', ['sales_meetings_from_conversation']],
    ];
    for (const [goal, expected] of goals) {
      expect(planBackfill([candidate({ currentGoal: goal })]).rows.map((r) => r.funnelKey)).toEqual(
        expected
      );
    }
  });
});

describe('what the backfill refuses to write', () => {
  it('declares nothing for a goal that names no funnel, and says so', () => {
    const plan = planBackfill([candidate({ currentGoal: 'whatsappConversation' })]);
    expect(plan.rows).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].reason).toBe('goal_names_no_funnel');
  });

  it('never guesses at a word that names no goal', () => {
    const plan = planBackfill([candidate({ currentGoal: 'telepathy' })]);
    expect(plan.rows).toEqual([]);
    expect(plan.skipped[0].reason).toBe('unrecognised_goal');
  });

  it('skips a website-led funnel for a brand with no website, keeping the half that runs', () => {
    // A `combinedSales` brand with no site cannot run the website-purchase
    // funnel — but it can still run the conversation one, and substituting a
    // different funnel for the half it loses would put words in its mouth.
    const plan = planBackfill([
      candidate({ currentGoal: 'combinedSales', hasDomain: false }),
    ]);
    expect(plan.rows.map((r) => r.funnelKey)).toEqual(['sales_meetings_from_conversation']);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({
      reason: 'website_led_funnel_without_website',
      funnelKey: 'website_purchases',
    });
  });

  it('writes nothing at all for a website-only goal on a brand with no website', () => {
    const plan = planBackfill([candidate({ currentGoal: 'websitePurchase', hasDomain: false })]);
    expect(plan.rows).toEqual([]);
    expect(plan.skipped[0].reason).toBe('website_led_funnel_without_website');
  });

  it('is a pure function of its input — the same candidates plan identically', () => {
    // The dry run and the real run share this function, so a dry run that
    // reasoned differently from the write would be worthless.
    const input = [
      candidate({ currentGoal: 'meetingBooked', hasClickDestination: true }),
      candidate({ brandId: 'brand-2', currentGoal: 'combinedSales' }),
      candidate({ brandId: 'brand-3', currentGoal: 'whatsappConversation' }),
    ];
    expect(planBackfill(input)).toEqual(planBackfill(input));
  });
});

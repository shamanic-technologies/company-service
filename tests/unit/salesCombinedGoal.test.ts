import { describe, it, expect } from 'vitest';

import { funnelKeysForRetiredGoal, toRetiredGoal } from '../../src/lib/goal-vocabulary';

/**
 * The `sales` collision, pinned from both sides — it must not come back through
 * the retirement.
 *
 * brand-service stored `sales` as WEBSITE PURCHASE since the goal existed, while
 * the dashboard and features-service spelled their COMBINED goal `sales`.
 * Reading one as the other bucketed every website-purchase brand under combined
 * sales in the cross-org fleet benchmark (distribute.you#3214).
 *
 * Now that the goal is retired, the two words resolve to FUNNELS, and that is
 * where the distinction has to survive: `sales` declares the website-purchase
 * funnel, and the combined goal declares TWO funnels rather than picking one.
 */
describe('the combined goal and website purchase never collide', () => {
  const context = { hasClickDestination: false };

  it('resolves every website-purchase spelling to the website-purchase funnel alone', () => {
    for (const wire of ['sales', 'website_purchase', 'purchase', 'websitePurchase'] as const) {
      expect(toRetiredGoal(wire)).toBe('websitePurchase');
      expect(funnelKeysForRetiredGoal(toRetiredGoal(wire), context)).toEqual([
        'website_purchases',
      ]);
    }
  });

  it('turns the combined goal into BOTH funnels, losing neither half', () => {
    for (const wire of ['combined_sales', 'combinedSales'] as const) {
      expect(toRetiredGoal(wire)).toBe('combinedSales');
      expect(funnelKeysForRetiredGoal(toRetiredGoal(wire), context)).toEqual([
        'sales_meetings_from_conversation',
        'website_purchases',
      ]);
    }
  });

  it('leaves the other goals alone', () => {
    expect(toRetiredGoal('signups')).toBe('signup');
    expect(toRetiredGoal('booked_meetings')).toBe('meetingBooked');
    expect(toRetiredGoal('whatsapp_conversations')).toBe('whatsappConversation');
    expect(toRetiredGoal('form_submissions')).toBe('formSubmission');
  });
});

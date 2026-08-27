import { describe, it, expect } from 'vitest';

import {
  RETIRED_GOALS,
  funnelKeysForRetiredGoal,
  toRetiredGoal,
} from '../../src/lib/goal-vocabulary';

/**
 * whatsappConversation is the one retired goal that DIES with the vocabulary.
 *
 * Every other goal named a funnel the catalogue has, so retiring it costs
 * nothing — the funnel says the same thing, better. There is no whatsapp funnel,
 * so this goal has nothing to become. No brand in production carries it.
 *
 * What is pinned here is that it neither disappears silently nor gets a
 * substitute: the spelling still parses (an old caller is still understood) and
 * resolving it to a funnel answers NOTHING, which the write acceptors turn into
 * a 400. Quietly declaring the click funnel instead would tell a brand it sells
 * through something it never said it sells through.
 */
describe('the whatsapp conversation goal', () => {
  it('is still understood as a word — an old caller is not met with nonsense', () => {
    expect(RETIRED_GOALS).toContain('whatsappConversation');
    expect(toRetiredGoal('whatsapp_conversations')).toBe('whatsappConversation');
    expect(toRetiredGoal('whatsappConversation')).toBe('whatsappConversation');
  });

  it('names no funnel, and is given no substitute', () => {
    expect(
      funnelKeysForRetiredGoal('whatsappConversation', { hasClickDestination: false })
    ).toEqual([]);
    expect(
      funnelKeysForRetiredGoal('whatsappConversation', { hasClickDestination: true })
    ).toEqual([]);
  });

  it('is the ONLY goal that names no funnel', () => {
    for (const goal of RETIRED_GOALS) {
      if (goal === 'whatsappConversation') continue;
      expect(
        funnelKeysForRetiredGoal(goal, { hasClickDestination: false }).length
      ).toBeGreaterThan(0);
    }
  });

  it("is nobody else's goal", () => {
    for (const goal of RETIRED_GOALS) {
      if (goal === 'whatsappConversation') continue;
      expect(toRetiredGoal(goal)).not.toBe('whatsappConversation');
    }
  });
});

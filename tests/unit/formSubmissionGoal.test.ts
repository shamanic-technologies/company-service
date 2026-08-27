import { describe, it, expect } from 'vitest';

import { RETIRED_GOALS, funnelKeysForRetiredGoal, toRetiredGoal } from '../../src/lib/goal-vocabulary';
import { SALES_FUNNELS } from '../../src/services/salesFunnelCatalogue';

/**
 * Form submission is its OWN funnel, and it stays that way through the goal
 * retirement.
 *
 * It used to collapse onto the `signup` runtime token, so features-service —
 * which prices visit->form->paid separately — had to re-derive the distinction
 * downstream. Making it a first-class goal fixed that; retiring the goal set
 * must not undo it. The Form Magnet funnel is the distinction now, and it is
 * carried by the key itself rather than by a word beside it.
 */
describe('form submission is its own funnel', () => {
  it('is still understood as a word, in both spellings', () => {
    expect(RETIRED_GOALS).toContain('formSubmission');
    for (const wire of ['form_submissions', 'formSubmission'] as const) {
      expect(toRetiredGoal(wire)).toBe('formSubmission');
      expect(toRetiredGoal(wire)).not.toBe('signup');
    }
  });

  it('declares the Form Magnet funnel, never the website-purchase one', () => {
    expect(funnelKeysForRetiredGoal('formSubmission', { hasClickDestination: false })).toEqual([
      'form_magnet',
    ]);
    expect(funnelKeysForRetiredGoal('signup', { hasClickDestination: false })).toEqual([
      'website_purchases',
    ]);
  });

  it('keeps the two sibling funnels distinct in the catalogue', () => {
    // Siblings (visit -> micro-conversion -> paid) that once shared one goal.
    // Now they are two keys, and no word can collapse them again.
    const form = SALES_FUNNELS.find((f) => f.key === 'form_magnet')!;
    const purchase = SALES_FUNNELS.find((f) => f.key === 'website_purchases')!;
    expect(form.legs).toEqual(['visitToFormSubmissionPct', 'formSubmissionToPaidClientPct']);
    expect(purchase.legs).toEqual(['visitToSignupPct', 'signupToPaidClientPct']);
  });
});

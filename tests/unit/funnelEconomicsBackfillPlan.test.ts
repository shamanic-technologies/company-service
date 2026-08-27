import { describe, it, expect } from 'vitest';
import {
  planEconomicsBackfill,
  ratesForFunnel,
  type EconomicsBackfillCandidate,
  type StatedEconomics,
} from '../../src/lib/funnel-economics-backfill-plan';

/**
 * The one-time move of a brand's stated numbers from the brand-wide record onto
 * the funnel(s) that replaced it.
 *
 * The whole plan is "same name, same number, nothing else": a leg of the
 * funnel's own funnel is filled from the economics column that shares its name,
 * and a leg with no such column was never stated and stays absent.
 */
describe('funnel economics backfill plan', () => {
  const stated: StatedEconomics = {
    lifetimeRevenueUsd: 4200,
    replyToMeetingPct: 31,
    visitToMeetingPct: 7,
    meetingToClosePct: 44,
    visitToSignupPct: 12,
    signupToPaidClientPct: 18,
    visitToFormSubmissionPct: 9,
    formSubmissionToPaidClientPct: 21,
  };

  const candidate = (funnelKey: EconomicsBackfillCandidate['funnelKey']) => ({
    orgId: 'org-1',
    brandId: 'brand-1',
    funnelKey,
    economics: stated,
  });

  describe('ratesForFunnel', () => {
    it('fills only the legs of the funnel own funnel', () => {
      expect(ratesForFunnel('website_purchases', stated)).toEqual({
        visitToSignupPct: 12,
        signupToPaidClientPct: 18,
      });
      expect(ratesForFunnel('form_magnet', stated)).toEqual({
        visitToFormSubmissionPct: 9,
        formSubmissionToPaidClientPct: 21,
      });
    });

    it('leaves the meeting show-up rate absent — it was never stated anywhere', () => {
      const conversation = ratesForFunnel('sales_meetings_from_conversation', stated);
      expect(conversation).toEqual({ replyToMeetingPct: 31, meetingToClosePct: 44 });
      expect('meetingBookedToAttendedPct' in conversation).toBe(false);

      const website = ratesForFunnel('sales_meetings_from_website', stated);
      expect(website).toEqual({ visitToMeetingPct: 7, meetingToClosePct: 44 });
      expect('meetingBookedToAttendedPct' in website).toBe(false);
    });

    it('never puts one funnel rate on another funnel funnel', () => {
      const website = ratesForFunnel('sales_meetings_from_website', stated);
      // The website meeting funnel starts on a VISIT, so the reply rate is not
      // its business — borrowing it would state a number the brand never gave
      // for that funnel.
      expect('replyToMeetingPct' in website).toBe(false);
    });
  });

  describe('planEconomicsBackfill', () => {
    it('carries the lifetime revenue onto every funnel it fills', () => {
      const plan = planEconomicsBackfill([
        candidate('website_purchases'),
        candidate('sales_meetings_from_conversation'),
      ]);
      expect(plan.skipped).toEqual([]);
      expect(plan.rows.map((r) => r.lifetimeRevenueUsd)).toEqual([4200, 4200]);
    });

    it('plans one fill per candidate, keyed on the (org, brand, funnel) it names', () => {
      const plan = planEconomicsBackfill([candidate('form_magnet')]);
      expect(plan.rows).toEqual([
        {
          orgId: 'org-1',
          brandId: 'brand-1',
          funnelKey: 'form_magnet',
          lifetimeRevenueUsd: 4200,
          rates: { visitToFormSubmissionPct: 9, formSubmissionToPaidClientPct: 21 },
        },
      ]);
    });

    it('skips a stored key that names no funnel rather than guessing a funnel', () => {
      const plan = planEconomicsBackfill([
        { ...candidate('website_purchases'), funnelKey: 'whatsapp_chat' as never },
      ]);
      expect(plan.rows).toEqual([]);
      expect(plan.skipped).toHaveLength(1);
      expect(plan.skipped[0].reason).toBe('unrecognised_funnel_key');
    });

    it('is a pure function of its input — planning twice plans the same thing', () => {
      const input = [candidate('website_purchases'), candidate('form_magnet')];
      expect(planEconomicsBackfill(input)).toEqual(planEconomicsBackfill(input));
    });

    it('writes a zero the brand actually stated, and never one it did not', () => {
      const zeroed: StatedEconomics = { ...stated, signupToPaidClientPct: 0 };
      const plan = planEconomicsBackfill([
        { ...candidate('website_purchases'), economics: zeroed },
      ]);
      expect(plan.rows[0].rates).toEqual({ visitToSignupPct: 12, signupToPaidClientPct: 0 });
    });
  });
});

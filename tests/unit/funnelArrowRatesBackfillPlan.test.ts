import { describe, it, expect } from 'vitest';
import {
  planArrowRatesBackfill,
  arrowsForDeclaration,
  type ArrowRatesBackfillCandidate,
} from '../../src/lib/funnel-arrow-rates-backfill-plan';
import { funnelArrows, salesFunnelByKey } from '../../src/services/salesFunnelCatalogue';

/**
 * Every rate a brand states through a named column IS the rate of one arrow of
 * one funnel. The plan is that correspondence, walked backwards — and the whole
 * of what makes it safe is what it refuses to do: it moves no figure, and it
 * writes nothing for an arrow nobody has stated.
 */
describe('Arrow-rate backfill plan', () => {
  const base = {
    orgId: 'org-1',
    brandId: 'brand-1',
    offerId: 'offer-1',
  };

  const candidate = (over: Partial<ArrowRatesBackfillCandidate>): ArrowRatesBackfillCandidate => ({
    ...base,
    funnelKey: 'sales_meetings_from_conversation',
    namedRates: {},
    ...over,
  });

  it('gives each stated named rate the arrow the catalogue says it prices', () => {
    const plan = planArrowRatesBackfill([
      candidate({
        namedRates: {
          replyToMeetingPct: 12,
          meetingBookedToAttendedPct: 70,
          meetingToClosePct: 30.5,
        },
      }),
    ]);

    expect(plan.rows).toEqual([
      { ...base, funnelKey: 'sales_meetings_from_conversation', fromStep: 'Positive reply', toStep: 'Meeting booked', ratePct: 12, rateKey: 'replyToMeetingPct' },
      { ...base, funnelKey: 'sales_meetings_from_conversation', fromStep: 'Meeting booked', toStep: 'Meeting attended', ratePct: 70, rateKey: 'meetingBookedToAttendedPct' },
      { ...base, funnelKey: 'sales_meetings_from_conversation', fromStep: 'Meeting attended', toStep: 'Paid client', ratePct: 30.5, rateKey: 'meetingToClosePct' },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('moves no figure: every rate written is the number the column holds', () => {
    const plan = planArrowRatesBackfill([
      candidate({ namedRates: { replyToMeetingPct: 0.0001, meetingToClosePct: 99.9999 } }),
    ]);
    expect(plan.rows.map((r) => r.ratePct)).toEqual([0.0001, 99.9999]);
  });

  it('writes nothing for an arrow the brand never stated — no zero, no average', () => {
    const plan = planArrowRatesBackfill([candidate({ namedRates: { replyToMeetingPct: 12 } })]);

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].toStep).toBe('Meeting booked');
    // The other two arrows of this funnel produce nothing at all.
    expect(plan.rows.some((r) => r.rateKey === 'meetingToClosePct')).toBe(false);
  });

  it('reads a rate onto a leg of the funnel that states it, and never another funnel', () => {
    // `visitToSignupPct` prices no leg of a meeting funnel, so a declaration
    // carrying it produces nothing — a rate is never borrowed across funnels.
    const plan = planArrowRatesBackfill([candidate({ namedRates: { visitToSignupPct: 40 } })]);

    expect(plan.rows).toEqual([]);
    expect(plan.skipped).toEqual([
      { candidate: expect.anything(), reason: 'nothing_stated' },
    ]);
  });

  it('skips a declaration the offer migration has not reached rather than guessing an offer', () => {
    const plan = planArrowRatesBackfill([
      candidate({ offerId: null, namedRates: { replyToMeetingPct: 12 } }),
    ]);

    expect(plan.rows).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['no_offer']);
    expect(plan.declarations).toEqual([]);
  });

  it('skips a funnel key the catalogue does not name rather than guessing a funnel', () => {
    const plan = planArrowRatesBackfill([
      candidate({ funnelKey: 'something_retired', namedRates: { replyToMeetingPct: 12 } }),
    ]);

    expect(plan.rows).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(['unrecognised_funnel_key']);
  });

  it('claims only the declarations it actually read arrows out of', () => {
    const plan = planArrowRatesBackfill([
      candidate({ namedRates: { replyToMeetingPct: 12 } }),
      candidate({ funnelKey: 'website_purchases', namedRates: {} }),
    ]);

    expect(plan.declarations).toEqual([
      { orgId: 'org-1', brandId: 'brand-1', offerId: 'offer-1', funnelKey: 'sales_meetings_from_conversation' },
    ]);
  });

  it('covers every funnel in the catalogue: each leg stated becomes that leg\'s arrow', () => {
    for (const def of ['sales_meetings_from_conversation', 'sales_meetings_from_website', 'website_purchases', 'form_magnet', 'sales_from_conversation', 'sales_meetings_from_ads', 'lead_forms_from_ads'] as const) {
      const arrows = funnelArrows(salesFunnelByKey(def));
      const namedRates = Object.fromEntries(arrows.map((a, i) => [a.rateKey, i + 1]));
      const rows = arrowsForDeclaration({ ...base, funnelKey: def, namedRates });
      expect(rows.map((r) => [r.fromStep, r.toStep, r.ratePct])).toEqual(
        arrows.map((a, i) => [a.fromStep, a.toStep, namedRates[a.rateKey]])
      );
    }
  });
});

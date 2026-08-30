import { describe, it, expect } from 'vitest';
import {
  SALES_FUNNELS,
  funnelArrows,
  salesFunnelByKey,
} from '../../src/services/salesFunnelCatalogue';
import {
  SalesFunnelArrowInvalidError,
  assertArrowIdentifiable,
  resolveFunnelArrowRates,
} from '../../src/services/salesFunnelArrowRatesService';

/**
 * A brand states a rate for the ARROWS of its funnels, named by the two steps
 * each connects. What this pins is the reconciliation between that vocabulary
 * and the named columns it will eventually replace: one precedence, applied
 * everywhere, and a named rate that keeps answering exactly as it does today.
 */
describe('funnelArrows', () => {
  it('names every arrow of every funnel, in funnel order, with its legacy rate', () => {
    for (const def of SALES_FUNNELS) {
      const arrows = funnelArrows(def);
      expect(arrows).toHaveLength(def.steps.length - 1);
      arrows.forEach((arrow, i) => {
        expect(arrow.fromStep).toBe(def.steps[i]);
        expect(arrow.toStep).toBe(def.steps[i + 1]);
        expect(arrow.rateKey).toBe(def.legs[i]);
      });
    }
  });
});

describe('assertArrowIdentifiable', () => {
  it('accepts an arrow the catalogue has never heard of', () => {
    // The whole point: a funnel gaining a step must not need a schema change.
    expect(() =>
      assertArrowIdentifiable({ fromStep: 'Positive reply', toStep: 'Phone call', ratePct: 40 })
    ).not.toThrow();
  });

  it('refuses a step that points at itself', () => {
    expect(() =>
      assertArrowIdentifiable({ fromStep: 'Meeting booked', toStep: 'Meeting booked', ratePct: 40 })
    ).toThrow(SalesFunnelArrowInvalidError);
  });

  it('refuses an empty step label', () => {
    expect(() =>
      assertArrowIdentifiable({ fromStep: '   ', toStep: 'Paid client', ratePct: 40 })
    ).toThrow(SalesFunnelArrowInvalidError);
  });
});

describe('resolveFunnelArrowRates', () => {
  const def = salesFunnelByKey('sales_meetings_from_conversation');

  it('falls back to the legacy named rate when the brand stated no arrow', () => {
    const arrows = resolveFunnelArrowRates(
      def,
      { replyToMeetingPct: 12, meetingBookedToAttendedPct: null, meetingToClosePct: 30 },
      []
    );

    expect(arrows.map((a) => [a.fromStep, a.toStep, a.ratePct, a.provenance])).toEqual([
      ['Positive reply', 'Meeting booked', 12, 'named_rate'],
      ['Meeting booked', 'Meeting attended', null, 'unstated'],
      ['Meeting attended', 'Paid client', 30, 'named_rate'],
    ]);
  });

  it('lets a stated arrow WIN over the named rate describing the same arrow', () => {
    const arrows = resolveFunnelArrowRates(
      def,
      { replyToMeetingPct: 12, meetingBookedToAttendedPct: 70, meetingToClosePct: 30 },
      [
        {
          funnelKey: 'sales_meetings_from_conversation',
          fromStep: 'Positive reply',
          toStep: 'Meeting booked',
          ratePct: 19,
        },
      ]
    );

    expect(arrows[0]).toMatchObject({
      ratePct: 19,
      provenance: 'stated_arrow',
      rateKey: 'replyToMeetingPct',
    });
    // Every other arrow is untouched by the statement.
    expect(arrows[1]).toMatchObject({ ratePct: 70, provenance: 'named_rate' });
    expect(arrows[2]).toMatchObject({ ratePct: 30, provenance: 'named_rate' });
  });

  it('carries an arrow no named rate can express, after the catalogue arrows', () => {
    const arrows = resolveFunnelArrowRates(
      def,
      { replyToMeetingPct: 12 },
      [
        {
          funnelKey: 'sales_meetings_from_conversation',
          fromStep: 'Positive reply',
          toStep: 'Phone call',
          ratePct: 44,
        },
        {
          funnelKey: 'sales_meetings_from_conversation',
          fromStep: 'Phone call',
          toStep: 'Meeting booked',
          ratePct: 55,
        },
      ]
    );

    // The catalogue's own arrows come first and keep their order.
    expect(arrows.slice(0, 3).map((a) => a.toStep)).toEqual([
      'Meeting booked',
      'Meeting attended',
      'Paid client',
    ]);
    expect(arrows.slice(3)).toEqual([
      {
        fromStep: 'Phone call',
        toStep: 'Meeting booked',
        ratePct: 55,
        provenance: 'stated_arrow',
        rateKey: null,
      },
      {
        fromStep: 'Positive reply',
        toStep: 'Phone call',
        ratePct: 44,
        provenance: 'stated_arrow',
        rateKey: null,
      },
    ]);
  });

  it('ignores rows stated for a DIFFERENT funnel', () => {
    const arrows = resolveFunnelArrowRates(
      def,
      { replyToMeetingPct: 12 },
      [
        {
          funnelKey: 'website_purchases',
          fromStep: 'Website visit',
          toStep: 'Signup',
          ratePct: 3,
        },
      ]
    );

    expect(arrows).toHaveLength(def.steps.length - 1);
    expect(arrows[0]).toMatchObject({ ratePct: 12, provenance: 'named_rate' });
  });

  it('never invents a number for an arrow nobody priced', () => {
    const arrows = resolveFunnelArrowRates(def, {}, []);
    expect(arrows.every((a) => a.ratePct === null && a.provenance === 'unstated')).toBe(true);
  });
});

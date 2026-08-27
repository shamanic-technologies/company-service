import { describe, it, expect, vi } from 'vitest';

// The services below reach `../db` transitively (brandGoalService), and the unit
// suite runs with NO database url — importing it un-mocked throws at import time.
vi.mock('../../src/db', () => ({
  db: {},
  brands: {},
  brandSalesEconomics: {},
  brandSalesFunnels: {},
}));

import {
  ACCEPTED_SALES_FUNNEL_KEYS,
  LEGACY_SALES_FUNNEL_KEYS,
  SALES_FUNNELS,
  SALES_FUNNEL_KEYS,
  funnelPricesRate,
  funnelRateKeys,
  isSalesFunnelKey,
  salesFunnelByKey,
  toSalesFunnelKey,
} from '../../src/services/salesFunnelCatalogue';
import {
  SalesFunnelDestinationNotUsedError,
  SalesFunnelRateNotInFunnelError,
  assertPatchFitsFunnel,
  buildFunnelWrite,
  formatDeclaredFunnel,
  normalizeBookingUrl,
} from '../../src/services/salesFunnelsService';
import { funnelKeysForRetiredGoal, toRetiredGoal } from '../../src/services/brandGoalService';
import { ClickDestinationValidationError } from '../../src/services/clickDestinationService';

/**
 * The funnel model: which funnels exist, which rates each one prices, and what a
 * declared funnel reads back as. The invariant under all of it is that a value
 * the brand never declared reads `null` — never a zero, never a stand-in.
 */
describe('sales funnel catalogue', () => {
  it('carries the funnels the dashboard renders, in its order, with the original four unmoved', () => {
    expect(SALES_FUNNELS.map((f) => f.key)).toEqual([
      'sales_meetings_from_conversation',
      'sales_meetings_from_website',
      'website_purchases',
      'form_magnet',
      'sales_from_conversation',
      'sales_meetings_from_ads',
      'lead_forms_from_ads',
    ]);
    expect(SALES_FUNNEL_KEYS).toEqual(SALES_FUNNELS.map((f) => f.key));
  });

  it('prices every arrow of every funnel — legs is one shorter than steps', () => {
    for (const def of SALES_FUNNELS) {
      expect(def.legs.length).toBe(def.steps.length - 1);
    }
  });

  it('gives the meeting show-up rate a home in every meeting funnel', () => {
    const withShowUp = SALES_FUNNELS.filter((f) =>
      f.legs.includes('meetingBookedToAttendedPct')
    ).map((f) => f.key);
    expect(withShowUp).toEqual([
      'sales_meetings_from_conversation',
      'sales_meetings_from_website',
      'sales_meetings_from_ads',
    ]);
  });

  it('collects a booking link exactly for the funnels that contain a meeting', () => {
    for (const def of SALES_FUNNELS) {
      const hasMeeting = def.steps.includes('Meeting booked');
      expect(def.bookingLink).toBe(hasMeeting);
    }
  });

  it('lands a page destination only on funnels that start with a website visit', () => {
    for (const def of SALES_FUNNELS) {
      const startsOnSite = def.steps[0] === 'Website visit';
      expect(def.pageDestination).toBe(startsOnSite);
      expect(def.requiresWebsite).toBe(startsOnSite);
    }
  });

  it('carries NO goal — the key is the whole vocabulary', () => {
    // The goal is retired precisely because it could not do this: BOTH meeting
    // funnels named `meetingBooked`, so a consumer reading the goal could not
    // price a meeting won from a reply apart from one won on the website.
    for (const def of SALES_FUNNELS) {
      expect('goal' in def).toBe(false);
    }
    const meetingFunnels = SALES_FUNNELS.filter((f) => f.steps.includes('Meeting booked'));
    expect(meetingFunnels).toHaveLength(3);
    expect(new Set(meetingFunnels.map((f) => f.key)).size).toBe(3);
  });

  it('rejects an unknown funnel key rather than guessing one', () => {
    expect(isSalesFunnelKey('sales_meetings_from_conversation')).toBe(true);
    expect(isSalesFunnelKey('visit_whatsapp')).toBe(false);
    expect(() => salesFunnelByKey('visit_whatsapp' as never)).toThrow(/Unknown sales funnel/);
  });

  it('reports which rates a funnel prices', () => {
    const def = salesFunnelByKey('website_purchases');
    expect(funnelRateKeys(def)).toEqual(['visitToSignupPct', 'signupToPaidClientPct']);
    expect(funnelPricesRate(def, 'visitToSignupPct')).toBe(true);
    expect(funnelPricesRate(def, 'replyToMeetingPct')).toBe(false);
  });
});

describe('a patch must describe the funnel it targets', () => {
  it('rejects a rate outside the funnel instead of storing it where nothing reads it', () => {
    expect(() =>
      assertPatchFitsFunnel(salesFunnelByKey('website_purchases'), {
        rates: { visitToSignupPct: 30, replyToMeetingPct: 10 },
      })
    ).toThrow(SalesFunnelRateNotInFunnelError);
  });

  it('accepts a subset of the funnel — a funnel can be priced one leg at a time', () => {
    expect(() =>
      assertPatchFitsFunnel(salesFunnelByKey('sales_meetings_from_conversation'), {
        rates: { meetingBookedToAttendedPct: 70 },
      })
    ).not.toThrow();
  });

  it('rejects a page destination on a funnel that never lands a click on the site', () => {
    expect(() =>
      assertPatchFitsFunnel(salesFunnelByKey('sales_meetings_from_conversation'), {
        destinationUrl: 'https://example.com/x',
      })
    ).toThrow(SalesFunnelDestinationNotUsedError);
  });

  it('rejects a booking link on a funnel whose funnel contains no meeting', () => {
    expect(() =>
      assertPatchFitsFunnel(salesFunnelByKey('form_magnet'), {
        bookingUrl: 'https://cal.com/team/30min',
      })
    ).toThrow(SalesFunnelDestinationNotUsedError);
  });
});

describe('omitted leaves unchanged, null clears', () => {
  it('names no column the patch did not carry', () => {
    expect(buildFunnelWrite({ rates: { visitToSignupPct: 30 } })).toEqual({
      visitToSignupPct: 30,
    });
  });

  it('writes an explicit null so a value can be taken back', () => {
    const write = buildFunnelWrite({
      rates: { visitToSignupPct: null },
      lifetimeRevenueUsd: null,
      destinationUrl: null,
    });
    expect(write).toEqual({
      visitToSignupPct: null,
      lifetimeRevenueUsd: null,
      destinationUrl: null,
    });
    // Present-and-null is what clears; absent is what preserves. The two must
    // stay distinguishable or "leave unchanged" silently becomes "wipe".
    expect('lifetimeRevenueUsd' in write).toBe(true);
    expect('bookingUrl' in write).toBe(false);
  });

  it('declares a funnel with nothing priced yet', () => {
    expect(buildFunnelWrite({})).toEqual({});
  });
});

describe('a declared funnel reads back only its own funnel', () => {
  const row = {
    brandId: 'b',
    funnelKey: 'website_purchases',
    lifetimeRevenueUsd: 4200,
    replyToMeetingPct: 11,
    visitToMeetingPct: 12,
    meetingBookedToAttendedPct: 13,
    meetingToClosePct: 14,
    visitToSignupPct: 30,
    signupToPaidClientPct: null,
    visitToFormSubmissionPct: 17,
    formSubmissionToPaidClientPct: 18,
    destinationUrl: 'https://example.com/pricing',
    bookingUrl: null,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
  } as never;

  it('projects the legs it prices and nothing else', () => {
    const funnel = formatDeclaredFunnel(row);
    expect(Object.keys(funnel.rates)).toEqual(['visitToSignupPct', 'signupToPaidClientPct']);
  });

  it('reports a rate the brand never gave us as null, not as zero', () => {
    const funnel = formatDeclaredFunnel(row);
    expect(funnel.rates.visitToSignupPct).toBe(30);
    expect(funnel.rates.signupToPaidClientPct).toBeNull();
  });

  it('carries no goal at all — the retired vocabulary is off the wire', () => {
    const funnel = formatDeclaredFunnel(row);
    expect('goal' in funnel).toBe(false);
    expect('currentGoal' in funnel).toBe(false);
    expect(funnel.funnelKey).toBe('website_purchases');
  });

  it('carries its own lifetime revenue and destinations', () => {
    const funnel = formatDeclaredFunnel(row);
    expect(funnel.lifetimeRevenueUsd).toBe(4200);
    expect(funnel.destinationUrl).toBe('https://example.com/pricing');
    expect(funnel.bookingUrl).toBeNull();
  });
});

describe('booking link', () => {
  it('accepts a third-party scheduler on any domain', () => {
    expect(normalizeBookingUrl('https://cal.com/team/30min')).toBe('https://cal.com/team/30min');
  });

  it('assumes https when the scheme is missing', () => {
    expect(normalizeBookingUrl('cal.com/team/30min')).toBe('https://cal.com/team/30min');
  });

  it('rejects something that is not a link at all', () => {
    expect(() => normalizeBookingUrl('book me')).toThrow(ClickDestinationValidationError);
    expect(() => normalizeBookingUrl('   ')).toThrow(ClickDestinationValidationError);
  });
});

/**
 * Yesterday's words keep writing. That is the whole reason the emission switch
 * could be made in one repo: nothing had to change in lockstep, because every
 * spelling a caller has ever sent still resolves — the old FUNNEL keys to the
 * new ones, and the retired GOALS to the funnels they named.
 */
describe('write tolerance for yesterday\'s words', () => {
  it('resolves every pre-retirement funnel key to its canonical one', () => {
    expect(toSalesFunnelKey('reply_meeting')).toBe('sales_meetings_from_conversation');
    expect(toSalesFunnelKey('visit_meeting')).toBe('sales_meetings_from_website');
    expect(toSalesFunnelKey('visit_signup')).toBe('website_purchases');
    expect(toSalesFunnelKey('visit_form')).toBe('form_magnet');
  });

  it('leaves a canonical key untouched, and refuses a word that names nothing', () => {
    for (const key of SALES_FUNNEL_KEYS) {
      expect(toSalesFunnelKey(key)).toBe(key);
    }
    expect(toSalesFunnelKey('visit_whatsapp')).toBeNull();
  });

  it('accepts exactly the canonical four plus the legacy four, and nothing else', () => {
    expect([...ACCEPTED_SALES_FUNNEL_KEYS].sort()).toEqual(
      [...SALES_FUNNEL_KEYS, ...Object.keys(LEGACY_SALES_FUNNEL_KEYS)].sort()
    );
  });

  it('never lets a legacy key BE a canonical one — they are disjoint spellings', () => {
    for (const legacy of Object.keys(LEGACY_SALES_FUNNEL_KEYS)) {
      expect(SALES_FUNNEL_KEYS).not.toContain(legacy);
    }
  });

  it("understands the dashboard's sales_meetings as the meeting funnel", () => {
    expect(toRetiredGoal('sales_meetings')).toBe('meetingBooked');
    expect(
      funnelKeysForRetiredGoal(toRetiredGoal('booked_meetings'), { hasClickDestination: false })
    ).toEqual(['sales_meetings_from_conversation']);
  });
});

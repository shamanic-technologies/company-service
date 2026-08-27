import { describe, it, expect } from 'vitest';

// The catalogue is pure — it reaches no database — but `salesFunnelsService`
// does, and the unit suite runs with NO database url.
import { vi } from 'vitest';
vi.mock('../../src/db', () => ({
  db: {},
  brands: {},
  brandSalesEconomics: {},
  brandSalesFunnels: {},
}));

import {
  SALES_FUNNELS,
  SALES_FUNNEL_START_EVENTS,
  funnelMilestoneStepIndex,
  salesFunnelByKey,
  type SalesFunnelDef,
} from '../../src/services/salesFunnelCatalogue';
import { formatDeclaredFunnel } from '../../src/services/salesFunnelsService';

/**
 * Two questions a consumer asks of every funnel, old and new: which acquisition
 * channels can feed it, and what does one month of such a channel have to pay
 * for. The first is answered by the START EVENT, the second by the MILESTONE.
 * Neither may be defaulted — a funnel that cannot answer them fails loud.
 */
describe('every funnel states the event that starts it', () => {
  it('answers with one of the three starting situations, never something else', () => {
    for (const def of SALES_FUNNELS) {
      expect(SALES_FUNNEL_START_EVENTS).toContain(def.startEvent);
    }
  });

  it('agrees with the first step of its own funnel', () => {
    const labelForEvent: Record<string, string> = {
      conversation_reply: 'Positive reply',
      website_visit: 'Website visit',
      ad_click: 'Ad click',
    };
    for (const def of SALES_FUNNELS) {
      expect(def.steps[0]).toBe(labelForEvent[def.startEvent]);
    }
  });

  it('needs a website exactly when the journey begins on the brand\'s own site', () => {
    for (const def of SALES_FUNNELS) {
      expect(def.requiresWebsite).toBe(def.startEvent === 'website_visit');
    }
  });

  it('separates the three situations a channel can produce', () => {
    const byEvent = (event: string) =>
      SALES_FUNNELS.filter((f) => f.startEvent === event).map((f) => f.key);

    expect(byEvent('conversation_reply')).toEqual([
      'sales_meetings_from_conversation',
      'sales_from_conversation',
    ]);
    expect(byEvent('website_visit')).toEqual([
      'sales_meetings_from_website',
      'website_purchases',
      'form_magnet',
    ]);
    // The platform-hosted journeys: the buyer engages with an ad and never
    // touches the brand's site, which is why neither of these requires one.
    expect(byEvent('ad_click')).toEqual(['sales_meetings_from_ads', 'lead_forms_from_ads']);
  });
});

describe('every funnel states the step it is named after', () => {
  it('names a step of its OWN funnel, so a consumer can read it instead of hardcoding one', () => {
    for (const def of SALES_FUNNELS) {
      expect(def.steps).toContain(def.milestoneStep);
      expect(def.steps[funnelMilestoneStepIndex(def)]).toBe(def.milestoneStep);
    }
  });

  it('keeps the milestone the original four already had', () => {
    expect(salesFunnelByKey('sales_meetings_from_conversation').milestoneStep).toBe('Meeting booked');
    expect(salesFunnelByKey('sales_meetings_from_website').milestoneStep).toBe('Meeting booked');
    expect(salesFunnelByKey('website_purchases').milestoneStep).toBe('Signup');
    expect(salesFunnelByKey('form_magnet').milestoneStep).toBe('Form filled');
  });

  it('names the new funnels after the moment that tells the brand they are working', () => {
    expect(salesFunnelByKey('sales_meetings_from_ads').milestoneStep).toBe('Meeting booked');
    expect(salesFunnelByKey('lead_forms_from_ads').milestoneStep).toBe('Lead form submitted');
    // The one funnel with no stage before the sale names the SALE, because that
    // genuinely is what it is named after — not a stand-in for a missing step.
    expect(salesFunnelByKey('sales_from_conversation').milestoneStep).toBe('Paid client');
  });

  it('refuses a funnel whose milestone is not one of its steps rather than answering 0', () => {
    // 0 is a real position in the funnel — the starting event — so a funnel that
    // cannot resolve its milestone must fail loud, never be read as "the start".
    const broken = {
      key: 'lead_forms_from_ads',
      name: 'Broken',
      startEvent: 'ad_click',
      steps: ['Ad click', 'Lead form submitted', 'Paid client'],
      legs: ['adClickToLeadFormPct', 'leadFormToPaidClientPct'],
      milestoneStep: 'Meeting booked',
      requiresWebsite: false,
      pageDestination: false,
      bookingLink: false,
    } as SalesFunnelDef;

    expect(() => funnelMilestoneStepIndex(broken)).toThrow(/names milestone step/);
  });
});

describe('the new funnels price their own legs, and only their own', () => {
  it('gives the sale-in-the-conversation funnel its single leg', () => {
    const def = salesFunnelByKey('sales_from_conversation');
    expect(def.steps).toEqual(['Positive reply', 'Paid client']);
    expect(def.legs).toEqual(['replyToPaidClientPct']);
    // No meeting is ever booked, so there is nothing to schedule and nothing to
    // land on the brand's site.
    expect(def.bookingLink).toBe(false);
    expect(def.pageDestination).toBe(false);
  });

  it('gives the ad-booked meeting its own first leg and shares the rest of the meeting funnel', () => {
    const def = salesFunnelByKey('sales_meetings_from_ads');
    expect(def.legs).toEqual([
      'adClickToMeetingPct',
      'meetingBookedToAttendedPct',
      'meetingToClosePct',
    ]);
    expect(def.bookingLink).toBe(true);
  });

  it('keeps the platform lead form general rather than naming one use of it', () => {
    const def = salesFunnelByKey('lead_forms_from_ads');
    expect(def.steps).toEqual(['Ad click', 'Lead form submitted', 'Paid client']);
    expect(def.legs).toEqual(['adClickToLeadFormPct', 'leadFormToPaidClientPct']);
  });
});

describe('a declared funnel reads back its start event and its milestone', () => {
  const row = {
    orgId: 'o',
    brandId: 'b',
    funnelKey: 'lead_forms_from_ads',
    active: true,
    lifetimeRevenueUsd: 900,
    adClickToLeadFormPct: 12,
    leadFormToPaidClientPct: null,
    replyToMeetingPct: 11,
    destinationUrl: null,
    bookingUrl: null,
    updatedAt: '2026-08-19T00:00:00.000Z',
  } as never;

  it('answers both questions on the wire, beside the funnel itself', () => {
    const funnel = formatDeclaredFunnel(row);
    expect(funnel.startEvent).toBe('ad_click');
    expect(funnel.milestoneStep).toBe('Lead form submitted');
    expect(funnel.milestoneStepIndex).toBe(1);
    expect(funnel.steps[funnel.milestoneStepIndex]).toBe(funnel.milestoneStep);
  });

  it('still projects only the legs this funnel prices, absent reading null', () => {
    const funnel = formatDeclaredFunnel(row);
    expect(Object.keys(funnel.rates)).toEqual([
      'adClickToLeadFormPct',
      'leadFormToPaidClientPct',
    ]);
    expect(funnel.rates.adClickToLeadFormPct).toBe(12);
    expect(funnel.rates.leadFormToPaidClientPct).toBeNull();
  });
});

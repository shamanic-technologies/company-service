import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from '../helpers/test-app';
import {
  db,
  brands,
  orgBrands,
  brandOffers,
  brandSalesFunnels,
  brandSalesFunnelArrowRates,
} from '../../src/db';
import { inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/**
 * A brand states a rate for an ARROW of a funnel, named by the two steps it
 * connects — including an arrow this service has never heard of, which is the
 * whole reason the arrow vocabulary exists: funnels are gaining steps (a phone
 * call between a positive reply and a booked meeting is the first) and under the
 * named-column model each one costs a migration plus a fleet-wide rename.
 *
 * Nothing about the existing rates moves. They are still written, still read and
 * still answer the same numbers, whether or not the brand has stated an arrow.
 */
describe('Rates stated for the arrows of a funnel', () => {
  const app = createTestApp();

  const orgId = randomUUID();
  const brandId = randomUUID();
  const domain = `arrows-${brandId.slice(0, 8)}.com`;

  beforeAll(async () => {
    await db.insert(brands).values({ id: brandId, url: `https://${domain}`, domain, name: 'Arrow Brand' });
    await db.insert(orgBrands).values({ orgId, brandId });
  });

  afterAll(async () => {
    await db
      .delete(brandSalesFunnelArrowRates)
      .where(inArray(brandSalesFunnelArrowRates.brandId, [brandId]));
    await db.delete(brandSalesFunnels).where(inArray(brandSalesFunnels.brandId, [brandId]));
    await db.delete(brandOffers).where(inArray(brandOffers.brandId, [brandId]));
    await db.delete(orgBrands).where(inArray(orgBrands.brandId, [brandId]));
    await db.delete(brands).where(inArray(brands.id, [brandId]));
  });

  const one = (key: string) => `/orgs/brands/${brandId}/sales-funnels/${key}`;
  const KEY = 'sales_meetings_from_conversation';
  const arrowOf = (funnel: any, fromStep: string, toStep: string) =>
    funnel.arrows.find((a: any) => a.fromStep === fromStep && a.toStep === toStep);

  it('a funnel priced only by named rates reads its arrows off those rates', async () => {
    const res = await request(app)
      .put(one(KEY))
      .set(getAuthHeaders(orgId))
      .send({ rates: { replyToMeetingPct: 12, meetingToClosePct: 30 } });

    expect(res.status).toBe(200);
    const funnel = res.body.funnel;
    // The named rates are exactly what they were before any of this existed.
    expect(funnel.rates.replyToMeetingPct).toBe(12);
    expect(funnel.rates.meetingToClosePct).toBe(30);
    // And the arrow view answers the same numbers, saying where they came from.
    expect(arrowOf(funnel, 'Positive reply', 'Meeting booked')).toMatchObject({
      ratePct: 12,
      provenance: 'named_rate',
      rateKey: 'replyToMeetingPct',
    });
    expect(arrowOf(funnel, 'Meeting booked', 'Meeting attended')).toMatchObject({
      ratePct: null,
      provenance: 'unstated',
    });
  });

  it('persists and reads back a rate for an arrow no named rate can express', async () => {
    const write = await request(app)
      .put(one(KEY))
      .set(getAuthHeaders(orgId))
      .send({
        arrowRates: [
          { fromStep: 'Positive reply', toStep: 'Phone call', ratePct: 44 },
          { fromStep: 'Phone call', toStep: 'Meeting booked', ratePct: 55 },
        ],
      });

    expect(write.status).toBe(200);
    expect(arrowOf(write.body.funnel, 'Positive reply', 'Phone call')).toMatchObject({
      ratePct: 44,
      provenance: 'stated_arrow',
      rateKey: null,
    });

    // Read back on a fresh request — the statement is stored, not echoed.
    const read = await request(app)
      .get(`/orgs/brands/${brandId}/sales-funnels`)
      .set(getAuthHeaders(orgId));
    expect(read.status).toBe(200);
    const funnel = read.body.funnels.find((f: any) => f.funnelKey === KEY);
    expect(arrowOf(funnel, 'Phone call', 'Meeting booked')).toMatchObject({
      ratePct: 55,
      provenance: 'stated_arrow',
    });
    // And the named rates the brand stated earlier are untouched by it.
    expect(funnel.rates.replyToMeetingPct).toBe(12);
    expect(funnel.rates.meetingToClosePct).toBe(30);
  });

  it('a stated arrow WINS over the named rate describing the same arrow', async () => {
    const res = await request(app)
      .put(one(KEY))
      .set(getAuthHeaders(orgId))
      .send({ arrowRates: [{ fromStep: 'Positive reply', toStep: 'Meeting booked', ratePct: 19 }] });

    expect(res.status).toBe(200);
    const funnel = res.body.funnel;
    expect(arrowOf(funnel, 'Positive reply', 'Meeting booked')).toMatchObject({
      ratePct: 19,
      provenance: 'stated_arrow',
    });
    // The named rate itself still answers 12 — an existing consumer sees no change.
    expect(funnel.rates.replyToMeetingPct).toBe(12);
  });

  it('clears a stated arrow with an explicit null, back to the named rate', async () => {
    const res = await request(app)
      .put(one(KEY))
      .set(getAuthHeaders(orgId))
      .send({ arrowRates: [{ fromStep: 'Positive reply', toStep: 'Meeting booked', ratePct: null }] });

    expect(res.status).toBe(200);
    expect(arrowOf(res.body.funnel, 'Positive reply', 'Meeting booked')).toMatchObject({
      ratePct: 12,
      provenance: 'named_rate',
    });
    // Clearing one arrow leaves every other statement exactly as stored.
    expect(arrowOf(res.body.funnel, 'Positive reply', 'Phone call')).toMatchObject({ ratePct: 44 });
  });

  it('refuses an arrow that cannot identify one', async () => {
    const res = await request(app)
      .put(one(KEY))
      .set(getAuthHeaders(orgId))
      .send({ arrowRates: [{ fromStep: 'Meeting booked', toStep: 'Meeting booked', ratePct: 40 }] });

    expect(res.status).toBe(400);
  });

  it('the internal read carries the arrows too', async () => {
    const res = await request(app)
      .get(`/internal/brands/${brandId}/sales-funnels`)
      .set(getInternalAuthHeaders())
      .set('x-org-id', orgId);

    expect(res.status).toBe(200);
    const funnel = res.body.funnels.find((f: any) => f.funnelKey === KEY);
    expect(arrowOf(funnel, 'Positive reply', 'Phone call')).toMatchObject({
      ratePct: 44,
      provenance: 'stated_arrow',
    });
  });

  it('a brand that has stated no arrow reads exactly what it read before', async () => {
    const otherKey = 'website_purchases';
    const res = await request(app)
      .put(one(otherKey))
      .set(getAuthHeaders(orgId))
      .send({ rates: { visitToSignupPct: 4, signupToPaidClientPct: 25 } });

    expect(res.status).toBe(200);
    expect(res.body.funnel.rates).toEqual({ visitToSignupPct: 4, signupToPaidClientPct: 25 });
    expect(res.body.funnel.arrows.every((a: any) => a.provenance === 'named_rate')).toBe(true);
  });
});

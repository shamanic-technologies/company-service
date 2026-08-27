import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { inArray } from 'drizzle-orm';
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from '../helpers/test-app';
import { db, brands, orgBrands, brandOffers, brandSalesFunnels } from '../../src/db';

/**
 * THE INTERNAL FUNNEL READ ASKS PER OFFER — because a funnel's price is the
 * offer's price, not the brand's.
 *
 * A declared funnel hangs off an OFFER and carries that offer's own lifetime
 * revenue and its own rates: a brand selling a $200 self-serve plan and a $20k
 * contract converts and is worth completely different numbers on the same
 * funnel. The service-auth read served the brand's SOLE offer, so a brand that
 * states a second could not be answered at all — and features-service, which
 * prices a lead through the offer its campaign sells, had no way to say which.
 *
 * What closes it is not a default. The caller NAMES the offer; a caller that
 * names none keeps the deliberate 409, because serving one proposition's
 * economics for another produces figures that read perfectly and are wrong
 * throughout.
 */
describe('internal sales-funnels read names an offer', () => {
  const app = createTestApp();

  const orgId = randomUUID();
  const soleOfferBrandId = randomUUID();
  const twoOfferBrandId = randomUUID();
  const brandIds = [soleOfferBrandId, twoOfferBrandId];

  let soleOfferId = '';
  let starterOfferId = '';
  let enterpriseOfferId = '';

  const internalPath = (brandId: string) => `/internal/brands/${brandId}/sales-funnels`;

  const declare = async (
    brandId: string,
    offerId: string,
    lifetimeRevenueUsd: number,
    replyToMeetingPct: number,
  ) => {
    const res = await request(app)
      .put(`/orgs/brands/${brandId}/offers/${offerId}/sales-funnels/sales_meetings_from_conversation`)
      .set(getAuthHeaders(orgId))
      .send({
        rates: { replyToMeetingPct, meetingToClosePct: 40 },
        lifetimeRevenueUsd,
      });
    expect(res.status).toBe(200);
  };

  const createOffer = async (brandId: string, name: string): Promise<string> => {
    const res = await request(app)
      .post(`/orgs/brands/${brandId}/offers`)
      .set(getAuthHeaders(orgId))
      .send({ name });
    expect(res.status).toBe(201);
    return res.body.offer.offerId;
  };

  beforeAll(async () => {
    await db.insert(brands).values(
      brandIds.map((id) => ({
        id,
        url: `https://funnelgrain-${id.slice(0, 8)}.com`,
        domain: `funnelgrain-${id.slice(0, 8)}.com`,
        name: 'Funnel Grain Brand',
      })),
    );
    await db.insert(orgBrands).values(brandIds.map((brandId) => ({ orgId, brandId })));

    soleOfferId = await createOffer(soleOfferBrandId, 'Only Offer');
    starterOfferId = await createOffer(twoOfferBrandId, 'Starter Plan');
    enterpriseOfferId = await createOffer(twoOfferBrandId, 'Enterprise');

    // Each proposition prices its OWN funnel — that difference is the only thing
    // that makes a wrong pick observable.
    await declare(soleOfferBrandId, soleOfferId, 4200, 25);
    await declare(twoOfferBrandId, starterOfferId, 200, 10);
    await declare(twoOfferBrandId, enterpriseOfferId, 20000, 70);
  });

  afterAll(async () => {
    await db.delete(brandSalesFunnels).where(inArray(brandSalesFunnels.brandId, brandIds));
    await db.delete(brandOffers).where(inArray(brandOffers.brandId, brandIds));
    await db.delete(orgBrands).where(inArray(orgBrands.brandId, brandIds));
    await db.delete(brands).where(inArray(brands.id, brandIds));
  });

  // ── A brand with ONE offer is unchanged ───────────────────────────────────

  it('answers a brand with ONE offer identically, named or unnamed', async () => {
    const unnamed = await request(app).get(internalPath(soleOfferBrandId)).set(getInternalAuthHeaders());
    const named = await request(app)
      .get(`${internalPath(soleOfferBrandId)}?offerId=${soleOfferId}`)
      .set(getInternalAuthHeaders());

    expect(unnamed.status).toBe(200);
    expect(unnamed.body.funnels).toHaveLength(1);
    expect(unnamed.body.funnels[0].lifetimeRevenueUsd).toBe(4200);
    // Naming the sole offer states what resolution already worked out; it does
    // not change the read.
    expect(named.status).toBe(200);
    expect(named.body).toEqual(unnamed.body);
  });

  // ── A brand with SEVERAL is answerable once one is named ──────────────────

  it("serves each offer's OWN lifetime revenue and rates, never the other's", async () => {
    const starter = await request(app)
      .get(`${internalPath(twoOfferBrandId)}?offerId=${starterOfferId}`)
      .set(getInternalAuthHeaders());
    const enterprise = await request(app)
      .get(`${internalPath(twoOfferBrandId)}?offerId=${enterpriseOfferId}`)
      .set(getInternalAuthHeaders());

    expect(starter.status).toBe(200);
    expect(starter.body.funnels).toHaveLength(1);
    expect(starter.body.funnels[0].lifetimeRevenueUsd).toBe(200);
    expect(starter.body.funnels[0].rates.replyToMeetingPct).toBe(10);

    expect(enterprise.status).toBe(200);
    expect(enterprise.body.funnels).toHaveLength(1);
    expect(enterprise.body.funnels[0].lifetimeRevenueUsd).toBe(20000);
    expect(enterprise.body.funnels[0].rates.replyToMeetingPct).toBe(70);
  });

  it('still refuses a brand selling several when NO offer is named', async () => {
    const res = await request(app).get(internalPath(twoOfferBrandId)).set(getInternalAuthHeaders());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEVERAL_OFFERS');
  });

  // ── An unresolvable offer fails loudly, never falls back ──────────────────

  it('404s an offerId that names no offer of this brand, rather than serving the brand rows', async () => {
    const foreign = await request(app)
      .get(`${internalPath(soleOfferBrandId)}?offerId=${starterOfferId}`)
      .set(getInternalAuthHeaders());
    expect(foreign.status).toBe(404);

    const unknown = await request(app)
      .get(`${internalPath(soleOfferBrandId)}?offerId=${randomUUID()}`)
      .set(getInternalAuthHeaders());
    expect(unknown.status).toBe(404);
  });

  it('400s a malformed offerId instead of reading it as "no offer named"', async () => {
    const res = await request(app)
      .get(`${internalPath(twoOfferBrandId)}?offerId=not-a-uuid`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(400);
  });
});

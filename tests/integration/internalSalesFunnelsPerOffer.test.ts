import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { inArray } from 'drizzle-orm';
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from '../helpers/test-app';
import { db, brands, orgBrands, brandOffers, brandSalesFunnels } from '../../src/db';

/**
 * THE SERVICE-AUTH FUNNEL READ ASKS PER OFFER.
 *
 * features-service prices a lead with the economics of the thing being sold:
 * the lifetime revenue of the offer, and that offer's own conversion rates. Both
 * hang off the offer already — a brand selling a $200 self-serve plan and a $20k
 * enterprise contract states two funnel sets, and averaging them prices every
 * lead wrong.
 *
 * The service-auth read was keyed by brand alone, so it resolved the brand's
 * SOLE offer and refused a brand holding several. The refusal was right — no
 * default is defensible — but the caller DOES hold the offer and had no way to
 * say so. `?offerId=` is that way.
 *
 * These pin the three things that must hold together: the named offer answers
 * with its OWN numbers, a caller that names none behaves exactly as before
 * (including the refusal), and an offer that does not belong to the brand is
 * refused rather than swapped for one that does.
 */
describe('internal sales-funnels read at the offer grain', () => {
  const app = createTestApp();

  const orgId = randomUUID();
  const soleOfferBrandId = randomUUID();
  const twoOfferBrandId = randomUUID();
  const brandIds = [soleOfferBrandId, twoOfferBrandId];

  let soleOfferId = '';
  let starterOfferId = '';
  let enterpriseOfferId = '';

  const internalPath = (brandId: string) => `/internal/brands/${brandId}/sales-funnels`;

  beforeAll(async () => {
    await db.insert(brands).values(
      brandIds.map((id) => ({
        id,
        url: `https://funnel-grain-${id.slice(0, 8)}.com`,
        domain: `funnel-grain-${id.slice(0, 8)}.com`,
        name: 'Funnel Grain Brand',
      })),
    );
    await db.insert(orgBrands).values(brandIds.map((brandId) => ({ orgId, brandId })));

    const createOffer = async (brandId: string, name: string) => {
      const res = await request(app)
        .post(`/orgs/brands/${brandId}/offers`)
        .set(getAuthHeaders(orgId))
        .send({ name });
      expect(res.status).toBe(201);
      return res.body.offer.offerId as string;
    };

    soleOfferId = await createOffer(soleOfferBrandId, 'Only Offer');
    starterOfferId = await createOffer(twoOfferBrandId, 'Starter Plan');
    enterpriseOfferId = await createOffer(twoOfferBrandId, 'Enterprise');

    // Each proposition prices its OWN sale. The difference in lifetime revenue
    // is what makes a wrong pick observable at all — an average across the two
    // would read as a plausible number and be wrong for both.
    const declare = async (
      brandId: string,
      offerId: string,
      funnelKey: string,
      body: Record<string, unknown>,
    ) => {
      const res = await request(app)
        .put(`/orgs/brands/${brandId}/offers/${offerId}/sales-funnels/${funnelKey}`)
        .set(getAuthHeaders(orgId))
        .send(body);
      expect(res.status).toBe(200);
    };

    await declare(soleOfferBrandId, soleOfferId, 'sales_from_conversation', {
      rates: { replyToPaidClientPct: 12 },
      lifetimeRevenueUsd: 900,
    });

    await declare(twoOfferBrandId, starterOfferId, 'sales_from_conversation', {
      rates: { replyToPaidClientPct: 20 },
      lifetimeRevenueUsd: 200,
    });
    await declare(twoOfferBrandId, enterpriseOfferId, 'sales_from_conversation', {
      rates: { replyToPaidClientPct: 3 },
      lifetimeRevenueUsd: 20000,
    });
  });

  afterAll(async () => {
    await db.delete(brandSalesFunnels).where(inArray(brandSalesFunnels.brandId, brandIds));
    await db.delete(brandOffers).where(inArray(brandOffers.brandId, brandIds));
    await db.delete(orgBrands).where(inArray(orgBrands.brandId, brandIds));
    await db.delete(brands).where(inArray(brands.id, brandIds));
  });

  // ── AC1 — a named offer answers with its OWN economics ────────────────────

  it('serves the NAMED offer\'s funnels, with that offer\'s lifetime revenue and rates', async () => {
    const starter = await request(app)
      .get(internalPath(twoOfferBrandId))
      .query({ offerId: starterOfferId })
      .set(getInternalAuthHeaders());
    const enterprise = await request(app)
      .get(internalPath(twoOfferBrandId))
      .query({ offerId: enterpriseOfferId })
      .set(getInternalAuthHeaders());

    expect(starter.status).toBe(200);
    expect(enterprise.status).toBe(200);

    expect(starter.body.funnels).toHaveLength(1);
    expect(enterprise.body.funnels).toHaveLength(1);

    expect(starter.body.funnels[0].lifetimeRevenueUsd).toBe(200);
    expect(starter.body.funnels[0].rates.replyToPaidClientPct).toBe(20);

    expect(enterprise.body.funnels[0].lifetimeRevenueUsd).toBe(20000);
    expect(enterprise.body.funnels[0].rates.replyToPaidClientPct).toBe(3);

    // Neither read carries the other's price. That leak is the whole failure
    // mode a brand-wide average produces, and it looks plausible.
    expect(starter.body.funnels[0].lifetimeRevenueUsd).not.toBe(
      enterprise.body.funnels[0].lifetimeRevenueUsd,
    );
  });

  it('only lists the ACTIVE funnels of the named offer', async () => {
    // A second funnel on the enterprise offer, then switched off. A scheduler
    // must never rank a funnel the org stopped selling through.
    const second = await request(app)
      .put(`/orgs/brands/${twoOfferBrandId}/offers/${enterpriseOfferId}/sales-funnels/lead_forms_from_ads`)
      .set(getAuthHeaders(orgId))
      .send({ rates: { adClickToLeadFormPct: 5 }, lifetimeRevenueUsd: 20000 });
    expect(second.status).toBe(200);

    const off = await request(app)
      .delete(`/orgs/brands/${twoOfferBrandId}/offers/${enterpriseOfferId}/sales-funnels/lead_forms_from_ads`)
      .set(getAuthHeaders(orgId));
    expect(off.status).toBe(200);

    const res = await request(app)
      .get(internalPath(twoOfferBrandId))
      .query({ offerId: enterpriseOfferId })
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.funnels.map((f: { funnelKey: string }) => f.funnelKey)).toEqual([
      'sales_from_conversation',
    ]);
  });

  // ── AC2 — naming nothing is byte-for-byte today's behaviour ───────────────

  it('answers a brand with ONE offer identically whether or not the offer is named', async () => {
    const unnamed = await request(app)
      .get(internalPath(soleOfferBrandId))
      .set(getInternalAuthHeaders());
    const named = await request(app)
      .get(internalPath(soleOfferBrandId))
      .query({ offerId: soleOfferId })
      .set(getInternalAuthHeaders());

    expect(unnamed.status).toBe(200);
    expect(named.status).toBe(200);
    expect(unnamed.body.funnels[0].lifetimeRevenueUsd).toBe(900);
    // Naming the sole offer states what resolution already worked out — it does
    // not change the read.
    expect(named.body).toEqual(unnamed.body);
  });

  it('keeps the deliberate refusal for a brand holding several offers when none is named', async () => {
    const res = await request(app).get(internalPath(twoOfferBrandId)).set(getInternalAuthHeaders());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SEVERAL_OFFERS');
    expect(res.body.offers.map((o: { name: string }) => o.name).sort()).toEqual([
      'Enterprise',
      'Starter Plan',
    ]);
  });

  it('still answers an unclaimed brand with an empty set when no offer is named', async () => {
    const res = await request(app).get(internalPath(randomUUID())).set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ funnels: [] });
  });

  // ── AC3 — a foreign offer is REFUSED, never swapped ───────────────────────

  it('404s an offer that belongs to another brand rather than serving this one\'s funnels', async () => {
    const res = await request(app)
      .get(internalPath(twoOfferBrandId))
      .query({ offerId: soleOfferId })
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OFFER_NOT_FOUND');
  });

  it('404s an offer id that names nothing at all', async () => {
    const res = await request(app)
      .get(internalPath(soleOfferBrandId))
      .query({ offerId: randomUUID() })
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OFFER_NOT_FOUND');
  });

  it('refuses a named offer on an UNCLAIMED brand instead of falling back to the empty set', async () => {
    const res = await request(app)
      .get(internalPath(randomUUID()))
      .query({ offerId: soleOfferId })
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('OFFER_NOT_FOUND');
  });

  it('400s a malformed offerId instead of reading it as "no offer named"', async () => {
    const res = await request(app)
      .get(internalPath(twoOfferBrandId))
      .query({ offerId: 'not-a-uuid' })
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(400);
  });

  // ── The org-authenticated reads are untouched ─────────────────────────────

  it('leaves the org-scoped per-offer read exactly as it was', async () => {
    const res = await request(app)
      .get(`/orgs/brands/${twoOfferBrandId}/offers/${starterOfferId}/sales-funnels`)
      .set(getAuthHeaders(orgId));

    expect(res.status).toBe(200);
    expect(res.body.funnels[0].lifetimeRevenueUsd).toBe(200);
  });
});

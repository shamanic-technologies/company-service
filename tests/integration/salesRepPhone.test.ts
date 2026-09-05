import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from '../helpers/test-app';
import { db, brands, orgBrands, brandSalesRepPhones } from '../../src/db';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/**
 * Per-brand sales rep phone — the one number to ring when a sales interest
 * lands on the brand. Set / change / remove through the org routes, read back
 * on the internal brand read, and `null` (never an error, never an empty
 * string) for the brands that never stated one.
 */
describe('Sales rep phone endpoints', () => {
  const app = createTestApp();

  const ownerOrgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID(); // owned by ownerOrgId
  const unsetBrandId = randomUUID(); // owned by ownerOrgId, never written
  const foreignBrandId = randomUUID(); // owned by otherOrgId
  const sharedBrandId = randomUUID(); // claimed by BOTH orgs
  const unknownBrandId = randomUUID(); // not in brands at all

  const allBrandIds = [brandId, unsetBrandId, foreignBrandId, sharedBrandId];
  const dom = (id: string) => `salesrep-${id.slice(0, 8)}.com`;

  beforeAll(async () => {
    await db.insert(brands).values(
      allBrandIds.map((id) => ({
        id,
        url: `https://${dom(id)}`,
        domain: dom(id),
        name: 'Sales Rep Test Brand',
      }))
    );
    await db.insert(orgBrands).values([
      { orgId: ownerOrgId, brandId },
      { orgId: ownerOrgId, brandId: unsetBrandId },
      { orgId: otherOrgId, brandId: foreignBrandId },
      { orgId: ownerOrgId, brandId: sharedBrandId },
      { orgId: otherOrgId, brandId: sharedBrandId },
    ]);
  });

  afterAll(async () => {
    await db.delete(brandSalesRepPhones).where(inArray(brandSalesRepPhones.brandId, allBrandIds));
    await db.delete(orgBrands).where(inArray(orgBrands.brandId, allBrandIds));
    await db.delete(brands).where(inArray(brands.id, allBrandIds));
  });

  const path = (id: string) => `/orgs/brands/${id}/sales-rep-phone`;

  // AC — set
  it('PUT stores the number and returns it in E.164', async () => {
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+33 7 70 65 75 85' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ salesRepPhone: '+33770657585' });
  });

  it('GET reads the stored number back', async () => {
    const res = await request(app).get(path(brandId)).set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ salesRepPhone: '+33770657585' });
  });

  // AC — change
  it('PUT is idempotent and a second write changes the number', async () => {
    await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+15551234567' });
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+15559876543' });

    expect(res.status).toBe(200);
    expect(res.body.salesRepPhone).toBe('+15559876543');

    const rows = await db
      .select()
      .from(brandSalesRepPhones)
      .where(eq(brandSalesRepPhones.brandId, brandId));
    expect(rows).toHaveLength(1);
  });

  // AC — the brand read reports the number
  it('GET /internal/brands/:id reports the number', async () => {
    await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+33770657585' });

    const res = await request(app)
      .get(`/internal/brands/${brandId}`)
      .set(getInternalAuthHeaders())
      .set('x-org-id', ownerOrgId);

    expect(res.status).toBe(200);
    expect(res.body.brand.salesRepPhone).toBe('+33770657585');
  });

  // AC — absence is a first-class answer
  it('GET /internal/brands/:id reports null for a brand that never stated one', async () => {
    const res = await request(app)
      .get(`/internal/brands/${unsetBrandId}`)
      .set(getInternalAuthHeaders())
      .set('x-org-id', ownerOrgId);

    expect(res.status).toBe(200);
    expect(res.body.brand.salesRepPhone).toBeNull();
  });

  it('GET /orgs/... reports null for a brand that never stated one', async () => {
    const res = await request(app).get(path(unsetBrandId)).set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ salesRepPhone: null });
  });

  it('the batch internal read carries the field per brand', async () => {
    const res = await request(app)
      .get(`/internal/brands?ids=${brandId},${unsetBrandId}`)
      .set(getInternalAuthHeaders())
      .set('x-org-id', ownerOrgId);

    expect(res.status).toBe(200);
    const set = res.body.brands.find((b: any) => b.id === brandId);
    const unset = res.body.brands.find((b: any) => b.id === unsetBrandId);
    expect(set.salesRepPhone).toBe('+33770657585');
    expect(unset.salesRepPhone).toBeNull();
  });

  // AC — remove
  it('DELETE removes the number and the brand goes back to nobody-to-ring', async () => {
    await request(app)
      .put(path(unsetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+15550001111' });

    const del = await request(app).delete(path(unsetBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ salesRepPhone: null });

    const read = await request(app)
      .get(`/internal/brands/${unsetBrandId}`)
      .set(getInternalAuthHeaders())
      .set('x-org-id', ownerOrgId);
    expect(read.body.brand.salesRepPhone).toBeNull();

    const rows = await db
      .select()
      .from(brandSalesRepPhones)
      .where(eq(brandSalesRepPhones.brandId, unsetBrandId));
    expect(rows).toHaveLength(0);
  });

  it('DELETE on a brand with no number is a 200, not a 404', async () => {
    const res = await request(app).delete(path(unsetBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ salesRepPhone: null });
  });

  // A brand several orgs claim: each org states its own number, and the read is
  // org-scoped — one org's rep is never served to another.
  it('two orgs claiming one brand hold their OWN number', async () => {
    await request(app)
      .put(path(sharedBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+33111111111' });
    await request(app)
      .put(path(sharedBrandId))
      .set(getAuthHeaders(otherOrgId))
      .send({ salesRepPhone: '+33222222222' });

    const mine = await request(app).get(path(sharedBrandId)).set(getAuthHeaders(ownerOrgId));
    const theirs = await request(app).get(path(sharedBrandId)).set(getAuthHeaders(otherOrgId));
    expect(mine.body.salesRepPhone).toBe('+33111111111');
    expect(theirs.body.salesRepPhone).toBe('+33222222222');

    const scoped = await request(app)
      .get(`/internal/brands/${sharedBrandId}`)
      .set(getInternalAuthHeaders())
      .set('x-org-id', otherOrgId);
    expect(scoped.body.brand.salesRepPhone).toBe('+33222222222');

    // No org named, two orgs have stated a number: answering with either one
    // would hand a rep's number to a different company.
    const ambiguous = await request(app)
      .get(`/internal/brands/${sharedBrandId}`)
      .set(getInternalAuthHeaders());
    expect(ambiguous.body.brand.salesRepPhone).toBeNull();
  });

  // A single claiming org is unambiguous, so a caller that sent no org still
  // gets the answer (this is what keeps existing internal callers working).
  it('a brand with a single stated number answers an org-less internal read', async () => {
    const res = await request(app)
      .get(`/internal/brands/${brandId}`)
      .set(getInternalAuthHeaders());

    expect(res.body.brand.salesRepPhone).toBe('+33770657585');
  });

  // The public read is unauthenticated and must not carry per-org contact data.
  it('the public brand read does NOT carry salesRepPhone', async () => {
    const res = await request(app).get(`/public/brands/${brandId}`);

    expect(res.status).toBe(200);
    expect(res.body.brand).not.toHaveProperty('salesRepPhone');
    // and the rest of the payload is untouched
    expect(res.body.brand.id).toBe(brandId);
  });

  // Rabbit hole: a number that cannot be dialled is refused loudly at the write
  // rather than reaching the dialler unusable.
  it('PUT a national number with no country code is rejected 400', async () => {
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '0770657585' });

    expect(res.status).toBe(400);
  });

  it('PUT an unparseable value or a missing body is rejected 400', async () => {
    const bad = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: 'call the office' });
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({});
    expect(missing.status).toBe(400);
  });

  // Ownership / id semantics mirror the click-destination + WhatsApp writes.
  it('PUT a non-UUID brand id is rejected 400', async () => {
    const res = await request(app)
      .put(path('not-a-uuid'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+33770657585' });

    expect(res.status).toBe(400);
  });

  it('PUT a brand owned by another org is rejected 403', async () => {
    const res = await request(app)
      .put(path(foreignBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+33770657585' });

    expect(res.status).toBe(403);
  });

  it('DELETE a brand owned by another org is rejected 403', async () => {
    const res = await request(app).delete(path(foreignBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(res.status).toBe(403);
  });

  it('PUT an unknown brand is rejected 404', async () => {
    const res = await request(app)
      .put(path(unknownBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ salesRepPhone: '+33770657585' });

    expect(res.status).toBe(404);
  });
});

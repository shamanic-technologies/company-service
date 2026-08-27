import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from '../helpers/test-app';
import { db } from '../../src/db';
import { brands, orgBrands } from '../../src/db/schema';
import { deleteBrandsByOrgIds } from '../helpers/test-db';

const app = createTestApp();

describe('brands.name lazy-fill', () => {
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    await deleteBrandsByOrgIds(createdOrgIds);
    createdOrgIds.length = 0;
  });

  it('POST /orgs/brands resolves the name at create — the response is never null and the read pays nothing', async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const url = 'https://lazyfill-create.example.com';

    const res = await request(app)
      .post('/orgs/brands')
      .set(getAuthHeaders(orgId, randomUUID()))
      .send({ url });

    // The onboarding header reads this `name`, so it must be a real value on
    // create. Test env skips the network funnel and lands on the terminal
    // titlecased-domain fallback.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('name');
    expect(res.body.name).toBe('Lazyfill Create');

    const [row] = await db
      .select({ name: brands.name })
      .from(brands)
      .where(eq(brands.id, res.body.brandId));
    expect(row.name).toBe('Lazyfill Create');

    // The subsequent read serves the stored name — no derivation on the read path.
    const getRes = await request(app)
      .get(`/internal/brands/${res.body.brandId}`)
      .set(getInternalAuthHeaders());
    expect(getRes.status).toBe(200);
    expect(getRes.body.brand.name).toBe('Lazyfill Create');

    const [after] = await db
      .select({ name: brands.name })
      .from(brands)
      .where(eq(brands.id, res.body.brandId));
    expect(after.name).toBe('Lazyfill Create');
  }, 15000);

  it('GET /internal/brands/:id lazy-fills name when null and persists to DB', async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const id = randomUUID();
    const url = 'https://lazyfill-get.example.com';
    const domain = 'lazyfill-get.example.com';

    // Insert a brand with name explicitly null to simulate legacy rows.
    await db.insert(brands).values({ id, url, domain, name: null });
    await db.insert(orgBrands).values({ orgId, brandId: id });

    const before = await db.select({ name: brands.name }).from(brands).where(eq(brands.id, id));
    expect(before[0].name).toBeNull();

    const res = await request(app)
      .get(`/internal/brands/${id}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.brand.name).not.toBeNull();
    expect(res.body.brand.name).not.toBe('');

    const after = await db.select({ name: brands.name }).from(brands).where(eq(brands.id, id));
    expect(after[0].name).not.toBeNull();
    expect(after[0].name).not.toBe('');
    // In test env we expect the domain to be persisted as name.
    expect(after[0].name).toBe(domain);
  }, 15000);

  it('GET /internal/brands/:id leaves an already-populated name untouched', async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const id = randomUUID();
    const url = 'https://lazyfill-noop.example.com';
    const domain = 'lazyfill-noop.example.com';
    const name = 'My Existing Brand';

    await db.insert(brands).values({ id, url, domain, name });
    await db.insert(orgBrands).values({ orgId, brandId: id });

    const res = await request(app)
      .get(`/internal/brands/${id}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.brand.name).toBe(name);

    const after = await db.select({ name: brands.name }).from(brands).where(eq(brands.id, id));
    expect(after[0].name).toBe(name);
  }, 15000);
});

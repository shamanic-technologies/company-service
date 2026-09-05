import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestApp, getInternalAuthHeaders } from '../helpers/test-app';
import { db } from '../../src/db';
import { brands, orgBrands } from '../../src/db/schema';
import { deleteBrandsByOrgIds } from '../helpers/test-db';

const app = createTestApp();

describe('GET /internal/brands and /public/brands — batch by ids', () => {
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    await deleteBrandsByOrgIds(createdOrgIds);
    createdOrgIds.length = 0;
  });

  async function insertBrand(opts: { name?: string | null; logoUrl?: string | null; domain: string }) {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const id = randomUUID();
    await db.insert(brands).values({
      id,
      url: `https://${opts.domain}`,
      domain: opts.domain,
      name: opts.name ?? null,
      logoUrl: opts.logoUrl ?? null,
    });
    await db.insert(orgBrands).values({ orgId, brandId: id });
    return id;
  }

  it('returns both brands when given two existing ids', async () => {
    const a = await insertBrand({ name: 'A', logoUrl: 'https://img.logo.dev/a?token=x', domain: `batch-a-${Date.now()}.example.com` });
    const b = await insertBrand({ name: 'B', logoUrl: 'https://img.logo.dev/b?token=x', domain: `batch-b-${Date.now()}.example.com` });

    const res = await request(app)
      .get(`/internal/brands?ids=${a},${b}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(2);
    const ids = res.body.brands.map((br: any) => br.id).sort();
    expect(ids).toEqual([a, b].sort());
    for (const brand of res.body.brands) {
      // `salesRepPhone` is served on the INTERNAL read only — it is per-org
      // contact data and the public variant below deliberately omits it.
      expect(Object.keys(brand).sort()).toEqual(
        ['clickDestinationUrl', 'colors', 'createdAt', 'domain', 'id', 'logoUrl', 'name', 'salesRepPhone', 'updatedAt', 'url', 'whatsAppLink'],
      );
    }
  }, 15000);

  it('silently omits ids that do not resolve (no 404)', async () => {
    const a = await insertBrand({ name: 'A', logoUrl: 'https://img.logo.dev/a?token=x', domain: `batch-omit-${Date.now()}.example.com` });
    const missing = '00000000-0000-0000-0000-000000000099';

    const res = await request(app)
      .get(`/internal/brands?ids=${a},${missing}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].id).toBe(a);
  }, 15000);

  it('returns 400 when ids is missing', async () => {
    const res = await request(app)
      .get('/internal/brands')
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing ids query param');
  });

  it('returns 400 when ids is empty', async () => {
    const res = await request(app)
      .get('/internal/brands?ids=')
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Empty ids query param');
  });

  it('returns 400 when more than 100 ids are provided', async () => {
    const ids = Array.from({ length: 101 }, () => randomUUID()).join(',');
    const res = await request(app)
      .get(`/internal/brands?ids=${ids}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Too many ids (max 100)');
  });

  it('returns 400 when an entry is not a UUID', async () => {
    const res = await request(app)
      .get(`/internal/brands?ids=${randomUUID()},not-a-uuid`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid brand ID format');
  });

  it('lazy-fills name when null in DB and persists it', async () => {
    const domain = `batch-lazyname-${Date.now()}.example.com`;
    const id = await insertBrand({ name: null, logoUrl: 'https://img.logo.dev/seed?token=x', domain });

    const res = await request(app)
      .get(`/internal/brands?ids=${id}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
    expect(res.body.brands[0].name).not.toBeNull();
    expect(res.body.brands[0].name).not.toBe('');

    const [row] = await db.select({ name: brands.name }).from(brands).where(eq(brands.id, id));
    expect(row.name).not.toBeNull();
  }, 15000);

  it('lazy-fills logoUrl with the logo.dev URL when null and persists it', async () => {
    const domain = `batch-lazylogo-${Date.now()}.example.com`;
    const id = await insertBrand({ name: 'Seed', logoUrl: null, domain });

    const res = await request(app)
      .get(`/internal/brands?ids=${id}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    const brand = res.body.brands[0];
    expect(brand.logoUrl).toMatch(/^https:\/\/img\.logo\.dev\//);
    expect(brand.logoUrl).toContain(encodeURIComponent(domain));
    expect(brand.logoUrl).toContain('size=256');

    const [row] = await db.select({ logoUrl: brands.logoUrl }).from(brands).where(eq(brands.id, id));
    expect(row.logoUrl).toBe(brand.logoUrl);
  }, 15000);

  // The public route is unauthenticated, so it carries everything the internal
  // read does EXCEPT `salesRepPhone` — the number to ring when a sales interest
  // lands, which is per-org contact data and must not be readable by anyone who
  // knows a brand id.
  it('GET /public/brands?ids returns the internal payload minus salesRepPhone', async () => {
    const a = await insertBrand({ name: 'A', logoUrl: 'https://img.logo.dev/a?token=x', domain: `batch-public-a-${Date.now()}.example.com` });
    const b = await insertBrand({ name: 'B', logoUrl: 'https://img.logo.dev/b?token=x', domain: `batch-public-b-${Date.now()}.example.com` });

    const [internalRes, publicRes] = await Promise.all([
      request(app).get(`/internal/brands?ids=${a},${b}`).set(getInternalAuthHeaders()),
      request(app).get(`/public/brands?ids=${a},${b}`),
    ]);

    expect(internalRes.status).toBe(200);
    expect(publicRes.status).toBe(200);

    const sortedInternal = [...internalRes.body.brands].sort((x, y) => x.id.localeCompare(y.id));
    const sortedPublic = [...publicRes.body.brands].sort((x, y) => x.id.localeCompare(y.id));
    for (const brand of sortedPublic) {
      expect(brand).not.toHaveProperty('salesRepPhone');
    }
    expect(sortedPublic).toEqual(
      sortedInternal.map(({ salesRepPhone, ...rest }: any) => rest),
    );
  }, 15000);

  it('GET /internal/brands without API key returns 401', async () => {
    const res = await request(app).get('/internal/brands?ids=00000000-0000-0000-0000-000000000099');
    expect(res.status).toBe(401);
  });

  it('GET /public/brands without auth still returns 200 (public route)', async () => {
    const a = await insertBrand({ name: 'A', logoUrl: 'https://img.logo.dev/a?token=x', domain: `batch-pubauth-${Date.now()}.example.com` });

    const res = await request(app).get(`/public/brands?ids=${a}`);
    expect(res.status).toBe(200);
    expect(res.body.brands).toHaveLength(1);
  }, 15000);
});

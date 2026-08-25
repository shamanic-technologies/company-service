import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestApp, getInternalAuthHeaders } from '../helpers/test-app';
import { db } from '../../src/db';
import { brands, brandExtractedFields, orgBrands } from '../../src/db/schema';
import { deleteBrandsByOrgIds } from '../helpers/test-db';

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

const app = createTestApp();

describe('GET /internal/brands/:id and /public/brands/:id — minimal shape', () => {
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    await deleteBrandsByOrgIds(createdOrgIds);
    createdOrgIds.length = 0;
  });

  it('returns only id, domain, url, name, logoUrl, colors, clickDestinationUrl, whatsAppLink, createdAt, updatedAt — no business fields', async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const id = randomUUID();
    const domain = 'minimalshape.example.com';
    const url = `https://${domain}`;

    await db.insert(brands).values({
      id,
      url,
      domain,
      name: 'Minimal Shape Brand',
      logoUrl: 'https://img.logo.dev/minimalshape.example.com?token=preexisting',
    });
    await db.insert(orgBrands).values({ orgId, brandId: id });

    const res = await request(app)
      .get(`/internal/brands/${id}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(Object.keys(res.body.brand).sort()).toEqual(
      ['clickDestinationUrl', 'colors', 'createdAt', 'domain', 'id', 'logoUrl', 'name', 'updatedAt', 'url', 'whatsAppLink'],
    );
    // Unset brand: producer defaults clickDestinationUrl to the brand's own url.
    expect(res.body.brand.clickDestinationUrl).toBe(url);
    // Unset brand: whatsAppLink has no sensible default → null.
    expect(res.body.brand.whatsAppLink).toBeNull();
    expect(res.body.brand.bio).toBeUndefined();
    expect(res.body.brand.categories).toBeUndefined();
    expect(res.body.brand.mission).toBeUndefined();
    expect(res.body.brand.elevatorPitch).toBeUndefined();
    expect(res.body.brand.location).toBeUndefined();
  }, 15000);

  it('GET /public/brands/:id returns identical shape to /internal/brands/:id', async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const id = randomUUID();
    const domain = 'publicparity.example.com';
    const url = `https://${domain}`;

    await db.insert(brands).values({
      id,
      url,
      domain,
      name: 'Parity Brand',
      logoUrl: 'https://img.logo.dev/publicparity.example.com?token=preexisting',
    });
    await db.insert(orgBrands).values({ orgId, brandId: id });

    const [internalRes, publicRes] = await Promise.all([
      request(app).get(`/internal/brands/${id}`).set(getInternalAuthHeaders()),
      request(app).get(`/public/brands/${id}`),
    ]);

    expect(internalRes.status).toBe(200);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body).toEqual(internalRes.body);
  }, 15000);

  it('lazy-fills logoUrl from logo.dev and persists when null', async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const id = randomUUID();
    const domain = 'lazylogo.example.com';
    const url = `https://${domain}`;

    await db.insert(brands).values({
      id,
      url,
      domain,
      name: 'Lazy Logo Brand',
      logoUrl: null,
    });
    await db.insert(orgBrands).values({ orgId, brandId: id });

    const before = await db.select({ logoUrl: brands.logoUrl }).from(brands).where(eq(brands.id, id));
    expect(before[0].logoUrl).toBeNull();

    const res = await request(app)
      .get(`/internal/brands/${id}`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.brand.logoUrl).toMatch(/^https:\/\/img\.logo\.dev\/lazylogo\.example\.com\?token=/);
    expect(res.body.brand.logoUrl).toContain('size=256');
    expect(res.body.brand.logoUrl).toContain('format=png');

    const after = await db.select({ logoUrl: brands.logoUrl }).from(brands).where(eq(brands.id, id));
    expect(after[0].logoUrl).toBe(res.body.brand.logoUrl);
  }, 15000);
});

describe('brand_extracted_fields — cache key includes field_description_hash', () => {
  const createdOrgIds: string[] = [];

  afterEach(async () => {
    await deleteBrandsByOrgIds(createdOrgIds);
    createdOrgIds.length = 0;
  });

  it('same (brandId, fieldKey) with different descriptions produces two distinct rows', async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const brandId = randomUUID();
    const domain = 'cachekey.example.com';

    await db.insert(brands).values({
      id: brandId,
      url: `https://${domain}`,
      domain,
      name: 'Cache Key Brand',
    });
    await db.insert(orgBrands).values({ orgId, brandId });

    const fieldKey = 'industry';
    const descA = 'Primary industry vertical';
    const descB = 'Detailed industry sub-vertical with technology stack';
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    await db.insert(brandExtractedFields).values({
      brandId,
      fieldKey,
      fieldDescription: descA,
      fieldDescriptionHash: md5(descA),
      fieldValue: 'SaaS productivity',
      expiresAt,
    });

    await db.insert(brandExtractedFields).values({
      brandId,
      fieldKey,
      fieldDescription: descB,
      fieldDescriptionHash: md5(descB),
      fieldValue: 'B2B SaaS workflow automation',
      expiresAt,
    });

    const rows = await db
      .select()
      .from(brandExtractedFields)
      .where(and(eq(brandExtractedFields.brandId, brandId), eq(brandExtractedFields.fieldKey, fieldKey)));

    expect(rows).toHaveLength(2);
    const hashes = rows.map((r) => r.fieldDescriptionHash).sort();
    expect(hashes).toEqual([md5(descA), md5(descB)].sort());
  }, 15000);

  it('same (brandId, fieldKey, description) hits unique partial index on second insert', async () => {
    const orgId = randomUUID();
    createdOrgIds.push(orgId);
    const brandId = randomUUID();
    const domain = 'cachekeycollide.example.com';

    await db.insert(brands).values({
      id: brandId,
      url: `https://${domain}`,
      domain,
      name: 'Collide Brand',
    });
    await db.insert(orgBrands).values({ orgId, brandId });

    const fieldKey = 'industry';
    const description = 'Primary industry vertical';
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    await db.insert(brandExtractedFields).values({
      brandId,
      fieldKey,
      fieldDescription: description,
      fieldDescriptionHash: md5(description),
      fieldValue: 'first',
      expiresAt,
    });

    await expect(
      db.insert(brandExtractedFields).values({
        brandId,
        fieldKey,
        fieldDescription: description,
        fieldDescriptionHash: md5(description),
        fieldValue: 'second',
        expiresAt,
      }),
    ).rejects.toThrow();

    const rows = await db
      .select()
      .from(brandExtractedFields)
      .where(and(eq(brandExtractedFields.brandId, brandId), eq(brandExtractedFields.fieldKey, fieldKey)));

    expect(rows).toHaveLength(1);
    expect(rows[0].fieldValue).toBe('first');
  }, 15000);
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockReturning } = vi.hoisted(() => ({
  mockReturning: vi.fn(),
}));

vi.mock('../../src/db', () => {
  const funnelable = () => {
    const funnel: Record<string, any> = {};
    for (const method of [
      'select', 'from', 'where', 'innerJoin',
      'insert', 'values', 'onConflictDoUpdate', 'onConflictDoNothing',
      'update', 'set', 'limit', 'delete',
    ]) {
      funnel[method] = vi.fn().mockReturnValue(funnel);
    }
    funnel.returning = mockReturning;
    funnel.then = (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve);
    return funnel;
  };
  return {
    db: funnelable(),
    brands: { id: 'brands.id', name: 'brands.name', domain: 'brands.domain' },
    brandsOld: { id: 'brands_old.id', orgId: 'brands_old.orgId', name: 'brands_old.name', domain: 'brands_old.domain' },
    orgBrands: { orgId: 'ob.orgId', brandId: 'ob.brandId' },
    brandExtractedFields: { brandId: 'bef.brandId', fieldKey: 'bef.fieldKey', expiresAt: 'bef.expiresAt' },
    pageScrapeCache: { normalizedUrl: 'psc.normalizedUrl' },
    urlMapCache: { normalizedSiteUrl: 'umc.normalizedSiteUrl' },
  };
});

vi.mock('../../src/db/utils', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

vi.mock('../../src/lib/runs-client', () => ({
  createRun: vi.fn().mockResolvedValue({ id: 'run-123' }),
  updateRun: vi.fn().mockResolvedValue({ id: 'run-123', status: 'completed' }),
  addCosts: vi.fn(),
}));

// ─── App ─────────────────────────────────────────────────────────────────────

import { createTestApp, getInternalAuthHeaders } from '../helpers/test-app';

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('POST /internal/transfer-brand', () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  const brandId = randomUUID();
  const sourceOrgId = randomUUID();
  const targetOrgId = randomUUID();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject requests with missing fields', async () => {
    const res = await request(app)
      .post('/internal/transfer-brand')
      .set(headers)
      .send({ sourceBrandId: brandId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });

  it('should reject requests with invalid UUIDs', async () => {
    const res = await request(app)
      .post('/internal/transfer-brand')
      .set(headers)
      .send({ sourceBrandId: 'not-a-uuid', sourceOrgId, targetOrgId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid request');
  });

  it('should update org_id when brand matches sourceOrgId', async () => {
    mockReturning.mockResolvedValueOnce([{ id: brandId }]);

    const res = await request(app)
      .post('/internal/transfer-brand')
      .set(headers)
      .send({ sourceBrandId: brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([{ tableName: 'org_brands', count: 1 }]);
  });

  it('should be idempotent — no matching rows returns count 0', async () => {
    mockReturning.mockResolvedValueOnce([]);

    const res = await request(app)
      .post('/internal/transfer-brand')
      .set(headers)
      .send({ sourceBrandId: brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([{ tableName: 'org_brands', count: 0 }]);
  });

  it('should not update a non-existent brand', async () => {
    mockReturning.mockResolvedValueOnce([]);

    const res = await request(app)
      .post('/internal/transfer-brand')
      .set(headers)
      .send({ sourceBrandId: randomUUID(), sourceOrgId, targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.updatedTables).toEqual([{ tableName: 'org_brands', count: 0 }]);
  });

  it('should require API key auth', async () => {
    const res = await request(app)
      .post('/internal/transfer-brand')
      .send({ sourceBrandId: brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(401);
  });

  it('should rewrite brand references and delete source brand when targetBrandId is provided', async () => {
    const targetBrandId = randomUUID();
    mockReturning.mockResolvedValueOnce([{ id: brandId }]);

    const res = await request(app)
      .post('/internal/transfer-brand')
      .set(headers)
      .send({ sourceBrandId: brandId, sourceOrgId, targetOrgId, targetBrandId });

    expect(res.status).toBe(200);
    // Should include rewrite results for all dependent tables + org_brands membership move
    expect(res.body.updatedTables).toContainEqual({ tableName: 'media_assets', count: 0 });
    expect(res.body.updatedTables).toContainEqual({ tableName: 'brand_extracted_fields', count: 0 });
    expect(res.body.updatedTables).toContainEqual({ tableName: 'org_brands', count: 1 });
    const { db } = await import('../../src/db');
    expect(db.delete).toHaveBeenCalled();
    const { query } = await import('../../src/db/utils');
    expect(query).toHaveBeenCalled();
  });

  it('should return 500 on database error', async () => {
    mockReturning.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(app)
      .post('/internal/transfer-brand')
      .set(headers)
      .send({ sourceBrandId: brandId, sourceOrgId, targetOrgId });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('connection refused');
  });
});

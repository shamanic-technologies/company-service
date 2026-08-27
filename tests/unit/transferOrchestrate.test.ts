import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockSelect, mockReturning, mockInsertReturning, mockDeleteReturning } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockReturning: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockDeleteReturning: vi.fn(),
}));

vi.mock('../../src/db', () => {
  const selectFunnel: Record<string, any> = {};
  for (const method of ['from', 'where', 'innerJoin', 'limit', 'orderBy']) {
    selectFunnel[method] = vi.fn().mockReturnValue(selectFunnel);
  }
  selectFunnel.then = (resolve: (v: unknown) => void) => Promise.resolve(mockSelect()).then(resolve);

  const updateFunnel: Record<string, any> = {};
  for (const method of ['set', 'where']) {
    updateFunnel[method] = vi.fn().mockReturnValue(updateFunnel);
  }
  updateFunnel.returning = mockReturning;

  const insertFunnel: Record<string, any> = {};
  for (const method of ['values']) {
    insertFunnel[method] = vi.fn().mockReturnValue(insertFunnel);
  }
  insertFunnel.returning = mockInsertReturning;

  const deleteFunnel: Record<string, any> = {};
  for (const method of ['where']) {
    deleteFunnel[method] = vi.fn().mockReturnValue(deleteFunnel);
  }
  deleteFunnel.returning = mockDeleteReturning;

  return {
    db: {
      select: vi.fn().mockReturnValue(selectFunnel),
      update: vi.fn().mockReturnValue(updateFunnel),
      insert: vi.fn().mockReturnValue(insertFunnel),
      delete: vi.fn().mockReturnValue(deleteFunnel),
    },
    brands: {
      id: 'brands.id',
      domain: 'brands.domain',
    },
    brandsOld: {
      id: 'brands_old.id',
      orgId: 'brands_old.orgId',
      domain: 'brands_old.domain',
    },
    orgBrands: { orgId: 'ob.orgId', brandId: 'ob.brandId' },
    brandTransfers: {
      id: 'brandTransfers.id',
      brandId: 'brandTransfers.brandId',
      sourceOrgId: 'brandTransfers.sourceOrgId',
      targetOrgId: 'brandTransfers.targetOrgId',
      createdAt: 'brandTransfers.createdAt',
    },
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

const mockDiscoverServices = vi.fn();
const mockFanOutTransfer = vi.fn();

vi.mock('../../src/services/transferService', () => ({
  discoverTransferServices: (...args: any[]) => mockDiscoverServices(...args),
  fanOutTransfer: (...args: any[]) => mockFanOutTransfer(...args),
}));

// ─── App ──────────────────────────────────────────────────────────────────

import { createTestApp, getAuthHeaders } from '../helpers/test-app';

// ─── Tests ────────────────────────────────────────────────────────────────

describe('POST /orgs/brands/:brandId/transfer', () => {
  const brandId = randomUUID();
  const sourceOrgId = randomUUID();
  const targetOrgId = randomUUID();
  const userId = randomUUID();
  const transferId = randomUUID();

  const app = createTestApp();
  const headers = getAuthHeaders(sourceOrgId, userId);

  function setupDefaults() {
    // 1st select: brand found in source org. 2nd select: no domain conflict.
    mockSelect
      .mockResolvedValueOnce([{ id: brandId, orgId: sourceOrgId, domain: 'acme.com' }])
      .mockResolvedValueOnce([]);
    mockReturning.mockResolvedValue([{ id: brandId }]);
    mockInsertReturning.mockResolvedValue([{ id: transferId }]);
    mockDiscoverServices.mockResolvedValue([]);
    mockFanOutTransfer.mockResolvedValue({});
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('should transfer a brand successfully', async () => {
    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.transferId).toBe(transferId);
    expect(res.body.sourceBrandId).toBe(brandId);
    expect(res.body.sourceOrgId).toBe(sourceOrgId);
    expect(res.body.targetOrgId).toBe(targetOrgId);
    expect(res.body.serviceResults['brand-service']).toEqual({
      updatedTables: [{ tableName: 'brands', count: 1 }],
    });
    expect(res.body.targetBrandId).toBeUndefined();
  });

  it('should include fan-out results from other services', async () => {
    mockFanOutTransfer.mockResolvedValue({
      'campaign-service': { updatedTables: [{ tableName: 'campaigns', count: 3 }] },
      'outlets-service': { skipped: true },
    });

    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.serviceResults['campaign-service']).toEqual({
      updatedTables: [{ tableName: 'campaigns', count: 3 }],
    });
    expect(res.body.serviceResults['outlets-service']).toEqual({ skipped: true });
  });

  it('should reject when x-user-id is missing', async () => {
    const noUserHeaders = {
      'X-API-Key': headers['X-API-Key'],
      'X-Org-Id': sourceOrgId,
      'Content-Type': 'application/json',
    };

    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(noUserHeaders)
      .send({ targetOrgId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('x-user-id');
  });

  it('should reject when source and target org are the same', async () => {
    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId: sourceOrgId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('same');
  });

  it('should return 404 when brand not found in source org', async () => {
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([]);

    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId });

    expect(res.status).toBe(404);
  });

  it('should rewrite brand refs and delete source brand on domain conflict, passing targetBrandId to fan-out', async () => {
    const existingBrandId = randomUUID();
    mockSelect.mockReset();
    mockSelect
      .mockResolvedValueOnce([{ id: brandId, orgId: sourceOrgId, domain: 'acme.com' }])
      .mockResolvedValueOnce([{ id: existingBrandId }]);
    mockReturning.mockResolvedValue([{ id: brandId }]);
    mockInsertReturning.mockResolvedValue([{ id: transferId }]);
    mockDeleteReturning.mockResolvedValue([{ id: brandId }]);
    mockDiscoverServices.mockResolvedValue([]);
    mockFanOutTransfer.mockResolvedValue({
      'campaign-service': { updatedTables: [{ tableName: 'campaigns', count: 2 }] },
    });

    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.targetBrandId).toBe(existingBrandId);
    // brand-service results should include rewrite tables + brands delete
    const brandResults = res.body.serviceResults['brand-service'].updatedTables;
    expect(brandResults).toContainEqual({ tableName: 'media_assets', count: 0 });
    expect(brandResults).toContainEqual({ tableName: 'brand_extracted_fields', count: 0 });
    expect(brandResults).toContainEqual({ tableName: 'brands', count: 1 });
    expect(res.body.serviceResults['campaign-service']).toEqual({
      updatedTables: [{ tableName: 'campaigns', count: 2 }],
    });
    // Verify targetBrandId was passed in fan-out
    expect(mockFanOutTransfer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceBrandId: brandId, targetBrandId: existingBrandId }),
    );
    // Verify rewriteBrandReferences was called via query
    const { query } = await import('../../src/db/utils');
    expect(query).toHaveBeenCalled();
  });

  it('should NOT move brand when a downstream service fails (return 207)', async () => {
    mockFanOutTransfer.mockResolvedValue({
      'campaign-service': { updatedTables: [{ tableName: 'campaigns', count: 3 }] },
      'outlets-service': { error: 'HTTP 500' },
    });

    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId });

    expect(res.status).toBe(207);
    expect(res.body.status).toBe('partial');
    // brand-service should NOT have updated the brand
    expect(res.body.serviceResults['brand-service']).toEqual({
      updatedTables: [{ tableName: 'brands', count: 0 }],
    });
    // db.update should NOT have been called (brand stays in source org)
    const { db } = await import('../../src/db');
    expect(db.update).not.toHaveBeenCalled();
  });

  it('should move brand only when ALL downstream services succeed', async () => {
    mockFanOutTransfer.mockResolvedValue({
      'campaign-service': { updatedTables: [{ tableName: 'campaigns', count: 3 }] },
      'outlets-service': { updatedTables: [{ tableName: 'outlets', count: 1 }] },
    });

    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.serviceResults['brand-service']).toEqual({
      updatedTables: [{ tableName: 'brands', count: 1 }],
    });
  });

  it('should reject invalid brandId format', async () => {
    const res = await request(app)
      .post('/orgs/brands/not-a-uuid/transfer')
      .set(headers)
      .send({ targetOrgId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('UUID');
  });

  it('should reject invalid targetOrgId', async () => {
    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId: 'not-a-uuid' });

    expect(res.status).toBe(400);
  });

  it('should require API key auth', async () => {
    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .send({ targetOrgId });

    expect(res.status).toBe(401);
  });

  it('should return 500 on service discovery failure', async () => {
    mockDiscoverServices.mockRejectedValue(new Error('api-registry unreachable'));

    const res = await request(app)
      .post(`/orgs/brands/${brandId}/transfer`)
      .set(headers)
      .send({ targetOrgId });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('api-registry');
  });
});

describe('GET /orgs/brand-transfers/outgoing', () => {
  const app = createTestApp();
  const orgId = randomUUID();
  const headers = getAuthHeaders(orgId);
  const brandId = randomUUID();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return outgoing transfers for the org', async () => {
    const transfer = {
      id: randomUUID(),
      brandId,
      sourceOrgId: orgId,
      targetOrgId: randomUUID(),
      initiatedByUserId: randomUUID(),
      serviceResults: { 'brand-service': { updatedTables: [{ tableName: 'brands', count: 1 }] } },
      createdAt: '2026-04-24T00:00:00.000Z',
    };
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([transfer]);

    const res = await request(app)
      .get('/orgs/brand-transfers/outgoing')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.transfers).toEqual([transfer]);
  });

  it('should filter by brandId when provided', async () => {
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([]);

    const res = await request(app)
      .get('/orgs/brand-transfers/outgoing')
      .query({ brandId })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.transfers).toEqual([]);
  });

  it('should reject invalid brandId', async () => {
    const res = await request(app)
      .get('/orgs/brand-transfers/outgoing')
      .query({ brandId: 'not-a-uuid' })
      .set(headers);

    expect(res.status).toBe(400);
  });

  it('should return empty array when no transfers exist', async () => {
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([]);

    const res = await request(app)
      .get('/orgs/brand-transfers/outgoing')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.transfers).toEqual([]);
  });

  it('should require auth', async () => {
    const res = await request(app)
      .get('/orgs/brand-transfers/outgoing');

    expect(res.status).toBe(401);
  });
});

describe('GET /orgs/brand-transfers/incoming', () => {
  const app = createTestApp();
  const orgId = randomUUID();
  const headers = getAuthHeaders(orgId);
  const brandId = randomUUID();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return incoming transfers for the org', async () => {
    const transfer = {
      id: randomUUID(),
      brandId,
      sourceOrgId: randomUUID(),
      targetOrgId: orgId,
      initiatedByUserId: randomUUID(),
      serviceResults: { 'brand-service': { updatedTables: [{ tableName: 'brands', count: 1 }] } },
      createdAt: '2026-04-24T00:00:00.000Z',
    };
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([transfer]);

    const res = await request(app)
      .get('/orgs/brand-transfers/incoming')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.transfers).toEqual([transfer]);
  });

  it('should filter by brandId when provided', async () => {
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([]);

    const res = await request(app)
      .get('/orgs/brand-transfers/incoming')
      .query({ brandId })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.transfers).toEqual([]);
  });

  it('should reject invalid brandId', async () => {
    const res = await request(app)
      .get('/orgs/brand-transfers/incoming')
      .query({ brandId: 'not-a-uuid' })
      .set(headers);

    expect(res.status).toBe(400);
  });

  it('should return empty array when no transfers exist', async () => {
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([]);

    const res = await request(app)
      .get('/orgs/brand-transfers/incoming')
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.transfers).toEqual([]);
  });

  it('should require auth', async () => {
    const res = await request(app)
      .get('/orgs/brand-transfers/incoming');

    expect(res.status).toBe(401);
  });
});

describe('GET /internal/brand-transfers', () => {
  const app = createTestApp();
  const headers = {
    'X-API-Key': process.env.BRAND_SERVICE_API_KEY || process.env.COMPANY_SERVICE_API_KEY || 'test-secret-key',
    'Content-Type': 'application/json',
  };
  const brandId = randomUUID();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return transfer history for a brand', async () => {
    const transfer = {
      id: randomUUID(),
      brandId,
      sourceOrgId: randomUUID(),
      targetOrgId: randomUUID(),
      initiatedByUserId: randomUUID(),
      serviceResults: { 'brand-service': { updatedTables: [{ tableName: 'brands', count: 1 }] } },
      createdAt: '2026-04-24T00:00:00.000Z',
    };
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([transfer]);

    const res = await request(app)
      .get('/internal/brand-transfers')
      .query({ brandId })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.transfers).toEqual([transfer]);
  });

  it('should reject missing brandId', async () => {
    const res = await request(app)
      .get('/internal/brand-transfers')
      .set(headers);

    expect(res.status).toBe(400);
  });

  it('should reject invalid brandId', async () => {
    const res = await request(app)
      .get('/internal/brand-transfers')
      .query({ brandId: 'not-a-uuid' })
      .set(headers);

    expect(res.status).toBe(400);
  });

  it('should return empty array when no transfers exist', async () => {
    mockSelect.mockReset();
    mockSelect.mockResolvedValue([]);

    const res = await request(app)
      .get('/internal/brand-transfers')
      .query({ brandId })
      .set(headers);

    expect(res.status).toBe(200);
    expect(res.body.transfers).toEqual([]);
  });
});

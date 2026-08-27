import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Tests for the resetCache feature on POST /orgs/brands/extract-fields.
 *
 * When resetCache=true, ALL cache layers are bypassed:
 * - Field extraction cache (brand_extracted_fields)
 * - URL map cache (url_map_cache)
 * - Page scrape cache (page_scrape_cache)
 * - Consolidated field cache (consolidated_field_cache)
 */

// ─── Source-level assertions ────────────────────────────────────────────────
// Verify the cache bypass is wired correctly at the source level.

describe('resetCache source-level wiring', () => {
  const fieldExtractionSrc = readFileSync(
    resolve(__dirname, '../../src/services/fieldExtractionService.ts'),
    'utf-8',
  );
  const multiBrandSrc = readFileSync(
    resolve(__dirname, '../../src/services/multiBrandFieldExtractionService.ts'),
    'utf-8',
  );

  it('ExtractFieldsOptions interface includes resetCache', () => {
    expect(fieldExtractionSrc).toContain('resetCache?: boolean');
  });

  it('MultiBrandExtractFieldsOptions interface includes resetCache', () => {
    expect(multiBrandSrc).toContain('resetCache?: boolean');
  });

  it('multi-brand service passes urlStrategy to extractFields', () => {
    expect(multiBrandSrc).toContain("urlStrategy?: UrlStrategy");
    expect(multiBrandSrc).toMatch(/extractFields\(\{[\s\S]*?urlStrategy/);
  });

  it('field extraction bypasses field cache when resetCache is true', () => {
    // The code should check resetCache before calling getCachedFields
    expect(fieldExtractionSrc).toContain('resetCache=true');
  });

  it('field extraction bypasses URL map cache when resetCache is true', () => {
    // getCachedUrlMap calls should be guarded by resetCache
    expect(fieldExtractionSrc).toContain('resetCache ? null : await getCachedUrlMap');
  });

  it('field extraction bypasses page scrape cache when resetCache is true', () => {
    // getCachedPageContent calls should be guarded by resetCache
    expect(fieldExtractionSrc).toContain('resetCache ? null : await getCachedPageContent');
  });

  it('multi-brand service bypasses consolidated cache when resetCache is true', () => {
    expect(multiBrandSrc).toContain('resetCache ? null : await getCachedConsolidated');
  });

  it('multi-brand service passes resetCache to extractFields', () => {
    // The extractFields call should include resetCache in its options
    expect(multiBrandSrc).toMatch(/extractFields\(\{[\s\S]*?resetCache/);
  });
});

// ─── Unit tests with mocked dependencies ────────────────────────────────────

const { mockSelect, mockInsert } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  db: { select: mockSelect, insert: mockInsert },
  brands: {},
  brandExtractedFields: {},
  pageScrapeCache: {},
  urlMapCache: {},
  consolidatedFieldCache: {
    cacheKey: 'cache_key',
    fieldValues: 'field_values',
    brandIds: 'brand_ids',
    fieldKeys: 'field_keys',
    campaignId: 'campaign_id',
    expiresAt: 'expires_at',
    updatedAt: 'updated_at',
  },
}));

vi.mock('../../src/lib/chat-client', () => ({
  chat: vi.fn(),
}));

vi.mock('../../src/lib/scraping-client', () => ({
  mapSiteUrls: vi.fn(),
  scrapeUrl: vi.fn(),
  SiteMapError: class SiteMapError extends Error {},
}));

vi.mock('../../src/lib/runs-client', () => ({
  createRun: vi.fn().mockResolvedValue({ id: 'test-run-id' }),
  updateRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/campaign-client', () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  gt: vi.fn((...args: unknown[]) => ({ type: 'gt', args })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  inArray: vi.fn((...args: unknown[]) => ({ type: 'inArray', args })),
  isNull: vi.fn((...args: unknown[]) => ({ type: 'isNull', args })),
  sql: vi.fn(),
}));

vi.mock('../../src/services/fieldExtractionService', () => ({
  extractFields: vi.fn(),
  getBrand: vi.fn(),
  buildFieldsResponseSchema: (keys: string[]) => ({ type: 'object', properties: {}, required: keys }),
}));

// Confirmed-store read is mocked out — no confirmed values → every non-user-facing
// key is `extracted`, no overlay, no DB hit in the provenance path.
vi.mock('../../src/services/brandUserFieldsService', () => ({
  getConfirmedByOfferId: vi.fn().mockResolvedValue(new Map()),
  isUserFacingFieldKey: (k: string) =>
    ['services', 'dreamOutcome', 'perceivedLikelihood', 'socialProof', 'riskReversal', 'urgency', 'scarcity'].includes(k),
}));

// The offer a brand-scoped extraction resolves to. `null` is what a brand with
// no offer answers, and it selects the pre-offer rows — the same value every
// production brand's sole offer produced before offers existed.
vi.mock('../../src/services/brandOffersService', () => ({
  resolveNamedOffer: vi.fn().mockResolvedValue(null),
}));

import { multiBrandExtractFields } from '../../src/services/multiBrandFieldExtractionService';
import { extractFields, getBrand } from '../../src/services/fieldExtractionService';

const mockedGetBrand = vi.mocked(getBrand);
const mockedExtractFields = vi.mocked(extractFields);

function mockDbCacheMiss() {
  const selectFunnel = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  mockSelect.mockReturnValue(selectFunnel);

  const insertFunnel = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  mockInsert.mockReturnValue(insertFunnel);

  return { selectFunnel, insertFunnel };
}

describe('multiBrandExtractFields with resetCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const orgCaller = { mode: 'org' as const, orgId: 'org-1', userId: 'user-1', runId: 'run-1' };

  it('should pass resetCache=true through to extractFields for single brand', async () => {
    mockedGetBrand.mockResolvedValue({
      id: 'brand-1',
      url: 'https://acme.com',
      name: 'Acme',
      domain: 'acme.com',
      orgId: 'org-1',
    });
    mockedExtractFields.mockResolvedValue([
      { key: 'industry', value: 'SaaS tools', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/about'] },
    ]);

    await multiBrandExtractFields({
      brandIds: ['brand-1'],
      fields: [{ key: 'industry', description: 'test' }],
      caller: orgCaller,
      resetCache: true,
    });

    expect(mockedExtractFields).toHaveBeenCalledWith(
      expect.objectContaining({ resetCache: true }),
    );
  });

  it('should skip consolidated cache when resetCache=true for multi-brand', async () => {
    mockDbCacheMiss();

    mockedGetBrand
      .mockResolvedValueOnce({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-2', url: 'https://finpay.io', name: 'FinPay', domain: 'finpay.io', orgId: 'org-1' });

    mockedExtractFields
      .mockResolvedValueOnce([
        { key: 'industry', value: 'SaaS tools', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/about'] },
      ])
      .mockResolvedValueOnce([
        { key: 'industry', value: 'FinTech payments', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://finpay.io/'] },
      ]);

    const { chat } = await import('../../src/lib/chat-client');
    vi.mocked(chat).mockResolvedValue({
      content: '',
      json: { industry: 'SaaS & FinTech' },
      tokensInput: 100,
      tokensOutput: 50,
      model: 'test-model',
    });

    await multiBrandExtractFields({
      brandIds: ['brand-1', 'brand-2'],
      fields: [{ key: 'industry', description: 'test' }],
      caller: orgCaller,
      resetCache: true,
    });

    expect(mockSelect).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('should NOT pass resetCache when not specified', async () => {
    mockedGetBrand.mockResolvedValue({
      id: 'brand-1',
      url: 'https://acme.com',
      name: 'Acme',
      domain: 'acme.com',
      orgId: 'org-1',
    });
    mockedExtractFields.mockResolvedValue([
      { key: 'industry', value: 'SaaS tools', cached: true, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/about'] },
    ]);

    await multiBrandExtractFields({
      brandIds: ['brand-1'],
      fields: [{ key: 'industry', description: 'test' }],
      caller: orgCaller,
    });

    expect(mockedExtractFields).toHaveBeenCalledWith(
      expect.objectContaining({ resetCache: undefined }),
    );
  });

  it('should pass urlStrategy through to extractFields for single brand', async () => {
    mockedGetBrand.mockResolvedValue({
      id: 'brand-1',
      url: 'https://acme.com',
      name: 'Acme',
      domain: 'acme.com',
      orgId: 'org-1',
    });
    mockedExtractFields.mockResolvedValue([
      { key: 'industry', value: 'SaaS tools', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com'] },
    ]);

    await multiBrandExtractFields({
      brandIds: ['brand-1'],
      fields: [{ key: 'industry', description: 'test' }],
      caller: orgCaller,
      urlStrategy: 'landing',
    });

    expect(mockedExtractFields).toHaveBeenCalledWith(
      expect.objectContaining({ urlStrategy: 'landing' }),
    );
  });
});

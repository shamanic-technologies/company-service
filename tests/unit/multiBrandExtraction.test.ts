import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they can be used in vi.mock factories
const { mockSelect, mockInsert, mockDelete } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockDelete: vi.fn(),
}));

// Mock all external dependencies before importing the services
vi.mock('../../src/db', () => ({
  db: { select: mockSelect, insert: mockInsert, delete: mockDelete },
  brands: {},
  brandExtractedFields: {},
  brandExtractedImages: {},
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

vi.mock('../../src/lib/cloudflare-client', () => ({
  uploadToCloudflare: vi.fn().mockResolvedValue({ url: 'https://r2.example.com/img.png', size: 1024 }),
  isCloudflareConfigured: vi.fn().mockReturnValue(true),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  gt: vi.fn((...args: unknown[]) => ({ type: 'gt', args })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  sql: vi.fn(),
}));

// Mock the field extraction service to avoid DB calls
vi.mock('../../src/services/fieldExtractionService', () => ({
  extractFields: vi.fn(),
  getBrand: vi.fn(),
  // consolidateFields builds a strict responseSchema from the real helper.
  buildFieldsResponseSchema: (keys: string[]) => ({ type: 'object', properties: {}, required: keys }),
}));

// Mock the image extraction service to avoid DB calls
vi.mock('../../src/services/imageExtractionService', () => ({
  extractImages: vi.fn(),
  getBrandForImages: vi.fn(),
}));

// Mock the confirmed-fields store: no confirmed values → every non-user-facing
// key is `extracted`, no overlay. Keeps the DB out of the provenance path.
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
import { multiBrandExtractImages } from '../../src/services/multiBrandImageExtractionService';
import { extractFields, getBrand } from '../../src/services/fieldExtractionService';
import { extractImages, getBrandForImages } from '../../src/services/imageExtractionService';
import { chat } from '../../src/lib/chat-client';
import { getConfirmedByOfferId } from '../../src/services/brandUserFieldsService';

const mockedGetConfirmed = vi.mocked(getConfirmedByOfferId);
const mockedGetBrand = vi.mocked(getBrand);
const mockedExtractFields = vi.mocked(extractFields);
const mockedGetBrandForImages = vi.mocked(getBrandForImages);
const mockedExtractImages = vi.mocked(extractImages);
const mockedChat = vi.mocked(chat);

const orgCaller = { mode: 'org' as const, orgId: 'org-1', userId: 'user-1', runId: 'run-1' };

// Helper to set up DB mock funnel for consolidated cache
function mockDbCacheHit(values: Record<string, unknown>) {
  const funnel = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ fieldValues: values }]),
  };
  mockSelect.mockReturnValue(funnel);
  return funnel;
}

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

describe('multiBrandExtractFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return unified format with full metadata in byBrand for single brand', async () => {
    mockedGetBrand.mockResolvedValue({
      id: 'brand-1',
      url: 'https://acme.com',
      name: 'Acme',
      domain: 'acme.com',
    });
    mockedExtractFields.mockResolvedValue([
      { key: 'industry', value: 'SaaS tools', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/about'] },
      { key: 'size', value: '100-500', cached: true, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/'] },
    ]);

    const result = await multiBrandExtractFields({
      brandIds: ['brand-1'],
      fields: [{ key: 'industry', description: 'test' }, { key: 'size', description: 'test' }],
      caller: orgCaller,
    });

    expect(result).toEqual({
      brands: [{ brandId: 'brand-1', domain: 'acme.com', name: 'Acme', brandUrl: 'https://acme.com' }],
      fields: {
        industry: {
          value: 'SaaS tools',
          byBrand: {
            'acme.com': { value: 'SaaS tools', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/about'] },
          },
        },
        size: {
          value: '100-500',
          byBrand: {
            'acme.com': { value: '100-500', cached: true, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/'] },
          },
        },
      },
      provenance: { industry: 'extracted', size: 'extracted' },
    });
  });

  it('should return unified format with LLM-consolidated value and full metadata for multiple brands', async () => {
    mockDbCacheMiss();

    mockedGetBrand
      .mockResolvedValueOnce({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-2', url: 'https://finpay.io', name: 'FinPay', domain: 'finpay.io', orgId: 'org-1' });

    mockedExtractFields
      .mockResolvedValueOnce([
        { key: 'industry', value: 'SaaS productivity tools', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/about'] },
      ])
      .mockResolvedValueOnce([
        { key: 'industry', value: 'FinTech payment processing', cached: true, extractedAt: '2024-01-05', expiresAt: '2024-02-04', sourceUrls: ['https://finpay.io/'] },
      ]);

    mockedChat.mockResolvedValue({
      content: '',
      json: { industry: 'SaaS & FinTech solutions for SMBs' },
      tokensInput: 100,
      tokensOutput: 50,
      model: 'test-model',
    });

    const result = await multiBrandExtractFields({
      brandIds: ['brand-1', 'brand-2'],
      fields: [{ key: 'industry', description: 'test' }],
      caller: orgCaller,
    });

    expect(result).toEqual({
      brands: [
        { brandId: 'brand-1', domain: 'acme.com', name: 'Acme', brandUrl: 'https://acme.com' },
        { brandId: 'brand-2', domain: 'finpay.io', name: 'FinPay', brandUrl: 'https://finpay.io' },
      ],
      fields: {
        industry: {
          value: 'SaaS & FinTech solutions for SMBs',
          byBrand: {
            'acme.com': { value: 'SaaS productivity tools', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/about'] },
            'finpay.io': { value: 'FinTech payment processing', cached: true, extractedAt: '2024-01-05', expiresAt: '2024-02-04', sourceUrls: ['https://finpay.io/'] },
          },
        },
      },
      provenance: { industry: 'extracted' },
    });

    // Verify consolidated result was persisted to DB
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('overlays a confirmed user-facing field and tags provenance confirmed/extracted', async () => {
    mockedGetBrand.mockResolvedValue({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com' });
    mockedExtractFields.mockResolvedValue([
      { key: 'services', value: 'extracted svc', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/'] },
      { key: 'industry', value: 'SaaS', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/'] },
    ]);
    // `services` is user-facing AND confirmed → overlaid + tagged confirmed.
    mockedGetConfirmed.mockResolvedValueOnce(new Map([['services', { value: ['Consulting', 'Audit'], confirmedAt: '2026-01-01T00:00:00.000Z' }]]));

    const result = await multiBrandExtractFields({
      brandIds: ['brand-1'],
      fields: [{ key: 'services', description: 'x' }, { key: 'industry', description: 'y' }],
      caller: orgCaller,
    });

    expect(result.provenance).toEqual({ services: 'confirmed', industry: 'extracted' });
    // Confirmed value overlaid at both the top level and byBrand.
    expect(result.fields.services.value).toEqual(['Consulting', 'Audit']);
    expect(result.fields.services.byBrand['acme.com'].value).toEqual(['Consulting', 'Audit']);
    // Non-user-facing key untouched.
    expect(result.fields.industry.value).toBe('SaaS');
  });

  it('tags an unconfirmed user-facing field as suggested (prefill kept)', async () => {
    mockedGetBrand.mockResolvedValue({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com' });
    mockedExtractFields.mockResolvedValue([
      { key: 'urgency', value: 'Ends Friday', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['https://acme.com/'] },
    ]);
    // No confirmed value (default empty Map from factory).

    const result = await multiBrandExtractFields({
      brandIds: ['brand-1'],
      fields: [{ key: 'urgency', description: 'x' }],
      caller: orgCaller,
    });

    expect(result.provenance).toEqual({ urgency: 'suggested' });
    expect(result.fields.urgency.value).toBe('Ends Friday');
  });

  it('should throw when a brand is not found', async () => {
    mockedGetBrand.mockResolvedValue(null);

    await expect(
      multiBrandExtractFields({
        brandIds: ['brand-nonexistent'],
        fields: [{ key: 'industry', description: 'test' }],
        caller: orgCaller,
      }),
    ).rejects.toThrow('Brand not found');
  });

  it('should pass a no-website brand through to extractFields, keyed by brandId', async () => {
    // A no-website brand (url + domain null, identified by name) is NOT rejected
    // here — the source-switch / fail-loud gate lives in extractFields. With no
    // domain, its per-brand result keys on the brandId instead.
    mockedGetBrand.mockResolvedValue({
      id: 'brand-1',
      url: null,
      name: 'Acme (no site)',
      domain: null,
    });
    mockedExtractFields.mockResolvedValue([
      { key: 'industry', value: 'Consulting', cached: false, extractedAt: '2024-01-01', expiresAt: '2024-02-01', sourceUrls: ['business-context://brand-1'] },
    ]);

    const result = await multiBrandExtractFields({
      brandIds: ['brand-1'],
      fields: [{ key: 'industry', description: 'test' }],
      caller: orgCaller,
    });

    expect(mockedExtractFields).toHaveBeenCalledTimes(1);
    expect(result.fields.industry.value).toBe('Consulting');
    expect(result.brands[0]).toMatchObject({ brandId: 'brand-1', domain: 'brand-1', brandUrl: null });
    expect(result.fields.industry.byBrand['brand-1'].value).toBe('Consulting');
  });

  it('should use DB-backed consolidated cache on second call with same per-brand values', async () => {
    const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Set up two brands for multi-brand
    mockedGetBrand
      .mockResolvedValueOnce({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-2', url: 'https://finpay.io', name: 'FinPay', domain: 'finpay.io', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-2', url: 'https://finpay.io', name: 'FinPay', domain: 'finpay.io', orgId: 'org-1' });

    mockedExtractFields
      .mockResolvedValueOnce([{ key: 'industry', value: 'SaaS tools', cached: true, extractedAt: '2024-01-01', expiresAt: futureExpiry, sourceUrls: ['https://acme.com/about'] }])
      .mockResolvedValueOnce([{ key: 'industry', value: 'FinTech payments', cached: true, extractedAt: '2024-01-05', expiresAt: futureExpiry, sourceUrls: ['https://finpay.io/'] }])
      .mockResolvedValueOnce([{ key: 'industry', value: 'SaaS tools', cached: true, extractedAt: '2024-01-01', expiresAt: futureExpiry, sourceUrls: ['https://acme.com/about'] }])
      .mockResolvedValueOnce([{ key: 'industry', value: 'FinTech payments', cached: true, extractedAt: '2024-01-05', expiresAt: futureExpiry, sourceUrls: ['https://finpay.io/'] }]);

    // First call: cache miss → LLM consolidation → DB write
    mockDbCacheMiss();
    mockedChat.mockResolvedValue({
      content: '',
      json: { industry: 'SaaS & FinTech' },
      tokensInput: 100,
      tokensOutput: 50,
      model: 'test-model',
    });

    const opts = {
      brandIds: ['brand-1', 'brand-2'],
      fields: [{ key: 'industry', description: 'test' }],
      caller: orgCaller,
    };

    await multiBrandExtractFields(opts);
    expect(mockedChat).toHaveBeenCalledTimes(1);
    expect(mockInsert).toHaveBeenCalledTimes(1);

    // Second call: DB cache hit → NO LLM call
    mockDbCacheHit({ industry: 'SaaS & FinTech' });

    const result2 = await multiBrandExtractFields(opts);
    expect(mockedChat).toHaveBeenCalledTimes(1); // still 1, not 2
    expect(result2.fields.industry.value).toBe('SaaS & FinTech');
  });

  it('should re-consolidate when per-brand values change (different cache key)', async () => {
    const futureExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    mockedGetBrand
      .mockResolvedValueOnce({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-2', url: 'https://finpay.io', name: 'FinPay', domain: 'finpay.io', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-2', url: 'https://finpay.io', name: 'FinPay', domain: 'finpay.io', orgId: 'org-1' });

    mockedExtractFields
      .mockResolvedValueOnce([{ key: 'industry', value: 'SaaS tools', cached: true, extractedAt: '2024-01-01', expiresAt: futureExpiry, sourceUrls: [] }])
      .mockResolvedValueOnce([{ key: 'industry', value: 'FinTech v1', cached: true, extractedAt: '2024-01-01', expiresAt: futureExpiry, sourceUrls: [] }])
      // Second call: brand-2 value changed (was re-extracted with new data)
      .mockResolvedValueOnce([{ key: 'industry', value: 'SaaS tools', cached: true, extractedAt: '2024-01-01', expiresAt: futureExpiry, sourceUrls: [] }])
      .mockResolvedValueOnce([{ key: 'industry', value: 'FinTech v2 updated', cached: false, extractedAt: '2024-01-10', expiresAt: futureExpiry, sourceUrls: [] }]);

    mockedChat
      .mockResolvedValueOnce({ content: '', json: { industry: 'Consolidated v1' }, tokensInput: 100, tokensOutput: 50, model: 'test' })
      .mockResolvedValueOnce({ content: '', json: { industry: 'Consolidated v2' }, tokensInput: 100, tokensOutput: 50, model: 'test' });

    // Both calls miss cache (different per-brand values → different cache keys)
    mockDbCacheMiss();

    const opts = {
      brandIds: ['brand-1', 'brand-2'],
      fields: [{ key: 'industry', description: 'test' }],
      caller: orgCaller,
    };

    const result1 = await multiBrandExtractFields(opts);
    expect(result1.fields.industry.value).toBe('Consolidated v1');

    // Re-mock for second call (different cache key → miss)
    mockDbCacheMiss();

    const result2 = await multiBrandExtractFields(opts);
    expect(result2.fields.industry.value).toBe('Consolidated v2');

    // Both calls triggered LLM because per-brand values differ
    expect(mockedChat).toHaveBeenCalledTimes(2);
  });
});

describe('multiBrandExtractImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return unified { brands, results } for single brand', async () => {
    mockedGetBrandForImages.mockResolvedValue({
      id: 'brand-1',
      url: 'https://acme.com',
      name: 'Acme',
      domain: 'acme.com',
    });
    const acmeLogo = {
      originalUrl: 'https://acme.com/logo.png',
      permanentUrl: 'https://r2.example.com/logo.png',
      description: 'Acme logo',
      width: 200,
      height: 100,
      format: 'png',
      sizeBytes: 5000,
      relevanceScore: 0.9,
      cached: false,
    };
    mockedExtractImages.mockResolvedValue([
      { category: 'logo', images: [acmeLogo] },
    ]);

    const result = await multiBrandExtractImages({
      brandIds: ['brand-1'],
      categories: [{ key: 'logo', description: 'Company logo', maxCount: 1 }],
      caller: orgCaller,
    });

    expect(result).toEqual({
      brands: [{ brandId: 'brand-1', domain: 'acme.com', name: 'Acme', brandUrl: 'https://acme.com' }],
      results: [{
        category: 'logo',
        images: [acmeLogo],
        byBrand: { 'acme.com': [acmeLogo] },
      }],
    });
  });

  it('should return unified format with merged images for multiple brands', async () => {
    mockedGetBrandForImages
      .mockResolvedValueOnce({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com', orgId: 'org-1' })
      .mockResolvedValueOnce({ id: 'brand-2', url: 'https://finpay.io', name: 'FinPay', domain: 'finpay.io', orgId: 'org-1' });

    const acmeLogo = {
      originalUrl: 'https://acme.com/logo.png',
      permanentUrl: 'https://r2.example.com/acme-logo.png',
      description: 'Acme logo',
      width: 200, height: 100, format: 'png', sizeBytes: 5000,
      relevanceScore: 0.9, cached: false,
    };
    const finpayLogo = {
      originalUrl: 'https://finpay.io/logo.png',
      permanentUrl: 'https://r2.example.com/finpay-logo.png',
      description: 'FinPay logo',
      width: 300, height: 150, format: 'png', sizeBytes: 8000,
      relevanceScore: 0.85, cached: false,
    };

    mockedExtractImages
      .mockResolvedValueOnce([{ category: 'logo', images: [acmeLogo] }])
      .mockResolvedValueOnce([{ category: 'logo', images: [finpayLogo] }]);

    const result = await multiBrandExtractImages({
      brandIds: ['brand-1', 'brand-2'],
      categories: [{ key: 'logo', description: 'Company logo', maxCount: 2 }],
      caller: orgCaller,
    });

    expect(result).toEqual({
      brands: [
        { brandId: 'brand-1', domain: 'acme.com', name: 'Acme', brandUrl: 'https://acme.com' },
        { brandId: 'brand-2', domain: 'finpay.io', name: 'FinPay', brandUrl: 'https://finpay.io' },
      ],
      results: [{
        category: 'logo',
        images: [acmeLogo, finpayLogo], // sorted by relevanceScore descending
        byBrand: {
          'acme.com': [acmeLogo],
          'finpay.io': [finpayLogo],
        },
      }],
    });
  });

  it('should throw when a brand is not found', async () => {
    mockedGetBrandForImages.mockResolvedValue(null);

    await expect(
      multiBrandExtractImages({
        brandIds: ['brand-nonexistent'],
        categories: [{ key: 'logo', description: 'Logo', maxCount: 1 }],
        caller: orgCaller,
      }),
    ).rejects.toThrow('Brand not found');
  });
});

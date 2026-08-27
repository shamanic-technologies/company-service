import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.fn();
vi.mock('../../src/lib/chat-client', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
}));

const mockMapSiteUrls = vi.fn();
const mockScrapeUrl = vi.fn();
vi.mock('../../src/lib/scraping-client', () => ({
  mapSiteUrls: (...args: unknown[]) => mockMapSiteUrls(...args),
  scrapeUrl: (...args: unknown[]) => mockScrapeUrl(...args),
  SiteMapError: class SiteMapError extends Error {
    name = 'SiteMapError';
  },
}));

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn();
vi.mock('../../src/lib/runs-client', () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: vi.fn(),
}));

vi.mock('../../src/lib/campaign-client', () => ({
  getCampaignFeatureInputs: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/trace-event', () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

// No saved profile version → no profile block injected; getByBrandId issues no
// db calls so the prompt assertions stay focused on the extraction message.
vi.mock('../../src/services/brandProfileService', () => ({
  brandProfileService: {
    getByBrandId: vi.fn().mockResolvedValue({ current: { fields: {} }, hasConfirmed: false, confirmedFields: {} }),
  },
}));

let dbCallIndex = 0;
let dbCallResults: unknown[][] = [];

function setDbSequence(results: unknown[][]) {
  dbCallIndex = 0;
  dbCallResults = results;
}

vi.mock('../../src/db', () => {
  const funnelable = () => {
    const funnel: Record<string, any> = {};
    for (const method of [
      'select',
      'from',
      'where',
      'innerJoin',
      'insert',
      'values',
      'onConflictDoUpdate',
      'onConflictDoNothing',
      'update',
      'set',
      'innerJoin',
      'leftJoin',
      'orderBy',
    ]) {
      funnel[method] = vi.fn().mockReturnValue(funnel);
    }
    funnel.limit = vi.fn().mockImplementation(() => {
      const result = dbCallResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result);
    });
    funnel.returning = vi.fn().mockResolvedValue([]);
    funnel.then = (resolve: (v: unknown) => void) => {
      const result = dbCallResults[dbCallIndex] ?? [];
      dbCallIndex++;
      return Promise.resolve(result).then(resolve);
    };
    return funnel;
  };
  return {
    db: funnelable(),
    brands: { id: 'brands.id', name: 'brands.name', url: 'brands.url', domain: 'brands.domain' },
    orgBrands: { orgId: 'ob.orgId', brandId: 'ob.brandId', claimedAt: 'ob.claimedAt' },
    brandExtractedFields: { brandId: 'bef.brandId', fieldKey: 'bef.fieldKey', fieldDescriptionHash: 'bef.fieldDescriptionHash', expiresAt: 'bef.expiresAt', campaignId: 'bef.campaignId' },
    pageScrapeCache: { normalizedUrl: 'psc.normalizedUrl', content: 'psc.content', expiresAt: 'psc.expiresAt', url: 'psc.url', scrapedAt: 'psc.scrapedAt', updatedAt: 'psc.updatedAt' },
    urlMapCache: { normalizedSiteUrl: 'umc.normalizedSiteUrl', urls: 'umc.urls', expiresAt: 'umc.expiresAt', siteUrl: 'umc.siteUrl', mappedAt: 'umc.mappedAt', updatedAt: 'umc.updatedAt' },
  };
});

import { extractFields } from '../../src/services/fieldExtractionService';

describe('extractFields LLM prompt — never null/empty', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbCallIndex = 0;
    mockCreateRun.mockResolvedValue({ id: 'run-prompt-1' });
    mockUpdateRun.mockResolvedValue({ id: 'run-prompt-1', status: 'completed' });
    mockMapSiteUrls.mockResolvedValue(['https://example.com']);
    mockScrapeUrl.mockResolvedValue('page content');
    // Both calls (URL selection + extraction) must return valid JSON.
    mockChat.mockResolvedValue({
      content: '{"industry":"SaaS"}',
      json: { industry: 'SaaS' },
      tokensInput: 100,
      tokensOutput: 20,
      model: 'gemini-pro',
    });
  });

  it("instructs the LLM never to return null/empty and to fall back to 'Unknown'", async () => {
    setDbSequence([
      [], // cache miss
      [{ id: 'brand-x', url: 'https://example.com', name: 'Test', domain: 'example.com', orgId: 'org-x' }], // getBrand
    ]);

    await extractFields({
      brandId: 'brand-x',
      caller: { mode: 'org', orgId: 'org-x', userId: 'user-x', runId: 'run-x' },
      fields: [{ key: 'industry', description: 'industry vertical' }],
    });

    // Locate the extraction call (system prompt identifies it).
    const extractionCall = mockChat.mock.calls.find((call) => {
      const params = call[0] as { systemPrompt?: string };
      return params.systemPrompt?.includes('brand information extraction');
    });
    expect(extractionCall).toBeDefined();
    const params = extractionCall![0] as { systemPrompt: string; message: string };

    // System prompt must enforce never-null and Unknown fallback.
    expect(params.systemPrompt).toMatch(/NEVER return null/);
    expect(params.systemPrompt).toMatch(/Unknown/);
    expect(params.systemPrompt).toMatch(/\["Unknown"\]/);

    // Message prompt must reiterate the rule.
    expect(params.message).toMatch(/NEVER return null/);
    expect(params.message).toMatch(/Unknown/);
    expect(params.message).toMatch(/\["Unknown"\]/);
    // Old offending instruction must be gone.
    expect(params.message).not.toMatch(/Use null if information is not found/);
  });

  it("grounds the LLM in today's date so expired time-sensitive claims are not surfaced as current", async () => {
    setDbSequence([
      [], // cache miss
      [{ id: 'brand-x', url: 'https://example.com', name: 'Test', domain: 'example.com', orgId: 'org-x' }], // getBrand
    ]);

    await extractFields({
      brandId: 'brand-x',
      caller: { mode: 'org', orgId: 'org-x', userId: 'user-x', runId: 'run-x' },
      fields: [{ key: 'urgency', description: 'Urgency elements and time pressure' }],
    });

    const extractionCall = mockChat.mock.calls.find((call) => {
      const params = call[0] as { systemPrompt?: string };
      return params.systemPrompt?.includes('brand information extraction');
    });
    expect(extractionCall).toBeDefined();
    const params = extractionCall![0] as { systemPrompt: string; message: string };

    // Current date must reach BOTH the system prompt and the message, so the
    // model can judge whether a scraped deadline is still in the future.
    expect(params.systemPrompt).toMatch(/Today's date is \d{4}-\d{2}-\d{2}/);
    expect(params.message).toMatch(/Today's date is \d{4}-\d{2}-\d{2}/);
    // And it must instruct the model to treat passed deadlines as expired.
    expect(params.systemPrompt).toMatch(/expired/i);
  });
});

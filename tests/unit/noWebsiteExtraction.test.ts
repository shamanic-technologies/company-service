import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Field-extraction SOURCE switch (no-website brands).
 *
 * A brand WITH a website scrapes + extracts from the site (unchanged). A brand
 * with NO website (url null) extracts from its pasted business context instead.
 * A brand with neither source fails loud.
 */

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
  orgBrands: {},
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

vi.mock('../../src/lib/trace-event', () => ({
  traceEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/brandProfileService', () => ({
  brandProfileService: {
    getByBrandId: vi.fn().mockResolvedValue({ hasConfirmed: false, confirmedFields: {} }),
  },
}));

vi.mock('../../src/services/brandBusinessContextService', () => ({
  getBrandBusinessContext: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  gt: vi.fn((...args: unknown[]) => ({ type: 'gt', args })),
  inArray: vi.fn((...args: unknown[]) => ({ type: 'inArray', args })),
  isNull: vi.fn((...args: unknown[]) => ({ type: 'isNull', args })),
  asc: vi.fn((...args: unknown[]) => ({ type: 'asc', args })),
  sql: vi.fn(),
}));

import { extractFields } from '../../src/services/fieldExtractionService';
import { chat } from '../../src/lib/chat-client';
import { mapSiteUrls, scrapeUrl } from '../../src/lib/scraping-client';
import { getBrandBusinessContext } from '../../src/services/brandBusinessContextService';

const mockedChat = vi.mocked(chat);
const mockedScrapeUrl = vi.mocked(scrapeUrl);
const mockedMapSiteUrls = vi.mocked(mapSiteUrls);
const mockedGetContext = vi.mocked(getBrandBusinessContext);

/**
 * Queue the two getBrand selects: brands row, then org_brands membership row.
 * Every select() returns a funnel whose terminal (.limit) resolves the next
 * queued value.
 */
function mockGetBrand(brandRow: any, orgId = 'org-1') {
  const results = [[brandRow], [{ orgId }]];
  let call = 0;
  mockSelect.mockImplementation(() => {
    const funnel: any = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => Promise.resolve(results[call++] ?? [])),
    };
    return funnel;
  });

  mockInsert.mockReturnValue({
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  });
}

const orgCaller = { mode: 'org' as const, orgId: 'org-1', userId: 'user-1', runId: 'run-1' };
const fields = [{ key: 'services', description: 'what the brand sells' }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractFields source switch', () => {
  it('extracts from pasted business context when the brand has NO website', async () => {
    mockGetBrand({ id: 'brand-1', url: null, name: 'Acme (no site)', domain: null });
    mockedGetContext.mockResolvedValue('Acme sells bespoke consulting and fractional CFO services.');
    mockedChat.mockResolvedValue({
      content: '',
      json: { services: 'Consulting, Fractional CFO' },
      tokensInput: 10,
      tokensOutput: 5,
      model: 'test',
    } as any);

    const result = await extractFields({ brandId: 'brand-1', fields, caller: orgCaller, resetCache: true });

    // Value is derived from the pasted context (not empty, not scraped).
    expect(result).toEqual([
      expect.objectContaining({ key: 'services', value: 'Consulting, Fractional CFO', cached: false }),
    ]);
    // The pasted context reached the model.
    expect(mockedChat).toHaveBeenCalledTimes(1);
    const chatArg = mockedChat.mock.calls[0][0] as any;
    expect(chatArg.message).toContain('bespoke consulting and fractional CFO');
    // No scraping happened.
    expect(mockedScrapeUrl).not.toHaveBeenCalled();
    expect(mockedMapSiteUrls).not.toHaveBeenCalled();
    // Source marker recorded (not a scraped http url).
    expect((result[0] as any).sourceUrls).toEqual(['business-context://brand-1#1']);
  });

  it('fails loud when the brand has neither a website nor business context', async () => {
    mockGetBrand({ id: 'brand-1', url: null, name: 'Empty', domain: null });
    mockedGetContext.mockResolvedValue(null);

    await expect(
      extractFields({ brandId: 'brand-1', fields, caller: orgCaller, resetCache: true }),
    ).rejects.toThrow(/neither a website URL nor pasted business context/);
    expect(mockedChat).not.toHaveBeenCalled();
  });

  it('scrapes the website (unchanged) and NEVER reads business context when a URL is present', async () => {
    mockGetBrand({ id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com' });
    mockedScrapeUrl.mockResolvedValue('Acme website content: we sell SaaS tools.');
    mockedChat.mockResolvedValue({
      content: '',
      json: { services: 'SaaS tools' },
      tokensInput: 10,
      tokensOutput: 5,
      model: 'test',
    } as any);

    const result = await extractFields({
      brandId: 'brand-1',
      fields,
      caller: orgCaller,
      resetCache: true,
      urlStrategy: 'landing',
    });

    expect(result).toEqual([
      expect.objectContaining({ key: 'services', value: 'SaaS tools', cached: false }),
    ]);
    expect(mockedScrapeUrl).toHaveBeenCalledWith('https://acme.com', expect.anything());
    // The website brand must NOT touch the business-context store.
    expect(mockedGetContext).not.toHaveBeenCalled();
  });
});

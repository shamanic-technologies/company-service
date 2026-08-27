import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regenerating a confirmed field — the PROMPT + CACHE half.
 *
 * A caller that asks to regenerate a field means "throw away what is written
 * here and write it again from my website". Two things made that impossible:
 * the confirmed value was injected into the prompt as authoritative, and the
 * cached extraction (itself produced under that prompt) was served back.
 * `regenerateFieldKeys` suppresses both — but ONLY for the listed keys, so the
 * rest of the confirmed profile still grounds the regeneration.
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
  brandProfileService: { getByBrandId: vi.fn() },
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

import { extractFields, hashFieldDescription } from '../../src/services/fieldExtractionService';
import { chat } from '../../src/lib/chat-client';
import { scrapeUrl } from '../../src/lib/scraping-client';
import { brandProfileService } from '../../src/services/brandProfileService';

const mockedChat = vi.mocked(chat);
const mockedScrapeUrl = vi.mocked(scrapeUrl);
const mockedProfile = vi.mocked(brandProfileService.getByBrandId);

const CONFIRMED = {
  services: ['Fractional CFO', 'Bookkeeping'],
  dreamOutcome: 'Books that close themselves',
  urgency: 'Only 3 slots left this quarter',
};

/**
 * Queue db reads in call order. `getCachedFields` awaits the funnel itself (its
 * terminal is `.where()`), `getBrand` terminates on `.limit()` — both pull the
 * next queued result.
 */
function mockDbReads(queued: any[][]) {
  let call = 0;
  const next = () => Promise.resolve(queued[call++] ?? []);
  mockSelect.mockImplementation(() => {
    const funnel: any = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(next),
      then: (resolve: any, reject: any) => next().then(resolve, reject),
    };
    return funnel;
  });
  mockInsert.mockReturnValue({
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  });
}

const brandRow = { id: 'brand-1', url: 'https://acme.com', name: 'Acme', domain: 'acme.com' };
const orgCaller = { mode: 'org' as const, orgId: 'org-1', userId: 'user-1', runId: 'run-1' };

const fields = [
  { key: 'services', description: 'what the brand sells' },
  { key: 'dreamOutcome', description: 'the dream outcome' },
  { key: 'urgency', description: 'why act now' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedProfile.mockResolvedValue({
    current: { fields: CONFIRMED },
    hasConfirmed: true,
    confirmedFields: CONFIRMED,
  } as any);
  mockedScrapeUrl.mockResolvedValue('Acme sells audit and tax retainers. Deadline: none.');
  mockedChat.mockResolvedValue({
    content: '',
    json: { services: 'Audit, Tax', dreamOutcome: 'A clean audit trail', urgency: 'Unknown' },
    tokensInput: 10,
    tokensOutput: 5,
    model: 'test',
  } as any);
});

describe('extractFields — regenerateFieldKeys suppresses the confirmed value in the PROMPT', () => {
  it('default (no regenerate): every confirmed value is still injected as authoritative', async () => {
    mockDbReads([[brandRow], [{ orgId: 'org-1' }]]);

    await extractFields({
      brandId: 'brand-1',
      fields,
      caller: orgCaller,
      resetCache: true,
      urlStrategy: 'landing',
    });

    const message = (mockedChat.mock.calls[0][0] as any).message as string;
    expect(message).toContain('Client-validated brand profile');
    expect(message).toContain('Books that close themselves');
    expect(message).toContain('Fractional CFO');
    expect(message).toContain('Only 3 slots left this quarter');
  });

  it('regenerating a key withholds ONLY that key — the other confirmed values still ground the draft', async () => {
    mockDbReads([[brandRow], [{ orgId: 'org-1' }]]);

    await extractFields({
      brandId: 'brand-1',
      fields,
      caller: orgCaller,
      resetCache: true,
      urlStrategy: 'landing',
      regenerateFieldKeys: ['dreamOutcome', 'urgency'],
    });

    const message = (mockedChat.mock.calls[0][0] as any).message as string;
    // The regenerated keys' confirmed values never reach the model.
    expect(message).not.toContain('Books that close themselves');
    expect(message).not.toContain('Only 3 slots left this quarter');
    // The confirmed SERVICES still do — the offer levers are written FROM them.
    expect(message).toContain('Client-validated brand profile');
    expect(message).toContain('Fractional CFO');
  });

  it('regenerating every confirmed key drops the whole authoritative block (no empty stub)', async () => {
    mockDbReads([[brandRow], [{ orgId: 'org-1' }]]);

    await extractFields({
      brandId: 'brand-1',
      fields,
      caller: orgCaller,
      resetCache: true,
      urlStrategy: 'landing',
      regenerateFieldKeys: ['services', 'dreamOutcome', 'urgency'],
    });

    const message = (mockedChat.mock.calls[0][0] as any).message as string;
    expect(message).not.toContain('Client-validated brand profile');
    expect(message).not.toContain('treat this as the source of truth');
  });
});

describe('extractFields — a regenerated key never serves from the extraction cache', () => {
  /** A cached row for every requested key, all still valid. */
  function cachedRows() {
    return fields.map((f) => ({
      fieldKey: f.key,
      fieldDescriptionHash: hashFieldDescription(f.description),
      fieldValue: `cached ${f.key}`,
      extractedAt: '2024-01-01',
      expiresAt: '2099-01-01',
      sourceUrls: ['https://acme.com/'],
    }));
  }

  it('without regenerate, an all-cached request returns the cache and never calls the model', async () => {
    mockDbReads([cachedRows()]);

    const result = await extractFields({
      brandId: 'brand-1',
      fields,
      caller: orgCaller,
      urlStrategy: 'landing',
    });

    expect(result.every((r) => r.cached)).toBe(true);
    expect(mockedChat).not.toHaveBeenCalled();
    expect(mockedScrapeUrl).not.toHaveBeenCalled();
  });

  it('a regenerated key is re-extracted even when its cache row is fresh; the rest still serve from cache', async () => {
    mockDbReads([cachedRows(), [brandRow], [{ orgId: 'org-1' }]]);
    mockedChat.mockResolvedValue({
      content: '',
      json: { dreamOutcome: 'A clean audit trail' },
      tokensInput: 10,
      tokensOutput: 5,
      model: 'test',
    } as any);

    const result = await extractFields({
      brandId: 'brand-1',
      fields,
      caller: orgCaller,
      urlStrategy: 'landing',
      regenerateFieldKeys: ['dreamOutcome'],
    });

    const byKey = new Map(result.map((r) => [r.key, r]));
    expect(byKey.get('dreamOutcome')).toMatchObject({ value: 'A clean audit trail', cached: false });
    expect(byKey.get('services')).toMatchObject({ value: 'cached services', cached: true });
    expect(byKey.get('urgency')).toMatchObject({ value: 'cached urgency', cached: true });

    // Only the regenerated key was sent to the model for extraction; the cached
    // keys' descriptions are absent from the request.
    const message = (mockedChat.mock.calls[0][0] as any).message as string;
    expect(message).toContain('the dream outcome');
    expect(message).not.toContain('what the brand sells');
    expect(message).not.toContain('why act now');
  });
});

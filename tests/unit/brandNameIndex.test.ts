/**
 * brands.name priority funnel: logo.dev index -> landing-page HTML -> titlecased
 * domain, both at CREATE time (fillBrandNameOnCreate) and on the read-path
 * safety net (ensureBrandName).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let selectIndex = 0;
let selectResults: unknown[][] = [];
let returningIndex = 0;
let returningResults: unknown[][] = [];
const updateSetMock = vi.fn();
const updateWhereMock = vi.fn();

function setSelectSequence(results: unknown[][]) {
  selectIndex = 0;
  selectResults = results;
}

function setReturningSequence(results: unknown[][]) {
  returningIndex = 0;
  returningResults = results;
}

vi.mock('../../src/db', () => {
  const funnelable = () => {
    const funnel: Record<string, any> = {};
    for (const method of ['select', 'from', 'insert', 'values', 'onConflictDoUpdate', 'onConflictDoNothing']) {
      funnel[method] = vi.fn().mockReturnValue(funnel);
    }
    funnel.update = vi.fn().mockReturnValue(funnel);
    funnel.set = (...args: unknown[]) => {
      updateSetMock(...args);
      return funnel;
    };
    funnel.where = (...args: unknown[]) => {
      updateWhereMock(...args);
      return funnel;
    };
    funnel.limit = vi.fn().mockImplementation(() => {
      const result = selectResults[selectIndex] ?? [];
      selectIndex++;
      return Promise.resolve(result);
    });
    funnel.returning = vi.fn().mockImplementation(() => {
      const result = returningResults[returningIndex] ?? [];
      returningIndex++;
      return Promise.resolve(result);
    });
    funnel.then = (resolve: (v: unknown) => void) => {
      const result = selectResults[selectIndex] ?? [];
      selectIndex++;
      return Promise.resolve(result).then(resolve);
    };
    return funnel;
  };
  return {
    db: funnelable(),
    brands: { id: 'brands.id', name: 'brands.name', url: 'brands.url', domain: 'brands.domain' },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  isNull: vi.fn((...args: unknown[]) => ({ type: 'isNull', args })),
  sql: Object.assign(vi.fn((strings: TemplateStringsArray) => ({ type: 'sql', raw: strings.raw })), {}),
}));

const searchBrandNameByDomainMock = vi.fn();
vi.mock('../../src/lib/logo-dev-search', () => ({
  searchBrandNameByDomain: (...args: unknown[]) => searchBrandNameByDomainMock(...args),
}));

import { fillBrandNameOnCreate, ensureBrandName } from '../../src/services/brandService';
import type { PlatformCaller } from '../../src/lib/chat-client';

const platformCaller: PlatformCaller = { mode: 'platform' };
const mockFetch = vi.fn();

function htmlResponse(html: string, ok = true, status = 200) {
  return { ok, status, text: () => Promise.resolve(html) };
}

describe('brand name priority funnel', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    setSelectSequence([]);
    setReturningSequence([]);
    vi.stubGlobal('fetch', mockFetch);
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllGlobals();
  });

  describe('fillBrandNameOnCreate (create path)', () => {
    it('uses the indexed company name and never fetches the customer website', async () => {
      // AC1: `Home | Acme` title would yield "Home"; the index yields "Acme Consulting".
      searchBrandNameByDomainMock.mockResolvedValueOnce('Acme Consulting');
      setReturningSequence([[{ name: 'Acme Consulting' }]]);

      const result = await fillBrandNameOnCreate('brand-1', 'https://acme.com', 'acme.com');

      expect(result).toBe('Acme Consulting');
      expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Acme Consulting' }));
      // AC4: the create never waits on a third-party website fetch.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns the titlecased domain immediately on an index miss, then upgrades from the page in the background', async () => {
      // AC2 + AC4: create resolves without waiting on the site; the HTML path
      // still runs and replaces the placeholder.
      searchBrandNameByDomainMock.mockResolvedValueOnce(null);
      setReturningSequence([[{ name: 'My Cool Brand' }], [{ name: 'Pressbeat' }]]);
      let resolveFetch: (value: unknown) => void = () => {};
      mockFetch.mockReturnValueOnce(new Promise((resolve) => { resolveFetch = resolve; }));

      const result = await fillBrandNameOnCreate('brand-2', 'https://my-cool-brand.com', 'my-cool-brand.com');

      expect(result).toBe('My Cool Brand');
      expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Cool Brand' }));

      resolveFetch(htmlResponse('<meta property="og:site_name" content="Pressbeat">'));

      await vi.waitFor(() => {
        expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pressbeat' }));
      });
      // The upgrade is conditioned on the row still holding the placeholder.
      expect(updateWhereMock).toHaveBeenCalledWith(
        expect.objectContaining({
          args: expect.arrayContaining([
            expect.objectContaining({ args: ['brands.name', 'My Cool Brand'] }),
          ]),
        }),
      );
    });

    it('keeps the titlecased domain when the page fetch fails (no upgrade write)', async () => {
      // AC2 terminal fallback.
      searchBrandNameByDomainMock.mockResolvedValueOnce(null);
      setReturningSequence([[{ name: 'Acme' }]]);
      mockFetch.mockRejectedValueOnce(new Error('network down'));

      const result = await fillBrandNameOnCreate('brand-3', 'https://acme.io', 'acme.io');

      expect(result).toBe('Acme');
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
      expect(updateSetMock).toHaveBeenCalledTimes(1);
    });

    it('never overwrites a name another writer already stored', async () => {
      // AC6: the conditional UPDATE matches nothing, the stored name wins.
      searchBrandNameByDomainMock.mockResolvedValueOnce('Indexed Name');
      setReturningSequence([[]]);
      setSelectSequence([[{ id: 'brand-4', name: 'User Chosen Name', domain: 'acme.com', url: 'https://acme.com' }]]);

      const result = await fillBrandNameOnCreate('brand-4', 'https://acme.com', 'acme.com');

      expect(result).toBe('User Chosen Name');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('bypasses the network entirely in test env', async () => {
      process.env.NODE_ENV = 'test';
      setReturningSequence([[{ name: 'Testdomain' }]]);

      const result = await fillBrandNameOnCreate('brand-5', 'https://testdomain.com', 'testdomain.com');

      expect(result).toBe('Testdomain');
      expect(searchBrandNameByDomainMock).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('ensureBrandName (read-path safety net)', () => {
    it('prefers the indexed company name over the page title', async () => {
      setSelectSequence([
        [{ id: 'brand-6', name: null, domain: 'acme.com', url: 'https://acme.com' }],
        [{ id: 'brand-6', name: null, domain: 'acme.com', url: 'https://acme.com' }],
      ]);
      searchBrandNameByDomainMock.mockResolvedValueOnce('Acme Consulting');

      const result = await ensureBrandName('brand-6', platformCaller);

      expect(result).toBe('Acme Consulting');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Acme Consulting' }));
    });

    it('falls through to the page HTML on an index miss', async () => {
      setSelectSequence([
        [{ id: 'brand-7', name: null, domain: 'pressbeat.io', url: 'https://pressbeat.io' }],
        [{ id: 'brand-7', name: null, domain: 'pressbeat.io', url: 'https://pressbeat.io' }],
      ]);
      searchBrandNameByDomainMock.mockResolvedValueOnce(null);
      mockFetch.mockResolvedValueOnce(htmlResponse('<meta property="og:site_name" content="Pressbeat">'));

      const result = await ensureBrandName('brand-7', platformCaller);

      expect(result).toBe('Pressbeat');
      expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pressbeat' }));
    });

    it('falls through to the titlecased domain when index and page both miss', async () => {
      setSelectSequence([
        [{ id: 'brand-8', name: null, domain: 'my-cool-brand.com', url: 'https://my-cool-brand.com' }],
        [{ id: 'brand-8', name: null, domain: 'my-cool-brand.com', url: 'https://my-cool-brand.com' }],
      ]);
      searchBrandNameByDomainMock.mockResolvedValueOnce(null);
      mockFetch.mockRejectedValueOnce(new Error('network down'));

      const result = await ensureBrandName('brand-8', platformCaller);

      expect(result).toBe('My Cool Brand');
    });
  });
});

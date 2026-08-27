import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let dbCallIndex = 0;
let dbCallResults: unknown[][] = [];
const updateSetMock = vi.fn();

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
      'insert',
      'values',
      'onConflictDoUpdate',
      'onConflictDoNothing',
    ]) {
      funnel[method] = vi.fn().mockReturnValue(funnel);
    }
    funnel.update = vi.fn().mockReturnValue(funnel);
    funnel.set = (...args: unknown[]) => {
      updateSetMock(...args);
      return funnel;
    };
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
    brands: {
      id: 'brands.id',
      orgId: 'brands.orgId',
      name: 'brands.name',
      url: 'brands.url',
      domain: 'brands.domain',
    },
  };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ type: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  isNull: vi.fn((...args: unknown[]) => ({ type: 'isNull', args })),
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray) => ({ type: 'sql', raw: strings.raw })),
    {},
  ),
}));

// This file covers the page-HTML link of the funnel, so the company index always
// misses here. Index-first behaviour lives in brandNameIndex.test.ts.
vi.mock('../../src/lib/logo-dev-search', () => ({
  searchBrandNameByDomain: vi.fn().mockResolvedValue(null),
}));

import { ensureBrandName } from '../../src/services/brandService';
import type { OrgCaller, PlatformCaller } from '../../src/lib/chat-client';

const platformCaller: PlatformCaller = { mode: 'platform' };

const orgCaller: OrgCaller = {
  mode: 'org',
  orgId: 'org-99',
  userId: 'user-99',
  runId: 'run-99',
};

const mockFetch = vi.fn();

function htmlResponse(html: string, ok = true, status = 200) {
  return { ok, status, text: () => Promise.resolve(html) };
}

describe('ensureBrandName (deterministic, no LLM)', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    dbCallIndex = 0;
    dbCallResults = [];
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.unstubAllGlobals();
  });

  it('returns existing name without fetching when name is already set', async () => {
    process.env.NODE_ENV = 'production';
    setDbSequence([
      [{ id: 'brand-1', name: 'Acme Inc', orgId: 'org-1', domain: 'acme.com', url: 'https://acme.com' }],
    ]);

    const result = await ensureBrandName('brand-1', platformCaller);

    expect(result).toBe('Acme Inc');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('throws when brand is not found', async () => {
    process.env.NODE_ENV = 'production';
    setDbSequence([[]]);

    await expect(ensureBrandName('missing-brand', platformCaller)).rejects.toThrow(
      /Brand not found: missing-brand/,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('derives the name from landing HTML (og:site_name) and persists it', async () => {
    process.env.NODE_ENV = 'production';
    setDbSequence([
      [{ id: 'brand-2', name: null, orgId: 'org-2', domain: 'pressbeat.io', url: 'https://pressbeat.io' }],
      [{ id: 'brand-2', name: null, orgId: 'org-2', domain: 'pressbeat.io', url: 'https://pressbeat.io' }],
    ]);
    mockFetch.mockResolvedValueOnce(
      htmlResponse('<meta property="og:site_name" content="Pressbeat"><title>Pressbeat | PR</title>'),
    );

    const result = await ensureBrandName('brand-2', platformCaller);

    expect(result).toBe('Pressbeat');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://pressbeat.io');
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pressbeat' }));
  });

  it('works the same for an org caller (caller is not used by the fill)', async () => {
    process.env.NODE_ENV = 'production';
    setDbSequence([
      [{ id: 'brand-2b', name: null, orgId: 'org-2', domain: 'pressbeat.io', url: 'https://pressbeat.io' }],
      [{ id: 'brand-2b', name: null, orgId: 'org-2', domain: 'pressbeat.io', url: 'https://pressbeat.io' }],
    ]);
    mockFetch.mockResolvedValueOnce(htmlResponse('<title>Pressbeat — PR coverage</title>'));

    const result = await ensureBrandName('brand-2b', orgCaller);

    expect(result).toBe('Pressbeat');
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'Pressbeat' }));
  });

  it('falls back to the titlecased domain when the fetch fails (no throw)', async () => {
    process.env.NODE_ENV = 'production';
    setDbSequence([
      [{ id: 'brand-3', name: null, orgId: 'org-3', domain: 'my-cool-brand.com', url: 'https://my-cool-brand.com' }],
      [{ id: 'brand-3', name: null, orgId: 'org-3', domain: 'my-cool-brand.com', url: 'https://my-cool-brand.com' }],
    ]);
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const result = await ensureBrandName('brand-3', platformCaller);

    expect(result).toBe('My Cool Brand');
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Cool Brand' }));
  });

  it('falls back to the titlecased domain on a non-OK response', async () => {
    process.env.NODE_ENV = 'production';
    setDbSequence([
      [{ id: 'brand-3b', name: null, orgId: 'org-3', domain: 'acme.io', url: 'https://acme.io' }],
      [{ id: 'brand-3b', name: null, orgId: 'org-3', domain: 'acme.io', url: 'https://acme.io' }],
    ]);
    mockFetch.mockResolvedValueOnce(htmlResponse('forbidden', false, 403));

    const result = await ensureBrandName('brand-3b', platformCaller);

    expect(result).toBe('Acme');
  });

  it('shares one in-flight name fill across concurrent calls for the same brand', async () => {
    process.env.NODE_ENV = 'production';
    setDbSequence([
      [{ id: 'brand-singleflight', name: null, orgId: 'org-1', domain: 'acme.com', url: 'https://acme.com' }],
      [{ id: 'brand-singleflight', name: null, orgId: 'org-1', domain: 'acme.com', url: 'https://acme.com' }],
      [{ id: 'brand-singleflight', name: null, orgId: 'org-1', domain: 'acme.com', url: 'https://acme.com' }],
    ]);

    let resolveFetch: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockReturnValueOnce(pending);

    const first = ensureBrandName('brand-singleflight', platformCaller);
    const second = ensureBrandName('brand-singleflight', platformCaller);

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    resolveFetch(htmlResponse('<meta property="og:site_name" content="Acme">'));

    await expect(Promise.all([first, second])).resolves.toEqual(['Acme', 'Acme']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(updateSetMock).toHaveBeenCalledTimes(1);
  });

  it('re-reads brands.name before fetching after joining the fill gate', async () => {
    process.env.NODE_ENV = 'production';
    setDbSequence([
      [{ id: 'brand-reread', name: null, orgId: 'org-1', domain: 'acme.com', url: 'https://acme.com' }],
      [{ id: 'brand-reread', name: 'Already Filled', orgId: 'org-1', domain: 'acme.com', url: 'https://acme.com' }],
    ]);

    const result = await ensureBrandName('brand-reread', platformCaller);

    expect(result).toBe('Already Filled');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('bypasses the network fetch in test env and persists domain as name', async () => {
    process.env.NODE_ENV = 'test';
    setDbSequence([
      [{ id: 'brand-4', name: null, orgId: 'org-4', domain: 'testdomain.com', url: 'https://testdomain.com' }],
    ]);

    const result = await ensureBrandName('brand-4', platformCaller);

    expect(result).toBe('testdomain.com');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'testdomain.com' }),
    );
  });
});

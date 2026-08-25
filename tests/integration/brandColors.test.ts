import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { eq, inArray } from 'drizzle-orm';

import { createTestApp, getAuthHeaders } from '../helpers/test-app';
import { db, brandColors, brands, logoDevBrandCalls, orgBrands } from '../../src/db';
import { deleteBrandsByOrgIds } from '../helpers/test-db';

// key-service is not reachable from a test run, and the point of these tests is
// the CADENCE, not the key lookup.
vi.mock('../../src/lib/keys-service', () => ({
  getPlatformKey: vi.fn(async () => 'sk_test'),
  getKeyForOrg: vi.fn(async () => ({ key: null, keySource: null })),
}));

const app = createTestApp();

const originalFetch = global.fetch;

/** Answer the NEXT logo.dev Brand call with this status + body. */
function respondOnce(status: number, body: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

const SHOCKWAVE_PALETTE = [
  { r: 0, g: 1, b: 3, hex: '#000103' },
  { r: 206, g: 46, b: 54, hex: '#ce2e36' },
  { r: 0, g: 51, b: 102, hex: '#003366' },
];

describe('brand colours', () => {
  const createdOrgIds: string[] = [];
  const createdBrandIds: string[] = [];
  const testDomains: string[] = [];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
    if (testDomains.length > 0) {
      await db.delete(logoDevBrandCalls).where(inArray(logoDevBrandCalls.domain, testDomains));
      testDomains.length = 0;
    }
    await deleteBrandsByOrgIds(createdOrgIds);
    createdOrgIds.length = 0;
    createdBrandIds.length = 0;
  });

  /** A website brand claimed by a fresh org, plus an optional colour row. */
  async function seedBrand(opts: {
    domain: string;
    colors?: string[] | null;
    status?: 'pending' | 'resolved' | 'unavailable';
    attempts?: number;
    withRow?: boolean;
  }): Promise<{ orgId: string; brandId: string }> {
    const orgId = randomUUID();
    const brandId = randomUUID();
    createdOrgIds.push(orgId);
    createdBrandIds.push(brandId);
    testDomains.push(opts.domain);

    await db.insert(brands).values({
      id: brandId,
      domain: opts.domain,
      url: `https://${opts.domain}`,
      name: 'Seeded Brand',
    });
    await db.insert(orgBrands).values({ orgId, brandId });

    if (opts.withRow !== false) {
      await db.insert(brandColors).values({
        brandId,
        colors: opts.colors ?? null,
        status: opts.status ?? 'pending',
        attempts: opts.attempts ?? 0,
      });
    }

    return { orgId, brandId };
  }

  describe('what a brand read carries', () => {
    it('serves the palette in the order the provider gave it', async () => {
      const { orgId, brandId } = await seedBrand({
        domain: `shockwave-${randomUUID().slice(0, 8)}.example`,
        colors: ['#000103', '#ce2e36', '#003366'],
        status: 'resolved',
      });

      const res = await request(app)
        .get(`/internal/brands/${brandId}`)
        .set(getAuthHeaders(orgId, randomUUID()));

      expect(res.status).toBe(200);
      // All three, in provider order — the consumer selects, we do not.
      expect(res.body.brand.colors).toEqual(['#000103', '#ce2e36', '#003366']);
    });

    it('is null — not [] and not a guess — for a brand whose colours we do not have', async () => {
      const pending = await seedBrand({ domain: `pend-${randomUUID().slice(0, 8)}.example` });
      const givenUp = await seedBrand({
        domain: `gone-${randomUUID().slice(0, 8)}.example`,
        status: 'unavailable',
        attempts: 8,
      });
      const never = await seedBrand({
        domain: `never-${randomUUID().slice(0, 8)}.example`,
        withRow: false,
      });

      for (const seeded of [pending, givenUp, never]) {
        const res = await request(app)
          .get(`/internal/brands/${seeded.brandId}`)
          .set(getAuthHeaders(seeded.orgId, randomUUID()));
        expect(res.status).toBe(200);
        expect(res.body.brand.colors).toBeNull();
      }
    });

    it('carries the palette on the org brand list too', async () => {
      const { orgId, brandId } = await seedBrand({
        domain: `list-${randomUUID().slice(0, 8)}.example`,
        colors: ['#000103'],
        status: 'resolved',
      });

      const res = await request(app)
        .get('/orgs/brands')
        .set(getAuthHeaders(orgId, randomUUID()));

      expect(res.status).toBe(200);
      const found = res.body.brands.find((b: { id: string }) => b.id === brandId);
      expect(found.colors).toEqual(['#000103']);
    });

    it('carries the palette on the batch read', async () => {
      const { orgId, brandId } = await seedBrand({
        domain: `batch-${randomUUID().slice(0, 8)}.example`,
        colors: ['#003366'],
        status: 'resolved',
      });

      const res = await request(app)
        .get(`/internal/brands?ids=${brandId}`)
        .set(getAuthHeaders(orgId, randomUUID()));

      expect(res.status).toBe(200);
      expect(res.body.brands[0].colors).toEqual(['#003366']);
    });
  });

  describe('the retrieval is decoupled from the write that enqueued it', () => {
    it('a brand created with a website is QUEUED, and no metered call is made on the create', async () => {
      const orgId = randomUUID();
      createdOrgIds.push(orgId);
      const domain = `create-${randomUUID().slice(0, 8)}.example`;
      testDomains.push(domain);

      const fetchSpy = vi.fn().mockRejectedValue(new Error('no network in tests'));
      global.fetch = fetchSpy as unknown as typeof fetch;

      const res = await request(app)
        .post('/orgs/brands')
        .set(getAuthHeaders(orgId, randomUUID()))
        .send({ url: `https://${domain}` });

      expect(res.status).toBe(200);
      const [row] = await db
        .select()
        .from(brandColors)
        .where(eq(brandColors.brandId, res.body.brandId));
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.colors).toBeNull();

      // Nothing was spent on the Brand endpoint by the create itself.
      const brandCalls = fetchSpy.mock.calls.filter(([url]) =>
        String(url).startsWith('https://api.logo.dev/brand/'),
      );
      expect(brandCalls).toHaveLength(0);
      const ledger = await db
        .select()
        .from(logoDevBrandCalls)
        .where(eq(logoDevBrandCalls.domain, domain));
      expect(ledger).toHaveLength(0);
    }, 20000);

    it('a 202 keeps the brand queued, and a LATER pass picks up the palette', async () => {
      const { brandId } = await seedBrand({ domain: `async-${randomUUID().slice(0, 8)}.example` });
      const { refreshPendingBrandColors } = await import('../../src/services/brandColorsService');

      // First contact: logo.dev has never indexed the domain. This is what six
      // of our seven live domains answered — a design that read the result here
      // would store nothing, forever.
      respondOnce(202, { msg: 'not found, looking up' });
      await refreshPendingBrandColors({ brandIds: [brandId] });

      let [row] = await db.select().from(brandColors).where(eq(brandColors.brandId, brandId));
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.colors).toBeNull();

      // A later pass, once the provider finished indexing. Nobody re-ran
      // anything by hand.
      respondOnce(200, { domain: 'x', colors: SHOCKWAVE_PALETTE });
      await refreshPendingBrandColors({ brandIds: [brandId] });

      [row] = await db.select().from(brandColors).where(eq(brandColors.brandId, brandId));
      expect(row.status).toBe('resolved');
      expect(row.colors).toEqual(['#000103', '#ce2e36', '#003366']);
      expect(row.resolvedAt).not.toBeNull();
    }, 30000);

    it('an indexed domain with no palette is terminal, and stays "no colours"', async () => {
      const { brandId } = await seedBrand({ domain: `empty-${randomUUID().slice(0, 8)}.example` });
      const { refreshPendingBrandColors } = await import('../../src/services/brandColorsService');

      respondOnce(200, { domain: 'x', colors: [] });
      await refreshPendingBrandColors({ brandIds: [brandId] });

      const [row] = await db.select().from(brandColors).where(eq(brandColors.brandId, brandId));
      expect(row.status).toBe('unavailable');
      expect(row.colors).toBeNull();
    }, 20000);

    it('a resolved brand is never called again', async () => {
      const domain = `done-${randomUUID().slice(0, 8)}.example`;
      const seeded = await seedBrand({ domain, colors: ['#000103'], status: 'resolved', attempts: 1 });
      const { refreshPendingBrandColors } = await import('../../src/services/brandColorsService');

      const fetchSpy = vi.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;
      await refreshPendingBrandColors({ brandIds: [seeded.brandId] });

      expect(
        fetchSpy.mock.calls.filter(([url]) => String(url).includes(domain)),
      ).toHaveLength(0);
    }, 20000);
  });

  describe('the spend is bounded by us — the endpoint exposes no quota', () => {
    it('every metered call lands in the ledger', async () => {
      const domain = `ledger-${randomUUID().slice(0, 8)}.example`;
      const seeded = await seedBrand({ domain });
      const { refreshPendingBrandColors } = await import('../../src/services/brandColorsService');

      respondOnce(202, { msg: 'not found, looking up' });
      await refreshPendingBrandColors({ brandIds: [seeded.brandId] });

      const ledger = await db
        .select()
        .from(logoDevBrandCalls)
        .where(eq(logoDevBrandCalls.domain, domain));
      expect(ledger).toHaveLength(1);
      expect(ledger[0].outcome).toBe('pending');
      expect(ledger[0].httpStatus).toBe(202);
    }, 20000);

    it('a 402 stops the pass without spending the brand an attempt', async () => {
      const { brandId } = await seedBrand({ domain: `broke-${randomUUID().slice(0, 8)}.example` });
      const { refreshPendingBrandColors } = await import('../../src/services/brandColorsService');
      vi.spyOn(console, 'error').mockImplementation(() => {});

      respondOnce(402, 'payment required');
      const summary = await refreshPendingBrandColors({ brandIds: [brandId] });

      expect(summary.stoppedReason).toBe('grant_exhausted');
      const [row] = await db.select().from(brandColors).where(eq(brandColors.brandId, brandId));
      // The brand got no answer, so it did not burn one of its bounded attempts.
      expect(row.attempts).toBe(0);
      expect(row.status).toBe('pending');
    }, 20000);

    it('a brand that has spent its attempts is no longer a candidate', async () => {
      const domain = `spent-${randomUUID().slice(0, 8)}.example`;
      const { MAX_ATTEMPTS, refreshPendingBrandColors } = await import(
        '../../src/services/brandColorsService'
      );
      const seeded = await seedBrand({ domain, status: 'pending', attempts: MAX_ATTEMPTS });

      const fetchSpy = vi.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;
      await refreshPendingBrandColors({ brandIds: [seeded.brandId] });

      expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes(domain))).toHaveLength(0);
    }, 20000);

    it('one pass never spends more than PER_RUN_LIMIT metered calls', async () => {
      const { PER_RUN_LIMIT, refreshPendingBrandColors } = await import(
        '../../src/services/brandColorsService'
      );
      const ids: string[] = [];
      for (let i = 0; i < PER_RUN_LIMIT + 3; i++) {
        ids.push((await seedBrand({ domain: `cap${i}-${randomUUID().slice(0, 8)}.example` })).brandId);
      }

      respondOnce(202, { msg: 'not found, looking up' });
      const summary = await refreshPendingBrandColors({ brandIds: ids });

      expect(summary.called).toBeLessThanOrEqual(PER_RUN_LIMIT);
    }, 40000);
  });
});

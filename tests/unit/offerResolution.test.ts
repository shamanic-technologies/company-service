import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * How a BRAND-scoped call resolves now that a brand can hold several offers.
 *
 * This is the back-compat contract: every existing consumer still asks per
 * brand, and must keep working. Three cases, and only one of them is a
 * judgement call we refuse to make.
 */

// A funnelable, thenable stand-in for drizzle's query builders: every builder
// method returns the same object, and awaiting it yields the next queued result.
// That covers `.from().where().orderBy()`, `.where().limit()`,
// `.values().onConflictDoNothing().returning()` and `.set().where().returning()`
// without each one needing its own shape.
const { queue, dbSpy } = vi.hoisted(() => {
  const queue: unknown[][] = [];
  function builder(): any {
    const self: any = {
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const next = queue.shift();
        if (next === undefined) {
          reject(new Error('the test queued no result for this query'));
          return;
        }
        resolve(next);
      },
    };
    for (const method of [
      'from', 'where', 'orderBy', 'limit', 'values', 'set',
      'onConflictDoNothing', 'onConflictDoUpdate', 'returning',
    ]) {
      self[method] = () => self;
    }
    return self;
  }
  const dbSpy = {
    select: vi.fn(() => builder()),
    insert: vi.fn(() => builder()),
    update: vi.fn(() => builder()),
    delete: vi.fn(() => builder()),
  };
  return { queue, dbSpy };
});

vi.mock('../../src/db', () => ({
  db: dbSpy,
  brandOffers: { id: 'o.id', orgId: 'o.orgId', brandId: 'o.brandId', name: 'o.name', createdAt: 'o.createdAt' },
  brandSalesFunnels: { id: 'f.id', orgId: 'f.orgId', brandId: 'f.brandId', offerId: 'f.offerId' },
  brandUserFields: { id: 'u.id', orgId: 'u.orgId', brandId: 'u.brandId', offerId: 'u.offerId' },
  brands: { id: 'b.id', name: 'b.name', domain: 'b.domain' },
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a, isNull: (a: unknown) => a, asc: (a: unknown) => a };
});

import {
  OfferNameTakenError,
  OfferNameUnavailableError,
  SeveralOffersError,
  offerScope,
  resolveOfferForWrite,
  resolveSoleOffer,
  requireValidOfferName,
} from '../../src/services/brandOffersService';
import { OfferNameError } from '../../src/lib/offer-name';

function offerRow(id: string, name: string) {
  return {
    id,
    orgId: 'org-1',
    brandId: 'brand-1',
    name,
    migratedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeEach(() => {
  queue.length = 0;
  vi.clearAllMocks();
});

describe('resolveSoleOffer — what a brand-scoped READ is about', () => {
  it('answers the one offer when there is exactly one', async () => {
    queue.push([offerRow('offer-1', 'Retainer')]);
    await expect(resolveSoleOffer('org-1', 'brand-1')).resolves.toBe('offer-1');
  });

  it('answers null when the brand has no offer, so the read stays exactly what it was', async () => {
    // `null` selects the rows no offer owns, which — scoped by org and brand —
    // is byte-for-byte the query these tables answered before offers existed.
    queue.push([]);
    await expect(resolveSoleOffer('org-1', 'brand-1')).resolves.toBeNull();
  });

  it('REFUSES rather than guessing when the brand sells several', async () => {
    queue.push([offerRow('offer-1', 'Self Serve'), offerRow('offer-2', 'Enterprise')]);
    await expect(resolveSoleOffer('org-1', 'brand-1')).rejects.toBeInstanceOf(SeveralOffersError);
  });

  it('names both offers and the routes to use, so the caller can act on the refusal', async () => {
    queue.push([offerRow('offer-1', 'Self Serve'), offerRow('offer-2', 'Enterprise')]);
    const error = await resolveSoleOffer('org-1', 'brand-1').catch((e) => e as SeveralOffersError);
    expect(error).toBeInstanceOf(SeveralOffersError);
    expect(error.message).toContain('Self Serve');
    expect(error.message).toContain('Enterprise');
    expect(error.message).toContain('/orgs/brands/{brandId}/offers/{offerId}');
    expect(error.offers.map((o: { offerId: string }) => o.offerId)).toEqual(['offer-1', 'offer-2']);
  });
});

describe('resolveOfferForWrite — what a brand-scoped WRITE is about', () => {
  it('uses the one offer when there is one, writing nothing new', async () => {
    queue.push([offerRow('offer-1', 'Retainer')]);
    await expect(resolveOfferForWrite('org-1', 'brand-1')).resolves.toBe('offer-1');
    expect(dbSpy.insert).not.toHaveBeenCalled();
  });

  it("creates the brand's FIRST offer when it has none, so onboarding keeps working unchanged", async () => {
    queue.push([]);                                            // no offers
    queue.push([{ name: 'Acme Widgets', domain: 'acme.com' }]); // the brand
    queue.push([offerRow('offer-new', 'Acme Widgets')]);        // the insert
    queue.push([]);                                            // adopt funnels
    queue.push([]);                                            // adopt user fields

    await expect(resolveOfferForWrite('org-1', 'brand-1')).resolves.toBe('offer-new');
    expect(dbSpy.insert).toHaveBeenCalledTimes(1);
  });

  it('ADOPTS the rows the migration has not reached onto that first offer', async () => {
    queue.push([]);
    queue.push([{ name: 'Acme', domain: 'acme.com' }]);
    queue.push([offerRow('offer-new', 'Acme')]);
    queue.push([{ id: 'f1' }, { id: 'f2' }]);
    queue.push([{ id: 'u1' }]);

    await resolveOfferForWrite('org-1', 'brand-1');
    // One update per re-scoped table: the brand's old economics cannot be left
    // stranded under `offer_id IS NULL` while new writes land beside them.
    expect(dbSpy.update).toHaveBeenCalledTimes(2);
  });

  it('REFUSES rather than guessing when the brand sells several', async () => {
    queue.push([offerRow('offer-1', 'Self Serve'), offerRow('offer-2', 'Enterprise')]);
    await expect(resolveOfferForWrite('org-1', 'brand-1')).rejects.toBeInstanceOf(SeveralOffersError);
    expect(dbSpy.insert).not.toHaveBeenCalled();
  });

  it('fails loud when the brand has no name and no domain, rather than coining one', async () => {
    queue.push([]);
    queue.push([{ name: null, domain: null }]);
    await expect(resolveOfferForWrite('org-1', 'brand-1')).rejects.toBeInstanceOf(
      OfferNameUnavailableError
    );
    expect(dbSpy.insert).not.toHaveBeenCalled();
  });

  it('re-resolves when a concurrent write won the race for the first offer', async () => {
    queue.push([]);                                       // no offers
    queue.push([{ name: 'Acme', domain: 'acme.com' }]);   // the brand
    queue.push([]);                                       // insert lost: no row back
    queue.push([offerRow('offer-theirs', 'Acme')]);       // re-resolve finds theirs

    await expect(resolveOfferForWrite('org-1', 'brand-1')).resolves.toBe('offer-theirs');
  });
});

describe('requireValidOfferName', () => {
  it('returns the canonical form', () => {
    expect(requireValidOfferName('  Self   Serve ')).toBe('Self Serve');
  });

  it('throws OfferNameError on a third word', () => {
    expect(() => requireValidOfferName('Self Serve Plan')).toThrow(OfferNameError);
  });

  it('throws OfferNameError past 20 characters', () => {
    expect(() => requireValidOfferName('Enterprisee Contracts')).toThrow(OfferNameError);
  });
});

describe('offerScope', () => {
  it('selects the rows no offer owns when the offer is null', () => {
    // The un-migrated shape: scoped by org and brand, this is exactly the query
    // these tables answered before offers existed.
    expect(offerScope('f.offerId' as never, null)).toBe('f.offerId');
  });

  it('selects one offer\'s rows otherwise', () => {
    expect(offerScope('f.offerId' as never, 'offer-1')).toEqual(['f.offerId', 'offer-1']);
  });
});

describe('OfferNameTakenError', () => {
  it('says the name is in use rather than suggesting we suffix a number onto it', () => {
    expect(new OfferNameTakenError('Retainer').message).toContain('already has an offer called');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  db,
  brands,
  orgBrands,
  brandOffers,
  brandSalesFunnels,
  brandSalesFunnelArrowRates,
} from '../../src/db';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { planArrowRatesBackfill } from '../../src/lib/funnel-arrow-rates-backfill-plan';
import {
  applyArrowRatesBackfill,
  readArrowRatesBackfillCandidates,
} from '../../src/services/funnelArrowRatesBackfillService';

/**
 * Every rate a brand has already stated is expressed as a rate for the funnel
 * ARROW it is about — without moving a figure.
 *
 * These pin the four properties that make the copy safe: what the brand stated
 * arrives at the arrow the catalogue says it prices, what it never stated stays
 * absent, an arrow the customer stated arrow-first is never overwritten, and a
 * second run changes nothing.
 */
describe('Arrow-rate backfill', () => {
  const orgId = randomUUID();

  const namedBrandId = randomUUID(); // named rates only
  const statedBrandId = randomUUID(); // a named rate AND an arrow stated by hand
  const silentBrandId = randomUUID(); // a declaration holding no number at all
  const noOfferBrandId = randomUUID(); // a declaration the offer migration missed

  const allBrandIds = [namedBrandId, statedBrandId, silentBrandId, noOfferBrandId];
  const offerOf = new Map<string, string>();

  const KEY = 'sales_meetings_from_conversation';
  const dom = (id: string) => `arrow-backfill-${id.slice(0, 8)}.com`;

  const arrowsOf = (brandId: string) =>
    db
      .select()
      .from(brandSalesFunnelArrowRates)
      .where(eq(brandSalesFunnelArrowRates.brandId, brandId));

  beforeAll(async () => {
    for (const brandId of allBrandIds) {
      await db
        .insert(brands)
        .values({ id: brandId, url: `https://${dom(brandId)}`, domain: dom(brandId), name: 'Arrow Backfill' });
      await db.insert(orgBrands).values({ orgId, brandId });
    }

    for (const brandId of [namedBrandId, statedBrandId, silentBrandId]) {
      const offerId = randomUUID();
      offerOf.set(brandId, offerId);
      await db.insert(brandOffers).values({ id: offerId, orgId, brandId, name: 'The offer' });
    }

    // Priced only through the named columns — the case the whole run is about.
    await db.insert(brandSalesFunnels).values({
      orgId,
      brandId: namedBrandId,
      offerId: offerOf.get(namedBrandId)!,
      funnelKey: KEY,
      replyToMeetingPct: 12,
      meetingToClosePct: 30.5,
      // The show-up leg is left blank: the brand never stated it.
    });

    // Named rates, plus an arrow this customer already stated by hand with a
    // DIFFERENT number. The stated arrow outranks the column and must survive.
    await db.insert(brandSalesFunnels).values({
      orgId,
      brandId: statedBrandId,
      offerId: offerOf.get(statedBrandId)!,
      funnelKey: KEY,
      replyToMeetingPct: 12,
      meetingToClosePct: 30,
    });
    await db.insert(brandSalesFunnelArrowRates).values({
      orgId,
      brandId: statedBrandId,
      offerId: offerOf.get(statedBrandId)!,
      funnelKey: KEY,
      fromStep: 'Positive reply',
      toStep: 'Meeting booked',
      ratePct: 19,
    });

    // A declaration holding no number at all.
    await db.insert(brandSalesFunnels).values({
      orgId,
      brandId: silentBrandId,
      offerId: offerOf.get(silentBrandId)!,
      funnelKey: KEY,
    });

    // A declaration the offer migration has not reached. An arrow needs an
    // offer, so this one is skipped rather than written under a guessed one.
    await db.insert(brandSalesFunnels).values({
      orgId,
      brandId: noOfferBrandId,
      offerId: null,
      funnelKey: KEY,
      replyToMeetingPct: 44,
    });
  });

  afterAll(async () => {
    await db
      .delete(brandSalesFunnelArrowRates)
      .where(inArray(brandSalesFunnelArrowRates.brandId, allBrandIds));
    await db.delete(brandSalesFunnels).where(inArray(brandSalesFunnels.brandId, allBrandIds));
    await db.delete(brandOffers).where(inArray(brandOffers.brandId, allBrandIds));
    await db.delete(orgBrands).where(inArray(orgBrands.brandId, allBrandIds));
    await db.delete(brands).where(inArray(brands.id, allBrandIds));
  });

  /** The run, exactly as the script performs it. */
  const run = async () => {
    const candidates = await readArrowRatesBackfillCandidates();
    const mine = candidates.filter((c) => allBrandIds.includes(c.brandId));
    const plan = planArrowRatesBackfill(mine);
    await applyArrowRatesBackfill(plan);
    return plan;
  };

  it('makes each stated named rate readable as the arrow it is about, and moves no figure', async () => {
    const plan = await run();

    const written = await arrowsOf(namedBrandId);
    expect(written).toHaveLength(2);
    expect(written.map((r) => [r.fromStep, r.toStep, r.ratePct]).sort()).toEqual(
      [
        ['Meeting attended', 'Paid client', 30.5],
        ['Positive reply', 'Meeting booked', 12],
      ].sort()
    );

    // The named columns are exactly where they were: nothing was restated.
    const [funnel] = await db
      .select()
      .from(brandSalesFunnels)
      .where(eq(brandSalesFunnels.brandId, namedBrandId));
    expect(funnel.replyToMeetingPct).toBe(12);
    expect(funnel.meetingToClosePct).toBe(30.5);
    expect(funnel.arrowRatesBackfilledAt).not.toBeNull();

    expect(plan.skipped.map((s) => s.reason).sort()).toEqual(['no_offer', 'nothing_stated']);
  });

  it('writes nothing for an arrow no brand has stated — no default, no zero', async () => {
    const written = await arrowsOf(namedBrandId);
    // The show-up leg was blank on the declaration and stays absent here.
    expect(written.some((r) => r.toStep === 'Meeting attended' && r.fromStep === 'Meeting booked')).toBe(false);

    // A declaration holding no number at all produced nothing whatsoever.
    expect(await arrowsOf(silentBrandId)).toEqual([]);
    // And neither did the one with no offer to hang an arrow off.
    expect(await arrowsOf(noOfferBrandId)).toEqual([]);
  });

  it('never overwrites an arrow the customer stated: precedence is unchanged', async () => {
    const written = await arrowsOf(statedBrandId);
    const stated = written.find((r) => r.fromStep === 'Positive reply' && r.toStep === 'Meeting booked');
    expect(stated!.ratePct).toBe(19); // what they said, not the column's 12
    expect(stated!.backfilledAt).toBeNull(); // and it is still their own statement

    // The arrow they had NOT stated is filled from its column, as normal.
    const filled = written.find((r) => r.fromStep === 'Meeting attended');
    expect(filled).toMatchObject({ ratePct: 30 });
    expect(filled!.backfilledAt).not.toBeNull();
  });

  it('a second run is a no-op', async () => {
    const before = await arrowsOf(namedBrandId);
    const plan = await run();

    expect(plan.rows).toEqual([]);
    expect(plan.declarations).toEqual([]);
    const after = await arrowsOf(namedBrandId);
    expect(after).toEqual(before);
  });

  it('what it wrote is identifiable, and undoing it leaves what the customer stated', async () => {
    const backfilled = await db
      .select()
      .from(brandSalesFunnelArrowRates)
      .where(
        and(
          inArray(brandSalesFunnelArrowRates.brandId, allBrandIds),
          eq(brandSalesFunnelArrowRates.funnelKey, KEY)
        )
      );
    const mineBackfilled = backfilled.filter((r) => r.backfilledAt !== null);
    expect(mineBackfilled).toHaveLength(3); // 2 for the named brand, 1 for the stated one

    // The undo, exactly as the script documents it.
    for (const row of mineBackfilled) {
      await db.delete(brandSalesFunnelArrowRates).where(eq(brandSalesFunnelArrowRates.id, row.id));
    }
    await db
      .update(brandSalesFunnels)
      .set({ arrowRatesBackfilledAt: null })
      .where(inArray(brandSalesFunnels.brandId, allBrandIds));

    // What the customer stated arrow-first is untouched by the undo.
    const left = await arrowsOf(statedBrandId);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ ratePct: 19, backfilledAt: null });

    // And a run afterwards writes the copy again, so the undo is not one-way.
    await run();
    expect(await arrowsOf(namedBrandId)).toHaveLength(2);
  });
});

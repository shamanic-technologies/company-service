import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from '../helpers/test-app';
import { db, brands, orgBrands, brandSalesFunnels } from '../../src/db';
import { inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/**
 * The sales funnels an ORG sells a brand through, and what each one is worth.
 *
 * Two properties carry the whole design and are what these tests pin:
 *   - a funnel switched OFF keeps its numbers, so switching it back on returns
 *     what the user entered rather than an empty form;
 *   - an org that has answered always keeps at least one funnel ON, which makes
 *     "answered, but sells through nothing" unreachable and leaves zero rows as
 *     the only way to say "never answered".
 *
 * Everything is per (org, brand): two orgs claiming the same domain configure it
 * independently and never read each other.
 */
describe('Sales Funnels Endpoints', () => {
  const app = createTestApp();

  const ownerOrgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID(); // claimed by BOTH orgs, has a website
  const noWebsiteBrandId = randomUUID(); // owner only, no url/domain
  const foreignBrandId = randomUUID(); // other org only
  const unknownBrandId = randomUUID(); // not in brands at all

  const dom = (id: string) => `funnels-${id.slice(0, 8)}.com`;
  const allBrandIds = [brandId, noWebsiteBrandId, foreignBrandId];

  beforeAll(async () => {
    await db.insert(brands).values([
      { id: brandId, url: `https://${dom(brandId)}`, domain: dom(brandId), name: 'Funnel Brand' },
      { id: noWebsiteBrandId, name: 'No Website Funnel Brand' },
      {
        id: foreignBrandId,
        url: `https://${dom(foreignBrandId)}`,
        domain: dom(foreignBrandId),
        name: 'Foreign Funnel Brand',
      },
    ]);
    await db.insert(orgBrands).values([
      { orgId: ownerOrgId, brandId },
      // The SAME brand, claimed by a second org: the case the scoping exists for.
      { orgId: otherOrgId, brandId },
      { orgId: ownerOrgId, brandId: noWebsiteBrandId },
      { orgId: otherOrgId, brandId: foreignBrandId },
    ]);
  });

  afterAll(async () => {
    // One statement per table whatever the brand count — a per-brand loop is
    // three round-trips per brand and blows the hook budget on a cold branch.
    await db.delete(brandSalesFunnels).where(inArray(brandSalesFunnels.brandId, allBrandIds));
    await db.delete(orgBrands).where(inArray(orgBrands.brandId, allBrandIds));
    await db.delete(brands).where(inArray(brands.id, allBrandIds));
  });

  const list = (id: string) => `/orgs/brands/${id}/sales-funnels`;
  const one = (id: string, key: string) => `/orgs/brands/${id}/sales-funnels/${key}`;

  it('starts with nothing — an empty list that means "never answered"', async () => {
    const res = await request(app).get(list(brandId)).set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ funnels: [] });
  });

  it('configures a funnel and reads it back, active by default', async () => {
    const put = await request(app)
      .put(one(brandId, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({
        rates: { visitToSignupPct: 30, signupToPaidClientPct: 12.5 },
        lifetimeRevenueUsd: 4200,
        destinationUrl: `https://${dom(brandId)}/pricing`,
      });

    expect(put.status).toBe(200);
    expect(put.body.funnel.funnelKey).toBe('website_purchases');
    // Configuring a funnel IS saying you sell through it.
    expect(put.body.funnel.active).toBe(true);
    expect(put.body.funnel.rates).toEqual({ visitToSignupPct: 30, signupToPaidClientPct: 12.5 });
    expect(put.body.funnel.lifetimeRevenueUsd).toBe(4200);
    expect(put.body.funnel.destinationUrl).toBe(`https://${dom(brandId)}/pricing`);
  });

  // The meeting show-up rate and the booking link exist on no other table.
  it('stores the meeting show-up rate and the booking link', async () => {
    const res = await request(app)
      .put(one(brandId, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId))
      .send({
        rates: { replyToMeetingPct: 40, meetingBookedToAttendedPct: 70, meetingToClosePct: 25 },
        lifetimeRevenueUsd: 18000,
        bookingUrl: 'https://cal.com/funnel-team/30min',
      });

    expect(res.status).toBe(200);
    expect(res.body.funnel.rates).toEqual({
      replyToMeetingPct: 40,
      meetingBookedToAttendedPct: 70,
      meetingToClosePct: 25,
    });
    expect(res.body.funnel.bookingUrl).toBe('https://cal.com/funnel-team/30min');
  });

  it('keeps two funnels of one brand priced independently', async () => {
    const res = await request(app).get(list(brandId)).set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(200);
    // Catalogue order, not insertion order.
    expect(res.body.funnels.map((f: any) => f.funnelKey)).toEqual(['sales_meetings_from_conversation', 'website_purchases']);
    const [meeting, signup] = res.body.funnels;
    expect(meeting.lifetimeRevenueUsd).toBe(18000);
    expect(signup.lifetimeRevenueUsd).toBe(4200);
    expect(meeting.rates).not.toHaveProperty('visitToSignupPct');
    expect(signup.rates).not.toHaveProperty('meetingBookedToAttendedPct');
  });

  it('writing one funnel leaves the other untouched', async () => {
    await request(app)
      .put(one(brandId, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ lifetimeRevenueUsd: 5000 });

    const res = await request(app).get(list(brandId)).set(getAuthHeaders(ownerOrgId));
    const byKey = Object.fromEntries(res.body.funnels.map((f: any) => [f.funnelKey, f]));
    expect(byKey.website_purchases.lifetimeRevenueUsd).toBe(5000);
    // Omitted here, so still exactly what the earlier write left.
    expect(byKey.website_purchases.rates.visitToSignupPct).toBe(30);
    expect(byKey.sales_meetings_from_conversation.lifetimeRevenueUsd).toBe(18000);
  });

  // ── Two orgs, one domain ───────────────────────────────────────────────────
  it("another org claiming the same brand sees none of the first org's funnels", async () => {
    const res = await request(app).get(list(brandId)).set(getAuthHeaders(otherOrgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ funnels: [] });
  });

  it('the two orgs configure the same brand without ever colliding', async () => {
    const put = await request(app)
      .put(one(brandId, 'website_purchases'))
      .set(getAuthHeaders(otherOrgId))
      .send({ lifetimeRevenueUsd: 99, rates: { visitToSignupPct: 1 } });
    expect(put.status).toBe(200);
    expect(put.body.funnel.lifetimeRevenueUsd).toBe(99);

    const mine = await request(app).get(list(brandId)).set(getAuthHeaders(ownerOrgId));
    const byKey = Object.fromEntries(mine.body.funnels.map((f: any) => [f.funnelKey, f]));
    // Untouched by the other org's write.
    expect(byKey.website_purchases.lifetimeRevenueUsd).toBe(5000);
    expect(byKey.website_purchases.rates.visitToSignupPct).toBe(30);
  });

  // ── Absence is absence ─────────────────────────────────────────────────────
  it('reports a rate the org never gave us as null, not zero', async () => {
    const res = await request(app)
      .put(one(brandId, 'form_magnet'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { visitToFormSubmissionPct: 8 } });

    expect(res.status).toBe(200);
    expect(res.body.funnel.rates).toEqual({
      visitToFormSubmissionPct: 8,
      formSubmissionToPaidClientPct: null,
    });
    expect(res.body.funnel.lifetimeRevenueUsd).toBeNull();
    expect(res.body.funnel.destinationUrl).toBeNull();
  });

  it('an explicit null takes a declared value back', async () => {
    const res = await request(app)
      .put(one(brandId, 'form_magnet'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { visitToFormSubmissionPct: null } });

    expect(res.status).toBe(200);
    expect(res.body.funnel.rates.visitToFormSubmissionPct).toBeNull();
  });

  it('configures a funnel with nothing priced yet', async () => {
    const res = await request(app)
      .put(one(brandId, 'sales_meetings_from_website'))
      .set(getAuthHeaders(ownerOrgId))
      .send({});

    expect(res.status).toBe(200);
    expect(Object.values(res.body.funnel.rates).every((v) => v === null)).toBe(true);
  });

  it('carries no goal — the key is the whole answer, and it tells the meeting funnels apart', () => {
    // The goal is retired because it could not do this: BOTH meeting funnels
    // said `meetingBooked`, so a consumer reading the goal could not price a
    // meeting won from a reply apart from one won on the website.
    return request(app)
      .get(list(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .then((res) => {
        const byKey = Object.fromEntries(res.body.funnels.map((f: any) => [f.funnelKey, f]));
        for (const funnel of res.body.funnels) {
          expect(funnel.goal).toBeUndefined();
          expect(funnel.currentGoal).toBeUndefined();
        }
        expect(byKey.sales_meetings_from_conversation.name).toBe('Sales Meeting from Conversation');
        expect(byKey.sales_meetings_from_website.name).toBe('Sales Meeting from Website');
        expect(byKey.sales_meetings_from_conversation.steps[0]).toBe('Positive reply');
        expect(byKey.sales_meetings_from_website.steps[0]).toBe('Website visit');
      });
  });

  it('accepts a pre-retirement funnel key on write and answers with the canonical one', async () => {
    // Yesterday's word keeps working, forever. That is what made the rename
    // safe to do without any consumer changing in lockstep.
    const res = await request(app)
      .put(one(brandId, 'reply_meeting'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { replyToMeetingPct: 21 } });

    expect(res.status).toBe(200);
    expect(res.body.funnel.funnelKey).toBe('sales_meetings_from_conversation');
    expect(res.body.funnel.rates.replyToMeetingPct).toBe(21);
  });

  // ── Switching off keeps the numbers ────────────────────────────────────────
  it('switching a funnel off keeps its numbers, and switching it back on returns them', async () => {
    const off = await request(app)
      .delete(one(brandId, 'sales_meetings_from_website'))
      .set(getAuthHeaders(ownerOrgId));
    expect(off.status).toBe(200);

    const byKeyOff = Object.fromEntries(off.body.funnels.map((f: any) => [f.funnelKey, f]));
    // Still listed, just off — the org read shows what it configured, active or not.
    expect(byKeyOff.sales_meetings_from_website.active).toBe(false);

    await request(app)
      .put(one(brandId, 'sales_meetings_from_website'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { meetingToClosePct: 33 }, lifetimeRevenueUsd: 7000 });
    await request(app).delete(one(brandId, 'sales_meetings_from_website')).set(getAuthHeaders(ownerOrgId));

    const back = await request(app)
      .put(one(brandId, 'sales_meetings_from_website'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ active: true });

    expect(back.status).toBe(200);
    expect(back.body.funnel.active).toBe(true);
    // The whole point: what the user typed is still there.
    expect(back.body.funnel.rates.meetingToClosePct).toBe(33);
    expect(back.body.funnel.lifetimeRevenueUsd).toBe(7000);

    await request(app).delete(one(brandId, 'sales_meetings_from_website')).set(getAuthHeaders(ownerOrgId));
  });

  it('switching off a funnel that is already off is a no-op, not an error', async () => {
    const res = await request(app)
      .delete(one(brandId, 'sales_meetings_from_website'))
      .set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.funnels.map((f: any) => [f.funnelKey, f]));
    expect(byKey.sales_meetings_from_website.active).toBe(false);
  });

  // ── The invariant ──────────────────────────────────────────────────────────
  it('refuses to switch off the LAST active funnel', async () => {
    const solo = randomUUID();
    await db.insert(brands).values({ id: solo, name: 'Solo Funnel Brand' });
    await db.insert(orgBrands).values({ orgId: ownerOrgId, brandId: solo });
    allBrandIds.push(solo);

    await request(app)
      .put(one(solo, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { replyToMeetingPct: 20 } });

    const res = await request(app)
      .delete(one(solo, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one funnel on/);

    // And the numbers are still there, untouched by the refusal.
    const after = await request(app).get(list(solo)).set(getAuthHeaders(ownerOrgId));
    expect(after.body.funnels[0].active).toBe(true);
    expect(after.body.funnels[0].rates.replyToMeetingPct).toBe(20);
  });

  it('refuses an empty set — an org that answered sells through something', async () => {
    const res = await request(app)
      .put(list(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ funnelKeys: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one funnel on/);
  });

  // ── Stating the whole set ──────────────────────────────────────────────────
  it('states the whole set: the named funnels on, the others off but kept', async () => {
    const res = await request(app)
      .put(list(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ funnelKeys: ['sales_meetings_from_conversation'] });

    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.funnels.map((f: any) => [f.funnelKey, f]));
    expect(byKey.sales_meetings_from_conversation.active).toBe(true);
    expect(byKey.website_purchases.active).toBe(false);
    // Off, but its numbers survived.
    expect(byKey.website_purchases.lifetimeRevenueUsd).toBe(5000);
  });

  it('restating a set keeps the economics of the funnels still in it', async () => {
    const res = await request(app)
      .put(list(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ funnelKeys: ['sales_meetings_from_conversation', 'website_purchases'] });

    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.funnels.map((f: any) => [f.funnelKey, f]));
    expect(byKey.website_purchases.active).toBe(true);
    expect(byKey.website_purchases.lifetimeRevenueUsd).toBe(5000);
    expect(byKey.sales_meetings_from_conversation.lifetimeRevenueUsd).toBe(18000);
  });

  it('rejects the whole set when one member cannot apply, writing nothing', async () => {
    const before = await request(app)
      .get(list(noWebsiteBrandId))
      .set(getAuthHeaders(ownerOrgId));

    const res = await request(app)
      .put(list(noWebsiteBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ funnelKeys: ['sales_meetings_from_conversation', 'website_purchases'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no website/);

    const after = await request(app)
      .get(list(noWebsiteBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(after.body).toEqual(before.body);
  });

  // ── Erasing, the one destructive path ──────────────────────────────────────
  //
  // Switching a funnel off stopped destroying anything, so "forget what I told
  // you about this funnel" had to stay reachable — deliberately, never as the
  // side effect of an ordinary deselect.
  it('erases a funnel outright, so redeclaring it starts from an empty form', async () => {
    const eraseBrand = randomUUID();
    await db.insert(brands).values({
      id: eraseBrand,
      url: `https://${dom(eraseBrand)}`,
      domain: dom(eraseBrand),
      name: 'Erase Funnel Brand',
    });
    await db.insert(orgBrands).values({ orgId: ownerOrgId, brandId: eraseBrand });
    allBrandIds.push(eraseBrand);

    await request(app)
      .put(one(eraseBrand, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { replyToMeetingPct: 40 }, lifetimeRevenueUsd: 9000 });
    await request(app)
      .put(one(eraseBrand, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { visitToSignupPct: 30 }, lifetimeRevenueUsd: 4200 });

    const erased = await request(app)
      .delete(one(eraseBrand, 'website_purchases'))
      .query({ erase: 'true' })
      .set(getAuthHeaders(ownerOrgId));

    expect(erased.status).toBe(200);
    // Gone entirely — not listed as inactive, the way a deselect leaves it.
    expect(erased.body.funnels.map((f: any) => f.funnelKey)).toEqual(['sales_meetings_from_conversation']);

    const back = await request(app)
      .put(one(eraseBrand, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({});
    expect(back.status).toBe(200);
    expect(back.body.funnel.lifetimeRevenueUsd).toBeNull();
    expect(back.body.funnel.rates.visitToSignupPct).toBeNull();
  });

  it('refuses an erase that would leave the org holding funnels with none active', async () => {
    const solo = randomUUID();
    // Needs a website: the second funnel here is a website-led one.
    await db.insert(brands).values({
      id: solo,
      url: `https://${dom(solo)}`,
      domain: dom(solo),
      name: 'Erase Invariant Brand',
    });
    await db.insert(orgBrands).values({ orgId: ownerOrgId, brandId: solo });
    allBrandIds.push(solo);

    await request(app)
      .put(one(solo, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { replyToMeetingPct: 20 } });
    await request(app)
      .put(one(solo, 'sales_meetings_from_website'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { meetingToClosePct: 25 } });
    await request(app).delete(one(solo, 'sales_meetings_from_website')).set(getAuthHeaders(ownerOrgId));

    // sales_meetings_from_conversation is the only active one, and an inactive row would survive it.
    const res = await request(app)
      .delete(one(solo, 'sales_meetings_from_conversation'))
      .query({ erase: 'true' })
      .set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one funnel on/);

    const after = await request(app).get(list(solo)).set(getAuthHeaders(ownerOrgId));
    expect(after.body.funnels).toHaveLength(2);
    expect(after.body.funnels.find((f: any) => f.funnelKey === 'sales_meetings_from_conversation').rates
      .replyToMeetingPct).toBe(20);
  });

  it('erasing the LAST remaining funnel is allowed, and says "never answered" again', async () => {
    const solo = randomUUID();
    await db.insert(brands).values({ id: solo, name: 'Erase Everything Brand' });
    await db.insert(orgBrands).values({ orgId: ownerOrgId, brandId: solo });
    allBrandIds.push(solo);

    await request(app)
      .put(one(solo, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { replyToMeetingPct: 20 } });

    const res = await request(app)
      .delete(one(solo, 'sales_meetings_from_conversation'))
      .query({ erase: 'true' })
      .set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ funnels: [] });
  });

  it('rejects an erase flag that is neither true nor false, changing nothing', async () => {
    const res = await request(app)
      .delete(one(brandId, 'website_purchases'))
      .query({ erase: 'yes' })
      .set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid "erase"/);

    const after = await request(app).get(list(brandId)).set(getAuthHeaders(ownerOrgId));
    const byKey = Object.fromEntries(after.body.funnels.map((f: any) => [f.funnelKey, f]));
    expect(byKey.website_purchases.active).toBe(true);
    expect(byKey.website_purchases.lifetimeRevenueUsd).toBe(5000);
  });

  // ── Validation ─────────────────────────────────────────────────────────────
  it('rejects a rate that is not a leg of this funnel', async () => {
    const res = await request(app)
      .put(one(brandId, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { replyToMeetingPct: 40 } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not price replyToMeetingPct/);
  });

  it('rejects a booking link on a funnel with no meeting', async () => {
    const res = await request(app)
      .put(one(brandId, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ bookingUrl: 'https://cal.com/x/30min' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no bookingUrl/);
  });

  it('rejects a page destination on a funnel that never lands a click on the site', async () => {
    const res = await request(app)
      .put(one(brandId, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ destinationUrl: `https://${dom(brandId)}/x` });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no destinationUrl/);
  });

  it("rejects a page destination off the brand's own domain", async () => {
    const res = await request(app)
      .put(one(brandId, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ destinationUrl: 'https://somewhere-else.com/pricing' });

    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range rate and an unknown funnel key', async () => {
    const bad = await request(app)
      .put(one(brandId, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { visitToSignupPct: 140 } });
    expect(bad.status).toBe(400);

    const unknown = await request(app)
      .put(one(brandId, 'visit_whatsapp'))
      .set(getAuthHeaders(ownerOrgId))
      .send({});
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/Unknown sales funnel/);
  });

  it('refuses a website-led funnel for a brand with no website', async () => {
    const res = await request(app)
      .put(one(noWebsiteBrandId, 'website_purchases'))
      .set(getAuthHeaders(ownerOrgId))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no website/);
  });

  it('lets a brand with no website use the reply-led funnel', async () => {
    const res = await request(app)
      .put(one(noWebsiteBrandId, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId))
      .send({ rates: { replyToMeetingPct: 35 } });

    expect(res.status).toBe(200);
    expect(res.body.funnel.rates.replyToMeetingPct).toBe(35);
  });

  // ── Auth ───────────────────────────────────────────────────────────────────
  it('rejects a malformed brand id', async () => {
    const res = await request(app).get(list('not-a-uuid')).set(getAuthHeaders(ownerOrgId));
    expect(res.status).toBe(400);
  });

  it("404s an unknown brand and 403s a brand the org does not claim", async () => {
    const unknown = await request(app).get(list(unknownBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(unknown.status).toBe(404);

    const foreign = await request(app).get(list(foreignBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(foreign.status).toBe(403);

    const foreignWrite = await request(app)
      .put(one(foreignBrandId, 'sales_meetings_from_conversation'))
      .set(getAuthHeaders(ownerOrgId))
      .send({});
    expect(foreignWrite.status).toBe(403);
  });

  // ── The internal read ──────────────────────────────────────────────────────
  it('serves only the ACTIVE funnels to a service caller, scoped by x-org-id', async () => {
    const res = await request(app)
      .get(`/internal/brands/${brandId}/sales-funnels`)
      .set({ ...getInternalAuthHeaders(), 'x-org-id': ownerOrgId });

    expect(res.status).toBe(200);
    const keys = res.body.funnels.map((f: any) => f.funnelKey);
    // form_magnet and sales_meetings_from_website were switched off by the set statement above.
    expect(keys).toEqual(['sales_meetings_from_conversation', 'website_purchases']);
    expect(res.body.funnels.every((f: any) => f.active)).toBe(true);
    // No goal on the service read either — one vocabulary, everywhere.
    expect(res.body.funnels.every((f: any) => f.goal === undefined)).toBe(true);
    // The list answers on its own — no separate flag saying the same thing.
    expect(res.body.declared).toBeUndefined();
  });

  it('refuses to guess when the brand is claimed by several orgs and no org is given', async () => {
    const res = await request(app)
      .get(`/internal/brands/${brandId}/sales-funnels`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ORG_REQUIRED');
  });

  it('resolves the org itself when only one claims the brand', async () => {
    const res = await request(app)
      .get(`/internal/brands/${noWebsiteBrandId}/sales-funnels`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.funnels.map((f: any) => f.funnelKey)).toEqual(['sales_meetings_from_conversation']);
  });

  it('answers a brand nobody claims with an empty set, not an error', async () => {
    const res = await request(app)
      .get(`/internal/brands/${unknownBrandId}/sales-funnels`)
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ funnels: [] });
  });

  // The retired `declared` flag said exactly what the list says. features-service
  // reads the list alone as of its v0.118.0, so nothing consumes the flag.
  it('answers with the list alone — the retired `declared` flag is gone', async () => {
    const answered = await request(app)
      .get(`/internal/brands/${noWebsiteBrandId}/sales-funnels`)
      .set(getInternalAuthHeaders());
    expect(answered.body.declared).toBeUndefined();
    expect(answered.body.funnels.length).toBeGreaterThan(0);

    const neverAnswered = await request(app)
      .get(`/internal/brands/${unknownBrandId}/sales-funnels`)
      .set(getInternalAuthHeaders());
    expect(neverAnswered.body.declared).toBeUndefined();
    expect(neverAnswered.body.funnels).toEqual([]);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from '../helpers/test-app';
import { db, brands, orgBrands, brandSalesEconomics } from '../../src/db';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/**
 * Brand-level sales conversion economics.
 * GET/PUT /orgs/brands/:brandId/sales-economics — org-ownership enforced.
 */
describe('Sales Economics Endpoints', () => {
  const app = createTestApp();

  const ownerOrgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID(); // owned by ownerOrgId
  const unsetBrandId = randomUUID(); // owned by ownerOrgId, never written
  const foreignBrandId = randomUUID(); // owned by otherOrgId
  const unknownBrandId = randomUUID(); // not in brands at all
  const bmBrandId = randomUUID(); // owned by ownerOrgId, business-model lifecycle
  const funnelBrandId = randomUUID(); // owned by ownerOrgId, funnel-fields lifecycle
  const funnelUnsetBrandId = randomUUID(); // owned by ownerOrgId, never written
  const defaultsBrandId = randomUUID(); // owned by ownerOrgId, row written WITHOUT the two sub-rates (DB defaults)
  const singleStepBrandId = randomUUID(); // owned by ownerOrgId, single-step goals + rates lifecycle
  const singleStepUnsetBrandId = randomUUID(); // owned by ownerOrgId, reads single-step rate defaults
  const formSubBrandId = randomUUID(); // owned by ownerOrgId, form_submissions goal + rates lifecycle
  const formSubUnsetBrandId = randomUUID(); // owned by ownerOrgId, reads null form-submission rates
  const combinedGoalBrandId = randomUUID(); // owned by ownerOrgId, combined-sales + website_purchase goal lifecycle
  const partialLtvBrandId = randomUUID(); // owned by ownerOrgId, single-field LTV patch
  const partialRateBrandId = randomUUID(); // owned by ownerOrgId, single-field conversion-rate patch
  const partialFullSetBrandId = randomUUID(); // owned by ownerOrgId, full-set write parity
  const partialUnsetBrandId = randomUUID(); // owned by ownerOrgId, patch against no stored row

  // visitToSignupPct 40 * signupToPaidClientPct 25 / 100 = 10 (derived visitToClosePct)
  const validMetrics = {
    lifetimeRevenueUsd: 4000,
    replyToMeetingPct: 30,
    visitToMeetingPct: 12,
    meetingToClosePct: 25,
    visitToSignupPct: 40,
    signupToPaidClientPct: 25,
  };

  // Every brand this suite owns. Kept as ONE list so setup/teardown stay in
  // lockstep as brands are added.
  const allBrandIds = [
    brandId, unsetBrandId, foreignBrandId, bmBrandId, funnelBrandId,
    funnelUnsetBrandId, defaultsBrandId, singleStepBrandId, singleStepUnsetBrandId,
    formSubBrandId, formSubUnsetBrandId, combinedGoalBrandId,
    partialLtvBrandId, partialRateBrandId, partialFullSetBrandId, partialUnsetBrandId,
  ];

  beforeAll(async () => {
    // Batched: one round trip each, not one per brand — the per-row loop grew
    // past the 10s hook budget as brands were added.
    await db.insert(brands).values(
      allBrandIds.map((id) => ({
        id,
        url: `https://sales-econ-${id.slice(0, 8)}.com`,
        domain: `sales-econ-${id.slice(0, 8)}.com`,
        name: 'Sales Econ Test Brand',
      }))
    );
    await db.insert(orgBrands).values(
      allBrandIds.map((id) => ({
        // foreignBrandId is the cross-org fixture — every other brand is the caller's.
        orgId: id === foreignBrandId ? otherOrgId : ownerOrgId,
        brandId: id,
      }))
    );
  });

  afterAll(async () => {
    await db.delete(brandSalesEconomics).where(inArray(brandSalesEconomics.brandId, allBrandIds));
    await db.delete(orgBrands).where(inArray(orgBrands.brandId, allBrandIds));
    await db.delete(brands).where(inArray(brands.id, allBrandIds));
  });

  const path = (id: string) => `/orgs/brands/${id}/sales-economics`;

  // AC2 — unset returns null, not an error
  it('GET an owned brand with nothing saved returns { salesEconomics: null }, 200', async () => {
    const res = await request(app).get(path(unsetBrandId)).set(getAuthHeaders(ownerOrgId));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ salesEconomics: null });
  });

  // AC1 — PUT then GET round-trips the exact values + derives visitToClosePct
  it('PUT metrics then GET returns exactly those values + derived visitToClosePct + updatedAt', async () => {
    const putRes = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics).toMatchObject(validMetrics);
    // derived = 40 * 25 / 100 = 10, never null, never sent on the request
    expect(putRes.body.salesEconomics.visitToClosePct).toBe(10);
    expect(typeof putRes.body.salesEconomics.updatedAt).toBe('string');

    const getRes = await request(app).get(path(brandId)).set(getAuthHeaders(ownerOrgId));

    expect(getRes.status).toBe(200);
    expect(getRes.body.salesEconomics).toMatchObject(validMetrics);
    expect(getRes.body.salesEconomics.visitToClosePct).toBe(10);
    expect(typeof getRes.body.salesEconomics.updatedAt).toBe('string');
  });

  // AC12 — WRITE response is non-null with updatedAt
  it('PUT response salesEconomics is non-null and carries updatedAt', async () => {
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(res.status).toBe(200);
    expect(res.body.salesEconomics).not.toBeNull();
    expect(res.body.salesEconomics).toHaveProperty('updatedAt');
  });

  // AC3 — idempotent
  it('PUT twice with the same body is idempotent (same end state)', async () => {
    const first = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);
    const second = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const strip = (b: any) => ({ ...b.salesEconomics, updatedAt: undefined });
    expect(strip(second.body)).toEqual(strip(first.body));

    const getRes = await request(app).get(path(brandId)).set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics).toMatchObject(validMetrics);
  });

  // AC4 — cross-org PUT rejected
  it('PUT for a brand owned by another org is rejected with 403', async () => {
    const res = await request(app)
      .put(path(foreignBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(res.status).toBe(403);

    // and nothing was written
    const rows = await db
      .select()
      .from(brandSalesEconomics)
      .where(eq(brandSalesEconomics.brandId, foreignBrandId));
    expect(rows.length).toBe(0);
  });

  // AC5 — cross-org GET rejected
  it('GET for a brand owned by another org is rejected with 403', async () => {
    const res = await request(app).get(path(foreignBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(res.status).toBe(403);
  });

  // AC6 — unknown brand is 404 (distinct from unset)
  it('GET an unknown brand returns 404', async () => {
    const res = await request(app).get(path(unknownBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(res.status).toBe(404);
  });

  it('PUT an unknown brand returns 404', async () => {
    const res = await request(app)
      .put(path(unknownBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);
    expect(res.status).toBe(404);
  });

  // AC7 — a metric omitted from a patch on an EXISTING brand is LEFT UNCHANGED.
  // It is no longer a 400: the all-or-nothing write is exactly what let a caller
  // holding a stale copy overwrite values it never meant to touch. The 400 now
  // applies only where there is nothing to leave unchanged (unset brand) — see
  // the partial-update block below.
  it('PUT omitting a metric on a brand that has a saved set leaves it unchanged', async () => {
    await request(app).put(path(brandId)).set(getAuthHeaders(ownerOrgId)).send(validMetrics);

    const { visitToSignupPct, ...incomplete } = validMetrics;
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(incomplete);

    expect(res.status).toBe(200);
    expect(res.body.salesEconomics.visitToSignupPct).toBe(validMetrics.visitToSignupPct);
  });

  it('PUT omitting signupToPaidClientPct on a saved brand leaves it unchanged', async () => {
    await request(app).put(path(brandId)).set(getAuthHeaders(ownerOrgId)).send(validMetrics);

    const { signupToPaidClientPct, ...incomplete } = validMetrics;
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(incomplete);

    expect(res.status).toBe(200);
    expect(res.body.salesEconomics.signupToPaidClientPct).toBe(
      validMetrics.signupToPaidClientPct
    );
  });

  // AC8 — out-of-range percentage fails loud
  it('PUT with a percentage > 100 returns 400', async () => {
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, replyToMeetingPct: 150 });
    expect(res.status).toBe(400);
  });

  // AC9 — decimal percentages are valid; only invalid types fail loud.
  it('PUT with fractional percentage values succeeds and preserves them', async () => {
    const fractionalMetrics = {
      ...validMetrics,
      replyToMeetingPct: 12.5,
      visitToSignupPct: 0.5,
      signupToPaidClientPct: 20,
    };
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(fractionalMetrics);

    expect(res.status).toBe(200);
    expect(res.body.salesEconomics).toMatchObject(fractionalMetrics);
    expect(res.body.salesEconomics.visitToClosePct).toBe(0.1);

    const getRes = await request(app).get(path(brandId)).set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics).toMatchObject(fractionalMetrics);
    expect(getRes.body.salesEconomics.visitToClosePct).toBe(0.1);
  });

  it('PUT with fractional lifetimeRevenueUsd still returns 400', async () => {
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, lifetimeRevenueUsd: 4000.5 });
    expect(res.status).toBe(400);
  });

  it('PUT with a string value (no coercion) returns 400', async () => {
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, lifetimeRevenueUsd: '4000' });
    expect(res.status).toBe(400);
  });

  // AC10 — malformed brand id
  it('GET with a non-UUID brand id returns 400', async () => {
    const res = await request(app).get(path('not-a-uuid')).set(getAuthHeaders(ownerOrgId));
    expect(res.status).toBe(400);
  });

  // AC11 — auth
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get(path(brandId));
    expect(res.status).toBe(401);
  });

  // ── businessModel (brand-level B2C/B2B) ──────────────────────────
  // Lifecycle runs IN ORDER on bmBrandId: fresh → set → preserve → clear.

  // Fresh brand: legacy 5-field PUT stores businessModel as null (never set)
  it('PUT 5 metrics with no businessModel on a fresh brand → businessModel null', async () => {
    const putRes = await request(app)
      .put(path(bmBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.businessModel).toBeNull();

    const getRes = await request(app).get(path(bmBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.businessModel).toBeNull();
  });

  // Set businessModel explicitly, round-trips through GET
  it('PUT with businessModel "b2b" → GET returns "b2b"', async () => {
    const putRes = await request(app)
      .put(path(bmBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, businessModel: 'b2b' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.businessModel).toBe('b2b');

    const getRes = await request(app).get(path(bmBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.businessModel).toBe('b2b');
  });

  // Back-compat: a 5-field PUT (no businessModel) must NOT wipe the stored value
  it('PUT 5 metrics with no businessModel preserves the stored "b2b"', async () => {
    const putRes = await request(app)
      .put(path(bmBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.businessModel).toBe('b2b');
  });

  // Explicit null clears it
  it('PUT with businessModel null clears it back to null', async () => {
    const putRes = await request(app)
      .put(path(bmBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, businessModel: null });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.businessModel).toBeNull();
  });

  // Invalid enum fails loud
  it('PUT with an unknown businessModel returns 400', async () => {
    const res = await request(app)
      .put(path(bmBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, businessModel: 'enterprise' });
    expect(res.status).toBe(400);
  });

  // ── funnelStages + the retired optimizationGoal ───────────────────
  //
  // A goal is still ACCEPTED on write, in every spelling, and it declares the
  // funnel(s) it meant. It is never READ BACK: what a brand sells through is
  // its declared funnel set, and that is the only vocabulary any read emits.
  // These assertions therefore say `toBeUndefined()` where they used to name a
  // token — that absence IS the retirement.
  // Lifecycle runs IN ORDER on funnelBrandId: set → preserve → clear-to-[].

  // AC2 — a brand that never set these reads [] + "sales" (server defaults)
  it('GET a brand that never set funnel fields → funnelStages [] and no goal on the wire', async () => {
    const putRes = await request(app)
      .put(path(funnelUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.funnelStages).toEqual([]);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();

    const getRes = await request(app)
      .get(path(funnelUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.funnelStages).toEqual([]);
    expect(getRes.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  // AC1 — PUT both fields then GET round-trips exactly
  it('PUT funnelStages + optimizationGoal → GET returns them exactly', async () => {
    const putRes = await request(app)
      .put(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({
        ...validMetrics,
        funnelStages: ['website_purchase', 'sales_meeting'],
        optimizationGoal: 'booked_meetings',
      });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.funnelStages).toEqual([
      'website_purchase',
      'sales_meeting',
    ]);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();

    const getRes = await request(app)
      .get(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.funnelStages).toEqual([
      'website_purchase',
      'sales_meeting',
    ]);
    expect(getRes.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  // AC3 — omitting both keys leaves prior values unchanged (idempotent)
  it('PUT 5 metrics with no funnel fields preserves stored funnelStages + optimizationGoal', async () => {
    const putRes = await request(app)
      .put(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.funnelStages).toEqual([
      'website_purchase',
      'sales_meeting',
    ]);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  // Sending [] explicitly clears funnelStages (distinct from omitting)
  it('PUT funnelStages [] sets it to empty (not unchanged)', async () => {
    const putRes = await request(app)
      .put(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, funnelStages: [] });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.funnelStages).toEqual([]);
    // optimizationGoal omitted → preserved
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  // AC4 — invalid funnelStages value fails loud, no write
  it('PUT with an unknown funnelStages value returns 400', async () => {
    const res = await request(app)
      .put(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, funnelStages: ['website_purchase', 'bogus_stage'] });
    expect(res.status).toBe(400);
  });

  // AC4 — funnelStages must be an array
  it('PUT with funnelStages as a non-array returns 400', async () => {
    const res = await request(app)
      .put(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, funnelStages: 'website_purchase' });
    expect(res.status).toBe(400);
  });

  // AC4 — invalid optimizationGoal fails loud
  it('PUT with an unknown optimizationGoal returns 400', async () => {
    const res = await request(app)
      .put(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, optimizationGoal: 'revenue' });
    expect(res.status).toBe(400);
  });

  // ── combined "Sales" goal + "website purchase" rename ────────────
  // The org GET/PUT accept the NEW combined-sales goal AND the renamed
  // website-purchase goal, backward-compatible with the legacy `sales` spelling,
  // with a hard guarantee the two never collide.

  const internalPath = (id: string) => `/internal/brands/${id}/sales-economics`;

  it('PUT combined_sales → GET round-trips it exactly (new combined goal)', async () => {
    const putRes = await request(app)
      .put(path(combinedGoalBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, optimizationGoal: 'combined_sales' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();

    const getRes = await request(app)
      .get(path(combinedGoalBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  it('PUT website_purchase → both reads answer websitePurchase', async () => {
    const putRes = await request(app)
      .put(path(combinedGoalBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, optimizationGoal: 'website_purchase' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();

    const orgGet = await request(app)
      .get(path(combinedGoalBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(orgGet.body.salesEconomics.optimizationGoal).toBeUndefined();

    // The internal (campaign-service) read answers the SAME token — one
    // vocabulary, so there is no per-entry-point collapse left.
    const internalGet = await request(app)
      .get(internalPath(combinedGoalBrandId))
      .set(getInternalAuthHeaders());
    expect(internalGet.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  it('PUT legacy sales spelling still accepted → website-purchase, never combined (backward-compat + no collision)', async () => {
    const putRes = await request(app)
      .put(path(combinedGoalBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, optimizationGoal: 'sales' });

    expect(putRes.status).toBe(200);
    // Stays website purchase, is NEVER reinterpreted as the combined goal.
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  // ── split self-serve close (visit→signup, signup→paid) ───────────

  // AC5 — funnelStages 'website_signup' (dropped) is rejected; valid values accepted
  it('PUT funnelStages "website_signup" (dropped) returns 400', async () => {
    const res = await request(app)
      .put(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, funnelStages: ['website_signup'] });
    expect(res.status).toBe(400);
  });

  it('PUT funnelStages [website_purchase, sales_meeting] is accepted', async () => {
    const res = await request(app)
      .put(path(funnelBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, funnelStages: ['website_purchase', 'sales_meeting'] });
    expect(res.status).toBe(200);
    expect(res.body.salesEconomics.funnelStages).toEqual(['website_purchase', 'sales_meeting']);
  });

  // AC2 — a legacy PUT still sending visitToClosePct does not corrupt state;
  // the two sub-rates are the source of truth, visitToClosePct is derived.
  it('PUT that also sends a legacy visitToClosePct ignores it (derives from sub-rates)', async () => {
    const res = await request(app)
      .put(path(brandId))
      .set(getAuthHeaders(ownerOrgId))
      // visitToClosePct: 99 is a stale legacy value; must be ignored
      .send({ ...validMetrics, visitToClosePct: 99 });

    expect(res.status).toBe(200);
    expect(res.body.salesEconomics.visitToSignupPct).toBe(40);
    expect(res.body.salesEconomics.signupToPaidClientPct).toBe(25);
    // derived from the sub-rates, NOT the 99 that was sent
    expect(res.body.salesEconomics.visitToClosePct).toBe(10);
  });

  // AC4 — fresh-brand defaults: a row inserted WITHOUT the two sub-rates reads
  // visitToSignupPct=25, signupToPaidClientPct=20 (DB defaults) → visitToClosePct=5.
  it('a row written without the sub-rates reads the 25/20 defaults → visitToClosePct 5', async () => {
    // Insert directly omitting visit_to_signup_pct + signup_to_paid_client_pct so
    // the DB column defaults apply. visit_to_close_pct is required (no default);
    // set it to a stale value to prove the response derives, not reads it.
    await db.insert(brandSalesEconomics).values({
      orgId: ownerOrgId,
      brandId: defaultsBrandId,
      lifetimeRevenueUsd: 1000,
      replyToMeetingPct: 10,
      visitToMeetingPct: 8,
      meetingToClosePct: 20,
      visitToClosePct: 77,
    } as any);

    const res = await request(app).get(path(defaultsBrandId)).set(getAuthHeaders(ownerOrgId));
    expect(res.status).toBe(200);
    expect(res.body.salesEconomics.visitToSignupPct).toBe(25);
    expect(res.body.salesEconomics.signupToPaidClientPct).toBe(20);
    // derived = 25 * 20 / 100 = 5, NOT the stale 77
    expect(res.body.salesEconomics.visitToClosePct).toBe(5);
  });

  // ── single-step goals (website_visits / positive_replies) + rates ──
  // Beta goals: a single conversion straight to a paid client, each with its own
  // single-step rate (visitToPaidClientPct / replyToPaidClientPct).

  // A brand that never set the single-step rates reads the server defaults 5 / 25.
  it('GET a brand that never set single-step rates → visitToPaidClientPct 5 + replyToPaidClientPct 25', async () => {
    const putRes = await request(app)
      .put(path(singleStepUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.visitToPaidClientPct).toBe(5);
    expect(putRes.body.salesEconomics.replyToPaidClientPct).toBe(25);

    const getRes = await request(app)
      .get(path(singleStepUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.visitToPaidClientPct).toBe(5);
    expect(getRes.body.salesEconomics.replyToPaidClientPct).toBe(25);
  });

  // PUT the website_visits goal + both single-step rates → GET round-trips exactly.
  it('PUT optimizationGoal "website_visits" + single-step rates → GET returns them', async () => {
    const putRes = await request(app)
      .put(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({
        ...validMetrics,
        optimizationGoal: 'website_visits',
        visitToPaidClientPct: 7.5,
        replyToPaidClientPct: 40,
      });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();
    expect(putRes.body.salesEconomics.visitToPaidClientPct).toBe(7.5);
    expect(putRes.body.salesEconomics.replyToPaidClientPct).toBe(40);

    const getRes = await request(app)
      .get(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.optimizationGoal).toBeUndefined();
    expect(getRes.body.salesEconomics.visitToPaidClientPct).toBe(7.5);
    expect(getRes.body.salesEconomics.replyToPaidClientPct).toBe(40);
  });

  // positive_replies goal round-trips too.
  it('PUT optimizationGoal "positive_replies" → GET returns it', async () => {
    const putRes = await request(app)
      .put(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, optimizationGoal: 'positive_replies' });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();

    const getRes = await request(app)
      .get(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  // `whatsappConversation` is the one retired goal that names no funnel — the
  // catalogue has no whatsapp funnel. It is refused rather than accepted into
  // silence, and the refusal must leave the metrics EXACTLY as they were: a
  // write that half-applies and then fails is worse than either outcome alone.
  it('PUT optimizationGoal "whatsapp_conversations" → 400, and nothing is written', async () => {
    const before = await request(app)
      .get(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId));

    const putRes = await request(app)
      .put(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, lifetimeRevenueUsd: 987654, optimizationGoal: 'whatsapp_conversations' });

    expect(putRes.status).toBe(400);
    expect(putRes.body.error).toMatch(/names no sales funnel/);

    const after = await request(app)
      .get(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(after.body.salesEconomics.lifetimeRevenueUsd).toBe(
      before.body.salesEconomics.lifetimeRevenueUsd
    );
    expect(after.body.salesEconomics.lifetimeRevenueUsd).not.toBe(987654);
  });

  // Omitting the single-step rates leaves prior values unchanged (partial update).
  it('PUT 5 metrics with no single-step rates preserves the stored 7.5 / 40', async () => {
    const putRes = await request(app)
      .put(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.visitToPaidClientPct).toBe(7.5);
    expect(putRes.body.salesEconomics.replyToPaidClientPct).toBe(40);
  });

  // Out-of-range single-step rate fails loud.
  it('PUT with visitToPaidClientPct > 100 returns 400', async () => {
    const res = await request(app)
      .put(path(singleStepBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, visitToPaidClientPct: 150 });
    expect(res.status).toBe(400);
  });

  // ── form_submissions goal (visit→form submission→paid) + two-step rates ──
  // Mid-funnel micro-conversion, structurally identical to signups. Carries its
  // own visitToFormSubmissionPct / formSubmissionToPaidClientPct pair. Maps to the
  // signup runtime goal — the org read round-trips the wire value.

  // A brand that never set the form-submission rates reads the server defaults
  // (25 / 20) — NOT NULL columns mirroring the single-step rates, so a
  // form_submissions-goal brand always serves real numbers (features-service
  // fails loud on null).
  it('GET a brand that never set form-submission rates → server defaults 25 / 20', async () => {
    const putRes = await request(app)
      .put(path(formSubUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.visitToFormSubmissionPct).toBe(25);
    expect(putRes.body.salesEconomics.formSubmissionToPaidClientPct).toBe(20);

    const getRes = await request(app)
      .get(path(formSubUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.visitToFormSubmissionPct).toBe(25);
    expect(getRes.body.salesEconomics.formSubmissionToPaidClientPct).toBe(20);
  });

  // AC1 — PUT form_submissions + both rates → GET round-trips the goal + rates exactly.
  it('PUT optimizationGoal "form_submissions" + two-step rates → GET returns them', async () => {
    const putRes = await request(app)
      .put(path(formSubBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({
        ...validMetrics,
        optimizationGoal: 'form_submissions',
        visitToFormSubmissionPct: 8.5,
        formSubmissionToPaidClientPct: 30,
      });

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();
    expect(putRes.body.salesEconomics.visitToFormSubmissionPct).toBe(8.5);
    expect(putRes.body.salesEconomics.formSubmissionToPaidClientPct).toBe(30);

    const getRes = await request(app)
      .get(path(formSubBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(getRes.body.salesEconomics.optimizationGoal).toBeUndefined();
    expect(getRes.body.salesEconomics.visitToFormSubmissionPct).toBe(8.5);
    expect(getRes.body.salesEconomics.formSubmissionToPaidClientPct).toBe(30);
  });

  // AC — omitting the goal + rates on a follow-up PUT preserves form_submissions + rates
  // (the leave-unchanged contract must not silently collapse it back to signups).
  it('PUT 5 metrics with no goal preserves stored form_submissions + rates', async () => {
    const putRes = await request(app)
      .put(path(formSubBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);

    expect(putRes.status).toBe(200);
    expect(putRes.body.salesEconomics.optimizationGoal).toBeUndefined();
    expect(putRes.body.salesEconomics.visitToFormSubmissionPct).toBe(8.5);
    expect(putRes.body.salesEconomics.formSubmissionToPaidClientPct).toBe(30);
  });

  // Out-of-range form-submission rate fails loud.
  it('PUT with formSubmissionToPaidClientPct > 100 returns 400', async () => {
    const res = await request(app)
      .put(path(formSubBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, formSubmissionToPaidClientPct: 150 });
    expect(res.status).toBe(400);
  });

  // AC — an unknown optimizationGoal still 400s (enum unchanged apart from the add).
  it('PUT with an unknown optimizationGoal still returns 400', async () => {
    const res = await request(app)
      .put(path(formSubBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, optimizationGoal: 'form_submission' }); // singular, not the enum value
    expect(res.status).toBe(400);
  });

  // ============================================================
  // PARTIAL UPDATE — a caller may send a subset; anything it does NOT send is
  // left unchanged. All-or-nothing writes are what let a screen holding a stale
  // in-memory copy silently overwrite rates the user had just confirmed
  // (prod incident 2026-07-29, brand 7604c385: visitToSignupPct 8.4 -> 5 and
  // signupToPaidClientPct 16.2 -> 10, neither of them touched by the user).
  // ============================================================

  // AC1 — update ONLY the lifetime revenue; every other stored metric survives.
  it('PUT with only lifetimeRevenueUsd changes it and leaves every other metric unchanged', async () => {
    const seed = {
      ...validMetrics,
      lifetimeRevenueUsd: 9000,
      visitToSignupPct: 8.4,
      signupToPaidClientPct: 16.2,
      visitToPaidClientPct: 3.5,
      replyToPaidClientPct: 12,
      visitToFormSubmissionPct: 18,
      formSubmissionToPaidClientPct: 22,
      businessModel: 'b2b',
      funnelStages: ['sales_meeting'],
    };
    const seeded = await request(app)
      .put(path(partialLtvBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(seed);
    expect(seeded.status).toBe(200);

    const patched = await request(app)
      .put(path(partialLtvBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ lifetimeRevenueUsd: 12345 });

    expect(patched.status).toBe(200);
    expect(patched.body.salesEconomics.lifetimeRevenueUsd).toBe(12345);

    const after = await request(app)
      .get(path(partialLtvBrandId))
      .set(getAuthHeaders(ownerOrgId));
    const before = seeded.body.salesEconomics;
    expect(after.body.salesEconomics).toEqual({
      ...before,
      lifetimeRevenueUsd: 12345,
      updatedAt: after.body.salesEconomics.updatedAt,
    });
  });

  // AC2 — update ONLY one conversion rate; the sibling rate is untouched and the
  // derived visitToClosePct follows the pair actually stored.
  it('PUT with only visitToSignupPct leaves signupToPaidClientPct unchanged and re-derives visitToClosePct', async () => {
    const seeded = await request(app)
      .put(path(partialRateBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, visitToSignupPct: 8.4, signupToPaidClientPct: 16.2 });
    expect(seeded.status).toBe(200);
    // 8.4 * 16.2 / 100 = 1.3608
    expect(seeded.body.salesEconomics.visitToClosePct).toBeCloseTo(1.3608, 4);

    const patched = await request(app)
      .put(path(partialRateBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ visitToSignupPct: 10 });

    expect(patched.status).toBe(200);
    expect(patched.body.salesEconomics.visitToSignupPct).toBe(10);
    // the rate the caller never sent keeps its confirmed value
    expect(patched.body.salesEconomics.signupToPaidClientPct).toBeCloseTo(16.2, 4);
    // derived from the MERGED pair: 10 * 16.2 / 100 = 1.62
    expect(patched.body.salesEconomics.visitToClosePct).toBeCloseTo(1.62, 4);

    const after = await request(app)
      .get(path(partialRateBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(after.body.salesEconomics.signupToPaidClientPct).toBeCloseTo(16.2, 4);
    expect(after.body.salesEconomics.visitToClosePct).toBeCloseTo(1.62, 4);
  });

  // AC2 (mirror) — patching a NON-core optional rate still leaves the core alone.
  it('PUT with only replyToPaidClientPct leaves the core metrics unchanged', async () => {
    const seeded = await request(app)
      .put(path(partialRateBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...validMetrics, replyToPaidClientPct: 12 });
    expect(seeded.status).toBe(200);

    const patched = await request(app)
      .put(path(partialRateBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ replyToPaidClientPct: 31 });

    expect(patched.status).toBe(200);
    expect(patched.body.salesEconomics.replyToPaidClientPct).toBe(31);
    expect(patched.body.salesEconomics).toMatchObject(validMetrics);
  });

  // AC3 — a full-set write behaves exactly as before, derived value included.
  it('PUT with the full set writes every field and derives visitToClosePct as before', async () => {
    const full = {
      ...validMetrics,
      lifetimeRevenueUsd: 7500,
      visitToSignupPct: 40,
      signupToPaidClientPct: 25,
    };
    const first = await request(app)
      .put(path(partialFullSetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(full);

    expect(first.status).toBe(200);
    expect(first.body.salesEconomics).toMatchObject(full);
    expect(first.body.salesEconomics.visitToClosePct).toBe(10); // 40 * 25 / 100

    // A second identical full-set write is still idempotent.
    const second = await request(app)
      .put(path(partialFullSetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(full);
    const strip = (b: any) => ({ ...b.salesEconomics, updatedAt: undefined });
    expect(strip(second.body)).toEqual(strip(first.body));

    // A full set OVERWRITES a previously patched value — no leave-unchanged
    // surprise for callers that do send everything.
    const overwritten = await request(app)
      .put(path(partialFullSetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...full, lifetimeRevenueUsd: 100 });
    expect(overwritten.body.salesEconomics.lifetimeRevenueUsd).toBe(100);
  });

  // AC4 — a brand with NOTHING stored has nothing to leave unchanged: a partial
  // payload fails loud rather than inventing a default or a cross-brand average.
  it('PUT a partial payload on a brand with no stored economics returns 400 naming the missing metrics', async () => {
    const res = await request(app)
      .put(path(partialUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ lifetimeRevenueUsd: 5000 });

    expect(res.status).toBe(400);
    expect(res.body.missing).toEqual(
      expect.arrayContaining([
        'replyToMeetingPct',
        'visitToMeetingPct',
        'meetingToClosePct',
        'visitToSignupPct',
        'signupToPaidClientPct',
      ])
    );
    expect(res.body.missing).not.toContain('lifetimeRevenueUsd');

    // Nothing was written — the brand is still unset, no invented row.
    const after = await request(app)
      .get(path(partialUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(after.body).toEqual({ salesEconomics: null });
  });

  // AC4 — the same brand accepts the full set, then accepts patches.
  it('PUT the full set on a previously unset brand creates it, then a partial patch works', async () => {
    const created = await request(app)
      .put(path(partialUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send(validMetrics);
    expect(created.status).toBe(200);
    expect(created.body.salesEconomics).toMatchObject(validMetrics);

    const patched = await request(app)
      .put(path(partialUnsetBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ meetingToClosePct: 42 });
    expect(patched.status).toBe(200);
    expect(patched.body.salesEconomics.meetingToClosePct).toBe(42);
    expect(patched.body.salesEconomics.lifetimeRevenueUsd).toBe(
      validMetrics.lifetimeRevenueUsd
    );
  });

  // Validation of a field that IS sent is unchanged by the partial contract.
  it('PUT a partial payload with an out-of-range percentage still returns 400', async () => {
    const res = await request(app)
      .put(path(partialLtvBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ replyToMeetingPct: 150 });
    expect(res.status).toBe(400);
  });

  it('PUT a partial payload with a string value (no coercion) still returns 400', async () => {
    const res = await request(app)
      .put(path(partialLtvBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ lifetimeRevenueUsd: '4000' });
    expect(res.status).toBe(400);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from '../helpers/test-app';
import {
  db,
  brands,
  orgBrands,
  brandSalesEconomics,
  brandUserFields,
} from '../../src/db';
import { salesEconomicsService } from '../../src/services/salesEconomicsService';

describe('Brand runtime context and current goal', () => {
  const app = createTestApp();

  const ownerOrgId = randomUUID();
  const otherOrgId = randomUUID();
  const defaultGoalBrandId = randomUUID();
  const runtimeBrandId = randomUUID();
  const foreignBrandId = randomUUID();

  const runtimePath = (brandId: string) => `/internal/brands/${brandId}/runtime-context`;
  const currentGoalPath = (brandId: string) => `/orgs/brands/${brandId}/current-goal`;
  const salesEconomicsPath = (brandId: string) => `/orgs/brands/${brandId}/sales-economics`;

  const metrics = {
    lifetimeRevenueUsd: 5000,
    replyToMeetingPct: 10,
    visitToMeetingPct: 5,
    meetingToClosePct: 30,
    visitToSignupPct: 25,
    signupToPaidClientPct: 20,
  };

  beforeAll(async () => {
    for (const id of [defaultGoalBrandId, runtimeBrandId, foreignBrandId]) {
      await db.insert(brands).values({
        id,
        url: `https://runtime-${id.slice(0, 8)}.com`,
        domain: `runtime-${id.slice(0, 8)}.com`,
        name: 'Runtime Test Brand',
        logoUrl: `https://img.logo.dev/runtime-${id.slice(0, 8)}.com`,
      });
    }

    await db.insert(orgBrands).values({ orgId: ownerOrgId, brandId: defaultGoalBrandId });
    await db.insert(orgBrands).values({ orgId: ownerOrgId, brandId: runtimeBrandId });
    await db.insert(orgBrands).values({ orgId: otherOrgId, brandId: foreignBrandId });

    await db.insert(brandUserFields).values({
      orgId: ownerOrgId,
      brandId: runtimeBrandId,
      fieldKey: 'dreamOutcome',
      value: 'Books qualified meetings',
    });

    await salesEconomicsService.upsertByBrandId(ownerOrgId, runtimeBrandId, {
      ...metrics,
      optimizationGoal: 'sales',
    });
  });

  afterAll(async () => {
    for (const id of [defaultGoalBrandId, runtimeBrandId, foreignBrandId]) {
      await db.delete(brandUserFields).where(eq(brandUserFields.brandId, id));
      await db.delete(brandSalesEconomics).where(eq(brandSalesEconomics.brandId, id));
      await db.delete(orgBrands).where(eq(orgBrands.brandId, id));
      await db.delete(brands).where(eq(brands.id, id));
    }
  });

  it('returns a service-auth runtime snapshot with the default current goal', async () => {
    const res = await request(app)
      .get(runtimePath(defaultGoalBrandId))
      .set(getInternalAuthHeaders());

    expect(res.status).toBe(200);
    expect(res.body.currentGoal).toBe('websitePurchase');
    expect(res.body.brand).toMatchObject({
      id: defaultGoalBrandId,
      domain: `runtime-${defaultGoalBrandId.slice(0, 8)}.com`,
      name: 'Runtime Test Brand',
    });
    // Backward-compatible shape: id/version null, fields present, createdAt ISO.
    expect(res.body.brandProfile).toMatchObject({
      id: null,
      brandId: defaultGoalBrandId,
      version: null,
      fields: {},
    });
    expect(typeof res.body.brandProfile.createdAt).toBe('string');
  });

  it('a goal sent to the retired route declares the funnel it meant, and answers with it', async () => {
    const update = await request(app)
      .put(currentGoalPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ currentGoal: 'meetingBooked' });

    expect(update.status).toBe(200);
    // The answer is a FUNNEL. No brand with a click destination here, so the
    // meetings come from the conversation — the distinction the goal could not make.
    expect(update.body.funnels.map((f: any) => f.funnelKey)).toContain(
      'sales_meetings_from_conversation'
    );
    expect(update.body.currentGoal).toBeUndefined();

    const runtime = await request(app)
      .get(runtimePath(runtimeBrandId))
      .set(getInternalAuthHeaders());

    expect(runtime.status).toBe(200);
    expect(runtime.body.currentGoal).toBe('meetingBooked');
    expect(runtime.body.brandProfile).toMatchObject({
      id: null,
      brandId: runtimeBrandId,
      version: null,
      fields: { dreamOutcome: 'Books qualified meetings' },
    });

    const legacyRead = await request(app)
      .get(salesEconomicsPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId));

    expect(legacyRead.status).toBe(200);
    // The economics read carries no goal: it is retired everywhere but the
    // runtime-context read, which campaign-service's scheduler still boots on.
    expect(legacyRead.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  it('a goal sent to the economics route also declares the funnel it meant', async () => {
    const update = await request(app)
      .put(salesEconomicsPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...metrics, optimizationGoal: 'signups' });

    expect(update.status).toBe(200);
    expect(update.body.salesEconomics.optimizationGoal).toBeUndefined();

    const runtime = await request(app)
      .get(runtimePath(runtimeBrandId))
      .set(getInternalAuthHeaders());

    expect(runtime.status).toBe(200);
    expect(runtime.body.currentGoal).toBe('signup');

    const funnels = await request(app)
      .get(`/orgs/brands/${runtimeBrandId}/sales-funnels`)
      .set(getAuthHeaders(ownerOrgId));
    expect(funnels.body.funnels.map((f: any) => f.funnelKey)).toContain('website_purchases');
  });

  it('maps the single-step optimizationGoal "website_visits" into currentGoal "websiteVisit"', async () => {
    const update = await request(app)
      .put(salesEconomicsPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ ...metrics, optimizationGoal: 'website_visits' });

    expect(update.status).toBe(200);
    expect(update.body.salesEconomics.optimizationGoal).toBeUndefined();

    const runtime = await request(app)
      .get(runtimePath(runtimeBrandId))
      .set(getInternalAuthHeaders());

    expect(runtime.status).toBe(200);
    expect(runtime.body.currentGoal).toBe('websiteVisit');
  });

  it('accepts currentGoal "positiveReply" and declares the conversation funnel', async () => {
    const update = await request(app)
      .put(currentGoalPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ currentGoal: 'positiveReply' });
    expect(update.status).toBe(200);
    expect(update.body.funnels.map((f: any) => f.funnelKey)).toContain(
      'sales_meetings_from_conversation'
    );

    const legacyRead = await request(app)
      .get(salesEconomicsPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId));
    expect(legacyRead.status).toBe(200);
    expect(legacyRead.body.salesEconomics.optimizationGoal).toBeUndefined();
  });

  it('rejects a goal that names no funnel rather than declaring nothing', async () => {
    // `whatsappConversation` is the one retired goal the catalogue has no funnel
    // for. A 200 would tell the caller the brand now sells through something.
    const update = await request(app)
      .put(currentGoalPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ currentGoal: 'whatsapp_conversations' });
    expect(update.status).toBe(400);
    expect(update.body.error).toMatch(/names no sales funnel/);
  });

  // A caller sending yesterday's word must keep working forever — including the
  // pre-rename `purchase`, which this very route used to be the only acceptor of.
  it.each([
    ['purchase', 'website_purchases'],
    ['sales', 'website_purchases'],
    ['website_purchase', 'website_purchases'],
    ['booked_meetings', 'sales_meetings_from_conversation'],
    ['sales_meetings', 'sales_meetings_from_conversation'],
    ['form_submissions', 'form_magnet'],
    ['combined_sales', 'website_purchases'],
  ])('accepts the legacy goal "%s" and declares "%s"', async (sent, expectedFunnel) => {
    const update = await request(app)
      .put(currentGoalPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ currentGoal: sent });
    expect(update.status).toBe(200);
    expect(update.body.funnels.map((f: any) => f.funnelKey)).toContain(expectedFunnel);
    // The answer is a funnel set, never a goal.
    expect(update.body.currentGoal).toBeUndefined();
  });

  it('declares BOTH funnels for the combined goal, rather than picking one', async () => {
    const update = await request(app)
      .put(currentGoalPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ currentGoal: 'combined_sales' });

    expect(update.status).toBe(200);
    const keys = update.body.funnels
      .filter((f: any) => f.active)
      .map((f: any) => f.funnelKey);
    expect(keys).toContain('sales_meetings_from_conversation');
    expect(keys).toContain('website_purchases');
  });

  it('enforces org ownership and request validation on current-goal updates', async () => {
    const foreign = await request(app)
      .put(currentGoalPath(foreignBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ currentGoal: 'meetingBooked' });
    expect(foreign.status).toBe(403);

    const invalid = await request(app)
      .put(currentGoalPath(runtimeBrandId))
      .set(getAuthHeaders(ownerOrgId))
      .send({ currentGoal: 'costPerRecipientPositiveReplyCents' });
    expect(invalid.status).toBe(400);
  });

  it('requires service auth and validates ids on the runtime consumer path', async () => {
    const unauthenticated = await request(app).get(runtimePath(runtimeBrandId));
    expect([401, 403]).toContain(unauthenticated.status);

    const badUuid = await request(app)
      .get(runtimePath('not-a-uuid'))
      .set(getInternalAuthHeaders());
    expect(badUuid.status).toBe(400);

    const unknown = await request(app)
      .get(runtimePath(randomUUID()))
      .set(getInternalAuthHeaders());
    expect(unknown.status).toBe(404);
  });
});

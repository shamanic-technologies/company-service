import express from 'express';
import fs from 'fs';
import path from 'path';
import { apiKeyAuth, requireOrgId } from '../../src/middleware/auth';

// Import routes — mixed files export { orgRouter, internalRouter }
import { orgRouter as brandsOrgRoutes, internalRouter as brandsInternalRoutes, publicRouter as brandsPublicRoutes } from '../../src/routes/brands.routes';
import { orgRouter as extractFieldsOrgRoutes, internalRouter as extractFieldsInternalRoutes } from '../../src/routes/extract-fields.routes';
import { orgRouter as extractImagesOrgRoutes, internalRouter as extractImagesInternalRoutes } from '../../src/routes/extract-images.routes';
import { orgRouter as publicInfoOrgRoutes, internalRouter as publicInfoInternalRoutes } from '../../src/routes/public-information.routes';
import { orgRouter as transferOrgRoutes, internalRouter as transferInternalRoutes } from '../../src/routes/transfer.routes';
import { orgRouter as salesEconomicsOrgRoutes, internalRouter as salesEconomicsInternalRoutes } from '../../src/routes/sales-economics.routes';
import { orgRouter as salesFunnelsOrgRoutes, internalRouter as salesFunnelsInternalRoutes } from '../../src/routes/sales-funnels.routes';
import { orgRouter as icpOrgRoutes } from '../../src/routes/icp.routes';
import { orgRouter as userFieldsOrgRoutes } from '../../src/routes/user-fields.routes';
import { orgRouter as brandGoalOrgRoutes, internalRouter as brandGoalInternalRoutes } from '../../src/routes/brand-goal.routes';
import { orgRouter as clickDestinationOrgRoutes } from '../../src/routes/click-destination.routes';
import { orgRouter as whatsAppLinkOrgRoutes } from '../../src/routes/whatsapp-link.routes';
import { orgRouter as salesRepPhoneOrgRoutes } from '../../src/routes/sales-rep-phone.routes';
import { orgRouter as businessContextOrgRoutes } from '../../src/routes/business-context.routes';
import { orgRouter as shareTokenOrgRoutes, internalRouter as shareTokenInternalRoutes } from '../../src/routes/share-token.routes';
import { orgRouter as offersOrgRoutes, internalRouter as offersInternalRoutes } from '../../src/routes/offers.routes';

// Import routes — single-tier files
import organizationRoutes from '../../src/routes/organization.routes';
import mediaAssetsRoutes from '../../src/routes/media-assets.routes';
import analyzeRoutes from '../../src/routes/analyze.routes';
import intakeFormRoutes from '../../src/routes/intake-form.routes';

/**
 * Create a test Express app instance
 */
export function createTestApp() {
  const app = express();

  app.use(express.json({ limit: '2mb' }));

  // ── Public routes (no auth) ──────────────────────────────────
  app.get('/', (req, res) => {
    res.send('Brand Service API');
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'brand-service' });
  });

  app.get('/openapi.json', (req, res) => {
    const specPath = path.resolve(__dirname, '../../openapi.json');
    if (!fs.existsSync(specPath)) {
      return res.status(404).json({ error: 'OpenAPI spec not generated yet. Run pnpm generate:openapi' });
    }
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
    res.json(spec);
  });

  // ── Public brand-info routes (no auth) ───────────────────────
  app.use('/public', brandsPublicRoutes);

  // ── Internal routes (API key only) ───────────────────────────
  app.use('/internal', apiKeyAuth, brandsInternalRoutes);
  app.use('/internal', apiKeyAuth, extractFieldsInternalRoutes);
  app.use('/internal', apiKeyAuth, extractImagesInternalRoutes);
  app.use('/internal', apiKeyAuth, publicInfoInternalRoutes);
  app.use('/internal', apiKeyAuth, transferInternalRoutes);
  app.use('/internal', apiKeyAuth, organizationRoutes);
  app.use('/internal/media-assets', apiKeyAuth, mediaAssetsRoutes);
  app.use('/internal', apiKeyAuth, intakeFormRoutes);
  app.use('/internal', apiKeyAuth, salesEconomicsInternalRoutes);
app.use('/internal', apiKeyAuth, salesFunnelsInternalRoutes);
  app.use('/internal', apiKeyAuth, brandGoalInternalRoutes);
  app.use('/internal', apiKeyAuth, shareTokenInternalRoutes);
  app.use('/internal', apiKeyAuth, offersInternalRoutes);

  // ── Org-scoped routes (API key + x-org-id) ──────────────────
  app.use('/orgs', apiKeyAuth, requireOrgId, brandsOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, extractFieldsOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, extractImagesOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, publicInfoOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, transferOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, salesEconomicsOrgRoutes);
app.use('/orgs', apiKeyAuth, requireOrgId, salesFunnelsOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, icpOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, userFieldsOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, brandGoalOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, clickDestinationOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, whatsAppLinkOrgRoutes);
app.use('/orgs', apiKeyAuth, requireOrgId, salesRepPhoneOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, businessContextOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, shareTokenOrgRoutes);
  app.use('/orgs', apiKeyAuth, requireOrgId, offersOrgRoutes);
  app.use('/orgs/media-assets', apiKeyAuth, requireOrgId, analyzeRoutes);

  return app;
}

/**
 * Get auth headers for org-scoped requests (/orgs/* routes).
 * Includes x-org-id and x-user-id (required by requireOrgId middleware).
 */
export function getAuthHeaders(orgId = 'test-org-uuid', userId = 'test-user-uuid', runId = 'test-run-uuid') {
  return {
    'X-API-Key': process.env.BRAND_SERVICE_API_KEY || process.env.COMPANY_SERVICE_API_KEY || 'test-secret-key',
    'X-Org-Id': orgId,
    'X-User-Id': userId,
    'X-Run-Id': runId,
    'Content-Type': 'application/json',
  };
}

/**
 * Get auth headers for internal requests (/internal/* routes).
 * Only API key, no identity headers required.
 */
export function getInternalAuthHeaders() {
  return {
    'X-API-Key': process.env.BRAND_SERVICE_API_KEY || process.env.COMPANY_SERVICE_API_KEY || 'test-secret-key',
    'Content-Type': 'application/json',
  };
}

/**
 * Get auth headers with workflow tracking headers.
 */
export function getAuthHeadersWithTracking(
  orgId = 'test-org-uuid',
  userId = 'test-user-uuid',
  runId = 'test-run-uuid',
  tracking: { campaignId?: string; featureSlug?: string; brandId?: string; workflowSlug?: string } = {}
) {
  return {
    ...getAuthHeaders(orgId, userId, runId),
    ...(tracking.campaignId && { 'X-Campaign-Id': tracking.campaignId }),
    ...(tracking.featureSlug && { 'X-Feature-Slug': tracking.featureSlug }),
    ...(tracking.brandId && { 'X-Brand-Id': tracking.brandId }),
    ...(tracking.workflowSlug && { 'X-Workflow-Slug': tracking.workflowSlug }),
  };
}

/**
 * Get legacy auth headers (for backward compatibility tests)
 */
export function getLegacyAuthHeaders() {
  return {
    'X-API-Key': process.env.API_KEY || 'test-secret-key',
    'Content-Type': 'application/json',
  };
}

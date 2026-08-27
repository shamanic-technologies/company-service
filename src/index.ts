import express, { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { apiKeyAuth, requireOrgId } from './middleware/auth';
import { db, brandExtractedFields } from './db';
import { lt, sql } from 'drizzle-orm';
import {
  describeErrorCauses,
  getMigrationFailure,
  getMigrationStatus,
  markMigrationsFailed,
  markMigrationsReady,
  requireMigrationsReady,
  runMigrationsWithConnectRetry,
} from './lib/boot-migrations';

// Import routes — mixed files export { orgRouter, internalRouter }
import { orgRouter as brandsOrgRoutes, internalRouter as brandsInternalRoutes, publicRouter as brandsPublicRoutes } from './routes/brands.routes';
import { orgRouter as extractFieldsOrgRoutes, internalRouter as extractFieldsInternalRoutes } from './routes/extract-fields.routes';
import { orgRouter as extractImagesOrgRoutes, internalRouter as extractImagesInternalRoutes } from './routes/extract-images.routes';
import { orgRouter as publicInfoOrgRoutes, internalRouter as publicInfoInternalRoutes } from './routes/public-information.routes';
import { orgRouter as transferOrgRoutes, internalRouter as transferInternalRoutes } from './routes/transfer.routes';
import { orgRouter as salesEconomicsOrgRoutes, internalRouter as salesEconomicsInternalRoutes } from './routes/sales-economics.routes';
import { orgRouter as salesFunnelsOrgRoutes, internalRouter as salesFunnelsInternalRoutes } from './routes/sales-funnels.routes';
import { orgRouter as icpOrgRoutes } from './routes/icp.routes';
import { orgRouter as userFieldsOrgRoutes } from './routes/user-fields.routes';
import { orgRouter as offersOrgRoutes, internalRouter as offersInternalRoutes } from './routes/offers.routes';
import { orgRouter as brandGoalOrgRoutes, internalRouter as brandGoalInternalRoutes } from './routes/brand-goal.routes';
import { orgRouter as whatsAppLinkOrgRoutes } from './routes/whatsapp-link.routes';
import { orgRouter as clickDestinationOrgRoutes } from './routes/click-destination.routes';
import { orgRouter as businessContextOrgRoutes } from './routes/business-context.routes';
import { orgRouter as shareTokenOrgRoutes, internalRouter as shareTokenInternalRoutes } from './routes/share-token.routes';

// Import routes — single-tier files (all internal except analyze which is all org-scoped)
import organizationRoutes from './routes/organization.routes';
import uploadRoutes from './routes/upload.routes';
import mediaAssetsRoutes from './routes/media-assets.routes';
import analyzeRoutes from './routes/analyze.routes';
import clientInfoRoutes from './routes/client-info.routes';
import intakeFormRoutes from './routes/intake-form.routes';
import thesisRoutes from './routes/thesis.routes';
import usersRoutes from './routes/users.routes';
import { assertEveryMigrationRan } from './db/verify-migrations';
import { refreshPendingBrandColors } from './services/brandColorsService';

const app = express();
const port = process.env.PORT || 3005;

// CORS configuration - service-to-service calls don't need CORS
// API key auth is sufficient protection
app.use(cors({
  origin: true, // Allow all origins - auth is via BRAND_SERVICE_API_KEY
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-External-Organization-Id', 'X-Org-Id', 'X-User-Id', 'X-Run-Id', 'X-Campaign-Id', 'X-Brand-Id', 'X-Workflow-Slug', 'X-Feature-Slug', 'X-Audience-Id'],
}));

// Body limit raised to 2mb so a brand's pasted business context (~1MB / ~300k
// chars — the no-website field-extraction source) is accepted without a 413.
app.use(express.json({ limit: '2mb' }));

// ── Public routes (no auth) ──────────────────────────────────────

app.get('/', (req: Request, res: Response) => {
  res.send('Company Service API');
});

// Liveness + readiness in one. `migrations: 'pending'` still answers 200 so a
// deploy landing on a suspended Neon compute passes Railway's healthcheck while
// the migrator waits for the compute to resume — the routes below are gated
// separately, so nothing is served against an unverified schema in the meantime.
// A migration that genuinely failed answers 503, which is what makes Railway
// mark the deploy unhealthy and keep the previous container serving.
app.get('/health', (req: Request, res: Response) => {
  const migrations = getMigrationStatus();

  if (migrations === 'failed') {
    return res.status(503).json({
      status: 'error',
      service: 'company-service',
      migrations,
      error: getMigrationFailure(),
    });
  }

  res.status(200).json({ status: 'ok', service: 'company-service', migrations });
});

app.get('/openapi.json', (req: Request, res: Response) => {
  const specPath = path.resolve(__dirname, '../openapi.json');
  if (!fs.existsSync(specPath)) {
    return res.status(404).json({ error: 'OpenAPI spec not generated yet. Run pnpm generate:openapi' });
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
  res.json(spec);
});

// ── Migration gate ───────────────────────────────────────────────
// Everything below this line touches the database. Until the migrator has
// finished, these routes answer 503 rather than run against a schema that may
// not match the code. `/`, `/health` and `/openapi.json` sit above the gate on
// purpose: they need no database and Railway's healthcheck depends on them.
app.use(requireMigrationsReady);

// ── Public brand-info routes (no auth) ───────────────────────────

app.use('/public', brandsPublicRoutes);

// ── Internal routes (API key only, no x-org-id required) ─────────

app.use('/internal', apiKeyAuth, brandsInternalRoutes);
app.use('/internal', apiKeyAuth, extractFieldsInternalRoutes);
app.use('/internal', apiKeyAuth, extractImagesInternalRoutes);
app.use('/internal', apiKeyAuth, publicInfoInternalRoutes);
app.use('/internal', apiKeyAuth, transferInternalRoutes);
app.use('/internal', apiKeyAuth, organizationRoutes);
app.use('/internal', apiKeyAuth, uploadRoutes);
app.use('/internal/media-assets', apiKeyAuth, mediaAssetsRoutes);
app.use('/internal', apiKeyAuth, clientInfoRoutes);
app.use('/internal', apiKeyAuth, intakeFormRoutes);
app.use('/internal', apiKeyAuth, thesisRoutes);
app.use('/internal/users', apiKeyAuth, usersRoutes);
app.use('/internal', apiKeyAuth, salesEconomicsInternalRoutes);
app.use('/internal', apiKeyAuth, salesFunnelsInternalRoutes);
app.use('/internal', apiKeyAuth, brandGoalInternalRoutes);
app.use('/internal', apiKeyAuth, shareTokenInternalRoutes);
app.use('/internal', apiKeyAuth, offersInternalRoutes);

// ── Org-scoped routes (API key + x-org-id required) ─────────────

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
app.use('/orgs', apiKeyAuth, requireOrgId, businessContextOrgRoutes);
app.use('/orgs', apiKeyAuth, requireOrgId, shareTokenOrgRoutes);
app.use('/orgs', apiKeyAuth, requireOrgId, offersOrgRoutes);
app.use('/orgs/media-assets', apiKeyAuth, requireOrgId, analyzeRoutes);

// ── Expired extracted-fields cleanup cron ────────────────────────
// Daily DELETE of expired rows from brand_extracted_fields (the ephemeral 3-day
// auto-extract cache). Confirmed user fields live in a DIFFERENT table
// (brand_user_fields, no TTL) and are NEVER touched. Started AFTER app.listen()
// per the boot-window rule; also runs once ~60s after boot so it doesn't wait 24h.
const EXPIRED_FIELDS_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const EXPIRED_FIELDS_CLEANUP_BOOT_DELAY_MS = 60 * 1000; // 60 seconds after boot

async function cleanupExpiredExtractedFields(): Promise<void> {
  const deleted = await db
    .delete(brandExtractedFields)
    .where(lt(brandExtractedFields.expiresAt, sql`NOW()`))
    .returning({ id: brandExtractedFields.id });
  if (deleted.length > 0) {
    console.log(`[brand-service] Cleaned up ${deleted.length} expired extracted-field row(s)`);
  }
}

// ── Brand-colour retrieval cadence ───────────────────────────────
// The logo.dev Brand endpoint answers 202 "not found, looking up" for a domain
// it has not indexed and only carries the palette on a LATER call, so the
// retrieval CANNOT ride the write that enqueued the brand — it needs a cadence
// of its own. Six of our seven live domains answered 202 on first contact
// (measured 2026-08-25), and were still 202 two minutes later.
//
// The endpoint is metered on a separate prepaid credit grant with NO quota
// header, so the pass bounds its own spend: a queue rather than a table sweep,
// a per-run cap, a per-brand attempt cap and a monthly budget counted off the
// call ledger. See services/brandColorsService.ts.
//
// Started AFTER app.listen() per the boot-window rule, and once ~90s after boot
// so a brand that arrived during the previous window is not waiting 6 hours.
const BRAND_COLORS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const BRAND_COLORS_REFRESH_BOOT_DELAY_MS = 90 * 1000; // 90 seconds after boot

function startBrandColorsRefresh(): void {
  setTimeout(() => {
    refreshPendingBrandColors().catch((err) =>
      console.error('[brand-service] Brand-colour refresh (boot) failed:', err),
    );
  }, BRAND_COLORS_REFRESH_BOOT_DELAY_MS);

  setInterval(() => {
    refreshPendingBrandColors().catch((err) =>
      console.error('[brand-service] Brand-colour refresh (interval) failed:', err),
    );
  }, BRAND_COLORS_REFRESH_INTERVAL_MS);
}

function startExpiredFieldsCleanup(): void {
  setTimeout(() => {
    cleanupExpiredExtractedFields().catch((err) =>
      console.error('[brand-service] Expired-fields cleanup (boot) failed:', err),
    );
  }, EXPIRED_FIELDS_CLEANUP_BOOT_DELAY_MS);

  setInterval(() => {
    cleanupExpiredExtractedFields().catch((err) =>
      console.error('[brand-service] Expired-fields cleanup (interval) failed:', err),
    );
  }, EXPIRED_FIELDS_CLEANUP_INTERVAL_MS);
}

// ── Boot ─────────────────────────────────────────────────────────
// The port binds FIRST, then migrations run behind it.
//
// Awaiting migrate() before app.listen() means a deploy that lands while the
// Neon compute is suspended spends its whole startup budget on the first
// connection: the port never opens inside Railway's ~30s healthcheck window and
// the deploy is marked FAILED, for reasons that have nothing to do with the code
// being deployed. Reproduced on a cold compute 2026-07-30; keeping the compute
// awake with a `SELECT 1` for the duration made the identical deploy pass.
//
// Binding first does not mean serving early: `requireMigrationsReady` above
// answers 503 on every database-backed route until the migrator finishes, so
// the service refuses rather than answering against an unverified schema. A
// migration that genuinely fails is logged in full and flips /health to 503,
// which marks the deploy unhealthy and leaves the previous container serving —
// strictly louder than the old process.exit(1), which crash-looped against
// Railway's ON_FAILURE restart policy and took the port down with it.
if (process.env.NODE_ENV === "test") {
  // The integration harness builds its own app (tests/helpers/test-app.ts) against
  // a schema CI has already provisioned, so there is no migrator to wait for.
  markMigrationsReady();
} else {
  const server = app.listen(Number(port), "::", () => {
    console.log(`Service running on port ${port} (migrations pending)`);
  });

  server.on("error", (err) => {
    console.error("Failed to bind port:", err);
    process.exit(1);
  });

  runMigrationsWithConnectRetry(() => migrate(db, { migrationsFolder: "./drizzle" }))
    .then(async () => {
      // "Migrations complete" is exactly what drizzle reports after SKIPPING a
      // file: it resumes by row count against journal position, so a numbering
      // gap makes it slice past one and finish clean. Prove the ledger is not
      // short before this service reports ready — a schema that is not the one
      // this build expects should fail the healthcheck, not serve 500s for
      // nineteen hours. See src/db/verify-migrations.ts (#416, #417).
      await assertEveryMigrationRan("./drizzle");
      markMigrationsReady();
      console.log("Migrations complete");
      startExpiredFieldsCleanup();
      startBrandColorsRefresh();
    })
    .catch((err) => {
      markMigrationsFailed(err);
      // Both: the funnel names the real cause (drivers wrap it out of sight), the
      // raw error carries the stack.
      console.error("Migration failed:", describeErrorCauses(err));
      console.error(err);
    });
}

export default app;

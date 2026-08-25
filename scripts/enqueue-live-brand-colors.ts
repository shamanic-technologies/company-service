/**
 * Put the brands that are actually LIVE in line for colour retrieval, once.
 *
 * The queue fills itself from here on: `getOrCreateBrand` enqueues every new
 * brand at create, which is a volume the grant absorbs. What it cannot do is
 * reach BACK — the brands already onboarded were created before the enqueue
 * existed, so they hold no row and the cadence has nothing to work on for them.
 *
 * The list is deliberately the LIVE set and nothing else. Enqueuing all 156
 * brand rows would, on its own, exceed the ~100-call monthly Brand-API grant —
 * and 149 of them are not being rendered by anybody. The seven below are the
 * live client domains as of 2026-08-25.
 *
 * This script spends NO metered call. It only inserts queue rows; the metered
 * logo.dev calls happen later, on the refresh cadence, under its own budget.
 *
 * Idempotent (`enqueueBrandColors` is ON CONFLICT DO NOTHING, so a brand already
 * queued or already resolved is untouched), dry-runnable, and reversible by
 * deleting the queue rows for these brand ids.
 *
 *   pnpm exec tsx scripts/enqueue-live-brand-colors.ts --dry-run
 *   pnpm exec tsx scripts/enqueue-live-brand-colors.ts
 */

import { inArray } from 'drizzle-orm';
import { db, brandColors, brands } from '../src/db';
import { enqueueBrandColors } from '../src/services/brandColorsService';

/** The live client domains. Normalized (lowercase, no `www.`) to match `brands.domain`. */
const LIVE_DOMAINS = [
  'shockwavecenters.com',
  'opsfolio.com',
  'docdinners.com',
  'voozaa.app',
  'emailtoolshub.com',
  'federalarchitect.com',
  'luxproperty.group',
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const rows = await db
    .select({ id: brands.id, domain: brands.domain })
    .from(brands)
    .where(inArray(brands.domain, LIVE_DOMAINS));

  const found = new Set(rows.map((r) => r.domain));
  const missing = LIVE_DOMAINS.filter((d) => !found.has(d));
  if (missing.length > 0) {
    // Loud, not fatal: a domain we cannot resolve to a brand row is a fact the
    // operator needs, and the ones we CAN resolve should still be queued.
    console.warn(`[enqueue-live-brand-colors] no brand row for: ${missing.join(', ')}`);
  }

  const existing = rows.length
    ? await db
        .select({ brandId: brandColors.brandId, status: brandColors.status })
        .from(brandColors)
        .where(inArray(brandColors.brandId, rows.map((r) => r.id)))
    : [];
  const alreadyQueued = new Map(existing.map((e) => [e.brandId, e.status]));

  for (const row of rows) {
    const already = alreadyQueued.get(row.id);
    if (already) {
      console.log(`[enqueue-live-brand-colors] ${row.domain}: already ${already}, untouched`);
      continue;
    }
    if (dryRun) {
      console.log(`[enqueue-live-brand-colors] DRY RUN would queue ${row.domain} (${row.id})`);
      continue;
    }
    await enqueueBrandColors(row.id);
    console.log(`[enqueue-live-brand-colors] queued ${row.domain} (${row.id})`);
  }

  console.log(
    `[enqueue-live-brand-colors] ${dryRun ? 'DRY RUN ' : ''}done: ${rows.length} resolved, ${alreadyQueued.size} already in the queue, ${missing.length} unresolved`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('[enqueue-live-brand-colors] failed:', err);
  process.exit(1);
});

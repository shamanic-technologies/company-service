/**
 * ONE-TIME BACKFILL — make every rate a brand has stated through a NAMED column
 * also readable as the rate of the ARROW it is about.
 *
 * A rate belongs to an arrow, named by the two steps it connects
 * (`brand_sales_funnel_arrow_rates`). That surface shipped, and nothing has been
 * written to it: every brand's economics still live only in the closed set of
 * named columns on `brand_sales_funnels`. So a consumer that has moved to asking
 * per arrow gets nothing back and falls through to the named rates — correct,
 * but it means the migration has not begun.
 *
 * The mapping is deterministic and already exists: `funnelArrows` says which
 * arrow of which funnel each named column prices, which is what makes the named
 * set answer per-arrow questions today. This walks it in the other direction.
 *
 * NO FIGURE MOVES — the number written for an arrow is the number the named
 *   column already holds, same precision and scale. The named columns are left
 *   exactly where they are and keep being written and read; a later, separate
 *   ship retires them. Precedence is unchanged: the stated arrow wins, the named
 *   rate is the fallback.
 * NOTHING IS INVENTED — only a named column that HOLDS a number produces an
 *   arrow. A leg left blank gets no row: no default, no average, no zero.
 * NEVER OVERWRITES — an arrow the brand had already stated arrow-first conflicts
 *   away untouched, so what the customer said last is what stays.
 * IDEMPOTENT — only a declaration carrying no `arrow_rates_backfilled_at` is a
 *   candidate, so a second run finds none and writes nothing. It also cannot
 *   resurrect an arrow the customer deleted after the first run.
 * REVERSIBLE — every arrow it writes carries `backfilled_at`, so undoing is an
 *   exact predicate with no timestamp window:
 *     DELETE FROM brand_sales_funnel_arrow_rates WHERE backfilled_at IS NOT NULL;
 *     UPDATE brand_sales_funnels SET arrow_rates_backfilled_at = NULL
 *      WHERE arrow_rates_backfilled_at IS NOT NULL;
 * DRY-RUNNABLE — `--dry-run` reads and prints the plan, writes nothing.
 *
 * Usage:
 *   BRAND_SERVICE_DATABASE_URL=... npx tsx scripts/backfill-funnel-arrow-rates.ts --dry-run
 *   BRAND_SERVICE_DATABASE_URL=... npx tsx scripts/backfill-funnel-arrow-rates.ts
 *
 * The counts this prints are the SCRIPT'S OWN LOG and are not the result. Read
 * the result back from the database:
 *   SELECT funnel_key, count(*)
 *     FROM brand_sales_funnel_arrow_rates WHERE backfilled_at IS NOT NULL
 *    GROUP BY 1;
 * A re-run legitimately reports zero of everything, which is indistinguishable
 * from "it did nothing" in the log alone.
 */

import { sql } from 'drizzle-orm';
import { db } from '../src/db';
import {
  planArrowRatesBackfill,
  type ArrowRatesBackfillPlan,
} from '../src/lib/funnel-arrow-rates-backfill-plan';
import {
  applyArrowRatesBackfill,
  readArrowRatesBackfillCandidates,
} from '../src/services/funnelArrowRatesBackfillService';

function summarise(plan: ArrowRatesBackfillPlan): void {
  const byFunnel = new Map<string, number>();
  for (const row of plan.rows) {
    byFunnel.set(row.funnelKey, (byFunnel.get(row.funnelKey) ?? 0) + 1);
  }
  console.log(`\narrows to write: ${plan.rows.length}`);
  for (const [key, count] of [...byFunnel].sort()) {
    console.log(`  ${key}: ${count}`);
  }
  console.log(`declarations read: ${plan.declarations.length}`);
  console.log(`brands touched: ${new Set(plan.rows.map((r) => r.brandId)).size}`);

  if (plan.skipped.length > 0) {
    console.log(`\nskipped: ${plan.skipped.length}`);
    const byReason = new Map<string, number>();
    for (const s of plan.skipped) {
      byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    }
    for (const [key, count] of [...byReason].sort()) {
      console.log(`  ${key}: ${count}`);
    }
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const candidates = await readArrowRatesBackfillCandidates();
  console.log(`declarations the backfill has not processed: ${candidates.length}`);

  const plan = planArrowRatesBackfill(candidates);
  summarise(plan);

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  await applyArrowRatesBackfill(plan);

  // Read the result back rather than reporting what we intended to write.
  const written = await db.execute<{ funnel_key: string; n: string; brands: string }>(sql`
    SELECT funnel_key,
           count(*)::text AS n,
           count(DISTINCT brand_id)::text AS brands
      FROM brand_sales_funnel_arrow_rates
     WHERE backfilled_at IS NOT NULL
     GROUP BY 1
     ORDER BY 1
  `);
  console.log('\nread back from the database (all backfilled arrows, not just this run):');
  for (const row of written) {
    console.log(`  ${row.funnel_key}: ${row.n} arrows across ${row.brands} brands`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

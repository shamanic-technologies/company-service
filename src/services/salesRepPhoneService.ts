import { and, eq, sql } from 'drizzle-orm';
import { db, brandSalesRepPhones } from '../db';

/**
 * Per-brand "sales rep phone" config: the ONE number to ring when a sales
 * interest lands on this brand (a prospect replies to a cold-email campaign
 * saying they are interested, and the rep is phoned within the minute).
 *
 * Brand grain, keyed on (org_id, brand_id) — mirrors the click-destination /
 * WhatsApp-link / sales-economics per-brand-config scoping, NOT the global
 * `brands` identity row. Unset simply means no row, and that reads as
 * `salesRepPhone: null` on the brand read — a first-class "nobody to ring".
 */

/** Thrown on invalid sales-rep-phone input — the route maps it to a 400. */
export class SalesRepPhoneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SalesRepPhoneValidationError';
  }
}

/**
 * Validate + normalize a user-typed phone number to strict E.164
 * (`+<country><subscriber>`, 8-15 digits). Fail loud: invalid input throws and
 * the route maps it to a 400 — nothing is coerced silently, because the stored
 * value is handed straight to a telephony provider and a number that reaches
 * the dialler unusable is a call that never happens, with no error anywhere.
 *
 * Accepted, since people type a number however they like:
 *  - `+33 7 70 65 75 85`, `+33-770-657-585`, `(+33) 770657585` → `+33770657585`
 *  - the international `00` prefix: `0033770657585` → `+33770657585`
 *
 * Rejected — deliberately, with no inference:
 *  - a national number with no country code (`0770657585`): guessing the
 *    country from anything (the brand's domain, the org, a default) would dial
 *    a different person.
 *  - letters, extensions, empty input, fewer than 8 or more than 15 digits
 *    (E.164's own maximum).
 */
export function normalizeSalesRepPhone(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new SalesRepPhoneValidationError('salesRepPhone must be a non-empty string');
  }

  const cleaned = input.trim().replace(/[\s\-().]/g, '');

  let digits: string;
  if (cleaned.startsWith('+')) {
    digits = cleaned.slice(1);
  } else if (cleaned.startsWith('00')) {
    digits = cleaned.slice(2);
  } else {
    throw new SalesRepPhoneValidationError(
      'salesRepPhone must include a country code — start it with `+` (e.g. +33770657585) ' +
        'or the international `00` prefix. A national number cannot be dialled internationally ' +
        'and no country is inferred.'
    );
  }

  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw new SalesRepPhoneValidationError(
      'salesRepPhone must be a valid international number: 8-15 digits after the country-code ' +
        'prefix, digits only, and the country code cannot start with 0.'
    );
  }

  return `+${digits}`;
}

export class SalesRepPhoneService {
  /** The saved number for an (org, brand), or null when unset (no row). */
  async getByBrandId(orgId: string, brandId: string): Promise<string | null> {
    const [row] = await db
      .select({ phone: brandSalesRepPhones.phone })
      .from(brandSalesRepPhones)
      .where(and(eq(brandSalesRepPhones.orgId, orgId), eq(brandSalesRepPhones.brandId, brandId)))
      .limit(1);

    return row?.phone ?? null;
  }

  /**
   * Idempotent upsert. One row per (org, brand); repeating the same write
   * yields the same end state. `phone` must already be normalized
   * (`normalizeSalesRepPhone`). Returns the saved value.
   */
  async upsertByBrandId(orgId: string, brandId: string, phone: string): Promise<string> {
    const [row] = await db
      .insert(brandSalesRepPhones)
      .values({ orgId, brandId, phone })
      .onConflictDoUpdate({
        target: [brandSalesRepPhones.orgId, brandSalesRepPhones.brandId],
        set: { phone, updatedAt: sql`NOW()` },
      })
      .returning({ phone: brandSalesRepPhones.phone });

    return row.phone;
  }

  /**
   * Remove the number: the row is DELETED, so the brand goes back to "nobody to
   * ring". Storing an empty string would make "set to nothing" a second way of
   * saying unset, and the row's presence is the only "set" signal. Idempotent —
   * removing a number that is not there is not an error.
   */
  async deleteByBrandId(orgId: string, brandId: string): Promise<void> {
    await db
      .delete(brandSalesRepPhones)
      .where(and(eq(brandSalesRepPhones.orgId, orgId), eq(brandSalesRepPhones.brandId, brandId)));
  }

  /**
   * The number to serve on a BRAND READ, which carries no org of its own.
   *
   * - an org was resolved (the caller sent `x-org-id`) → that org's row, full stop.
   * - no org, and exactly ONE org has stated a number for this brand → that
   *   number, because the question has a single possible answer.
   * - no org and SEVERAL orgs have stated one → null. Each org configures the
   *   brand independently (21 production brands are claimed by more than one
   *   org), so picking one would hand a rep's number to a different company.
   *   Absence is already a first-class answer here, so the honest answer to an
   *   ambiguous question is "nobody to ring", not somebody else's rep.
   *
   * Same spirit as `resolveInternalOrgScope`, without turning an existing
   * always-200 brand read into a 400.
   */
  async resolveForBrandRead(brandId: string, orgId?: string | null): Promise<string | null> {
    if (orgId) return this.getByBrandId(orgId, brandId);

    const rows = await db
      .select({ phone: brandSalesRepPhones.phone })
      .from(brandSalesRepPhones)
      .where(eq(brandSalesRepPhones.brandId, brandId))
      .limit(2);

    if (rows.length !== 1) return null;
    return rows[0].phone;
  }
}

export const salesRepPhoneService = new SalesRepPhoneService();

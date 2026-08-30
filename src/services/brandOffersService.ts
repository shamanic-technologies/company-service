import { and, asc, eq, isNull, SQL } from 'drizzle-orm';
import { db, brandOffers, brandSalesFunnelArrowRates, brandSalesFunnels, brandUserFields, brands } from '../db';
import {
  OFFER_NAME_MAX_CHARS,
  OFFER_NAME_MAX_WORDS,
  OfferNameError,
  normalizeOfferName,
  offerNameForBrand,
  offerNameProblem,
} from '../lib/offer-name';

/**
 * OFFERS — the things a brand sells, and the level every value proposition and
 * every set of conversion rates now hangs off.
 *
 * An offer exists because someone said so: a row, a name, and nothing derived.
 * There is deliberately no defaulting layer and NO PRIMARY OFFER — several run
 * at once and none outranks another, the same rule the sales-funnel model
 * settled on, for the same reason. Ranking them is a question for whoever is
 * spending money, not for the record of what exists.
 *
 * This file also owns the BACK-COMPAT resolution the brand-scoped routes run:
 * every consumer of brand-service still asks its questions per BRAND, and will
 * for a while. See `resolveSoleOffer` below for what a brand-scoped call means
 * now that a brand can hold more than one.
 */

/** One offer, as read. Nothing here is derived — every field is stored. */
export interface BrandOffer {
  offerId: string;
  brandId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Thrown when a name is already taken within the brand (→ 409 upstream). */
export class OfferNameTakenError extends Error {
  constructor(public readonly name: string) {
    super(
      `This brand already has an offer called "${name}". Two offers a reader cannot tell apart ` +
      'are two offers nobody can pick between, so a name is used once per brand.'
    );
    this.name = 'OfferNameTakenError';
  }
}

/** Thrown when an offer id names nothing under this (org, brand) (→ 404 upstream). */
export class OfferNotFoundError extends Error {
  constructor(public readonly offerId: string) {
    super(`No offer ${offerId} on this brand.`);
    this.name = 'OfferNotFoundError';
  }
}

/**
 * Thrown when a BRAND-scoped call reaches a brand holding SEVERAL offers
 * (→ 409 upstream).
 *
 * The whole point of the offer level is that a brand's rates, lifetime revenue
 * and value proposition are no longer one answer. So a call that names only the
 * brand is a question with several answers, and picking one is picking which of
 * the customer's products the caller meant — which nobody asked us to do, and
 * which would write one offer's numbers over another's the first time it guessed
 * wrong. It refuses instead, and says what to send.
 *
 * This mirrors billing-service refusing to move money when a funnel is split
 * across several channels, and `resolveInternalOrgScope` refusing to answer for
 * a brand several orgs claim. Same shape, same reason: no defensible default.
 */
export class SeveralOffersError extends Error {
  constructor(
    public readonly brandId: string,
    public readonly offers: BrandOffer[]
  ) {
    super(
      `Brand ${brandId} sells ${offers.length} offers (${offers.map((o) => o.name).join(', ')}), ` +
      'so a brand-scoped call has no single answer: each offer carries its own conversion rates, ' +
      'its own lifetime revenue and its own value proposition. Name the offer — use the ' +
      '/orgs/brands/{brandId}/offers/{offerId}/... routes.'
    );
    this.name = 'SeveralOffersError';
  }
}

/**
 * Thrown when a brand carries neither a name nor a domain, so the offer a legacy
 * write needs cannot be named after anything the customer told us (→ 400).
 * Fails rather than coining a word: a name is what four other services will key
 * their display on, and inventing one puts it in the customer's mouth.
 */
export class OfferNameUnavailableError extends Error {
  constructor(public readonly brandId: string) {
    super(
      `Brand ${brandId} has neither a name nor a domain, so its first offer cannot be named after ` +
      'anything it told us. Create the offer explicitly with a name of your own: ' +
      'POST /orgs/brands/{brandId}/offers.'
    );
    this.name = 'OfferNameUnavailableError';
  }
}

type OfferRow = typeof brandOffers.$inferSelect;

function formatOffer(row: OfferRow): BrandOffer {
  return {
    offerId: row.id,
    brandId: row.brandId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Every offer this org sells under this brand, oldest first — a stable order, so
 * two reads never disagree and no position implies rank. `[]` means the org has
 * never stated one.
 */
export async function listOffers(orgId: string, brandId: string): Promise<BrandOffer[]> {
  const rows = await db
    .select()
    .from(brandOffers)
    .where(and(eq(brandOffers.orgId, orgId), eq(brandOffers.brandId, brandId)))
    .orderBy(asc(brandOffers.createdAt), asc(brandOffers.id));
  return rows.map(formatOffer);
}

/** One offer, or null when the id names nothing under this (org, brand). */
export async function getOffer(
  orgId: string,
  brandId: string,
  offerId: string
): Promise<BrandOffer | null> {
  const [row] = await db
    .select()
    .from(brandOffers)
    .where(
      and(
        eq(brandOffers.orgId, orgId),
        eq(brandOffers.brandId, brandId),
        eq(brandOffers.id, offerId)
      )
    )
    .limit(1);
  return row ? formatOffer(row) : null;
}

/**
 * One offer by id alone, with the (org, brand) it belongs to — what an INTERNAL
 * service-auth read has, since a sibling service holds an offer id and no org.
 * `null` when the id names nothing.
 */
export async function getOfferById(
  offerId: string
): Promise<(BrandOffer & { orgId: string }) | null> {
  const [row] = await db
    .select()
    .from(brandOffers)
    .where(eq(brandOffers.id, offerId))
    .limit(1);
  return row ? { ...formatOffer(row), orgId: row.orgId } : null;
}

/** Proves the offer exists under this (org, brand), or throws. */
export async function assertOfferOnBrand(
  orgId: string,
  brandId: string,
  offerId: string
): Promise<BrandOffer> {
  const offer = await getOffer(orgId, brandId, offerId);
  if (!offer) throw new OfferNotFoundError(offerId);
  return offer;
}

/**
 * Validate a name and return its canonical form, or throw `OfferNameError`.
 * Both limits are checked here as well as by the table's CHECKs, so a caller
 * gets a sentence a person can read instead of a constraint-violation string.
 */
export function requireValidOfferName(input: string): string {
  const problem = offerNameProblem(input);
  if (problem) throw new OfferNameError(problem);
  return normalizeOfferName(input);
}

/** Create an offer. Fails loud on a bad name and on a name already in use. */
export async function createOffer(
  orgId: string,
  brandId: string,
  name: string,
  options: { migratedAt?: string } = {}
): Promise<BrandOffer> {
  const canonical = requireValidOfferName(name);

  const [row] = await db
    .insert(brandOffers)
    .values({
      orgId,
      brandId,
      name: canonical,
      ...(options.migratedAt ? { migratedAt: options.migratedAt } : {}),
    })
    // The name is the natural key inside the brand, so a collision is the caller
    // describing an offer that already exists. Report it rather than suffixing a
    // number onto their word — see the CRM-audience naming rule: a name we
    // invent to dodge a 409 is a name nobody asked for.
    .onConflictDoNothing({
      target: [brandOffers.orgId, brandOffers.brandId, brandOffers.name],
    })
    .returning();

  if (!row) throw new OfferNameTakenError(canonical);
  return formatOffer(row);
}

/** Rename an offer. The two limits apply exactly as they do on create. */
export async function renameOffer(
  orgId: string,
  brandId: string,
  offerId: string,
  name: string
): Promise<BrandOffer> {
  await assertOfferOnBrand(orgId, brandId, offerId);
  const canonical = requireValidOfferName(name);

  const clash = await db
    .select({ id: brandOffers.id })
    .from(brandOffers)
    .where(
      and(
        eq(brandOffers.orgId, orgId),
        eq(brandOffers.brandId, brandId),
        eq(brandOffers.name, canonical)
      )
    )
    .limit(1);
  if (clash.length > 0 && clash[0].id !== offerId) {
    throw new OfferNameTakenError(canonical);
  }

  const [row] = await db
    .update(brandOffers)
    .set({ name: canonical, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(brandOffers.orgId, orgId),
        eq(brandOffers.brandId, brandId),
        eq(brandOffers.id, offerId)
      )
    )
    .returning();

  if (!row) throw new OfferNotFoundError(offerId);
  return formatOffer(row);
}

/**
 * WHICH offer a BRAND-scoped call is about.
 *
 * Every existing consumer asks per brand, and must keep working byte-for-byte
 * the day this ships. Three cases, and only one of them is a judgement call we
 * refuse to make:
 *
 *   - exactly ONE offer  → that one. The question has a single answer.
 *   - SEVERAL offers     → `SeveralOffersError` (409). No default is defensible,
 *                          and a wrong guess writes one product's economics over
 *                          another's.
 *   - NO offer           → `null`. A brand with no offer has stated nothing, so
 *                          every brand-scoped READ answers exactly what it
 *                          answered before: an empty funnel set, user-fields
 *                          with nothing confirmed. A WRITE takes the other path
 *                          below and creates the brand's first offer.
 */
export async function resolveSoleOffer(
  orgId: string,
  brandId: string
): Promise<string | null> {
  const offers = await listOffers(orgId, brandId);
  if (offers.length === 0) return null;
  if (offers.length > 1) throw new SeveralOffersError(brandId, offers);
  return offers[0].offerId;
}

/**
 * WHICH offer a READ is about when the caller MAY name one.
 *
 * The offer a caller names wins, once it is proved to exist under this
 * (org, brand) — naming an offer of somebody else's brand, or an id that names
 * nothing, is `OfferNotFoundError` (404), never a quiet fall back to the brand's
 * own rows. That refusal is the whole point: a read that silently swapped a
 * named offer for a resolved one would feed one proposition's words into
 * another proposition's answer, and the output would look plausible.
 *
 * A caller that names NOTHING keeps `resolveSoleOffer`'s three answers exactly
 * — one offer, no offer, or the deliberate `SeveralOffersError` (409) for a
 * brand that has stated several. That is what makes this byte-for-byte today's
 * behaviour for every brand in production, all of which hold exactly one offer.
 */
export async function resolveNamedOffer(
  orgId: string,
  brandId: string,
  offerId?: string | null
): Promise<string | null> {
  if (offerId === undefined || offerId === null) {
    return resolveSoleOffer(orgId, brandId);
  }
  await assertOfferOnBrand(orgId, brandId, offerId);
  return offerId;
}

/**
 * The offer a BRAND-scoped WRITE is about, creating the brand's first one when
 * it has none.
 *
 * Creating is what preserves the existing contract exactly: onboarding declares
 * a funnel on a brand-new brand, and that call used to need nothing but the
 * brand. Refusing it would break the one path every new customer walks. There is
 * nothing to guess at either — a brand with no offer has exactly one possible
 * offer for the write to land on.
 *
 * The implicit offer is named after the BRAND'S OWN words (its name, else its
 * domain label), cut to the two limits by dropping trailing words. It is NOT the
 * generated name the one-time migration produces: that one describes what a
 * brand already sells, and this brand has not told us anything yet. A brand
 * carrying neither name nor domain fails loud rather than receiving a coined
 * word.
 */
export async function resolveOfferForWrite(orgId: string, brandId: string): Promise<string> {
  const existing = await resolveSoleOffer(orgId, brandId);
  if (existing) return existing;

  const [brand] = await db
    .select({ name: brands.name, domain: brands.domain })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (!brand) throw new OfferNotFoundError(brandId);

  const name = offerNameForBrand(brand);
  if (!name) throw new OfferNameUnavailableError(brandId);

  try {
    const created = await createOffer(orgId, brandId, name);
    // Anything this brand already stated, before the backfill reached it, is
    // this offer's — there is only one offer it could belong to.
    await adoptUnmigratedRows(orgId, brandId, created.offerId);
    return created.offerId;
  } catch (error) {
    // Two concurrent legacy writes both found no offer. The name is the natural
    // key, so one of them lost — re-resolve rather than failing a write that is
    // now perfectly answerable.
    if (error instanceof OfferNameTakenError) {
      const settled = await resolveSoleOffer(orgId, brandId);
      if (settled) return settled;
    }
    throw error;
  }
}

/**
 * The predicate that selects ONE offer's rows on the two re-scoped tables.
 *
 * `null` selects the rows the migration has not reached (`offer_id IS NULL`),
 * which — scoped by org and brand as every caller already scopes them — is
 * BYTE-FOR-BYTE the query those tables answered before offers existed. That is
 * what keeps every brand-scoped read correct in the window between this schema
 * landing and the backfill script running: a brand nobody has migrated reads
 * exactly what it read yesterday, rather than reading empty.
 */
export function offerScope(
  column:
    | typeof brandSalesFunnels.offerId
    | typeof brandUserFields.offerId
    | typeof brandSalesFunnelArrowRates.offerId,
  offerId: string | null
): SQL {
  return offerId === null ? isNull(column) : eq(column, offerId);
}

/**
 * Put the rows the migration has not reached onto this offer.
 *
 * The same move the one-time migration makes, minus the generated name. It runs
 * whenever a brand-scoped WRITE creates a brand's first offer, so a brand the
 * script has not reached yet cannot end up with its old economics stranded under
 * `offer_id IS NULL` while new writes land on a fresh offer beside them — which
 * would split one brand's answer across two rows and let a read see half of it.
 *
 * Idempotent by its own predicate: it only ever touches rows still holding NULL.
 */
export async function adoptUnmigratedRows(
  orgId: string,
  brandId: string,
  offerId: string
): Promise<{ funnels: number; userFields: number }> {
  const funnels = await db
    .update(brandSalesFunnels)
    .set({ offerId })
    .where(
      and(
        eq(brandSalesFunnels.orgId, orgId),
        eq(brandSalesFunnels.brandId, brandId),
        isNull(brandSalesFunnels.offerId)
      )
    )
    .returning({ id: brandSalesFunnels.id });

  const userFields = await db
    .update(brandUserFields)
    .set({ offerId })
    .where(
      and(
        eq(brandUserFields.orgId, orgId),
        eq(brandUserFields.brandId, brandId),
        isNull(brandUserFields.offerId)
      )
    )
    .returning({ id: brandUserFields.id });

  return { funnels: funnels.length, userFields: userFields.length };
}

/** The two limits, re-exported so a caller states them once. */
export { OFFER_NAME_MAX_CHARS, OFFER_NAME_MAX_WORDS, OfferNameError };

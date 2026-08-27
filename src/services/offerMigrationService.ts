import { isNull, sql } from 'drizzle-orm';
import { db, brandSalesFunnels, brandUserFields } from '../db';
import { chat } from '../lib/chat-client';
import { offerNameProblem, normalizeOfferName, DEFAULT_OFFER_NAME, OFFER_NAME_MAX_CHARS, OFFER_NAME_MAX_WORDS } from '../lib/offer-name';
import {
  OfferMigrationCandidate,
  OfferMigrationPlan,
  PlannedOffer,
} from '../lib/offer-migration-plan';
import { adoptUnmigratedRows, createOffer } from './brandOffersService';

/**
 * The database and LLM halves of the one-time brand→offer migration. The pure
 * half — WHICH brands need an offer — is `src/lib/offer-migration-plan.ts`.
 */

/**
 * Every (org, brand) pair holding rows no offer owns yet, with everything the
 * naming prompt gets to read.
 *
 * The predicate is `offer_id IS NULL` on either table, and it is the whole of
 * the idempotence: after a run no pair matches, so a second run reads nothing.
 * A pair that was PARTLY migrated — a crash between the two updates — still
 * matches on its remaining table and is completed rather than skipped.
 */
export async function readOfferMigrationCandidates(): Promise<OfferMigrationCandidate[]> {
  const rows = await db.execute<{
    org_id: string;
    brand_id: string;
    brand_name: string | null;
    brand_domain: string | null;
    funnel_keys: string[] | null;
    user_fields: Record<string, unknown> | null;
  }>(sql`
    WITH pairs AS (
      SELECT DISTINCT "org_id", "brand_id" FROM "brand_sales_funnels" WHERE "offer_id" IS NULL
      UNION
      SELECT DISTINCT "org_id", "brand_id" FROM "brand_user_fields"   WHERE "offer_id" IS NULL
    )
    SELECT p."org_id",
           p."brand_id",
           b."name"   AS brand_name,
           b."domain" AS brand_domain,
           (SELECT array_agg(f."funnel_key" ORDER BY f."funnel_key")
              FROM "brand_sales_funnels" f
             WHERE f."org_id" = p."org_id" AND f."brand_id" = p."brand_id"
               AND f."offer_id" IS NULL) AS funnel_keys,
           (SELECT jsonb_object_agg(u."field_key", u."value")
              FROM "brand_user_fields" u
             WHERE u."org_id" = p."org_id" AND u."brand_id" = p."brand_id"
               AND u."offer_id" IS NULL
               AND u."value" IS NOT NULL) AS user_fields
      FROM pairs p
      JOIN "brands" b ON b."id" = p."brand_id"
     ORDER BY p."brand_id", p."org_id"
  `);

  return [...rows].map((r) => ({
    orgId: r.org_id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    brandDomain: r.brand_domain,
    funnelKeys: r.funnel_keys ?? [],
    userFields: r.user_fields ?? {},
  }));
}

/** Thrown when an offer name cannot be generated for a brand. Never swallowed. */
export class OfferNameGenerationError extends Error {
  constructor(brandId: string, detail: string) {
    super(
      `Could not generate an offer name for brand ${brandId}: ${detail}. ` +
      'Refusing to migrate it under an invented or empty name — the name is what four other ' +
      'services will key their display on. Fix the input or create the offer by hand, then re-run: ' +
      'the migration is idempotent and every other brand keeps the offer it already got.'
    );
    this.name = 'OfferNameGenerationError';
  }
}

const NAMING_SYSTEM_PROMPT =
  'You name the OFFER a business sells — WHAT IT SELLS, in its customer\'s words. ' +
  'The services it lists are the answer whenever it lists any: name those. The rest of the input ' +
  '(its value proposition, who it is for, the business itself) is there to sharpen that name when ' +
  'the services are vague or several, not to replace it. Do not echo a field label back — name ' +
  'the thing, not the category it was filed under. ' +
  `Answer with a name of AT MOST ${OFFER_NAME_MAX_WORDS} words and AT MOST ${OFFER_NAME_MAX_CHARS} ` +
  'characters, in the language the input is written in. ' +
  'Use the words the business itself used wherever they fit. Do not invent a product it never ' +
  'mentioned, do not add a tier or a price, do not add punctuation, and do not answer with the ' +
  "company's own name unless the company name IS what it sells. If the input says too little to " +
  'name anything, answer with an empty string rather than guessing.';

/** The JSON shape chat-service enforces provider-side, so the answer cannot ramble. */
const NAMING_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: `The offer name. At most ${OFFER_NAME_MAX_WORDS} words, at most ${OFFER_NAME_MAX_CHARS} characters. Empty when the input says too little.`,
    },
  },
  required: ['name'],
} as const;

/**
 * What the model is shown. Only what the brand itself stated — its confirmed
 * value proposition and its own identity. Nothing derived, nothing from another
 * brand.
 *
 * The SERVICES lead, because an offer is what the brand sells and that field is
 * the brand's own answer to exactly that question. Everything else follows to
 * sharpen it.
 *
 * THE SALES FUNNELS ARE DELIBERATELY ABSENT. A funnel is how an offer is SOLD —
 * a click onto the site, a reply that becomes a meeting — and an offer is what
 * is sold. Showing them invites a name like "Website Sales" for
 * `website_purchases`, which labels the offer with its delivery mechanism and
 * collapses the two levels this whole entity exists to separate. Do not add
 * them back as "context": the model reads whatever it is given, and a brand
 * that states nothing else would be named after its funnel every time.
 */
export function buildNamingPrompt(candidate: OfferMigrationCandidate): string {
  const lines: string[] = [];

  const services = candidate.userFields.services;
  const renderedServices = Array.isArray(services) ? services.join('; ') : String(services ?? '');
  if (renderedServices.trim() !== '') lines.push(`Services sold: ${renderedServices}`);

  for (const [key, value] of Object.entries(candidate.userFields)) {
    if (key === 'services') continue;
    const rendered = Array.isArray(value) ? value.join('; ') : String(value ?? '');
    if (rendered.trim() !== '') lines.push(`${key}: ${rendered}`);
  }

  if (candidate.brandName) lines.push(`Business name: ${candidate.brandName}`);
  if (candidate.brandDomain) lines.push(`Website: ${candidate.brandDomain}`);

  return lines.join('\n');
}

/**
 * The name for one brand's single offer, generated from what that brand sells.
 *
 * PLATFORM-billed through chat-service: there is no customer org behind a
 * migration, so it takes the `/internal/platform-complete` path. chat-service
 * owns the model, the provider key and the token cost — this service declares
 * no LLM cost of its own and must not, or the same tokens are counted twice.
 *
 * An EMPTY answer is not a failure — it is the answer the system prompt asks
 * for when the input says too little to name anything, and 135 of the 188
 * brands on the platform state no value proposition at all, so it is the
 * COMMON case rather than the edge. Those get `DEFAULT_OFFER_NAME`, which the
 * owner picked precisely for it. Aborting the migration there would block it on
 * the majority of the platform over a case the design anticipated.
 *
 * A name that BREAKS A LIMIT gets one more turn with the broken rule quoted
 * back. Language models count words badly and correct well once told, and this
 * is worth a call rather than a stop: "Dinner with Docs" is a good name that is
 * one word too long, and losing it would be worse than asking again. Twice
 * unable, the brand takes the default and is reported by id.
 *
 * An answer carrying NO NAME FIELD still throws. The schema makes it required,
 * so its absence is a broken call rather than an answer we can judge — and
 * there is still no fallback to the brand's own name and no truncation of an
 * over-long answer, because a name nobody chose, on a row four other services
 * key their display on, is worse than a migration that says where it stopped.
 */
export async function generateOfferName(
  candidate: OfferMigrationCandidate
): Promise<string> {
  const message = buildNamingPrompt(candidate);
  // Nothing at all to read — do not spend a call to be told so.
  if (message.trim() === '') return DEFAULT_OFFER_NAME;

  const first = await askForOfferName(candidate, message);
  if (first.name !== null) return first.name;

  // The model broke a limit rather than failing to understand. Language models
  // count words badly and correct well once told which rule they broke and by
  // how much, so it gets ONE more turn with its own answer quoted back. This is
  // not a retry of a flaky call: the same prompt at temperature 0 would return
  // the same answer, so re-asking identically would be pure waste.
  const second = await askForOfferName(
    candidate,
    `${message}\n\nYour previous answer was rejected: ${first.problem} ` +
      'Answer again, within the limits, keeping the words the business itself used.'
  );
  if (second.name !== null) return second.name;

  // Twice unable to answer within limits. Take the default rather than stop the
  // migration or mint something of our own: the name is a label a person can
  // rename, and "Default Offer" states honestly that we could not derive one.
  // The brand is reported so it can be named by hand.
  console.warn(
    `[offer-migration] brand ${candidate.brandId} fell back to "${DEFAULT_OFFER_NAME}": ${second.problem}`
  );
  return DEFAULT_OFFER_NAME;
}

/**
 * One naming turn. Returns the name, or the SENTENCE saying why it cannot be
 * stored — the same sentence a person would be shown, which is what makes it
 * usable as the correction handed back to the model.
 *
 * A missing name FIELD is not a rejected answer, it is a broken call: the schema
 * makes it required, so its absence means chat-service did not answer at all.
 * That still throws.
 */
async function askForOfferName(
  candidate: OfferMigrationCandidate,
  message: string
): Promise<{ name: string | null; problem: string }> {
  const result = await chat(
    {
      message,
      systemPrompt: NAMING_SYSTEM_PROMPT,
      provider: 'google',
      model: 'flash',
      responseFormat: 'json',
      responseSchema: NAMING_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      temperature: 0,
      // A two-word answer needs no funnel of thought, and the migration walks
      // every brand on the platform.
      disableThinking: true,
    },
    { mode: 'platform' }
  );

  const raw = result.json?.name;
  if (typeof raw !== 'string') {
    throw new OfferNameGenerationError(
      candidate.brandId,
      `chat-service answered with no name (got ${JSON.stringify(result.json ?? result.content)})`
    );
  }

  const name = normalizeOfferName(raw);
  // The designed "I cannot tell from this" answer, which the system prompt asks
  // for by name. It is the majority case, not an error.
  if (name === '') return { name: DEFAULT_OFFER_NAME, problem: '' };

  const problem = offerNameProblem(name);
  return problem ? { name: null, problem } : { name, problem: '' };
}

/** One offer as created, beside the rows it took over. Read back, not assumed. */
export interface MigratedOffer {
  orgId: string;
  brandId: string;
  offerId: string;
  name: string;
  funnels: number;
  userFields: number;
}

/**
 * Create one brand's offer and move its rows onto it.
 *
 * The name is generated FIRST: if that fails, nothing has been written and the
 * brand is exactly as it was. The offer is then created and the rows adopted by
 * the same `offer_id IS NULL` predicate the candidate reader used, so a row a
 * concurrent write has already claimed is left alone rather than moved twice.
 */
export async function migrateOneBrand(planned: PlannedOffer, stamp: string): Promise<MigratedOffer> {
  const name = await generateOfferName(planned.candidate);
  const offer = await createOffer(planned.orgId, planned.brandId, name, { migratedAt: stamp });
  const moved = await adoptUnmigratedRows(planned.orgId, planned.brandId, offer.offerId);

  return {
    orgId: planned.orgId,
    brandId: planned.brandId,
    offerId: offer.offerId,
    name: offer.name,
    funnels: moved.funnels,
    userFields: moved.userFields,
  };
}

/**
 * Apply the whole plan, one brand at a time.
 *
 * Sequential on purpose: each brand is one LLM call, and a fan-out would spend
 * the platform's rate limit on a job that runs once and is not in a hurry.
 *
 * A brand that cannot be named ABORTS the run rather than being skipped and
 * logged. That is safe precisely because the migration is idempotent — every
 * brand already migrated keeps its offer, and a re-run after the input is fixed
 * picks up exactly where this stopped — and it is what stops a silent partial
 * migration from being mistaken for a complete one.
 */
export async function applyOfferMigration(plan: OfferMigrationPlan): Promise<MigratedOffer[]> {
  const stamp = new Date().toISOString();
  const migrated: MigratedOffer[] = [];

  for (const planned of plan.offers) {
    migrated.push(await migrateOneBrand(planned, stamp));
  }

  return migrated;
}

/**
 * What is left un-migrated, read back from the database rather than inferred
 * from the run's own log. A completed run answers zero on both.
 */
export async function countUnmigratedRows(): Promise<{ funnels: number; userFields: number }> {
  const funnels = await db
    .select({ id: brandSalesFunnels.id })
    .from(brandSalesFunnels)
    .where(isNull(brandSalesFunnels.offerId));
  const userFields = await db
    .select({ id: brandUserFields.id })
    .from(brandUserFields)
    .where(isNull(brandUserFields.offerId));
  return { funnels: funnels.length, userFields: userFields.length };
}

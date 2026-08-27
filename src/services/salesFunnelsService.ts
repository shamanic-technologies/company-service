import { and, eq, notInArray } from 'drizzle-orm';
import { db, brandSalesFunnels } from '../db';
import {
  offerScope,
  resolveOfferForWrite,
  resolveSoleOffer,
} from './brandOffersService';
import {
  SALES_FUNNELS,
  SalesFunnelDef,
  SalesFunnelKey,
  SalesFunnelRateKey,
  SalesFunnelStartEvent,
  funnelMilestoneStepIndex,
  funnelPricesRate,
  funnelRateKeys,
  salesFunnelByKey,
} from './salesFunnelCatalogue';
import {
  funnelKeysForRetiredGoal,
  type RetiredGoal,
  type RetiredGoalContext,
} from '../lib/goal-vocabulary';
import {
  ClickDestinationValidationError,
  assertClickDestinationOnBrandDomain,
  normalizeClickDestinationUrl,
} from './clickDestinationService';

/**
 * The sales funnels a brand DECLARES it sells through, and the economics of
 * each one.
 *
 * Declaration is explicit and nothing else: a funnel exists for a brand because
 * the brand said so (a row), and every number on it is a number the brand gave
 * us (a non-null column). There is deliberately no defaulting layer here — no
 * cross-brand average, no seeding from `brand_sales_economics`, no "0 means
 * unset". A consumer that needs a stand-in for a value the brand never declared
 * chooses one itself, knowing it is choosing.
 *
 * This is the layer campaign-service arbitration reads: the funnels a brand
 * authorizes and the economics each is ranked on. A funnel carries NO goal —
 * that vocabulary is retired, and the funnel key is the whole answer to "what
 * does this brand sell through?". See `src/lib/goal-vocabulary.ts` for what
 * survives of the goal, which is write tolerance and nothing else.
 */

/**
 * The answer to "which funnels does this org sell this brand through?".
 *
 * An EMPTY list means the org has NEVER answered — a gap a consumer must
 * surface, never "sells through nothing". It cannot mean the latter, because an
 * org that has answered always keeps at least one ACTIVE funnel (switching off
 * the last one is refused), so "answered, but none" is not a reachable state.
 *
 * The ORG read returns every funnel the org has ever configured, active or not,
 * because the inactive ones carry the numbers a user already entered and the
 * screen has to show them. The INTERNAL read returns only the ACTIVE ones —
 * a scheduler asking "what does this org sell through?" must never rank a
 * funnel the org switched off.
 */
export interface DeclaredSalesFunnelSet {
  funnels: DeclaredSalesFunnel[];
}

/** A rate the brand declared, or `null` when it never gave us that number. */
export type FunnelRates = Partial<Record<SalesFunnelRateKey, number | null>>;

/** One declared funnel, as read. Absent values are `null`, never invented. */
export interface DeclaredSalesFunnel {
  funnelKey: SalesFunnelKey;
  /** Whether the org currently sells through this funnel. */
  active: boolean;
  /** Human name of the funnel, from the catalogue. */
  name: string;
  /** The funnel the rates below price. */
  steps: string[];
  /**
   * The event that STARTS this funnel. A consumer matches an acquisition channel
   * against it: a channel that can only produce a phone conversation cannot feed
   * a funnel that starts at a `website_visit`. `steps[0]` is the same event as a
   * label.
   */
  startEvent: SalesFunnelStartEvent;
  /**
   * The step this funnel is NAMED after — its MILESTONE — and where it sits in
   * `steps`. The moment that tells a brand the funnel is working, and what a
   * channel's minimum budget is priced against: one month must pay for at least
   * one of these. Always a member of `steps`, so a consumer reads it instead of
   * hardcoding a funnel-to-step mapping of its own.
   */
  milestoneStep: string;
  milestoneStepIndex: number;
  /**
   * NO GOAL. A funnel used to carry one beside its key, and it is retired: it
   * was the poorer word (both meeting funnels mapped onto one `meetingBooked`,
   * so no consumer could price them apart). The KEY is the whole answer.
   */
  /** Exactly the rates THIS funnel's funnel prices, in funnel order. */
  rates: Record<string, number | null>;
  lifetimeRevenueUsd: number | null;
  destinationUrl: string | null;
  bookingUrl: string | null;
  updatedAt: string;
}

/**
 * WRITE shape: a PARTIAL patch. An OMITTED field is left exactly as stored; an
 * explicit `null` CLEARS the value back to never-declared. The distinction is
 * the point — a screen editing one rate must not restate the others from a
 * possibly-stale copy, and a user removing a number must be able to remove it
 * rather than being forced to invent a replacement.
 */
export interface SalesFunnelPatch {
  /** Switch the funnel on or off. Omitted = leave as stored (true on create). */
  active?: boolean;
  rates?: FunnelRates;
  lifetimeRevenueUsd?: number | null;
  destinationUrl?: string | null;
  bookingUrl?: string | null;
}

/** Thrown when a patch names a rate outside the funnel's own funnel (→ 400). */
export class SalesFunnelRateNotInFunnelError extends Error {
  constructor(
    public readonly funnelKey: SalesFunnelKey,
    public readonly rateKeys: string[]
  ) {
    super(
      `Funnel "${funnelKey}" does not price ${rateKeys.join(', ')}. ` +
      'A rate that is not a leg of this funnel\'s funnel is rejected rather than stored where nothing would ever read it.'
    );
    this.name = 'SalesFunnelRateNotInFunnelError';
  }
}

/** Thrown when a patch sets a destination the funnel has no use for (→ 400). */
export class SalesFunnelDestinationNotUsedError extends Error {
  constructor(funnelKey: SalesFunnelKey, field: 'destinationUrl' | 'bookingUrl') {
    super(
      `Funnel "${funnelKey}" has no ${field}: its funnel neither lands a click on the brand's site nor contains a meeting.`
    );
    this.name = 'SalesFunnelDestinationNotUsedError';
  }
}

/** Thrown when a website-led funnel is declared on a brand with no site (→ 400). */
export class SalesFunnelRequiresWebsiteError extends Error {
  constructor(funnelKey: SalesFunnelKey) {
    super(
      `Funnel "${funnelKey}" starts with a click onto the brand's website, so it cannot be declared for a brand that has no website.`
    );
    this.name = 'SalesFunnelRequiresWebsiteError';
  }
}

/**
 * A booking link sits on a third-party scheduler, so only the URL SHAPE is
 * checked — never the domain. Fails loud; the route maps it to a 400.
 */
export function normalizeBookingUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new ClickDestinationValidationError('bookingUrl must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ClickDestinationValidationError(
      'bookingUrl must be a valid URL (e.g. https://cal.com/yourteam/30min)'
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ClickDestinationValidationError('bookingUrl must use http or https');
  }
  if (!parsed.hostname.includes('.')) {
    throw new ClickDestinationValidationError(
      'bookingUrl must be a valid URL (e.g. https://cal.com/yourteam/30min)'
    );
  }
  return parsed.toString();
}

/**
 * Reject a patch that names a rate the funnel's funnel does not convert at, or a
 * destination it has no use for. Fail loud rather than dropping the field: a
 * silently-ignored write reads back as "the brand never declared it".
 */
export function assertPatchFitsFunnel(def: SalesFunnelDef, patch: SalesFunnelPatch): void {
  const foreign = Object.keys(patch.rates ?? {}).filter(
    (key) => !funnelPricesRate(def, key as SalesFunnelRateKey)
  );
  if (foreign.length > 0) {
    throw new SalesFunnelRateNotInFunnelError(def.key, foreign);
  }
  if (patch.destinationUrl !== undefined && !def.pageDestination) {
    throw new SalesFunnelDestinationNotUsedError(def.key, 'destinationUrl');
  }
  if (patch.bookingUrl !== undefined && !def.bookingLink) {
    throw new SalesFunnelDestinationNotUsedError(def.key, 'bookingUrl');
  }
}

type FunnelRow = typeof brandSalesFunnels.$inferSelect;

/**
 * Read a stored row as the funnel it declares. Only the funnel's OWN rates are
 * projected — the columns a funnel does not price are not its business, and
 * emitting them as null would read as "this funnel has that leg, unfilled".
 */
export function formatDeclaredFunnel(row: FunnelRow): DeclaredSalesFunnel {
  const def = salesFunnelByKey(row.funnelKey as SalesFunnelKey);
  const rates: Record<string, number | null> = {};
  for (const key of funnelRateKeys(def)) {
    rates[key] = row[key] ?? null;
  }
  return {
    funnelKey: def.key,
    active: row.active,
    name: def.name,
    steps: def.steps,
    startEvent: def.startEvent,
    milestoneStep: def.milestoneStep,
    // Fails loud on a funnel whose milestone is not one of its steps, rather
    // than answering 0 — which is a real position in the funnel, the start event.
    milestoneStepIndex: funnelMilestoneStepIndex(def),
    rates,
    lifetimeRevenueUsd: row.lifetimeRevenueUsd ?? null,
    destinationUrl: row.destinationUrl ?? null,
    bookingUrl: row.bookingUrl ?? null,
    updatedAt: row.updatedAt,
  };
}

/** Catalogue order, so two reads of the same brand never disagree on order. */
function byCatalogueOrder(a: DeclaredSalesFunnel, b: DeclaredSalesFunnel): number {
  const order = SALES_FUNNELS.map((f) => f.key);
  return order.indexOf(a.funnelKey) - order.indexOf(b.funnelKey);
}

/**
 * The column set an upsert writes. Only the keys the patch actually carries are
 * present, so an omitted field never appears in the UPDATE and is preserved,
 * while an explicit `null` is written and clears the value.
 */
export function buildFunnelWrite(
  patch: SalesFunnelPatch
): Partial<Record<string, number | string | boolean | null>> {
  const write: Partial<Record<string, number | string | boolean | null>> = {};
  if (patch.active !== undefined) write.active = patch.active;
  for (const [key, value] of Object.entries(patch.rates ?? {})) {
    write[key] = value ?? null;
  }
  if (patch.lifetimeRevenueUsd !== undefined) {
    write.lifetimeRevenueUsd = patch.lifetimeRevenueUsd;
  }
  if (patch.destinationUrl !== undefined) write.destinationUrl = patch.destinationUrl;
  if (patch.bookingUrl !== undefined) write.bookingUrl = patch.bookingUrl;
  return write;
}

/** Thrown when a write would leave the org selling through nothing (→ 400). */
export class LastActiveSalesFunnelError extends Error {
  constructor(funnelKey?: SalesFunnelKey) {
    super(
      funnelKey
        ? `Funnel "${funnelKey}" is the last one still active: an org that sells this brand must keep at least one funnel on.`
        : 'An org that sells this brand must keep at least one funnel on.'
    );
    this.name = 'LastActiveSalesFunnelError';
  }
}

/**
 * Thrown when a caller sends a retired goal that names no funnel at all (→ 400).
 *
 * Only `whatsappConversation` reaches this: the catalogue has no whatsapp funnel,
 * so there is nothing the goal could declare. Fail loud rather than accept a
 * write that would silently declare nothing — a 200 there would tell the caller
 * the brand now sells through something it does not.
 */
export class RetiredGoalNamesNoFunnelError extends Error {
  constructor(public readonly goal: RetiredGoal) {
    super(
      `The goal "${goal}" names no sales funnel: the catalogue has no funnel for it, so there is ` +
      'nothing it can declare. State the funnels this brand sells through instead.'
    );
    this.name = 'RetiredGoalNamesNoFunnelError';
  }
}

/**
 * Resolve a retired goal to the funnel(s) it named, or throw.
 *
 * Separate from the write so a caller can settle "can this goal be honoured?"
 * BEFORE it starts writing anything of its own. The sales-economics PUT needs
 * that: it stores metrics and declares a funnel in one call, and a goal that
 * cannot be declared has to reject the whole thing rather than leave the metrics
 * saved under a word that says nothing.
 *
 * Returns the keys so the caller does not resolve the mapping twice.
 */
export function assertRetiredGoalDeclarable(
  goal: RetiredGoal,
  context: RetiredGoalContext,
  brandDomain: string | null
): SalesFunnelKey[] {
  const keys = funnelKeysForRetiredGoal(goal, context);
  if (keys.length === 0) throw new RetiredGoalNamesNoFunnelError(goal);

  for (const key of keys) {
    const def = salesFunnelByKey(key);
    if (def.requiresWebsite && !brandDomain) {
      throw new SalesFunnelRequiresWebsiteError(key);
    }
  }

  return keys;
}

export class SalesFunnelsService {
  /**
   * Every funnel THIS org has configured on THIS brand, in catalogue order —
   * active and inactive alike, because an inactive one still carries the numbers
   * the user entered and the screen has to show them. `[]` = never answered.
   */
  async readByBrandId(orgId: string, brandId: string): Promise<DeclaredSalesFunnelSet> {
    return this.readByOfferId(orgId, brandId, await resolveSoleOffer(orgId, brandId));
  }

  /** The same read, for ONE named offer. `null` = the rows no offer owns yet. */
  async readByOfferId(
    orgId: string,
    brandId: string,
    offerId: string | null
  ): Promise<DeclaredSalesFunnelSet> {
    const rows = await db
      .select()
      .from(brandSalesFunnels)
      .where(
        and(
          eq(brandSalesFunnels.orgId, orgId),
          eq(brandSalesFunnels.brandId, brandId),
          offerScope(brandSalesFunnels.offerId, offerId)
        )
      );

    return { funnels: rows.map(formatDeclaredFunnel).sort(byCatalogueOrder) };
  }

  /**
   * Only the funnels the org currently sells through. This is what a scheduler
   * asks for: a funnel switched off must never be ranked. `[]` = never answered,
   * which is a gap to surface — it can never mean "sells through nothing",
   * because the last active funnel cannot be switched off.
   */
  async readActiveByBrandId(orgId: string, brandId: string): Promise<DeclaredSalesFunnelSet> {
    return this.readActiveByOfferId(orgId, brandId, await resolveSoleOffer(orgId, brandId));
  }

  /** The active-only read, for ONE named offer. */
  async readActiveByOfferId(
    orgId: string,
    brandId: string,
    offerId: string | null
  ): Promise<DeclaredSalesFunnelSet> {
    const rows = await db
      .select()
      .from(brandSalesFunnels)
      .where(
        and(
          eq(brandSalesFunnels.orgId, orgId),
          eq(brandSalesFunnels.brandId, brandId),
          offerScope(brandSalesFunnels.offerId, offerId),
          eq(brandSalesFunnels.active, true)
        )
      );

    return { funnels: rows.map(formatDeclaredFunnel).sort(byCatalogueOrder) };
  }

  /** The funnel keys this org currently sells this brand through. */
  private async activeKeys(
    orgId: string,
    brandId: string,
    offerId: string | null
  ): Promise<SalesFunnelKey[]> {
    const rows = await db
      .select({ funnelKey: brandSalesFunnels.funnelKey })
      .from(brandSalesFunnels)
      .where(
        and(
          eq(brandSalesFunnels.orgId, orgId),
          eq(brandSalesFunnels.brandId, brandId),
          offerScope(brandSalesFunnels.offerId, offerId),
          eq(brandSalesFunnels.active, true)
        )
      );
    return rows.map((r) => r.funnelKey as SalesFunnelKey);
  }

  /**
   * Configure one funnel and write what the caller sent. Idempotent.
   *
   * `active` defaults to true on a first write (configuring a funnel is saying
   * you sell through it) and is left as stored otherwise. Switching one OFF
   * keeps the row and every number on it, so switching it back on returns what
   * the user already entered — but the LAST active funnel cannot be switched
   * off, because an org that has answered always sells through something.
   */
  async declareByBrandId(
    orgId: string,
    brandId: string,
    funnelKey: SalesFunnelKey,
    patch: SalesFunnelPatch,
    brandDomain: string | null
  ): Promise<DeclaredSalesFunnel> {
    return this.declareByOfferId(
      orgId,
      brandId,
      await resolveOfferForWrite(orgId, brandId),
      funnelKey,
      patch,
      brandDomain
    );
  }

  /** The same write, against ONE named offer. */
  async declareByOfferId(
    orgId: string,
    brandId: string,
    offerId: string,
    funnelKey: SalesFunnelKey,
    patch: SalesFunnelPatch,
    brandDomain: string | null
  ): Promise<DeclaredSalesFunnel> {
    const def = salesFunnelByKey(funnelKey);
    if (patch.active !== false && def.requiresWebsite && !brandDomain) {
      throw new SalesFunnelRequiresWebsiteError(funnelKey);
    }
    assertPatchFitsFunnel(def, patch);

    if (patch.active === false) {
      const active = await this.activeKeys(orgId, brandId, offerId);
      if (active.length === 1 && active[0] === funnelKey) {
        throw new LastActiveSalesFunnelError(funnelKey);
      }
    }

    const normalized: SalesFunnelPatch = { ...patch };
    if (typeof patch.destinationUrl === 'string') {
      const url = normalizeClickDestinationUrl(patch.destinationUrl);
      if (brandDomain) assertClickDestinationOnBrandDomain(url, brandDomain);
      normalized.destinationUrl = url;
    }
    if (typeof patch.bookingUrl === 'string') {
      normalized.bookingUrl = normalizeBookingUrl(patch.bookingUrl);
    }

    const write = buildFunnelWrite(normalized);

    const [row] = await db
      .insert(brandSalesFunnels)
      .values({ orgId, brandId, offerId, funnelKey, ...write })
      .onConflictDoUpdate({
        // The natural key is the OFFER and the funnel: two offers of one brand
        // legitimately sell through the same funnel at different rates.
        target: [brandSalesFunnels.offerId, brandSalesFunnels.funnelKey],
        // Only the columns the patch carries are named, so an omitted field is
        // left exactly as stored and an explicit null clears it.
        set: { ...write, updatedAt: new Date().toISOString() },
      })
      .returning();

    return formatDeclaredFunnel(row);
  }

  /**
   * State the WHOLE set: exactly these funnels are active, every other one the
   * org has configured is switched off but KEPT with its numbers intact.
   *
   * The list may not be empty — an org that has answered sells through at least
   * one funnel. The set is validated whole before anything is written, so a
   * member that cannot apply rejects the call with nothing half-applied.
   */
  async statesetByBrandId(
    orgId: string,
    brandId: string,
    funnelKeys: SalesFunnelKey[],
    brandDomain: string | null
  ): Promise<DeclaredSalesFunnelSet> {
    return this.statesetByOfferId(
      orgId,
      brandId,
      await resolveOfferForWrite(orgId, brandId),
      funnelKeys,
      brandDomain
    );
  }

  /** The same whole-set write, against ONE named offer. */
  async statesetByOfferId(
    orgId: string,
    brandId: string,
    offerId: string,
    funnelKeys: SalesFunnelKey[],
    brandDomain: string | null
  ): Promise<DeclaredSalesFunnelSet> {
    const keys = [...new Set(funnelKeys)];
    if (keys.length === 0) throw new LastActiveSalesFunnelError();

    for (const key of keys) {
      const def = salesFunnelByKey(key);
      if (def.requiresWebsite && !brandDomain) {
        throw new SalesFunnelRequiresWebsiteError(key);
      }
    }

    // Everything outside the set is switched OFF, never deleted: its numbers are
    // the memory a user gets back if they switch it on again.
    await db
      .update(brandSalesFunnels)
      .set({ active: false, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(brandSalesFunnels.orgId, orgId),
          eq(brandSalesFunnels.brandId, brandId),
          offerScope(brandSalesFunnels.offerId, offerId),
          notInArray(brandSalesFunnels.funnelKey, keys)
        )
      );

    // Members already configured keep everything they were priced with.
    await db
      .insert(brandSalesFunnels)
      .values(keys.map((funnelKey) => ({ orgId, brandId, offerId, funnelKey, active: true })))
      .onConflictDoUpdate({
        target: [brandSalesFunnels.offerId, brandSalesFunnels.funnelKey],
        set: { active: true, updatedAt: new Date().toISOString() },
      });

    return this.readByOfferId(orgId, brandId, offerId);
  }

  /**
   * WRITE TOLERANCE for the retired goal vocabulary: declare the funnel(s) a
   * goal a caller sent MEANT, and answer with the funnel set.
   *
   * A caller still sending yesterday's word keeps working, and what it gets back
   * is a funnel — the only vocabulary this service emits. The mapping is
   * `funnelKeysForRetiredGoal`, the same one the one-time backfill inverted, so
   * a brand lands on the same declaration whichever way its goal arrived.
   *
   * ADDITIVE, never destructive. It switches the named funnels ON and leaves
   * every other declaration exactly as stored, numbers included. A goal was one
   * word and the model is multi-funnel, so treating a goal write as "these and
   * only these" would silently switch off a funnel the org stated deliberately
   * through the funnel routes. Stating the whole set is what `statesetByBrandId`
   * is for, and it is the only thing that switches a funnel off.
   */
  async declareFromRetiredGoal(
    orgId: string,
    brandId: string,
    goal: RetiredGoal,
    context: RetiredGoalContext,
    brandDomain: string | null
  ): Promise<DeclaredSalesFunnelSet> {
    const keys = assertRetiredGoalDeclarable(goal, context, brandDomain);
    const offerId = await resolveOfferForWrite(orgId, brandId);

    await db
      .insert(brandSalesFunnels)
      .values(keys.map((funnelKey) => ({ orgId, brandId, offerId, funnelKey, active: true })))
      .onConflictDoUpdate({
        target: [brandSalesFunnels.offerId, brandSalesFunnels.funnelKey],
        // Only `active` is named: a funnel the org already priced keeps every
        // number on it.
        set: { active: true, updatedAt: new Date().toISOString() },
      });

    return this.readByOfferId(orgId, brandId, offerId);
  }

  /**
   * Switch a funnel off. The row and every number on it SURVIVE — that is the
   * point: a user who switches it back on finds what they already entered.
   * Refused when it is the last active one. Returns true when something changed.
   */
  async deactivateByBrandId(
    orgId: string,
    brandId: string,
    funnelKey: SalesFunnelKey
  ): Promise<boolean> {
    return this.deactivateByOfferId(
      orgId,
      brandId,
      await resolveSoleOffer(orgId, brandId),
      funnelKey
    );
  }

  /** The same switch-off, against ONE named offer. */
  async deactivateByOfferId(
    orgId: string,
    brandId: string,
    offerId: string | null,
    funnelKey: SalesFunnelKey
  ): Promise<boolean> {
    const active = await this.activeKeys(orgId, brandId, offerId);
    if (active.length === 1 && active[0] === funnelKey) {
      throw new LastActiveSalesFunnelError(funnelKey);
    }

    const updated = await db
      .update(brandSalesFunnels)
      .set({ active: false, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(brandSalesFunnels.orgId, orgId),
          eq(brandSalesFunnels.brandId, brandId),
          offerScope(brandSalesFunnels.offerId, offerId),
          eq(brandSalesFunnels.funnelKey, funnelKey)
        )
      )
      .returning({ funnelKey: brandSalesFunnels.funnelKey });

    return updated.length > 0;
  }

  /**
   * FORGET the funnel: delete the row and every number on it. This is the only
   * path that destroys what a user entered, and it exists so that a deliberate
   * "forget what I told you about this" stays possible now that an ordinary
   * deselect only switches the funnel off.
   *
   * It is refused (400) when it would leave the org holding funnel rows with
   * NONE of them active — the same invariant `deactivate` protects, since a
   * state of "answered, but sells through nothing" is not reachable and must
   * not become reachable through erasure. Erasing the LAST remaining row is
   * therefore allowed and is the one way back to "never answered": nothing is
   * left to be inconsistent with.
   *
   * Returns true when a row was actually erased (erasing what is not there is a
   * no-op, not an error).
   */
  async eraseByBrandId(
    orgId: string,
    brandId: string,
    funnelKey: SalesFunnelKey
  ): Promise<boolean> {
    return this.eraseByOfferId(
      orgId,
      brandId,
      await resolveSoleOffer(orgId, brandId),
      funnelKey
    );
  }

  /** The same erasure, against ONE named offer. */
  async eraseByOfferId(
    orgId: string,
    brandId: string,
    offerId: string | null,
    funnelKey: SalesFunnelKey
  ): Promise<boolean> {
    const rows = await db
      .select({ funnelKey: brandSalesFunnels.funnelKey, active: brandSalesFunnels.active })
      .from(brandSalesFunnels)
      .where(
        and(
          eq(brandSalesFunnels.orgId, orgId),
          eq(brandSalesFunnels.brandId, brandId),
          offerScope(brandSalesFunnels.offerId, offerId)
        )
      );

    const survivors = rows.filter((r) => r.funnelKey !== funnelKey);
    if (survivors.length > 0 && !survivors.some((r) => r.active)) {
      throw new LastActiveSalesFunnelError(funnelKey);
    }

    const deleted = await db
      .delete(brandSalesFunnels)
      .where(
        and(
          eq(brandSalesFunnels.orgId, orgId),
          eq(brandSalesFunnels.brandId, brandId),
          offerScope(brandSalesFunnels.offerId, offerId),
          eq(brandSalesFunnels.funnelKey, funnelKey)
        )
      )
      .returning({ funnelKey: brandSalesFunnels.funnelKey });

    return deleted.length > 0;
  }
}

export const salesFunnelsService = new SalesFunnelsService();

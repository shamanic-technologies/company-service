import { Router, Request, Response } from 'express';
import { DeclareSalesFunnelRequestSchema, StateSalesFunnelSetRequestSchema } from '../schemas';
import {
  UUID_REGEX,
  resolveBrandOwnership,
  rejectOwnership,
} from '../lib/brand-ownership';
import { getBrand } from '../services/brandService';
import { SALES_FUNNEL_KEYS, toSalesFunnelKey, SalesFunnelKey } from '../services/salesFunnelCatalogue';
import {
  SalesFunnelDestinationNotUsedError,
  SalesFunnelRateNotInChainError,
  SalesFunnelRequiresWebsiteError,
  LastActiveSalesFunnelError,
  RetiredGoalNamesNoFunnelError,
  salesFunnelsService,
} from '../services/salesFunnelsService';
import { ClickDestinationValidationError } from '../services/clickDestinationService';
import { resolveInternalOrgScope, rejectInternalOrgScope } from '../lib/internal-org-scope';
import { OfferNotFoundError } from '../services/brandOffersService';
import { rejectOfferProblem } from '../lib/offer-scope';

export const orgRouter = Router();
export const internalRouter = Router();

/**
 * The sales funnels a brand sells through, and the economics of each.
 *
 * The declared SET is the answer to "which ways does this brand sell?", and it
 * can only be declared — it is not derivable from anything else brand-service
 * stores, because every rate on `brand_sales_economics` is NOT NULL with a
 * server default, so a brand that configured nothing still reads back
 * plausible-looking numbers there and no absence signals anything.
 */

/**
 * Resolve a funnel key from the path, or write the 400 and return null.
 *
 * Accepts the pre-retirement spellings (`reply_meeting`, `visit_meeting`,
 * `visit_signup`, `visit_form`) forever and resolves them to the canonical key —
 * a caller still sending yesterday's word keeps working, and reads back the
 * canonical one.
 */
function parseFunnelKey(req: Request, res: Response): SalesFunnelKey | null {
  const resolved = toSalesFunnelKey(req.params.funnelKey);
  if (!resolved) {
    res.status(400).json({
      error:
        `Unknown sales funnel "${req.params.funnelKey}": expected one of ` +
        SALES_FUNNEL_KEYS.join(', '),
    });
    return null;
  }
  return resolved;
}

/**
 * Read the `erase` flag off a DELETE, or write the 400 and return null.
 *
 * Absent is the ordinary deselect (false). Only the exact string `true` asks for
 * the destructive path — anything else is rejected rather than read as "no",
 * because a caller that mistyped the one flag that destroys data deserves to
 * hear about it instead of quietly getting the other behaviour.
 */
export function parseEraseFlag(req: Request, res: Response): boolean | null {
  const raw = req.query.erase;
  if (raw === undefined) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  res.status(400).json({
    error: 'Invalid "erase": expected true or false. Omit it to switch the funnel off and keep its economics.',
  });
  return null;
}

/**
 * Map a declaration failure to its 400. Every one of these is the caller
 * describing a funnel that does not exist as described — never something to
 * clean up and store anyway.
 */
function rejectDeclaration(res: Response, error: unknown): boolean {
  // A brand-scoped call against a brand holding SEVERAL offers has no single
  // answer — 409, naming the offer routes, rather than a guess.
  if (rejectOfferProblem(res, error)) return true;
  if (
    error instanceof SalesFunnelRateNotInChainError ||
    error instanceof SalesFunnelDestinationNotUsedError ||
    error instanceof SalesFunnelRequiresWebsiteError ||
    error instanceof LastActiveSalesFunnelError ||
    error instanceof RetiredGoalNamesNoFunnelError ||
    error instanceof ClickDestinationValidationError
  ) {
    res.status(400).json({ error: (error as Error).message });
    return true;
  }
  return false;
}

/**
 * GET /orgs/brands/:brandId/sales-funnels
 * `{ funnels }` — every funnel this org has configured on this brand, ACTIVE and
 * retired alike, each carrying `active`. A retired one still holds the numbers
 * the user entered, which is what the screen has to show. An empty list means
 * the org has never answered.
 */
orgRouter.get('/brands/:brandId/sales-funnels', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    let set;
    try {
      set = await salesFunnelsService.readByBrandId(req.orgId!, brandId);
    } catch (error) {
      if (rejectOfferProblem(res, error)) return;
      throw error;
    }
    return res.status(200).json(set);
  } catch (error: any) {
    console.error('[brand-service] Get sales funnels error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * PUT /orgs/brands/:brandId/sales-funnels
 * State the WHOLE set: exactly these funnels are active, no others. Funnels
 * already in the set keep their economics; funnels dropped from it are switched
 * OFF and keep theirs too, so putting one back returns what the user entered.
 *
 * The list may not be empty — an org that has answered sells through at least
 * one funnel, which is what leaves zero rows as the only way to say "never
 * answered".
 */
orgRouter.put('/brands/:brandId/sales-funnels', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    const parsed = StateSalesFunnelSetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    const brand = await getBrand(brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // A pre-retirement spelling is resolved here; the schema already refused
    // anything that names no funnel, so every entry maps.
    const funnelKeys = parsed.data.funnelKeys.map(
      (key) => toSalesFunnelKey(key) as SalesFunnelKey
    );

    let set;
    try {
      set = await salesFunnelsService.statesetByBrandId(
        req.orgId!,
        brandId,
        funnelKeys,
        brand.domain ?? null
      );
    } catch (error) {
      if (rejectDeclaration(res, error)) return;
      throw error;
    }

    return res.status(200).json(set);
  } catch (error: any) {
    console.error('[brand-service] State sales funnel set error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * PUT /orgs/brands/:brandId/sales-funnels/:funnelKey
 * Declare the funnel and write what the caller sent of its economics.
 * Idempotent; PARTIAL (omit = leave unchanged, `null` = clear).
 */
orgRouter.put('/brands/:brandId/sales-funnels/:funnelKey', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const funnelKey = parseFunnelKey(req, res);
    if (!funnelKey) return;

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    const parsed = DeclareSalesFunnelRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    // Ownership already proved the brand exists; its domain is what a page
    // destination must sit on, and its absence is what blocks a website-led funnel.
    const brand = await getBrand(brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    let funnel;
    try {
      funnel = await salesFunnelsService.declareByBrandId(
        req.orgId!,
        brandId,
        funnelKey,
        parsed.data,
        brand.domain ?? null
      );
    } catch (error) {
      if (rejectDeclaration(res, error)) return;
      throw error;
    }

    return res.status(200).json({ funnel });
  } catch (error: any) {
    console.error('[brand-service] Declare sales funnel error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * DELETE /orgs/brands/:brandId/sales-funnels/:funnelKey
 * Switch the funnel OFF. The row and its numbers SURVIVE, so switching it back
 * on returns what the user already entered. Refused when it is the last active
 * one. Returns the whole set so the caller renders what it just created.
 *
 * `?erase=true` instead FORGETS the funnel — the row and every number on it are
 * deleted. It is opt-in precisely because it is the destructive one: an ordinary
 * deselect must never take a user's numbers with it, and a caller that means to
 * destroy them has to say so.
 */
orgRouter.delete('/brands/:brandId/sales-funnels/:funnelKey', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const funnelKey = parseFunnelKey(req, res);
    if (!funnelKey) return;

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    const erase = parseEraseFlag(req, res);
    if (erase === null) return;

    try {
      if (erase) {
        await salesFunnelsService.eraseByBrandId(req.orgId!, brandId, funnelKey);
      } else {
        await salesFunnelsService.deactivateByBrandId(req.orgId!, brandId, funnelKey);
      }
    } catch (error) {
      if (rejectDeclaration(res, error)) return;
      throw error;
    }
    const set = await salesFunnelsService.readByBrandId(req.orgId!, brandId);
    return res.status(200).json(set);
  } catch (error: any) {
    if (rejectOfferProblem(res, error)) return;
    console.error('[brand-service] Undeclare sales funnel error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * GET /internal/brands/:brandId/sales-funnels
 * Service-auth read of the funnels a brand AUTHORIZES, keyed by brandId with no
 * org context — what campaign-service arbitration ranks over.
 *
 * An unknown or unclaimed brand simply has nothing configured, and answers with
 * an empty set — the same contract the internal sales-economics read has always
 * had.
 *
 * `?offerId=` names WHICH offer's funnels the caller wants, and is what lets a
 * consumer price a lead with the economics of the thing it is actually being
 * sold: each offer carries its own lifetime revenue and its own rates, so a
 * brand-wide answer would be an average across everything the brand sells.
 * features-service holds the offer a lead belongs to and could not say so.
 * Omitted keeps today's answer exactly, including the deliberate 409 for a
 * brand that has stated several offers.
 */
internalRouter.get('/brands/:brandId/sales-funnels', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const rawOfferId = req.query.offerId;
    const offerId = typeof rawOfferId === 'string' && rawOfferId.length > 0 ? rawOfferId : undefined;
    if (offerId !== undefined && !UUID_REGEX.test(offerId)) {
      return res.status(400).json({ error: 'Invalid offer ID format: must be a UUID' });
    }

    // An unknown or unclaimed brand simply has nothing configured. Unset is a
    // 200 with an empty set here, never a 404 — the same contract the internal
    // sales-economics read has always had.
    const scope = await resolveInternalOrgScope(req, brandId);
    if (rejectInternalOrgScope(res, scope)) return;

    // ACTIVE only: a scheduler asking what this org sells through must never
    // rank a funnel the org switched off.
    let set;
    try {
      if (scope.orgId) {
        set = await salesFunnelsService.readActiveByNamedOffer(scope.orgId, brandId, offerId);
      } else if (offerId) {
        // Nobody claims this brand, so no offer can be PROVED to belong to it.
        // The unclaimed-brand contract is an empty set for a caller that named
        // nothing; a caller that named an offer asked a question about a
        // proposition we cannot attach to this brand, and swapping it for the
        // brand's own rows is exactly the silent substitution this refuses.
        throw new OfferNotFoundError(offerId);
      } else {
        set = { funnels: [] };
      }
    } catch (error) {
      if (rejectOfferProblem(res, error)) return;
      throw error;
    }
    return res.status(200).json(set);
  } catch (error: any) {
    console.error('[brand-service] Internal get sales funnels error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export default orgRouter;

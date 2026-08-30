import { Router, Request, Response } from 'express';
import {
  CreateOfferRequestSchema,
  DeclareSalesFunnelRequestSchema,
  PutUserFieldsRequestSchema,
  RenameOfferRequestSchema,
  StateSalesFunnelSetRequestSchema,
} from '../schemas';
import { UUID_REGEX, resolveBrandOwnership, rejectOwnership } from '../lib/brand-ownership';
import { rejectOfferProblem } from '../lib/offer-scope';
import { getBrand } from '../services/brandService';
import {
  assertOfferOnBrand,
  createOffer,
  getOfferById,
  listOffers,
  renameOffer,
} from '../services/brandOffersService';
import { toSalesFunnelKey, SALES_FUNNEL_KEYS, SalesFunnelKey } from '../services/salesFunnelCatalogue';
import {
  SalesFunnelDestinationNotUsedError,
  SalesFunnelRateNotInFunnelError,
  SalesFunnelRequiresWebsiteError,
  LastActiveSalesFunnelError,
  RetiredGoalNamesNoFunnelError,
  salesFunnelsService,
} from '../services/salesFunnelsService';
import { SalesFunnelArrowInvalidError } from '../services/salesFunnelArrowRatesService';
import { ClickDestinationValidationError } from '../services/clickDestinationService';
import {
  getUserFieldsViewByOfferId,
  upsertUserFieldsByOfferId,
  UnknownUserFieldKeyError,
} from '../services/brandUserFieldsService';
import { parseEraseFlag } from './sales-funnels.routes';
import { resolveInternalOrgScope, rejectInternalOrgScope } from '../lib/internal-org-scope';

export const orgRouter = Router();
export const internalRouter = Router();

/**
 * OFFERS — the things a brand sells, and everything scoped to one of them.
 *
 * A brand is an IDENTITY; an offer is a PROPOSITION. Its value (the 7 Hormozi
 * user-fields) and the funnels it is sold through, with their rates, lifetime
 * revenue and destinations, all hang off the offer — so a brand selling a $200
 * self-serve plan and a $20k contract prices each one for what it is.
 *
 * These routes are the SAME operations the brand-scoped ones expose, with the
 * offer named instead of guessed. The brand-scoped routes are unchanged and
 * still answer byte-for-byte what they always did, resolving the brand's one
 * offer; they refuse 409 when there is more than one, and that refusal points
 * here. There is NO PRIMARY OFFER: several run at once and none outranks
 * another.
 */

/** Resolve `:offerId` under the caller's brand, or write the 400/404 and return null. */
async function resolveOfferParam(
  req: Request,
  res: Response
): Promise<{ brandId: string; offerId: string } | null> {
  const { brandId, offerId } = req.params;
  if (!UUID_REGEX.test(brandId)) {
    res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    return null;
  }
  if (!UUID_REGEX.test(offerId)) {
    res.status(400).json({ error: 'Invalid offer ID format: must be a UUID' });
    return null;
  }

  const ownership = await resolveBrandOwnership(brandId, req.orgId!);
  if (rejectOwnership(res, ownership)) return null;

  try {
    await assertOfferOnBrand(req.orgId!, brandId, offerId);
  } catch (error) {
    if (rejectOfferProblem(res, error)) return null;
    throw error;
  }
  return { brandId, offerId };
}

/** Resolve a funnel key from the path, accepting the pre-retirement spellings. */
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

/** Every declaration failure is the caller describing a funnel that is not there. */
function rejectDeclaration(res: Response, error: unknown): boolean {
  if (rejectOfferProblem(res, error)) return true;
  if (
    error instanceof SalesFunnelRateNotInFunnelError ||
    error instanceof SalesFunnelArrowInvalidError ||
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

// ── The offers themselves ───────────────────────────────────────────────────

/**
 * GET /orgs/brands/:brandId/offers
 * Every offer this org sells under this brand, oldest first. `[]` means the org
 * has never stated one, which is not an error — a brand that sells nothing yet.
 * The order is stable and implies NO rank: there is no primary offer.
 */
orgRouter.get('/brands/:brandId/offers', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    return res.status(200).json({ offers: await listOffers(req.orgId!, brandId) });
  } catch (error: any) {
    console.error('[brand-service] List offers error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * POST /orgs/brands/:brandId/offers
 * Create an offer. The name is at most 2 words and at most 20 characters, and
 * is unique within the brand — a name already taken is a 409, never a name we
 * suffix a number onto. The new offer starts with NOTHING: no funnel, no
 * confirmed field. It is independent of every other offer on the brand.
 */
orgRouter.post('/brands/:brandId/offers', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const parsed = CreateOfferRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    try {
      const offer = await createOffer(req.orgId!, brandId, parsed.data.name);
      return res.status(201).json({ offer });
    } catch (error) {
      if (rejectOfferProblem(res, error)) return;
      throw error;
    }
  } catch (error: any) {
    console.error('[brand-service] Create offer error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/** GET /orgs/brands/:brandId/offers/:offerId — one offer. */
orgRouter.get('/brands/:brandId/offers/:offerId', async (req: Request, res: Response) => {
  try {
    const scope = await resolveOfferParam(req, res);
    if (!scope) return;

    const offer = await assertOfferOnBrand(req.orgId!, scope.brandId, scope.offerId);
    return res.status(200).json({ offer });
  } catch (error: any) {
    if (rejectOfferProblem(res, error)) return;
    console.error('[brand-service] Get offer error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * PATCH /orgs/brands/:brandId/offers/:offerId — rename it.
 * The two name limits apply exactly as they do on create, and the name stays
 * unique within the brand.
 */
orgRouter.patch('/brands/:brandId/offers/:offerId', async (req: Request, res: Response) => {
  try {
    const scope = await resolveOfferParam(req, res);
    if (!scope) return;

    const parsed = RenameOfferRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    try {
      const offer = await renameOffer(req.orgId!, scope.brandId, scope.offerId, parsed.data.name);
      return res.status(200).json({ offer });
    } catch (error) {
      if (rejectOfferProblem(res, error)) return;
      throw error;
    }
  } catch (error: any) {
    console.error('[brand-service] Rename offer error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ── One offer's sales funnels ───────────────────────────────────────────────

/** GET /orgs/brands/:brandId/offers/:offerId/sales-funnels */
orgRouter.get('/brands/:brandId/offers/:offerId/sales-funnels', async (req: Request, res: Response) => {
  try {
    const scope = await resolveOfferParam(req, res);
    if (!scope) return;

    const set = await salesFunnelsService.readByOfferId(req.orgId!, scope.brandId, scope.offerId);
    return res.status(200).json(set);
  } catch (error: any) {
    console.error('[brand-service] Get offer sales funnels error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/** PUT /orgs/brands/:brandId/offers/:offerId/sales-funnels — state the whole set. */
orgRouter.put('/brands/:brandId/offers/:offerId/sales-funnels', async (req: Request, res: Response) => {
  try {
    const scope = await resolveOfferParam(req, res);
    if (!scope) return;

    const parsed = StateSalesFunnelSetRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    const brand = await getBrand(scope.brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const funnelKeys = parsed.data.funnelKeys.map((key) => toSalesFunnelKey(key) as SalesFunnelKey);

    try {
      const set = await salesFunnelsService.statesetByOfferId(
        req.orgId!,
        scope.brandId,
        scope.offerId,
        funnelKeys,
        brand.domain ?? null
      );
      return res.status(200).json(set);
    } catch (error) {
      if (rejectDeclaration(res, error)) return;
      throw error;
    }
  } catch (error: any) {
    console.error('[brand-service] State offer sales funnel set error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/** PUT /orgs/brands/:brandId/offers/:offerId/sales-funnels/:funnelKey */
orgRouter.put(
  '/brands/:brandId/offers/:offerId/sales-funnels/:funnelKey',
  async (req: Request, res: Response) => {
    try {
      const scope = await resolveOfferParam(req, res);
      if (!scope) return;

      const funnelKey = parseFunnelKey(req, res);
      if (!funnelKey) return;

      const parsed = DeclareSalesFunnelRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      }

      const brand = await getBrand(scope.brandId);
      if (!brand) return res.status(404).json({ error: 'Brand not found' });

      try {
        const funnel = await salesFunnelsService.declareByOfferId(
          req.orgId!,
          scope.brandId,
          scope.offerId,
          funnelKey,
          parsed.data,
          brand.domain ?? null
        );
        return res.status(200).json({ funnel });
      } catch (error) {
        if (rejectDeclaration(res, error)) return;
        throw error;
      }
    } catch (error: any) {
      console.error('[brand-service] Declare offer sales funnel error:', error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
);

/**
 * DELETE /orgs/brands/:brandId/offers/:offerId/sales-funnels/:funnelKey
 * Switch it off, keeping every number on it. `?erase=true` forgets it outright.
 */
orgRouter.delete(
  '/brands/:brandId/offers/:offerId/sales-funnels/:funnelKey',
  async (req: Request, res: Response) => {
    try {
      const scope = await resolveOfferParam(req, res);
      if (!scope) return;

      const funnelKey = parseFunnelKey(req, res);
      if (!funnelKey) return;

      const erase = parseEraseFlag(req, res);
      if (erase === null) return;

      try {
        if (erase) {
          await salesFunnelsService.eraseByOfferId(req.orgId!, scope.brandId, scope.offerId, funnelKey);
        } else {
          await salesFunnelsService.deactivateByOfferId(
            req.orgId!,
            scope.brandId,
            scope.offerId,
            funnelKey
          );
        }
      } catch (error) {
        if (rejectDeclaration(res, error)) return;
        throw error;
      }

      const set = await salesFunnelsService.readByOfferId(req.orgId!, scope.brandId, scope.offerId);
      return res.status(200).json(set);
    } catch (error: any) {
      console.error('[brand-service] Undeclare offer sales funnel error:', error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }
);

// ── One offer's value proposition ───────────────────────────────────────────

/**
 * GET /orgs/brands/:brandId/offers/:offerId/user-fields
 * The 7 user-facing keys for THIS offer. `confirmed` is the offer's own; the
 * `suggested` prefill stays brand-wide — it is read off the brand's site, which
 * describes the company and knows nothing about which product you are looking
 * at, so every offer prefills from the same extraction.
 */
orgRouter.get('/brands/:brandId/offers/:offerId/user-fields', async (req: Request, res: Response) => {
  try {
    const scope = await resolveOfferParam(req, res);
    if (!scope) return;

    const fields = await getUserFieldsViewByOfferId(req.orgId!, scope.brandId, scope.offerId);
    return res.status(200).json({ fields });
  } catch (error: any) {
    console.error('[brand-service] Get offer user fields error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/** PUT /orgs/brands/:brandId/offers/:offerId/user-fields */
orgRouter.put('/brands/:brandId/offers/:offerId/user-fields', async (req: Request, res: Response) => {
  try {
    const scope = await resolveOfferParam(req, res);
    if (!scope) return;

    const parsed = PutUserFieldsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    try {
      await upsertUserFieldsByOfferId(req.orgId!, scope.brandId, scope.offerId, parsed.data.fields);
    } catch (err) {
      if (err instanceof UnknownUserFieldKeyError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const fields = await getUserFieldsViewByOfferId(req.orgId!, scope.brandId, scope.offerId);
    return res.status(200).json({ fields });
  } catch (error: any) {
    console.error('[brand-service] Put offer user fields error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// ── Internal (service auth, no org) ─────────────────────────────────────────

/**
 * GET /internal/brands/:brandId/offers
 * The offers under a brand, for a sibling service that holds a brand id and is
 * moving to the offer grain. Org resolution is the same as every other internal
 * read: `x-org-id`, else the single org that claims the brand, else 400.
 */
internalRouter.get('/brands/:brandId/offers', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const scope = await resolveInternalOrgScope(req, brandId);
    if (rejectInternalOrgScope(res, scope)) return;

    // An unclaimed brand simply has nothing configured — a 200 with an empty
    // list, the same contract every other internal read here has.
    const offers = scope.orgId ? await listOffers(scope.orgId, brandId) : [];
    return res.status(200).json({ offers });
  } catch (error: any) {
    console.error('[brand-service] Internal list offers error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * GET /internal/offers/:offerId/sales-funnels
 * The ACTIVE funnels of ONE offer, keyed by the offer alone — what a scheduler
 * ranks over once it holds an offer id. A funnel switched off is never listed:
 * it must never be ranked. An unknown offer is a 404, unlike the brand-keyed
 * read, because an offer id that names nothing is a caller error rather than an
 * unconfigured brand.
 */
internalRouter.get('/offers/:offerId/sales-funnels', async (req: Request, res: Response) => {
  try {
    const { offerId } = req.params;
    if (!UUID_REGEX.test(offerId)) {
      return res.status(400).json({ error: 'Invalid offer ID format: must be a UUID' });
    }

    const offer = await getOfferById(offerId);
    if (!offer) return res.status(404).json({ error: 'Offer not found' });

    const set = await salesFunnelsService.readActiveByOfferId(offer.orgId, offer.brandId, offerId);
    return res.status(200).json(set);
  } catch (error: any) {
    console.error('[brand-service] Internal get offer sales funnels error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export default orgRouter;

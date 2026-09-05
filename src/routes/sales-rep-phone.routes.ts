import { Router, Request, Response } from 'express';
import { UpsertSalesRepPhoneRequestSchema } from '../schemas';
import {
  UUID_REGEX,
  resolveBrandOwnership,
  rejectOwnership,
} from '../lib/brand-ownership';
import {
  salesRepPhoneService,
  normalizeSalesRepPhone,
  SalesRepPhoneValidationError,
} from '../services/salesRepPhoneService';

export const orgRouter = Router();

/**
 * GET /orgs/brands/:brandId/sales-rep-phone
 *
 * The number to ring when a sales interest lands on this brand, or `null` when
 * the brand never stated one ("nobody to ring" — a first-class answer, not an
 * error). Per-brand config, org-scoped like the write below.
 */
orgRouter.get('/brands/:brandId/sales-rep-phone', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    const salesRepPhone = await salesRepPhoneService.getByBrandId(req.orgId!, brandId);
    return res.status(200).json({ salesRepPhone });
  } catch (error: any) {
    console.error('[brand-service] Get sales rep phone error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * PUT /orgs/brands/:brandId/sales-rep-phone
 *
 * State (or change) the one number to ring when a sales interest lands on this
 * brand. Per-brand config (mirrors the click-destination / WhatsApp-link write
 * routes), one row per (org, brand), reused across every campaign and channel
 * of the brand. Body `{ salesRepPhone: string }` accepts a number typed in any
 * format as long as it carries a country code; it is normalized to strict E.164
 * before storage so the consumer can hand it straight to a telephony provider.
 * Invalid input → 400. Idempotent upsert. Returns `{ salesRepPhone }` (the
 * saved, normalized value).
 *
 * Same auth as the per-brand click-destination / WhatsApp-link PUT: org-scoped
 * + the brand must belong to the caller's org (400 bad uuid / 404 unknown brand
 * / 403 foreign).
 */
orgRouter.put('/brands/:brandId/sales-rep-phone', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    const parsed = UpsertSalesRepPhoneRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    }

    let salesRepPhone: string;
    try {
      salesRepPhone = normalizeSalesRepPhone(parsed.data.salesRepPhone);
    } catch (err) {
      if (err instanceof SalesRepPhoneValidationError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const saved = await salesRepPhoneService.upsertByBrandId(req.orgId!, brandId, salesRepPhone);
    return res.status(200).json({ salesRepPhone: saved });
  } catch (error: any) {
    console.error('[brand-service] Upsert sales rep phone error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

/**
 * DELETE /orgs/brands/:brandId/sales-rep-phone
 *
 * Remove the number: the row is deleted and the brand goes back to "nobody to
 * ring". Idempotent — removing a number that was never stated is a 200 with
 * `{ salesRepPhone: null }`, not a 404, because absence is a legitimate state
 * rather than a missing resource.
 */
orgRouter.delete('/brands/:brandId/sales-rep-phone', async (req: Request, res: Response) => {
  try {
    const { brandId } = req.params;
    if (!UUID_REGEX.test(brandId)) {
      return res.status(400).json({ error: 'Invalid brand ID format: must be a UUID' });
    }

    const ownership = await resolveBrandOwnership(brandId, req.orgId!);
    if (rejectOwnership(res, ownership)) return;

    await salesRepPhoneService.deleteByBrandId(req.orgId!, brandId);
    return res.status(200).json({ salesRepPhone: null });
  } catch (error: any) {
    console.error('[brand-service] Delete sales rep phone error:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

export default orgRouter;

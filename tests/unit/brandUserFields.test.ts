import { describe, it, expect, vi, beforeEach } from 'vitest';

// src/db/index.ts throws at import time without a DB url (CI test:unit runs with
// none). Stub the named exports the service references. `db.insert` is a spy so
// we can assert upsert never writes on an invalid key.
const { mockInsert } = vi.hoisted(() => ({ mockInsert: vi.fn() }));

vi.mock('../../src/db', () => ({
  db: { insert: mockInsert },
  brandUserFields: {
    brandId: 'buf.brandId',
    offerId: 'buf.offerId',
    fieldKey: 'buf.fieldKey',
    value: 'buf.value',
    confirmedAt: 'buf.confirmedAt',
    updatedAt: 'buf.updatedAt',
  },
  brandExtractedFields: {},
  // The service now reaches the offer resolver, which imports these.
  brandOffers: {},
  brandSalesFunnels: {},
  brands: {},
}));

import {
  USER_FACING_FIELD_KEYS,
  isUserFacingFieldKey,
  buildUserFieldsView,
  upsertUserFields,
  upsertUserFieldsByOfferId,
  UnknownUserFieldKeyError,
  type ConfirmedUserField,
} from '../../src/services/brandUserFieldsService';

describe('USER_FACING_FIELD_KEYS', () => {
  it('is exactly the 7 confirmed keys, with dreamOutcome replacing valueProposition', () => {
    expect(USER_FACING_FIELD_KEYS).toEqual([
      'services',
      'dreamOutcome',
      'perceivedLikelihood',
      'socialProof',
      'riskReversal',
      'urgency',
      'scarcity',
    ]);
    expect(USER_FACING_FIELD_KEYS).not.toContain('valueProposition');
  });

  it('isUserFacingFieldKey recognises only the 7 keys', () => {
    expect(isUserFacingFieldKey('services')).toBe(true);
    expect(isUserFacingFieldKey('dreamOutcome')).toBe(true);
    expect(isUserFacingFieldKey('valueProposition')).toBe(false);
    expect(isUserFacingFieldKey('industry')).toBe(false);
  });
});

describe('buildUserFieldsView', () => {
  const confirmed = (v: unknown): ConfirmedUserField => ({ value: v, confirmedAt: '2026-01-01T00:00:00.000Z' });

  it('returns all 7 keys, confirmed value winning over suggested', () => {
    const view = buildUserFieldsView(
      new Map([['services', confirmed(['A', 'B'])]]),
      new Map<string, unknown>([['services', 'ignored suggestion'], ['urgency', 'Limited time']]),
    );

    expect(Object.keys(view).sort()).toEqual([...USER_FACING_FIELD_KEYS].sort());
    // Confirmed wins.
    expect(view.services).toEqual({ value: ['A', 'B'], provenance: 'confirmed' });
    // Suggested prefill for a non-confirmed key.
    expect(view.urgency).toEqual({ value: 'Limited time', provenance: 'suggested' });
    // No confirmed, no suggestion → null suggested.
    expect(view.scarcity).toEqual({ value: null, provenance: 'suggested' });
  });

  it('treats a confirmed null value as confirmed (not suggested)', () => {
    const view = buildUserFieldsView(new Map([['socialProof', confirmed(null)]]), new Map());
    expect(view.socialProof).toEqual({ value: null, provenance: 'confirmed' });
  });
});

describe('upsertUserFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const funnel = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    };
    mockInsert.mockReturnValue(funnel);
  });

  it('throws UnknownUserFieldKeyError and writes NOTHING on an unknown key', async () => {
    await expect(
      upsertUserFields('org-1', 'brand-1', { services: 'ok', industry: 'nope' }),
    ).rejects.toBeInstanceOf(UnknownUserFieldKeyError);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  // The offer-grain write is the one that reaches the database directly; the
  // brand-scoped wrapper resolves an offer first, which needs a live db.select.
  it('upserts one insert per valid key', async () => {
    await upsertUserFieldsByOfferId('org-1', 'brand-1', 'offer-1', { services: ['x'], urgency: 'soon' });
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  it('writes NOTHING on an unknown key at the offer grain either', async () => {
    await expect(
      upsertUserFieldsByOfferId('org-1', 'brand-1', 'offer-1', { industry: 'nope' }),
    ).rejects.toBeInstanceOf(UnknownUserFieldKeyError);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('no-ops on an empty map', async () => {
    await upsertUserFields('org-1', 'brand-1', {});
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

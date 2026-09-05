import { describe, it, expect, vi } from 'vitest';

// The service imports ../db, which throws at import time with no DB url (the
// unit suite runs without one).
vi.mock('../../src/db', () => ({ db: {}, brandSalesRepPhones: {} }));

import {
  normalizeSalesRepPhone,
  SalesRepPhoneValidationError,
} from '../../src/services/salesRepPhoneService';

/**
 * The number is handed straight to a telephony provider, so a value that
 * reaches the dialler unusable is a call that never happens, silently. The
 * normalizer is what stops that: any typed format in, strict E.164 out, and a
 * loud 400 for anything that cannot be dialled internationally.
 */
describe('normalizeSalesRepPhone', () => {
  it('keeps an already-E.164 number as-is', () => {
    expect(normalizeSalesRepPhone('+33770657585')).toBe('+33770657585');
  });

  it('strips whatever separators a person typed', () => {
    expect(normalizeSalesRepPhone('+33 7 70 65 75 85')).toBe('+33770657585');
    expect(normalizeSalesRepPhone('+33-770-657-585')).toBe('+33770657585');
    expect(normalizeSalesRepPhone(' (+1) 555.987.6543 ')).toBe('+15559876543');
  });

  it('accepts the international 00 prefix as the country-code marker', () => {
    expect(normalizeSalesRepPhone('0033770657585')).toBe('+33770657585');
    expect(normalizeSalesRepPhone('00 33 770 657 585')).toBe('+33770657585');
  });

  // No inference: a national number could belong to any country, and a guess
  // dials a different person.
  it('rejects a national number with no country code rather than guessing one', () => {
    expect(() => normalizeSalesRepPhone('0770657585')).toThrow(SalesRepPhoneValidationError);
    expect(() => normalizeSalesRepPhone('770657585')).toThrow(SalesRepPhoneValidationError);
  });

  it('rejects a country code starting with 0', () => {
    expect(() => normalizeSalesRepPhone('+0770657585')).toThrow(SalesRepPhoneValidationError);
  });

  it('rejects letters, extensions and anything unparseable', () => {
    expect(() => normalizeSalesRepPhone('+3377065758x123')).toThrow(SalesRepPhoneValidationError);
    expect(() => normalizeSalesRepPhone('call me')).toThrow(SalesRepPhoneValidationError);
  });

  it('rejects too few and too many digits (E.164 allows 15)', () => {
    expect(() => normalizeSalesRepPhone('+1234567')).toThrow(SalesRepPhoneValidationError);
    expect(normalizeSalesRepPhone('+12345678')).toBe('+12345678');
    expect(normalizeSalesRepPhone('+123456789012345')).toBe('+123456789012345');
    expect(() => normalizeSalesRepPhone('+1234567890123456')).toThrow(SalesRepPhoneValidationError);
  });

  it('rejects a missing / empty / non-string value instead of storing an empty number', () => {
    expect(() => normalizeSalesRepPhone(undefined)).toThrow(SalesRepPhoneValidationError);
    expect(() => normalizeSalesRepPhone('')).toThrow(SalesRepPhoneValidationError);
    expect(() => normalizeSalesRepPhone('   ')).toThrow(SalesRepPhoneValidationError);
    expect(() => normalizeSalesRepPhone(33770657585)).toThrow(SalesRepPhoneValidationError);
  });
});

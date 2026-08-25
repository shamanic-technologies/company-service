/**
 * What one Brand-API answer does to a brand's colour row.
 *
 * Pure — no database, no network — so the retrieval cadence's decisions are
 * testable on their own: which outcomes are terminal, which cost the brand one
 * of its bounded attempts, and when a brand gives up.
 */

import type { LogoDevBrandOutcome } from './logo-dev-brand';

export interface BrandColorsState {
  status: 'pending' | 'resolved' | 'unavailable';
  attempts: number;
  /** Non-null ONLY when the provider actually returned a palette. */
  colors: string[] | null;
  /** True when this answer ends the brand's retrieval for good. */
  terminal: boolean;
}

/**
 * `maxAttempts` bounds what a single brand may ever cost on a credit grant we
 * cannot query. A domain the provider never indexes would otherwise be retried
 * forever.
 */
export function nextBrandColorsState(
  attemptsBefore: number,
  outcome: LogoDevBrandOutcome['outcome'],
  colors: string[],
  maxAttempts: number,
): BrandColorsState {
  const attempts = attemptsBefore + 1;

  if (outcome === 'colors') {
    return { status: 'resolved', attempts, colors, terminal: true };
  }

  // The provider HAS the domain and reports no palette. Retrying cannot make
  // one appear — and it stays "no colours", never a guessed one.
  if (outcome === 'no_colors') {
    return { status: 'unavailable', attempts, colors: null, terminal: true };
  }

  // 'pending' (202, not indexed YET — the normal first answer) and 'failed'
  // (network / non-2xx / unparseable) are both retryable, and both spend one of
  // the brand's bounded attempts.
  const givenUp = attempts >= maxAttempts;
  return {
    status: givenUp ? 'unavailable' : 'pending',
    attempts,
    colors: null,
    terminal: givenUp,
  };
}

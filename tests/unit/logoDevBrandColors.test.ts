import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  fetchBrandColorsFromLogoDev,
  normalizeBrandDomain,
  parseLogoDevColors,
} from '../../src/lib/logo-dev-brand';
import { nextBrandColorsState } from '../../src/lib/brand-colors-plan';

const originalFetch = global.fetch;

function respond(status: number, body: string): void {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('parseLogoDevColors', () => {
  it('keeps the provider order and takes the hex verbatim', () => {
    // Exactly the payload api.logo.dev/brand/shockwavecenters.com returns today:
    // a near-black, a red, a navy. The consumer selects; we do not.
    const colors = parseLogoDevColors([
      { r: 0, g: 1, b: 3, hex: '#000103' },
      { r: 206, g: 46, b: 54, hex: '#ce2e36' },
      { r: 0, g: 51, b: 102, hex: '#003366' },
    ]);
    expect(colors).toEqual(['#000103', '#ce2e36', '#003366']);
  });

  it('does not rank, filter, or de-duplicate — a repeated colour survives in place', () => {
    expect(parseLogoDevColors([{ hex: '#fff' }, { hex: '#000103' }, { hex: '#fff' }])).toEqual([
      '#fff',
      '#000103',
      '#fff',
    ]);
  });

  it('accepts a bare string array (only the hex is ever stored)', () => {
    expect(parseLogoDevColors(['#000103', '#CE2E36'])).toEqual(['#000103', '#CE2E36']);
  });

  it('drops an entry carrying no well-formed hex rather than storing a guess', () => {
    expect(parseLogoDevColors([{ r: 1, g: 2, b: 3 }, { hex: 'crimson' }, { hex: '#003366' }])).toEqual([
      '#003366',
    ]);
  });

  it('answers empty on a non-array payload', () => {
    expect(parseLogoDevColors(undefined)).toEqual([]);
    expect(parseLogoDevColors({ hex: '#fff' })).toEqual([]);
  });
});

describe('normalizeBrandDomain', () => {
  it('lowercases and strips www / trailing dot', () => {
    expect(normalizeBrandDomain('  WWW.ShockwaveCenters.com. ')).toBe('shockwavecenters.com');
  });
});

describe('fetchBrandColorsFromLogoDev', () => {
  it('returns the palette on 200', async () => {
    respond(
      200,
      JSON.stringify({
        domain: 'shockwavecenters.com',
        colors: [{ hex: '#000103' }, { hex: '#ce2e36' }, { hex: '#003366' }],
      }),
    );
    const result = await fetchBrandColorsFromLogoDev('shockwavecenters.com', 'sk_test');
    expect(result).toEqual({
      outcome: 'colors',
      colors: ['#000103', '#ce2e36', '#003366'],
      httpStatus: 200,
    });
  });

  it('calls the Brand endpoint with the SECRET key as a bearer token', async () => {
    respond(200, JSON.stringify({ colors: [{ hex: '#003366' }] }));
    await fetchBrandColorsFromLogoDev('opsfolio.com', 'sk_secret');
    const [url, init] = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.logo.dev/brand/opsfolio.com');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_secret');
  });

  it('reports 202 as PENDING — the domain is not indexed yet, not "no colours"', async () => {
    respond(202, JSON.stringify({ msg: 'not found, looking up' }));
    const result = await fetchBrandColorsFromLogoDev('docdinners.com', 'sk_test');
    expect(result.outcome).toBe('pending');
    expect(result.httpStatus).toBe(202);
  });

  it('reports 402 as EXHAUSTED so the caller stops spending', async () => {
    respond(402, 'payment required');
    const result = await fetchBrandColorsFromLogoDev('voozaa.app', 'sk_test');
    expect(result.outcome).toBe('exhausted');
    expect(console.error).toHaveBeenCalled();
  });

  it('reports an indexed domain with an empty palette as no_colors, never an empty array of colours', async () => {
    respond(200, JSON.stringify({ domain: 'emailtoolshub.com', colors: [] }));
    const result = await fetchBrandColorsFromLogoDev('emailtoolshub.com', 'sk_test');
    expect(result.outcome).toBe('no_colors');
    expect(console.warn).toHaveBeenCalled();
  });

  it('reports a non-2xx as failed, loudly', async () => {
    respond(500, 'boom');
    const result = await fetchBrandColorsFromLogoDev('federalarchitect.com', 'sk_test');
    expect(result).toMatchObject({ outcome: 'failed', httpStatus: 500 });
    expect(console.warn).toHaveBeenCalled();
  });

  it('reports an unparseable body as failed, loudly', async () => {
    respond(200, '<html>nope</html>');
    const result = await fetchBrandColorsFromLogoDev('luxproperty.group', 'sk_test');
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(console.warn).toHaveBeenCalled();
  });

  it('reports a transport failure as failed and never throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
    const result = await fetchBrandColorsFromLogoDev('opsfolio.com', 'sk_test');
    expect(result).toMatchObject({ outcome: 'failed', httpStatus: null });
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('nextBrandColorsState', () => {
  it('a palette resolves the brand', () => {
    expect(nextBrandColorsState(3, 'colors', ['#000103'], 8)).toEqual({
      status: 'resolved',
      attempts: 4,
      colors: ['#000103'],
      terminal: true,
    });
  });

  it('an indexed domain with no palette is terminal — retrying cannot invent one', () => {
    expect(nextBrandColorsState(0, 'no_colors', [], 8)).toEqual({
      status: 'unavailable',
      attempts: 1,
      colors: null,
      terminal: true,
    });
  });

  it('a 202 stays pending and costs one bounded attempt', () => {
    expect(nextBrandColorsState(0, 'pending', [], 8)).toEqual({
      status: 'pending',
      attempts: 1,
      colors: null,
      terminal: false,
    });
  });

  it('gives up once the attempts are spent, so one domain cannot drain the grant', () => {
    expect(nextBrandColorsState(7, 'pending', [], 8)).toMatchObject({
      status: 'unavailable',
      attempts: 8,
      terminal: true,
    });
  });

  it('a transport failure is retryable too, and bounded the same way', () => {
    expect(nextBrandColorsState(1, 'failed', [], 8)).toMatchObject({ status: 'pending', attempts: 2 });
    expect(nextBrandColorsState(7, 'failed', [], 8)).toMatchObject({ status: 'unavailable' });
  });

  it('never carries colours on any outcome but a real palette', () => {
    for (const outcome of ['pending', 'failed', 'no_colors'] as const) {
      expect(nextBrandColorsState(0, outcome, ['#ffffff'], 8).colors).toBeNull();
    }
  });
});

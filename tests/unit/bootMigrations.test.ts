import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import {
  CONNECT_RETRY_DELAYS_MS,
  describeErrorCauses,
  getMigrationFailure,
  getMigrationStatus,
  isTransientConnectError,
  markMigrationsFailed,
  markMigrationsReady,
  requireMigrationsReady,
  resetMigrationState,
  runMigrationsWithConnectRetry,
} from '../../src/lib/boot-migrations';

function mockResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
  };
  return res as unknown as Response & typeof res;
}

describe('boot-migrations', () => {
  beforeEach(() => {
    resetMigrationState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isTransientConnectError', () => {
    it('recognises the AggregateError happy-eyeballs emits when a compute is resuming', () => {
      const sub = Object.assign(new Error('connect ETIMEDOUT 3.1.2.3:5432'), { code: 'ETIMEDOUT' });
      const err = new AggregateError([sub, sub], 'connect failed');

      expect(isTransientConnectError(err)).toBe(true);
    });

    it('recognises a code carried on a nested cause', () => {
      const err = new Error('write failed', {
        cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
      });

      expect(isTransientConnectError(err)).toBe(true);
    });

    it("recognises postgres.js's pool-acquire timeout, which carries no code", () => {
      expect(isTransientConnectError(new Error('timeout exceeded when trying to connect'))).toBe(true);
    });

    it('recognises a compute answering mid-resume', () => {
      expect(isTransientConnectError(new Error('the database system is starting up'))).toBe(true);
    });

    it('does NOT retry a real migration failure', () => {
      const syntaxError = Object.assign(new Error('syntax error at or near "SELCT"'), { code: '42601' });
      const constraintError = Object.assign(
        new Error('null value in column "visit_to_close_pct" violates not-null constraint'),
        { code: '23502' },
      );

      expect(isTransientConnectError(syntaxError)).toBe(false);
      expect(isTransientConnectError(constraintError)).toBe(false);
    });

    it('terminates on a cyclic cause funnel', () => {
      const a = new Error('a') as Error & { cause?: unknown };
      const b = new Error('b') as Error & { cause?: unknown };
      a.cause = b;
      b.cause = a;

      expect(isTransientConnectError(a)).toBe(false);
    });
  });

  describe('describeErrorCauses', () => {
    it('names the cause the driver wrapped out of sight', () => {
      // Exactly the shape drizzle produces: the interesting message is one cause down.
      const err = new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"', {
        cause: Object.assign(new Error('password authentication failed for user "neondb_owner"'), {
          code: '28P01',
        }),
      });

      const funnel = describeErrorCauses(err);

      expect(funnel).toContain('Failed query: CREATE SCHEMA');
      expect(funnel).toContain('password authentication failed');
      expect(funnel).toContain('28P01');
    });

    it('does not repeat an identical message twice', () => {
      const sub = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const funnel = describeErrorCauses(new AggregateError([sub, sub], 'connect failed'));

      expect(funnel.match(/connect ETIMEDOUT/g)).toHaveLength(1);
    });

    it('terminates on a cyclic cause funnel', () => {
      const a = new Error('a') as Error & { cause?: unknown };
      const b = new Error('b') as Error & { cause?: unknown };
      a.cause = b;
      b.cause = a;

      expect(describeErrorCauses(a)).toContain('a');
    });
  });

  describe('runMigrationsWithConnectRetry', () => {
    const wait = () => Promise.resolve();

    it('retries a cold compute until it answers', async () => {
      const cold = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const run = vi
        .fn()
        .mockRejectedValueOnce(cold)
        .mockRejectedValueOnce(cold)
        .mockResolvedValueOnce(undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await runMigrationsWithConnectRetry(run, { wait });

      expect(run).toHaveBeenCalledTimes(3);
    });

    it('logs every retry rather than swallowing it', async () => {
      const cold = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const run = vi.fn().mockRejectedValueOnce(cold).mockResolvedValueOnce(undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await runMigrationsWithConnectRetry(run, { wait });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('ETIMEDOUT');
    });

    it('rethrows a real migration failure on the first attempt, with no retry', async () => {
      const broken = Object.assign(new Error('syntax error at or near "SELCT"'), { code: '42601' });
      const run = vi.fn().mockRejectedValue(broken);

      await expect(runMigrationsWithConnectRetry(run, { wait })).rejects.toThrow('syntax error');
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('gives up once the backoff ladder is exhausted, and surfaces the original error', async () => {
      const cold = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const run = vi.fn().mockRejectedValue(cold);
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        runMigrationsWithConnectRetry(run, { delaysMs: [1, 1, 1], wait }),
      ).rejects.toThrow('connect ETIMEDOUT');
      expect(run).toHaveBeenCalledTimes(4);
    });

    it('waits with the documented backoff', async () => {
      const cold = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const run = vi.fn().mockRejectedValueOnce(cold).mockRejectedValueOnce(cold).mockResolvedValueOnce(undefined);
      const waited: number[] = [];
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await runMigrationsWithConnectRetry(run, {
        wait: async (ms) => {
          waited.push(ms);
        },
      });

      expect(waited).toEqual(CONNECT_RETRY_DELAYS_MS.slice(0, 2));
    });
  });

  describe('requireMigrationsReady', () => {
    it('refuses with 503 + Retry-After while the migrator is still running', () => {
      const res = mockResponse();
      const next = vi.fn() as unknown as NextFunction;

      requireMigrationsReady({} as Request, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.headers['Retry-After']).toBe('5');
      expect(res.body).toMatchObject({ code: 'MIGRATIONS_PENDING' });
    });

    it('lets requests through once migrations are done', () => {
      markMigrationsReady();
      const res = mockResponse();
      const next = vi.fn() as unknown as NextFunction;

      requireMigrationsReady({} as Request, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
      expect(getMigrationStatus()).toBe('ready');
    });

    it('refuses with the failure detail once migrations have failed', () => {
      markMigrationsFailed(Object.assign(new Error('relation "brands" does not exist'), { code: '42P01' }));
      const res = mockResponse();
      const next = vi.fn() as unknown as NextFunction;

      requireMigrationsReady({} as Request, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({ code: 'MIGRATIONS_FAILED' });
      expect(getMigrationFailure()).toBe('relation "brands" does not exist (42P01)');
    });
  });
});

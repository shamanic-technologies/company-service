import type { NextFunction, Request, Response } from 'express';

/**
 * Boot-time migration state, and the gate that keeps the rest of the app from
 * answering while the migrator is still working.
 *
 * Why this exists: Railway healthchecks a new container inside a ~30s window, and
 * a Neon compute that has suspended takes seconds to resume. Awaiting `migrate()`
 * before `app.listen()` spends that whole window on the first connection, so the
 * port never opens, the healthcheck fails and the deploy is marked FAILED — for
 * reasons that have nothing to do with the code being deployed.
 *
 * So the port binds first and migrations run behind it. That is only safe because
 * it is not a silent trade: until the migrator finishes, every route except the
 * unauthenticated liveness ones answers 503 through `requireMigrationsReady`, so
 * the service never serves a request against a schema its code does not expect.
 * It refuses, loudly and with a status code that says so.
 */

export type MigrationStatus = 'pending' | 'ready' | 'failed';

let status: MigrationStatus = 'pending';
let failureMessage: string | null = null;

export function getMigrationStatus(): MigrationStatus {
  return status;
}

export function getMigrationFailure(): string | null {
  return failureMessage;
}

export function markMigrationsReady(): void {
  status = 'ready';
  failureMessage = null;
}

export function markMigrationsFailed(err: unknown): void {
  status = 'failed';
  failureMessage = describeError(err);
}

/** Test-only: restore the module to its pre-boot state. */
export function resetMigrationState(): void {
  status = 'pending';
  failureMessage = null;
}

/**
 * Connect-phase error codes. Every one of these means the query never reached
 * the server, so re-running the migrator cannot half-apply anything.
 *
 * `CONNECT_TIMEOUT` / `CONNECTION_CLOSED` / `CONNECTION_ENDED` are postgres.js's
 * own; the rest come from Node's socket layer. `ETIMEDOUT` in particular arrives
 * wrapped in an `AggregateError` (one sub-error per address Neon's proxy resolves
 * to), which is why the walk below flattens `errors` as well as `cause`.
 */
const TRANSIENT_CONNECT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P03', // cannot_connect_now — Postgres is still starting up
]);

/**
 * Some of the same failures arrive with no `.code` at all, only a message.
 * postgres.js's pool-acquire timeout is one; a compute mid-resume answering
 * "the database system is starting up" is another.
 */
const TRANSIENT_MESSAGE_PATTERN =
  /timeout expired|timeout exceeded when trying to connect|connection terminated|connection ended|the database system is starting up|cannot connect now|write CONNECTION_CLOSED|socket hang up/i;

function flattenErrors(err: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      const withCause = current as { cause?: unknown; errors?: unknown };
      if (withCause.cause !== undefined) stack.push(withCause.cause);
      if (Array.isArray(withCause.errors)) stack.push(...withCause.errors);
    }
    out.push(current);
  }

  return out;
}

/**
 * True when the failure happened while OPENING the connection — not while
 * running a statement. A statement-level failure (bad SQL, failed constraint,
 * a migration that genuinely does not apply) is never retried: it is a real
 * migration failure and must surface.
 */
export function isTransientConnectError(err: unknown): boolean {
  for (const candidate of flattenErrors(err)) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { code, message } = candidate as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && TRANSIENT_CONNECT_CODES.has(code)) return true;
    if (typeof message === 'string' && TRANSIENT_MESSAGE_PATTERN.test(message)) return true;
  }
  return false;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? `${err.message} (${code})` : err.message;
  }
  return String(err);
}

/**
 * The whole cause funnel on one line.
 *
 * Drivers wrap the interesting error: drizzle reports `Failed query: CREATE
 * SCHEMA IF NOT EXISTS "drizzle"` and hides `password authentication failed`
 * one `cause` down, where a default `console.error` of the top-level error does
 * not print it. An operator reading the deploy log needs the bottom of the
 * funnel, so log this alongside the error itself.
 */
export function describeErrorCauses(err: unknown): string {
  const parts: string[] = [];
  for (const candidate of flattenErrors(err)) {
    if (candidate instanceof Error || (typeof candidate === 'object' && candidate !== null)) {
      const described = describeError(candidate);
      if (described && !parts.includes(described)) parts.push(described);
    }
  }
  return parts.join(' <- ');
}

/**
 * Backoff for a resuming compute. Neon reports a resume as taking seconds, so
 * the early retries are quick and the tail is patient; the whole ladder is
 * ~31s of waiting. Nothing here is on the healthcheck's critical path — the
 * port is already bound by the time this runs — so the budget can be generous.
 */
export const CONNECT_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run the migrator, retrying only while the failure is a connect-phase one.
 * Every retry is logged; a non-transient error, or a transient one that outlasts
 * the ladder, is rethrown untouched.
 */
export async function runMigrationsWithConnectRetry(
  run: () => Promise<unknown>,
  options: { delaysMs?: number[]; wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const delays = options.delaysMs ?? CONNECT_RETRY_DELAYS_MS;
  const wait = options.wait ?? sleep;

  for (let attempt = 0; ; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      if (attempt >= delays.length || !isTransientConnectError(err)) throw err;
      const delay = delays[attempt];
      console.warn(
        `[brand-service] Database not reachable on migration attempt ${attempt + 1}/${delays.length + 1}: ` +
          `${describeError(err)}. Retrying in ${delay}ms (the compute is probably resuming).`,
      );
      await wait(delay);
    }
  }
}

/**
 * Refuse every request that touches the database until the schema is known to
 * match. 503 with `Retry-After` while the migrator is still running; 503 with
 * the failure message once it has given up.
 */
export function requireMigrationsReady(req: Request, res: Response, next: NextFunction): void {
  const current = getMigrationStatus();

  if (current === 'ready') {
    next();
    return;
  }

  if (current === 'failed') {
    res.status(503).json({
      error: 'Database migrations failed — refusing to serve against an unverified schema',
      code: 'MIGRATIONS_FAILED',
      detail: getMigrationFailure(),
    });
    return;
  }

  res.setHeader('Retry-After', '5');
  res.status(503).json({
    error: 'Database migrations are still running',
    code: 'MIGRATIONS_PENDING',
  });
}

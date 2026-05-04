// HTTP client for the Seniorify backend. Per `contracts/backend-client.md`:
// - Bearer token + X-Tenant-Id + Content-Type on every request.
// - Bounded exponential backoff on 5xx (≤3 attempts). 4xx is NOT retried.
// - Idempotency-Key on mutating endpoints; the caller supplies it for retries.
// - Refuses to start against an incompatible backend major version.
// - All cross-boundary errors are Result<T, BackendError>. No thrown exceptions.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { request as undiciRequest } from 'undici';
import { z } from 'zod';

import { err, ok, type Result } from '../shared/result.js';

import { backendError } from './errors.js';
import { whoamiResponseSchema, type WhoamiResponse } from './schemas/whoami.js';

import type { BackendError } from './errors.js';
import type { Dispatcher } from 'undici';

/**
 * Default base URL for the hosted Seniorify backend. Override via
 * `SENIORIFY_BACKEND_URL` for local / staging / self-hosted deployments.
 * Drift entry (2026-05-03): the hosted-SaaS pivot makes this the default
 * because the original plan envisioned manual env-var configuration.
 */
export const DEFAULT_BACKEND_URL = 'https://api.seniorify.dev';

const DEFAULT_RETRIES = 3;
const BASE_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 1_500;

export type BackendVersion = 'v1';
export const SUPPORTED_BACKEND_MAJOR: BackendVersion = 'v1';

export interface ClientConfig {
  readonly baseUrl: string;
  readonly authToken: string;
  readonly tenantId: string;
  readonly maxRetries?: number;
  readonly userAgent?: string;
  /** Override for tests; defaults to undici's `request`. */
  readonly transport?: typeof undiciRequest;
  /** Override for tests; defaults to crypto.randomUUID. */
  readonly newIdempotencyKey?: () => string;
}

export interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH';
  readonly path: string;
  readonly body?: unknown;
  /** Required for POST/PATCH that mutate state. */
  readonly idempotencyKey?: string;
  /** Caller-supplied retry override; otherwise uses config.maxRetries. */
  readonly retries?: number;
  /**
   * Suppress the `X-Tenant-Id` header for endpoints that *resolve* the
   * tenant (currently only `GET /v1/whoami` — sending it would be
   * circular). Default false; flip to true at the one call site that
   * needs it.
   */
  readonly omitTenantHeader?: boolean;
}

const versionHandshakeSchema = z.object({
  major: z.string(),
  minor: z.string(),
});

export class BackendClient {
  readonly #cfg: Required<Omit<ClientConfig, 'userAgent'>> & Pick<ClientConfig, 'userAgent'>;
  #handshakeChecked = false;

  constructor(cfg: ClientConfig) {
    this.#cfg = {
      baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
      authToken: cfg.authToken,
      tenantId: cfg.tenantId,
      maxRetries: cfg.maxRetries ?? DEFAULT_RETRIES,
      transport: cfg.transport ?? undiciRequest,
      newIdempotencyKey: cfg.newIdempotencyKey ?? (() => randomUUID()),
      ...(cfg.userAgent !== undefined ? { userAgent: cfg.userAgent } : {}),
    };
  }

  /**
   * Verifies backend major version once before any other call. Refuses to
   * start against an incompatible major (Constitution §III: schema-first
   * surfaces prevent client/server drift).
   */
  async ensureCompatible(): Promise<Result<void, BackendError>> {
    if (this.#handshakeChecked) return ok(undefined);
    const res = await this.request<unknown>({ method: 'GET', path: '/v1/meta/version' });
    if (!res.ok) return res;
    const parsed = versionHandshakeSchema.safeParse(res.value);
    if (!parsed.success) {
      return err(
        backendError('schema-mismatch', 'version handshake response did not parse', {
          details: { issues: parsed.error.issues },
        }),
      );
    }
    if (parsed.data.major !== SUPPORTED_BACKEND_MAJOR) {
      return err(
        backendError(
          'incompatible-backend-version',
          `plugin requires ${SUPPORTED_BACKEND_MAJOR}, backend is ${parsed.data.major}`,
        ),
      );
    }
    this.#handshakeChecked = true;
    return ok(undefined);
  }

  /**
   * Resolves the active session's tenant + user from the bearer token.
   * Drift entry (2026-05-03): hosted-SaaS pivot replaced manual
   * SENIORIFY_TENANT_ID + SENIORIFY_USER_ID env vars with this lookup.
   * Sends Authorization but NOT X-Tenant-Id — sending the tenant header
   * would be circular (whoami's whole purpose is to learn the tenant).
   */
  async whoami(): Promise<Result<WhoamiResponse, BackendError>> {
    const res = await this.request<unknown>({
      method: 'GET',
      path: '/v1/whoami',
      omitTenantHeader: true,
    });
    if (!res.ok) return res;
    const parsed = whoamiResponseSchema.safeParse(res.value);
    if (!parsed.success) {
      return err(
        backendError('schema-mismatch', 'whoami response did not parse', {
          details: { issues: parsed.error.issues },
        }),
      );
    }
    return ok(parsed.data);
  }

  async request<T>(opts: RequestOptions): Promise<Result<T, BackendError>> {
    const isMutating = opts.method !== 'GET';
    const idempotencyKey = isMutating
      ? opts.idempotencyKey ?? this.#cfg.newIdempotencyKey()
      : undefined;

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#cfg.authToken}`,
      ...(opts.omitTenantHeader === true ? {} : { 'x-tenant-id': this.#cfg.tenantId }),
      'content-type': 'application/json',
      ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
      ...(this.#cfg.userAgent !== undefined ? { 'user-agent': this.#cfg.userAgent } : {}),
    };

    const url = `${this.#cfg.baseUrl}${opts.path}`;
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const maxRetries = opts.retries ?? this.#cfg.maxRetries;

    let lastNetworkError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      let response: Dispatcher.ResponseData;
      try {
        response = await this.#cfg.transport(url, {
          method: opts.method,
          headers,
          ...(body !== undefined ? { body } : {}),
        });
      } catch (e) {
        lastNetworkError = e instanceof Error ? e : new Error(String(e));
        if (attempt < maxRetries) {
          await sleep(this.#backoffMs(attempt));
          continue;
        }
        return err(
          backendError('backend-unavailable', `network error: ${lastNetworkError.message}`),
        );
      }

      const status = response.statusCode;

      if (status >= 200 && status < 300) {
        const text = await response.body.text();
        if (text.length === 0) return ok(undefined as T);
        try {
          return ok(JSON.parse(text) as T);
        } catch {
          return err(
            backendError('schema-mismatch', 'response body was not valid JSON', { status }),
          );
        }
      }

      if (status >= 400 && status < 500) {
        const parsed = await this.#parseErrorBody(response);
        return err(parsed ?? backendError(this.#mapClientError(status), `HTTP ${status}`, { status }));
      }

      if (status >= 500) {
        if (attempt < maxRetries) {
          await sleep(this.#backoffMs(attempt));
          continue;
        }
        const parsed = await this.#parseErrorBody(response);
        return err(parsed ?? backendError('backend-unavailable', `HTTP ${status}`, { status }));
      }

      return err(backendError('backend-unavailable', `unexpected HTTP ${status}`, { status }));
    }

    return err(
      backendError(
        'backend-unavailable',
        lastNetworkError !== undefined ? lastNetworkError.message : 'retry budget exhausted',
      ),
    );
  }

  #backoffMs(attempt: number): number {
    const exp = BASE_BACKOFF_MS * 2 ** attempt;
    const jitter = Math.floor(Math.random() * BASE_BACKOFF_MS);
    return Math.min(exp + jitter, MAX_BACKOFF_MS);
  }

  #mapClientError(status: number): BackendError['code'] {
    if (status === 401 || status === 403) return 'cross-tenant-rejection';
    if (status === 404) return 'plan-not-found';
    if (status === 409) return 'already-signed';
    if (status === 422) return 'invalid-input';
    return 'invalid-input';
  }

  async #parseErrorBody(response: Dispatcher.ResponseData): Promise<BackendError | undefined> {
    const text = await response.body.text();
    if (text.length === 0) return undefined;
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      if (typeof parsed.code === 'string' && typeof parsed.message === 'string') {
        return backendError(parsed.code as BackendError['code'], parsed.message, {
          status: response.statusCode,
        });
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }
}

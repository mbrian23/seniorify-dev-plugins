// Tenant settings cache. Per-session, 5-minute TTL, invalidated on session
// start. On cache miss + backend unreachable: the hook FAIL-CLOSES (returns
// `block` with reason `tenant-settings-unavailable`) per Constitution §IV
// and FR-007. This module surfaces the failure as a Result; the hook layer
// translates it into the block decision.

import { tenantSettingsSchema, type TenantSettings } from '../backend/schemas/tenant-settings.js';
import { err, ok, type Result } from '../shared/result.js';

import type { BackendClient } from '../backend/client.js';
import type { BackendError } from '../backend/errors.js';
import type { TenantId } from '../shared/types.js';

const TTL_MS = 5 * 60 * 1_000;

export class TenantSettingsCache {
  readonly #client: BackendClient;
  readonly #now: () => number;
  #entry: { value: TenantSettings; fetchedAtMs: number } | null = null;

  constructor(client: BackendClient, now: () => number = Date.now) {
    this.#client = client;
    this.#now = now;
  }

  /** Force-invalidate the cache (e.g., on session start). */
  invalidate(): void {
    this.#entry = null;
  }

  async get(tenantId: TenantId): Promise<Result<TenantSettings, BackendError>> {
    const cached = this.#entry;
    if (cached !== null && this.#now() - cached.fetchedAtMs < TTL_MS && cached.value.tenant_id === tenantId) {
      return ok(cached.value);
    }
    const res = await this.#client.request<unknown>({
      method: 'GET',
      path: `/v1/tenants/${encodeURIComponent(tenantId)}/settings`,
    });
    if (!res.ok) return res;
    const parsed = tenantSettingsSchema.safeParse(res.value);
    if (!parsed.success) {
      return err({
        code: 'schema-mismatch',
        message: 'tenant settings response did not parse',
        details: { issues: parsed.error.issues },
      });
    }
    this.#entry = { value: parsed.data, fetchedAtMs: this.#now() };
    return ok(parsed.data);
  }
}

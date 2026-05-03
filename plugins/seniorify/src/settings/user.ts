// Per-user setting resolver. The backend enforces the floor — a user override
// that would relax below the tenant admin's gating-strength floor is REJECTED
// at write time on the backend. The plugin trusts the backend's resolution
// for `effective_gating_strength` (FR-006c). Aggressiveness is freely
// per-user-overridable within the tenant's allowed list (FR-001a).

import {
  userSettingResponseSchema,
  type UserSetting,
} from '../backend/schemas/user-setting.js';
import { err, ok, type Result } from '../shared/result.js';

import type { BackendClient } from '../backend/client.js';
import type { BackendError } from '../backend/errors.js';
import type {
  Aggressiveness,
  GatingStrength,
} from '../backend/schemas/engagement-event.js';
import type { TenantSettings } from '../backend/schemas/tenant-settings.js';
import type { UserId } from '../shared/types.js';

export class UserSettingResolver {
  readonly #client: BackendClient;

  constructor(client: BackendClient) {
    this.#client = client;
  }

  async fetch(userId: UserId): Promise<Result<UserSetting | null, BackendError>> {
    const res = await this.#client.request<unknown>({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(userId)}/setting`,
    });
    if (!res.ok) return res;
    const parsed = userSettingResponseSchema.safeParse(res.value);
    if (!parsed.success) {
      return err({
        code: 'schema-mismatch',
        message: 'user setting response did not parse',
        details: { issues: parsed.error.issues },
      });
    }
    if ('not_set' in parsed.data) return ok(null);
    return ok(parsed.data);
  }
}

export const effectiveAggressiveness = (
  tenant: TenantSettings,
  user: UserSetting | null,
): Aggressiveness => user?.aggressiveness ?? tenant.aggressiveness;

export const effectiveGatingStrength = (
  tenant: TenantSettings,
  user: UserSetting | null,
): GatingStrength => user?.gating_strength ?? tenant.gating_strength;

// `override` MCP tool. Per contracts/mcp-tools.md.
//
// Override is NOT metered — it does not generate a follow-up question. No
// `withReservation` wrap; this is the only audit-mutating MCP path that
// skips the budget gate (Constitution §VIII applies to *metered* calls).

import { z } from 'zod';

import { findingSchema } from '../../backend/schemas/finding.js';
import { err, ok, type Result } from '../../shared/result.js';

import type { BackendClient } from '../../backend/client.js';
import type { BackendError } from '../../backend/errors.js';
import type { Finding } from '../../backend/schemas/finding.js';
import type { TenantId, UserId } from '../../shared/types.js';

export const overrideInputSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  plan_id: z.string().min(1),
  finding_id: z.string().min(1),
  text: z.string().min(1).max(4_000),
  surface: z.enum(['inline', 'page']),
});

export type OverrideInput = z.infer<typeof overrideInputSchema>;

const overrideResponseSchema = z.object({
  finding: findingSchema,
});

export interface OverrideOutput {
  readonly finding: Finding;
}

export interface OverrideDeps {
  readonly client: BackendClient;
  readonly resolvedTenantId: TenantId;
  readonly resolvedUserId: UserId;
}

export const handleOverride = async (
  deps: OverrideDeps,
  input: OverrideInput,
): Promise<Result<OverrideOutput, BackendError>> => {
  if (input.tenant_id !== deps.resolvedTenantId) {
    return err({ code: 'cross-tenant-rejection', message: 'override tenant mismatch' });
  }
  if (input.user_id !== deps.resolvedUserId) {
    return err({ code: 'cross-tenant-rejection', message: 'override user mismatch' });
  }

  const res = await deps.client.request<unknown>({
    method: 'POST',
    path: `/v1/findings/${encodeURIComponent(input.finding_id)}/overrides`,
    body: {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      plan_id: input.plan_id,
      text: input.text,
      surface: input.surface,
    },
  });
  if (!res.ok) return res;
  const parsed = overrideResponseSchema.safeParse(res.value);
  if (!parsed.success) {
    return err({
      code: 'schema-mismatch',
      message: 'override response did not parse',
      details: { issues: parsed.error.issues },
    });
  }
  return ok({ finding: parsed.data.finding });
};

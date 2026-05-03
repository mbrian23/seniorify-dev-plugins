// `sign_plan` MCP tool. Per contracts/mcp-tools.md.
//
// Signing is NOT metered — no LLM call. No `withReservation` wrap.

import { z } from 'zod';

import { engagementEventIdSchema } from '../../backend/schemas/primitives.js';
import { signatureSchema } from '../../backend/schemas/signature.js';
import { err, ok, type Result } from '../../shared/result.js';

import type { BackendClient } from '../../backend/client.js';
import type { BackendError } from '../../backend/errors.js';
import type { Signature } from '../../backend/schemas/signature.js';
import type { EngagementEventId, TenantId, UserId } from '../../shared/types.js';

export const signPlanInputSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  plan_id: z.string().min(1),
  surface: z.enum(['inline', 'page']),
  unaddressed_findings_acknowledgment: z
    .literal('override-and-sign')
    .nullable()
    .optional(),
});

export type SignPlanInput = z.infer<typeof signPlanInputSchema>;

const signPlanResponseSchema = z.object({
  signature: signatureSchema,
  engagement_event_id: engagementEventIdSchema,
});

export interface SignPlanOutput {
  readonly signature: Signature;
  readonly engagement_event_id: EngagementEventId;
}

export interface SignPlanDeps {
  readonly client: BackendClient;
  readonly resolvedTenantId: TenantId;
  readonly resolvedUserId: UserId;
  readonly newIdempotencyKey?: () => string;
}

export const handleSignPlan = async (
  deps: SignPlanDeps,
  input: SignPlanInput,
): Promise<Result<SignPlanOutput, BackendError>> => {
  if (input.tenant_id !== deps.resolvedTenantId) {
    return err({ code: 'cross-tenant-rejection', message: 'sign_plan tenant mismatch' });
  }
  if (input.user_id !== deps.resolvedUserId) {
    return err({ code: 'cross-tenant-rejection', message: 'sign_plan user mismatch' });
  }

  const res = await deps.client.request<unknown>({
    method: 'POST',
    path: `/v1/plans/${encodeURIComponent(input.plan_id)}/signatures`,
    body: {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      surface: input.surface,
      unaddressed_findings_acknowledgment:
        input.unaddressed_findings_acknowledgment ?? null,
    },
    // Sign is idempotent — retrying with the same key is safe and yields
    // the existing signature. The plugin's outer caller may pass a stable
    // key tied to a (plan_id, user_id) pair.
    ...(deps.newIdempotencyKey !== undefined
      ? { idempotencyKey: deps.newIdempotencyKey() }
      : {}),
  });
  if (!res.ok) return res;
  const parsed = signPlanResponseSchema.safeParse(res.value);
  if (!parsed.success) {
    return err({
      code: 'schema-mismatch',
      message: 'sign_plan response did not parse',
      details: { issues: parsed.error.issues },
    });
  }
  return ok({
    signature: parsed.data.signature,
    engagement_event_id: parsed.data.engagement_event_id,
  });
};

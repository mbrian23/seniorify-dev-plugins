// `defend` MCP tool. Per contracts/mcp-tools.md.
//
// Constitution §VIII (NON-NEGOTIABLE): follow-up generation is metered. We
// always reserve budget around the call — if the backend chooses not to
// emit a follow-up, the reservation just stays under-used (the backend
// refunds on close-out, per backend-client.md TTL contract).

import { z } from 'zod';

import { findingSchema } from '../../backend/schemas/finding.js';
import { withReservation } from '../../budget/reservation.js';
import { err, ok, type Result } from '../../shared/result.js';

import type { BackendClient } from '../../backend/client.js';
import type { BackendError } from '../../backend/errors.js';
import type { Finding } from '../../backend/schemas/finding.js';
import type { BudgetReservationClient } from '../../budget/reservation.js';
import type { TenantId, UserId } from '../../shared/types.js';

export const defendInputSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  plan_id: z.string().min(1),
  finding_id: z.string().min(1),
  text: z.string().min(1).max(4_000),
  surface: z.enum(['inline', 'page']),
});

export type DefendInput = z.infer<typeof defendInputSchema>;

const defendResponseSchema = z.object({
  finding: findingSchema,
  follow_up_finding: findingSchema.nullable(),
});

export interface DefendOutput {
  readonly finding: Finding;
  readonly follow_up_finding: Finding | null;
}

export interface DefendDeps {
  readonly client: BackendClient;
  readonly budget: BudgetReservationClient;
  readonly resolvedTenantId: TenantId;
  readonly resolvedUserId: UserId;
}

export const handleDefend = async (
  deps: DefendDeps,
  input: DefendInput,
): Promise<Result<DefendOutput, BackendError>> => {
  if (input.tenant_id !== deps.resolvedTenantId) {
    return err({ code: 'cross-tenant-rejection', message: 'defend tenant mismatch' });
  }
  if (input.user_id !== deps.resolvedUserId) {
    return err({ code: 'cross-tenant-rejection', message: 'defend user mismatch' });
  }

  return withReservation(
    deps.budget,
    {
      tenant_id: deps.resolvedTenantId,
      user_id: deps.resolvedUserId,
      model: 'claude-haiku-4-5',
      estimated_input_tokens: Math.ceil(input.text.length / 4),
      estimated_output_tokens: 1_000,
    },
    async () => {
      const res = await deps.client.request<unknown>({
        method: 'POST',
        path: `/v1/findings/${encodeURIComponent(input.finding_id)}/defenses`,
        body: {
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          plan_id: input.plan_id,
          text: input.text,
          surface: input.surface,
        },
      });
      if (!res.ok) return res;
      const parsed = defendResponseSchema.safeParse(res.value);
      if (!parsed.success) {
        return err<BackendError>({
          code: 'schema-mismatch',
          message: 'defend response did not parse',
          details: { issues: parsed.error.issues },
        });
      }
      return ok<DefendOutput>({
        finding: parsed.data.finding,
        follow_up_finding: parsed.data.follow_up_finding,
      });
    },
  );
};

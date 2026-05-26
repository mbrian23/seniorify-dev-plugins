// `submit_plan` MCP tool. Per contracts/mcp-tools.md.
//
// Constitution §VIII (NON-NEGOTIABLE): the backend's question-generator is
// metered, so we MUST consult `withReservation` before issuing the call. The
// reservation gates not just the LLM call but the whole `POST /v1/plans`
// path — the backend bills a generation token even on zero-finding plans.

import { z } from 'zod';

import { findingSchema } from '../../backend/schemas/finding.js';
import { planIdSchema } from '../../backend/schemas/primitives.js';
import { withReservation } from '../../budget/reservation.js';
import { err, ok, type Result } from '../../shared/result.js';

import type { BackendClient } from '../../backend/client.js';
import type { BackendError } from '../../backend/errors.js';
import type { Finding } from '../../backend/schemas/finding.js';
import type { BudgetReservationClient } from '../../budget/reservation.js';
import type { PlanId, TenantId, UserId } from '../../shared/types.js';

export const submitPlanInputSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  pending_engagement_id: z.string().min(1),
  body: z.string().min(1).max(16_000),
  target_paths: z.array(z.string().min(1)).min(1),
  may_also_touch: z.array(z.string().min(1)).optional(),
  public_surface_changes: z
    .array(
      z.object({
        kind: z.enum(['add', 'modify-signature', 'modify-body-only', 'remove']),
        symbol: z.string().min(1),
      }),
    )
    .optional(),
  new_dependencies: z.array(z.string().min(1)).optional(),
});

export type SubmitPlanInput = z.infer<typeof submitPlanInputSchema>;

const submitPlanResponseSchema = z.object({
  plan_id: planIdSchema,
  initial_findings: z.array(findingSchema),
  budget_remaining_for_user: z.number().nonnegative(),
});

export interface SubmitPlanOutput {
  readonly plan_id: PlanId;
  readonly initial_findings: readonly Finding[];
  readonly budget_remaining_for_user: number;
}

export interface SubmitPlanDeps {
  readonly client: BackendClient;
  readonly budget: BudgetReservationClient;
  readonly resolvedTenantId: TenantId;
  readonly resolvedUserId: UserId;
}

export const handleSubmitPlan = async (
  deps: SubmitPlanDeps,
  input: SubmitPlanInput,
): Promise<Result<SubmitPlanOutput, BackendError>> => {
  if (input.tenant_id !== deps.resolvedTenantId) {
    return err({
      code: 'cross-tenant-rejection',
      message: 'submit_plan tenant_id does not match resolved session tenant',
    });
  }
  if (input.user_id !== deps.resolvedUserId) {
    return err({
      code: 'cross-tenant-rejection',
      message: 'submit_plan user_id does not match resolved session user',
    });
  }

  return withReservation(
    deps.budget,
    {
      tenant_id: deps.resolvedTenantId,
      user_id: deps.resolvedUserId,
      // Plan-generation is the bookkeeping model; the backend may re-tag.
      model: 'claude-haiku-4-5',
      estimated_input_tokens: estimateInputTokens(input.body),
      estimated_output_tokens: 1_500,
    },
    async () => {
      const res = await deps.client.request<unknown>({
        method: 'POST',
        path: '/v1/plans',
        body: {
          tenant_id: input.tenant_id,
          user_id: input.user_id,
          pending_engagement_id: input.pending_engagement_id,
          body: input.body,
          target_paths: input.target_paths,
          may_also_touch: input.may_also_touch ?? [],
          public_surface_changes: input.public_surface_changes ?? [],
          new_dependencies: input.new_dependencies ?? [],
        },
      });
      if (!res.ok) return res;
      const parsed = submitPlanResponseSchema.safeParse(res.value);
      if (!parsed.success) {
        return err<BackendError>({
          code: 'schema-mismatch',
          message: 'submit_plan response did not parse',
          details: { issues: parsed.error.issues },
        });
      }
      return ok<SubmitPlanOutput>({
        plan_id: parsed.data.plan_id,
        initial_findings: parsed.data.initial_findings,
        budget_remaining_for_user: parsed.data.budget_remaining_for_user,
      });
    },
  );
};

const estimateInputTokens = (body: string): number =>
  // Cheap and conservative: ≈ 4 chars / token for English.
  Math.ceil(body.length / 4);

import { z } from 'zod';

import {
  iso8601Schema,
  planIdSchema,
  sessionIdSchema,
  tenantIdSchema,
  userIdSchema,
} from './primitives.js';

export const publicSurfaceChangeSchema = z.object({
  kind: z.enum(['add', 'modify-signature', 'modify-body-only', 'remove']),
  symbol: z.string().min(1),
});

export type PublicSurfaceChange = z.infer<typeof publicSurfaceChangeSchema>;

export const planSchema = z.object({
  plan_id: planIdSchema,
  tenant_id: tenantIdSchema,
  user_id: userIdSchema,
  session_id: sessionIdSchema,
  body: z.string().min(1).max(16_000),
  target_paths: z.array(z.string().min(1)).min(1),
  may_also_touch: z.array(z.string().min(1)).default([]),
  public_surface_changes: z.array(publicSurfaceChangeSchema).default([]),
  new_dependencies: z.array(z.string().min(1)).default([]),
  submitted_at: iso8601Schema,
  signed_at: iso8601Schema.nullable(),
  signature_hash: z.string().nullable(),
});

export type Plan = z.infer<typeof planSchema>;

// Bootstrap shape — what `GET /v1/users/{id}/in_flight_plans` returns per FR-014.
export const inFlightPlanSchema = z.object({
  plan_id: planIdSchema,
  tenant_id: tenantIdSchema,
  body_excerpt: z.string().max(200),
  target_paths: z.array(z.string().min(1)),
  submitted_at: iso8601Schema,
  findings_pending: z.number().int().nonnegative(),
  resume_url: z.string().url(),
});

export type InFlightPlan = z.infer<typeof inFlightPlanSchema>;

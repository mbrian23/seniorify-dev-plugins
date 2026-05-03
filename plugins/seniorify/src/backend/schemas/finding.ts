import { z } from 'zod';

import {
  findingIdSchema,
  iso8601Schema,
  planIdSchema,
  tenantIdSchema,
  userIdSchema,
} from './primitives.js';

// Grounding is a discriminated union (Constitution §VI). Generic prompts cannot
// pass schema validation: each kind requires a specific reference field. The
// schema is the source of truth — any backend response with an unknown kind
// (or with kind: 'unknown' missing a `reason`) fails parsing at the boundary.

export const groundingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('convention_ref'),
    ref: z.string().min(1),
    excerpt: z.string().min(1),
  }),
  z.object({
    kind: z.literal('plan_artifact'),
    path: z.string().min(1),
    excerpt: z.string().min(1),
  }),
  z.object({
    kind: z.literal('prior_plan_ref'),
    plan_id: planIdSchema,
    excerpt: z.string().min(1),
  }),
  z.object({
    kind: z.literal('unknown'),
    reason: z.string().min(1),
  }),
]);

export type Grounding = z.infer<typeof groundingSchema>;

export const defenseSchema = z.object({
  finding_id: findingIdSchema,
  text: z.string().min(1).max(4_000),
  surface: z.enum(['inline', 'page']),
  user_id: userIdSchema,
  tenant_id: tenantIdSchema,
  created_at: iso8601Schema,
});

export type Defense = z.infer<typeof defenseSchema>;

export const overrideSchema = z.object({
  finding_id: findingIdSchema,
  text: z.string().min(1).max(4_000),
  surface: z.enum(['inline', 'page']),
  user_id: userIdSchema,
  tenant_id: tenantIdSchema,
  created_at: iso8601Schema,
  permanent: z.literal(true),
});

export type Override = z.infer<typeof overrideSchema>;

export const findingSchema = z.object({
  finding_id: findingIdSchema,
  plan_id: planIdSchema,
  tenant_id: tenantIdSchema,
  question: z.string().min(1),
  grounding: groundingSchema,
  defense: defenseSchema.nullable(),
  override: overrideSchema.nullable(),
  follow_up: findingIdSchema.nullable(),
  created_at: iso8601Schema,
});

export type Finding = z.infer<typeof findingSchema>;

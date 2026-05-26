import { z } from 'zod';

import {
  engagementEventIdSchema,
  iso8601Schema,
  planIdSchema,
  sessionIdSchema,
  tenantIdSchema,
  userIdSchema,
} from './primitives.js';

export const eventTypeSchema = z.enum([
  'auto-engaged',
  'force-engaged',
  'auto-skipped',
  'trivial-exempt-declared',
  'session-suspended',
  'session-resumed',
  'skipped-pending-justification',
  'skip-justified',
  'signed',
  'override-and-signed',
  'divergence-detected',
  'divergence-override',
]);

export type EventType = z.infer<typeof eventTypeSchema>;

export const gatingStrengthSchema = z.enum([
  'warn-only',
  'soft-block',
  'soft-block-skip-disabled',
  'hard-block-until-justified',
]);

export type GatingStrength = z.infer<typeof gatingStrengthSchema>;

export const aggressivenessSchema = z.enum(['low', 'medium', 'high']);
export type Aggressiveness = z.infer<typeof aggressivenessSchema>;

export const agentActionSignalSchema = z.object({
  tool: z.string().min(1),
  affected_paths: z.array(z.string()),
  diff_lines: z.number().int().nonnegative(),
  is_public_surface_touch: z.boolean(),
  introduces_dependency: z.boolean(),
});

export type AgentActionSignal = z.infer<typeof agentActionSignalSchema>;

export const engagementEventSchema = z.object({
  event_id: engagementEventIdSchema,
  tenant_id: tenantIdSchema,
  user_id: userIdSchema,
  session_id: sessionIdSchema,
  plan_id: planIdSchema.nullable(),
  event_type: eventTypeSchema,
  agent_action_signal: agentActionSignalSchema,
  inline_short_reason: z.string().nullable(),
  deferred_full_justification: z.string().nullable(),
  aggressiveness_at_event: aggressivenessSchema,
  gating_strength_at_event: gatingStrengthSchema,
  created_at: iso8601Schema,
  updated_at: iso8601Schema,
});

export type EngagementEvent = z.infer<typeof engagementEventSchema>;

// State transition: only one mutation is permitted on a single event row.
// `skipped-pending-justification` → `skip-justified`. All other types are
// terminal at creation. The plugin only writes new events; the
// PATCH transition is performed by the web page.
export const allowedTransitions: ReadonlyMap<EventType, ReadonlySet<EventType>> = new Map([
  ['skipped-pending-justification', new Set<EventType>(['skip-justified'])],
]);

export const skipPendingJustificationSchema = z.object({
  engagement_event_id: engagementEventIdSchema,
  inline_short_reason: z.string().min(1),
  agent_action_signal: agentActionSignalSchema,
  created_at: iso8601Schema,
  due_by: iso8601Schema,
  blocks_next_plan_submission: z.boolean(),
});

export type SkipPendingJustification = z.infer<typeof skipPendingJustificationSchema>;

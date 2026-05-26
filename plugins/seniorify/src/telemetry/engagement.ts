// Engagement-event emitter. POST /v1/engagement_events is durable-on-write
// per `contracts/backend-client.md` — the plugin awaits the response before
// the hook returns its decision. If the write fails, the hook's caller MUST
// treat it as fail-closed (reason: 'audit-log-unavailable') per FR-007.
//
// This module does NOT batch — every call awaits a backend ack. That's the
// point: the engagement event is the load-bearing audit-trail entry, and a
// silent loss of one event is a Constitution §IV violation.

import { randomUUID } from 'node:crypto';

import {
  engagementEventSchema,
  type AgentActionSignal,
  type Aggressiveness,
  type EngagementEvent,
  type EventType,
  type GatingStrength,
} from '../backend/schemas/engagement-event.js';
import { err, ok, type Result } from '../shared/result.js';

import type { BackendClient } from '../backend/client.js';
import type { BackendError } from '../backend/errors.js';
import type {
  EngagementEventId,
  PlanId,
  SessionId,
  TenantId,
  UserId,
} from '../shared/types.js';

export interface EmitInput {
  readonly tenant_id: TenantId;
  readonly user_id: UserId;
  readonly session_id: SessionId;
  readonly plan_id: PlanId | null;
  readonly event_type: EventType;
  readonly agent_action_signal: AgentActionSignal;
  readonly inline_short_reason: string | null;
  readonly aggressiveness_at_event: Aggressiveness;
  readonly gating_strength_at_event: GatingStrength;
}

export class EngagementEventEmitter {
  readonly #client: BackendClient;
  readonly #newIdempotencyKey: () => string;

  constructor(client: BackendClient, newIdempotencyKey: () => string = () => randomUUID()) {
    this.#client = client;
    this.#newIdempotencyKey = newIdempotencyKey;
  }

  async emit(input: EmitInput): Promise<Result<EngagementEvent, BackendError>> {
    const res = await this.#client.request<unknown>({
      method: 'POST',
      path: '/v1/engagement_events',
      body: {
        ...input,
        deferred_full_justification: null,
      },
      idempotencyKey: this.#newIdempotencyKey(),
    });
    if (!res.ok) return res;
    const parsed = engagementEventSchema.safeParse(res.value);
    if (!parsed.success) {
      return err({
        code: 'schema-mismatch',
        message: 'engagement event response did not parse',
        details: { issues: parsed.error.issues },
      });
    }
    return ok(parsed.data);
  }
}

export const isDurabilityFailure = (
  error: BackendError,
): boolean =>
  error.code === 'backend-unavailable' || error.code === 'audit-log-unavailable';

export type PendingEngagementId = EngagementEventId;

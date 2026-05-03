// SessionContext lifecycle module. Resolves tenant + user on session start,
// fetches tenant settings, user override, pending justifications, and any
// in-flight unsigned plans (FR-014). Holds in-memory state shared by the
// hook, MCP server, and slash commands. NO disk persistence — discarded on
// Claude Code process exit.
//
// FR-014: if `in_flight_plans` is non-empty, the next agent action surfaces
// a single inline reminder line. There is no auto-promote-to-signed path —
// the dev must explicitly resume in the web UI or start a new plan.

import { z } from 'zod';

import { skipPendingJustificationSchema } from '../backend/schemas/engagement-event.js';
import {
  inFlightPlanSchema,
  type InFlightPlan,
  type Plan,
} from '../backend/schemas/plan.js';
import { TenantSettingsCache } from '../settings/tenant.js';
import { UserSettingResolver } from '../settings/user.js';
import { err, ok, type Result } from '../shared/result.js';

import type { BackendClient } from '../backend/client.js';
import type { BackendError } from '../backend/errors.js';
import type {
  AgentActionSignal,
  SkipPendingJustification,
} from '../backend/schemas/engagement-event.js';
import type { TenantSettings } from '../backend/schemas/tenant-settings.js';
import type { UserSetting } from '../backend/schemas/user-setting.js';
import type {
  EngagementEventId,
  SessionId,
  TenantId,
  UserId,
} from '../shared/types.js';


export interface PendingEngagement {
  readonly engagement_event_id: EngagementEventId;
  readonly agent_action_signal: AgentActionSignal;
  readonly created_at: string;
}

export interface SessionContextSnapshot {
  readonly session_id: SessionId;
  readonly tenant_id: TenantId;
  readonly user_id: UserId;
  readonly tenant_settings: TenantSettings;
  readonly user_setting: UserSetting | null;
  readonly current_signed_plan: Plan | null;
  readonly pending_engagement: PendingEngagement | null;
  readonly suspended: boolean;
  readonly pending_justifications: readonly SkipPendingJustification[];
  readonly in_flight_plans: readonly InFlightPlan[];
  /** Set true once the inline reminder has been surfaced this session. */
  readonly in_flight_reminder_shown: boolean;
  /** Set true on /seniorify-audit; the next hook reads + clears it. */
  readonly force_engage_pending: boolean;
}

export interface ResolveInput {
  readonly session_id: SessionId;
  readonly tenant_id: TenantId;
  readonly user_id: UserId;
}

const inFlightResponseSchema = z.object({ in_flight: z.array(inFlightPlanSchema) });
const pendingJustificationsResponseSchema = z.object({
  pending: z.array(skipPendingJustificationSchema),
});

export class SessionContext {
  readonly #client: BackendClient;
  readonly #tenantSettings: TenantSettingsCache;
  readonly #userSettings: UserSettingResolver;
  #state: SessionContextSnapshot | null = null;

  constructor(
    client: BackendClient,
    tenantSettings?: TenantSettingsCache,
    userSettings?: UserSettingResolver,
  ) {
    this.#client = client;
    this.#tenantSettings = tenantSettings ?? new TenantSettingsCache(client);
    this.#userSettings = userSettings ?? new UserSettingResolver(client);
  }

  async resolve(input: ResolveInput): Promise<Result<SessionContextSnapshot, BackendError>> {
    this.#tenantSettings.invalidate();

    const [tenantRes, userRes, pendingRes, inFlightRes] = await Promise.all([
      this.#tenantSettings.get(input.tenant_id),
      this.#userSettings.fetch(input.user_id),
      this.#fetchPendingJustifications(input.user_id),
      this.#fetchInFlightPlans(input.user_id),
    ]);

    if (!tenantRes.ok) return tenantRes;
    if (!userRes.ok) return userRes;
    if (!pendingRes.ok) return pendingRes;
    if (!inFlightRes.ok) return inFlightRes;

    const snapshot: SessionContextSnapshot = {
      session_id: input.session_id,
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      tenant_settings: tenantRes.value,
      user_setting: userRes.value,
      current_signed_plan: null,
      pending_engagement: null,
      suspended: false,
      pending_justifications: pendingRes.value,
      in_flight_plans: inFlightRes.value,
      in_flight_reminder_shown: false,
      force_engage_pending: false,
    };
    this.#state = snapshot;
    return ok(snapshot);
  }

  snapshot(): SessionContextSnapshot {
    if (this.#state === null) {
      throw new Error('SessionContext.snapshot() called before resolve()');
    }
    return this.#state;
  }

  /** Mutates a single field, returning the new snapshot. Internal use only. */
  #mutate<K extends keyof SessionContextSnapshot>(
    key: K,
    value: SessionContextSnapshot[K],
  ): SessionContextSnapshot {
    if (this.#state === null) {
      throw new Error('SessionContext.mutate() before resolve()');
    }
    this.#state = { ...this.#state, [key]: value };
    return this.#state;
  }

  setPendingEngagement(p: PendingEngagement | null): SessionContextSnapshot {
    return this.#mutate('pending_engagement', p);
  }

  setSuspended(s: boolean): SessionContextSnapshot {
    return this.#mutate('suspended', s);
  }

  setSignedPlan(p: Plan | null): SessionContextSnapshot {
    return this.#mutate('current_signed_plan', p);
  }

  setForceEngagePending(v: boolean): SessionContextSnapshot {
    return this.#mutate('force_engage_pending', v);
  }

  markInFlightReminderShown(): SessionContextSnapshot {
    return this.#mutate('in_flight_reminder_shown', true);
  }

  /**
   * Returns the inline reminder line that the next agent action should
   * surface (FR-014), or null if there is nothing to remind. Idempotent —
   * once consumed, subsequent calls return null until the next session.
   */
  consumeInFlightReminder(): string | null {
    const s = this.#state;
    if (s === null || s.in_flight_reminder_shown || s.in_flight_plans.length === 0) {
      return null;
    }
    const first = s.in_flight_plans[0];
    if (first === undefined) return null;
    this.markInFlightReminderShown();
    const others = s.in_flight_plans.length - 1;
    const suffix = others > 0 ? ` (and ${others} more)` : '';
    return (
      `You have an unsigned plan from your last session: "${first.body_excerpt}". ` +
      `Resume at ${first.resume_url}, or run /seniorify-audit to start a new plan.${suffix}`
    );
  }

  async #fetchPendingJustifications(
    userId: UserId,
  ): Promise<Result<readonly SkipPendingJustification[], BackendError>> {
    const res = await this.#client.request<unknown>({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(userId)}/pending_justifications`,
    });
    if (!res.ok) return res;
    const parsed = pendingJustificationsResponseSchema.safeParse(res.value);
    if (!parsed.success) {
      return err({
        code: 'schema-mismatch',
        message: 'pending justifications response did not parse',
        details: { issues: parsed.error.issues },
      });
    }
    return ok(parsed.data.pending);
  }

  async #fetchInFlightPlans(
    userId: UserId,
  ): Promise<Result<readonly InFlightPlan[], BackendError>> {
    const res = await this.#client.request<unknown>({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(userId)}/in_flight_plans`,
    });
    if (!res.ok) return res;
    const parsed = inFlightResponseSchema.safeParse(res.value);
    if (!parsed.success) {
      return err({
        code: 'schema-mismatch',
        message: 'in-flight plans response did not parse',
        details: { issues: parsed.error.issues },
      });
    }
    return ok(parsed.data.in_flight);
  }
}

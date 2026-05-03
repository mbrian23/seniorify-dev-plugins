// PreToolUse hook entrypoint. Per contracts/pretooluse-hook.md.
//
// Decision protocol:
//   1. Parse PreToolUse payload from stdin.
//   2. Resolve SessionContext (tenant settings, user setting, force-engage flag).
//   3. Extract AgentActionSignal from tool_input.
//   4. Run layered threshold evaluator.
//   5. Per gating_strength: allow / warn / block.
//   6. Emit engagement event durably; FAIL-CLOSED if write fails (FR-007).
//   7. Print JSON decision on stdout, exit 0.
//
// The hook MUST be deterministic and side-effect-free outside the durable
// engagement-event write. The contract bias is fail-closed (Constitution §IV).

import { z } from 'zod';

import { BackendClient } from '../backend/client.js';
import { TenantSettingsCache } from '../settings/tenant.js';
import {
  effectiveAggressiveness,
  effectiveGatingStrength,
  UserSettingResolver,
} from '../settings/user.js';
import { err, ok, type Result } from '../shared/result.js';
import { EngagementEventEmitter } from '../telemetry/engagement.js';
import { evaluate } from '../threshold/evaluator.js';
import { extractSignal } from '../threshold/signals.js';

import { loadState } from './state-store.js';

import type { BackendError } from '../backend/errors.js';
import type {
  AgentActionSignal,
  EventType,
} from '../backend/schemas/engagement-event.js';
import type { Plan } from '../backend/schemas/plan.js';
import type { TenantSettings } from '../backend/schemas/tenant-settings.js';
import type { UserSetting } from '../backend/schemas/user-setting.js';
import type {
  EngagementEventId,
  PlanId,
  SessionId,
  TenantId,
  UserId,
} from '../shared/types.js';
import type { EmitInput } from '../telemetry/engagement.js';
import type { Verdict } from '../threshold/evaluator.js';

export const preToolUsePayloadSchema = z.object({
  tool_name: z.string().min(1),
  tool_input: z.unknown(),
  session_id: z.string().min(1),
  cwd: z.string().optional(),
});

export type PreToolUsePayload = z.infer<typeof preToolUsePayloadSchema>;

export interface EngagementHandoff {
  readonly pending_engagement_id: EngagementEventId;
  readonly agent_action_signal: AgentActionSignal;
  readonly next_step: 'submit_plan' | 'force_audit_pending';
}

export type HookDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'block'; readonly reason: string; readonly engagement: EngagementHandoff }
  | { readonly decision: 'warn'; readonly reason: string; readonly engagement: EngagementHandoff };

export interface DecideDeps {
  readonly tenant_settings: TenantSettings;
  readonly user_setting: UserSetting | null;
  readonly signed_plan: Plan | null;
  readonly suspended: boolean;
  readonly force_engage_pending: boolean;
  readonly emitter: EngagementEventEmitter;
  readonly tenant_id: TenantId;
  readonly user_id: UserId;
  readonly session_id: SessionId;
}

const REASON_BUDGET_BYTES = 1_024;

/**
 * Pure-ish: takes resolved deps + payload, returns a decision. The only
 * side effect is the engagement-event emit (which the contract requires
 * to be durable BEFORE the decision is returned, FR-007). Tests pass an
 * in-memory emitter to verify the call shape.
 */
export const decide = async (
  deps: DecideDeps,
  payload: PreToolUsePayload,
): Promise<Result<HookDecision, BackendError>> => {
  if (deps.suspended) {
    return ok({ decision: 'allow' });
  }

  const signal = extractSignal({ tool: payload.tool_name, tool_input: payload.tool_input });
  const aggressiveness = effectiveAggressiveness(deps.tenant_settings, deps.user_setting);
  const gating = effectiveGatingStrength(deps.tenant_settings, deps.user_setting);

  const verdict: Verdict = evaluate({
    signal,
    signed_plan: deps.signed_plan,
    aggressiveness,
    force_engage_pending: deps.force_engage_pending,
  });

  const planId: PlanId | null = deps.signed_plan?.plan_id ?? null;
  const baseEmit: Omit<EmitInput, 'event_type' | 'inline_short_reason'> = {
    tenant_id: deps.tenant_id,
    user_id: deps.user_id,
    session_id: deps.session_id,
    plan_id: planId,
    agent_action_signal: signal,
    aggressiveness_at_event: aggressiveness,
    gating_strength_at_event: gating,
  };

  switch (verdict.kind) {
    case 'trivial': {
      const emit = await deps.emitter.emit({
        ...baseEmit,
        event_type: 'auto-skipped',
        inline_short_reason: verdict.trivial_class,
      });
      if (!emit.ok) {
        return err({ code: 'audit-log-unavailable', message: emit.error.message });
      }
      return ok({ decision: 'allow' });
    }
    case 'covered-by-signed-plan':
      // Covered actions emit no event (the engagement decision was the sign).
      return ok({ decision: 'allow' });

    case 'diverged-from-signed-plan': {
      const emit = await deps.emitter.emit({
        ...baseEmit,
        event_type: 'divergence-detected',
        inline_short_reason: verdict.reason,
      });
      if (!emit.ok) {
        return err({ code: 'audit-log-unavailable', message: emit.error.message });
      }
      return ok({
        decision: 'block',
        reason: shortenReason(
          [
            'plan-audit required (post-sign divergence).',
            `divergence: ${verdict.reason}`,
            `pending_engagement_id: ${emit.value.event_id}`,
            `affected_paths: ${JSON.stringify(signal.affected_paths)}`,
            'next: amend the signed plan, revert, or override-with-reason.',
          ].join('\n'),
        ),
        engagement: {
          pending_engagement_id: emit.value.event_id,
          agent_action_signal: signal,
          next_step: 'submit_plan',
        },
      });
    }
    case 'non-trivial': {
      const eventType: EventType = deps.force_engage_pending ? 'force-engaged' : 'auto-engaged';
      const emit = await deps.emitter.emit({
        ...baseEmit,
        event_type: eventType,
        inline_short_reason: null,
      });
      if (!emit.ok) {
        return err({ code: 'audit-log-unavailable', message: emit.error.message });
      }
      const handoff: EngagementHandoff = {
        pending_engagement_id: emit.value.event_id,
        agent_action_signal: signal,
        next_step: 'submit_plan',
      };
      const reason = shortenReason(
        [
          'plan-audit required.',
          `pending_engagement_id: ${emit.value.event_id}`,
          `affected_paths: ${JSON.stringify(signal.affected_paths)}`,
          signal.is_public_surface_touch ? 'public_surface_change: yes' : '',
          signal.introduces_dependency ? 'introduces_dependency: yes' : '',
          'next: call submit_plan with the above and a 1-2 sentence plan body.',
        ]
          .filter((s) => s.length > 0)
          .join('\n'),
      );
      if (gating === 'warn-only') {
        return ok({ decision: 'warn', reason, engagement: handoff });
      }
      return ok({ decision: 'block', reason, engagement: handoff });
    }
    default: {
      const _exhaustive: never = verdict;
      return _exhaustive;
    }
  }
};

const shortenReason = (text: string): string => {
  const limit = REASON_BUDGET_BYTES;
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, limit - 3);
  return `${buf.toString('utf8')}...`;
};

interface HookEnv {
  readonly SENIORIFY_BACKEND_URL: string;
  readonly SENIORIFY_AUTH_TOKEN: string;
  readonly SENIORIFY_TENANT_ID: TenantId;
  readonly SENIORIFY_USER_ID: UserId;
}

const requireEnv = (): Result<HookEnv, BackendError> => {
  const env = process.env;
  const url = env.SENIORIFY_BACKEND_URL;
  const token = env.SENIORIFY_AUTH_TOKEN;
  const tenant = env.SENIORIFY_TENANT_ID;
  const user = env.SENIORIFY_USER_ID;
  if (
    url === undefined ||
    token === undefined ||
    tenant === undefined ||
    user === undefined ||
    url.length === 0 ||
    token.length === 0 ||
    tenant.length === 0 ||
    user.length === 0
  ) {
    return err({
      code: 'tenant-unresolved',
      message:
        'hook requires SENIORIFY_BACKEND_URL, SENIORIFY_AUTH_TOKEN, SENIORIFY_TENANT_ID, SENIORIFY_USER_ID',
    });
  }
  return ok({
    SENIORIFY_BACKEND_URL: url,
    SENIORIFY_AUTH_TOKEN: token,
    SENIORIFY_TENANT_ID: tenant as TenantId,
    SENIORIFY_USER_ID: user as UserId,
  });
};

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const writeBlock = (reason: string): void => {
  process.stdout.write(JSON.stringify({ decision: 'block', reason, engagement: null }));
};

export const main = async (): Promise<void> => {
  const envRes = requireEnv();
  if (!envRes.ok) {
    writeBlock(`tenant-unresolved: ${envRes.error.message}`);
    return;
  }
  const env = envRes.value;

  const raw = await readStdin();
  let parsed: PreToolUsePayload;
  try {
    parsed = preToolUsePayloadSchema.parse(JSON.parse(raw));
  } catch {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  const sessionId = parsed.session_id as SessionId;
  const state = await loadState(sessionId);

  const client = new BackendClient({
    baseUrl: env.SENIORIFY_BACKEND_URL,
    authToken: env.SENIORIFY_AUTH_TOKEN,
    tenantId: env.SENIORIFY_TENANT_ID,
  });
  const tenantCache = new TenantSettingsCache(client);
  const userResolver = new UserSettingResolver(client);

  const [settingsRes, userRes] = await Promise.all([
    tenantCache.get(env.SENIORIFY_TENANT_ID),
    userResolver.fetch(env.SENIORIFY_USER_ID),
  ]);
  if (!settingsRes.ok) {
    writeBlock('tenant settings unavailable');
    return;
  }
  if (!userRes.ok) {
    writeBlock('user settings unavailable');
    return;
  }

  const emitter = new EngagementEventEmitter(client);

  const decisionRes = await decide(
    {
      tenant_settings: settingsRes.value,
      user_setting: userRes.value,
      signed_plan: null,
      suspended: false,
      force_engage_pending: state.force_engage_pending,
      emitter,
      tenant_id: env.SENIORIFY_TENANT_ID,
      user_id: env.SENIORIFY_USER_ID,
      session_id: sessionId,
    },
    parsed,
  );

  if (!decisionRes.ok) {
    writeBlock(`audit-log unavailable: ${decisionRes.error.message}`);
    return;
  }

  process.stdout.write(JSON.stringify(decisionRes.value));
};

if (process.argv[1]?.endsWith('pretooluse.js') === true) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(
      JSON.stringify({ decision: 'block', reason: `evaluator-error: ${msg}` }),
    );
    process.exit(0);
  });
}

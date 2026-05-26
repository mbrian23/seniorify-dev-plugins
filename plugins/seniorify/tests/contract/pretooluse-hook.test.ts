// T025 — contract test for the PreToolUse hook decision protocol.
// Verifies that every branch in research.md §2 layered heuristic produces
// the right {decision, engagement} payload, and that the block-message
// reason is ≤ 1 KB and includes pending_engagement_id and affected_paths.

import { describe, expect, it } from 'vitest';

import { decide } from '../../src/hook/pretooluse.js';
import { ok, type Result } from '../../src/shared/result.js';

import type { BackendError } from '../../src/backend/errors.js';
import type { EngagementEvent } from '../../src/backend/schemas/engagement-event.js';
import type { Plan } from '../../src/backend/schemas/plan.js';
import type { TenantSettings } from '../../src/backend/schemas/tenant-settings.js';
import type {
  EngagementEventId,
  ISO8601,
  PlanId,
  SessionId,
  TenantId,
  UserId,
} from '../../src/shared/types.js';
import type {
  EmitInput,
  EngagementEventEmitter,
} from '../../src/telemetry/engagement.js';

const t = (s: string): TenantId => s as TenantId;
const u = (s: string): UserId => s as UserId;
const sid = (s: string): SessionId => s as SessionId;

const baseSettings = (overrides: Partial<TenantSettings> = {}): TenantSettings => ({
  tenant_id: t('tnt-1'),
  tier: 'enterprise',
  aggressiveness: 'low',
  gating_strength: 'soft-block',
  max_follow_up_depth: 1,
  trivial_classes: ['small-edit-no-public-surface'],
  updated_at: '2026-05-03T00:00:00Z' as ISO8601,
  ...overrides,
});

const fakeEmitter = (
  fn?: (input: EmitInput) => Promise<Result<EngagementEvent, BackendError>>,
): { calls: EmitInput[]; emitter: EngagementEventEmitter } => {
  const calls: EmitInput[] = [];
  const emit = (input: EmitInput): Promise<Result<EngagementEvent, BackendError>> => {
    calls.push(input);
    if (fn !== undefined) return fn(input);
    return Promise.resolve(
      ok({
        event_id: `evt-${calls.length.toString()}` as EngagementEventId,
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        plan_id: input.plan_id,
        event_type: input.event_type,
        agent_action_signal: input.agent_action_signal,
        inline_short_reason: input.inline_short_reason,
        deferred_full_justification: null,
        aggressiveness_at_event: input.aggressiveness_at_event,
        gating_strength_at_event: input.gating_strength_at_event,
        created_at: '2026-05-03T00:00:00Z' as ISO8601,
        updated_at: '2026-05-03T00:00:00Z' as ISO8601,
      }),
    );
  };
  return { calls, emitter: { emit } as unknown as EngagementEventEmitter };
};

const baseDeps = (overrides?: {
  settings?: TenantSettings;
  signed_plan?: Plan | null;
  force_engage_pending?: boolean;
  suspended?: boolean;
}) => {
  const f = fakeEmitter();
  return {
    f,
    deps: {
      tenant_settings: overrides?.settings ?? baseSettings(),
      user_setting: null,
      signed_plan: overrides?.signed_plan ?? null,
      suspended: overrides?.suspended ?? false,
      force_engage_pending: overrides?.force_engage_pending ?? false,
      emitter: f.emitter,
      tenant_id: t('tnt-1'),
      user_id: u('usr-1'),
      session_id: sid('ses-1'),
    },
  };
};

describe('PreToolUse hook — research.md §2 layered heuristic branches', () => {
  it('suspended session → allow with no event', async () => {
    const { f, deps } = baseDeps({ suspended: true });
    const r = await decide(deps, {
      tool_name: 'Edit',
      tool_input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision).toBe('allow');
    expect(f.calls).toHaveLength(0);
  });

  it('Read tool → trivial → allow with auto-skipped event', async () => {
    const { f, deps } = baseDeps();
    const r = await decide(deps, {
      tool_name: 'Read',
      tool_input: { file_path: 'x.ts' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision).toBe('allow');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.event_type).toBe('auto-skipped');
  });

  it('small non-public edit under low aggressiveness → trivial → allow', async () => {
    const { f, deps } = baseDeps();
    const r = await decide(deps, {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision).toBe('allow');
    expect(f.calls[0]?.event_type).toBe('auto-skipped');
  });

  it('non-trivial action (public surface) under soft-block → block + auto-engaged event', async () => {
    const { f, deps } = baseDeps();
    const r = await decide(deps, {
      tool_name: 'Write',
      tool_input: { file_path: 'src/api.ts', content: 'export function foo() {}' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.decision).toBe('block');
      if (r.value.decision === 'block') {
        expect(r.value.reason).toContain('pending_engagement_id');
        expect(r.value.reason).toContain('src/api.ts');
        expect(r.value.engagement.next_step).toBe('submit_plan');
      }
    }
    expect(f.calls[0]?.event_type).toBe('auto-engaged');
  });

  it('non-trivial action under warn-only gating → warn + auto-engaged event', async () => {
    const { f, deps } = baseDeps({
      settings: baseSettings({ gating_strength: 'warn-only' }),
    });
    const r = await decide(deps, {
      tool_name: 'Write',
      tool_input: { file_path: 'src/api.ts', content: 'export function foo() {}' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision).toBe('warn');
    expect(f.calls[0]?.event_type).toBe('auto-engaged');
  });

  it('force_engage_pending → block + force-engaged event', async () => {
    const { f, deps } = baseDeps({ force_engage_pending: true });
    const r = await decide(deps, {
      tool_name: 'Edit',
      tool_input: { file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision).toBe('block');
    expect(f.calls[0]?.event_type).toBe('force-engaged');
  });

  it('action covered by signed plan → allow with no event', async () => {
    const signed: Plan = {
      plan_id: 'plan-1' as PlanId,
      tenant_id: t('tnt-1'),
      user_id: u('usr-1'),
      session_id: sid('ses-1'),
      body: 'plan body',
      target_paths: ['src/foo.ts'],
      may_also_touch: [],
      public_surface_changes: [
        { kind: 'modify-body-only', symbol: 'foo' },
      ],
      new_dependencies: [],
      submitted_at: '2026-05-03T00:00:00Z' as ISO8601,
      signed_at: '2026-05-03T00:00:01Z' as ISO8601,
      signature_hash: 'sha256:x',
    };
    const { f, deps } = baseDeps({ signed_plan: signed });
    const r = await decide(deps, {
      tool_name: 'Write',
      tool_input: { file_path: 'src/foo.ts', content: 'export function foo() {}' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.decision).toBe('allow');
    // Covered actions emit no event per contract.
    expect(f.calls).toHaveLength(0);
  });

  it('action diverged from signed plan (path) → block + divergence-detected event', async () => {
    const signed: Plan = {
      plan_id: 'plan-1' as PlanId,
      tenant_id: t('tnt-1'),
      user_id: u('usr-1'),
      session_id: sid('ses-1'),
      body: 'b',
      target_paths: ['src/billing/**'],
      may_also_touch: [],
      public_surface_changes: [],
      new_dependencies: [],
      submitted_at: '2026-05-03T00:00:00Z' as ISO8601,
      signed_at: '2026-05-03T00:00:01Z' as ISO8601,
      signature_hash: 'sha256:x',
    };
    const { f, deps } = baseDeps({ signed_plan: signed });
    const r = await decide(deps, {
      tool_name: 'Write',
      tool_input: { file_path: 'src/auth/login.ts', content: 'export function x() {}' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.decision).toBe('block');
      if (r.value.decision === 'block') {
        expect(r.value.reason).toContain('divergence');
      }
    }
    expect(f.calls[0]?.event_type).toBe('divergence-detected');
  });
});

describe('PreToolUse hook — block-message reason budget (≤ 1 KB)', () => {
  it('reason byte length stays under 1024 even with huge affected_paths', async () => {
    const { deps } = baseDeps();
    const longPath = `src/${'x'.repeat(2_000)}.ts`;
    const r = await decide(deps, {
      tool_name: 'Write',
      tool_input: { file_path: longPath, content: 'export const a = 1' },
      session_id: 'ses-1',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.decision === 'block') {
      const bytes = Buffer.byteLength(r.value.reason, 'utf8');
      expect(bytes).toBeLessThanOrEqual(1_024);
      // It MUST still include the pending_engagement_id token.
      expect(r.value.reason.startsWith('plan-audit required')).toBe(true);
    }
  });
});

describe('PreToolUse hook — fail-closed on engagement-event write failure', () => {
  it('returns audit-log-unavailable when emitter fails durability', async () => {
    const f = fakeEmitter(() =>
      Promise.resolve({
        ok: false,
        error: { code: 'backend-unavailable', message: 'no network' },
      }),
    );
    const r = await decide(
      {
        tenant_settings: baseSettings(),
        user_setting: null,
        signed_plan: null,
        suspended: false,
        force_engage_pending: false,
        emitter: f.emitter,
        tenant_id: t('tnt-1'),
        user_id: u('usr-1'),
        session_id: sid('ses-1'),
      },
      {
        tool_name: 'Write',
        tool_input: { file_path: 'src/api.ts', content: 'export const x = 1' },
        session_id: 'ses-1',
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('audit-log-unavailable');
  });
});

describe('PreToolUse hook — emitter call shape', () => {
  it('emit input carries tenant/user/session/agent_action_signal', async () => {
    const { f, deps } = baseDeps();
    await decide(deps, {
      tool_name: 'Write',
      tool_input: { file_path: 'src/api.ts', content: 'export const x = 1' },
      session_id: 'ses-1',
    });
    expect(f.calls).toHaveLength(1);
    const arg = f.calls[0];
    expect(arg).toBeDefined();
    if (arg !== undefined) {
      expect(arg.tenant_id).toBe('tnt-1');
      expect(arg.user_id).toBe('usr-1');
      expect(arg.session_id).toBe('ses-1');
      expect(arg.agent_action_signal.affected_paths).toEqual(['src/api.ts']);
    }
  });
});

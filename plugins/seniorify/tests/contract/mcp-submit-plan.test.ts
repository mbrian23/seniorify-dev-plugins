// T021 — contract test for `submit_plan` MCP tool.
// Verifies Zod input validation, error shapes, budget-reservation gating,
// pending-engagement-id binding, and (FR-018 / Constitution §VI) that any
// returned `Finding.grounding` parses as the discriminated union.

import { describe, expect, it, vi } from 'vitest';

import { BackendClient } from '../../src/backend/client.js';
import { groundingSchema } from '../../src/backend/schemas/finding.js';
import { BudgetReservationClient } from '../../src/budget/reservation.js';
import { handleSubmitPlan, submitPlanInputSchema } from '../../src/mcp/tools/submit-plan.js';

import type { TenantId, UserId } from '../../src/shared/types.js';

interface FakeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const fakeTransport = (responses: { statusCode: number; body: string }[]) => {
  const calls: FakeRequest[] = [];
  let i = 0;
  return {
    calls,
    fn: vi.fn((url: unknown, opts: unknown) => {
      const o = opts as { method: string; headers: Record<string, string>; body?: string };
      calls.push({
        url: String(url),
        method: o.method,
        headers: o.headers,
        ...(o.body !== undefined ? { body: o.body } : {}),
      });
      const r = responses[i] ?? responses[responses.length - 1];
      i += 1;
      if (r === undefined) throw new Error('no fake response');
      return Promise.resolve({
        statusCode: r.statusCode,
        body: { text: () => Promise.resolve(r.body) },
      });
    }) as unknown as (...args: unknown[]) => Promise<{
      statusCode: number;
      body: { text: () => Promise<string> };
    }>,
  };
};

const validFindingPayload = {
  finding_id: 'fnd-1',
  plan_id: 'plan-1',
  tenant_id: 'tnt-1',
  question: 'You picked axios but ADR-0014 picked @acme/internal-http. Why deviate?',
  grounding: { kind: 'convention_ref', ref: 'ADR-0014', excerpt: 'use @acme/internal-http' },
  defense: null,
  override: null,
  follow_up: null,
  created_at: '2026-05-03T00:00:00Z',
};

const happyPlanResponse = {
  plan_id: 'plan-1',
  initial_findings: [validFindingPayload],
  budget_remaining_for_user: 100_000,
};

const mkDeps = (transport: ReturnType<typeof fakeTransport>['fn']) => {
  const client = new BackendClient({
    baseUrl: 'http://backend.test',
    authToken: 'tok',
    tenantId: 'tnt-1',
    transport: transport as never,
    newIdempotencyKey: () => 'fixed-uuid',
    maxRetries: 0,
  });
  return {
    client,
    budget: new BudgetReservationClient(client),
    resolvedTenantId: 'tnt-1' as TenantId,
    resolvedUserId: 'usr-1' as UserId,
  };
};

const validInput = {
  tenant_id: 'tnt-1',
  user_id: 'usr-1',
  pending_engagement_id: 'eng-1',
  body: 'Add a rate limiter to /v2/billing/charge',
  target_paths: ['src/billing/charge.ts'],
};

describe('submit_plan input schema (Zod)', () => {
  it('accepts a minimal valid plan', () => {
    expect(submitPlanInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('rejects empty body', () => {
    expect(submitPlanInputSchema.safeParse({ ...validInput, body: '' }).success).toBe(false);
  });

  it('rejects empty target_paths', () => {
    expect(submitPlanInputSchema.safeParse({ ...validInput, target_paths: [] }).success).toBe(
      false,
    );
  });

  it('rejects body over 16k chars', () => {
    expect(
      submitPlanInputSchema.safeParse({ ...validInput, body: 'x'.repeat(16_001) }).success,
    ).toBe(false);
  });

  it('rejects missing pending_engagement_id', () => {
    const { pending_engagement_id: _drop, ...rest } = validInput;
    expect(submitPlanInputSchema.safeParse(rest).success).toBe(false);
  });
});

describe('handleSubmitPlan — cross-tenant gate', () => {
  it('refuses tenant_id mismatch with cross-tenant-rejection', async () => {
    const t = fakeTransport([{ statusCode: 200, body: '{}' }]);
    const res = await handleSubmitPlan(mkDeps(t.fn), {
      ...validInput,
      tenant_id: 'tnt-OTHER',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cross-tenant-rejection');
    // Importantly: no backend call was issued.
    expect(t.calls).toHaveLength(0);
  });

  it('refuses user_id mismatch with cross-tenant-rejection', async () => {
    const t = fakeTransport([{ statusCode: 200, body: '{}' }]);
    const res = await handleSubmitPlan(mkDeps(t.fn), {
      ...validInput,
      user_id: 'usr-OTHER',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cross-tenant-rejection');
    expect(t.calls).toHaveLength(0);
  });
});

describe('handleSubmitPlan — budget reservation gating', () => {
  it('does NOT issue POST /v1/plans when reservation refused', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"granted":false,"reason":"per-seat-ceiling-reached"}' },
      { statusCode: 200, body: JSON.stringify(happyPlanResponse) },
    ]);
    const res = await handleSubmitPlan(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('budget-exhausted');
    // The only call should have been to budget/reservations.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toContain('/v1/budget/reservations');
  });

  it('issues POST /v1/plans exactly once when reservation granted', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"reservation_id":"rsv-1","granted":true}' },
      { statusCode: 200, body: JSON.stringify(happyPlanResponse) },
    ]);
    const res = await handleSubmitPlan(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]?.url).toContain('/v1/plans');
    expect(t.calls[1]?.method).toBe('POST');
  });
});

describe('handleSubmitPlan — pending-engagement-id binding', () => {
  it('forwards pending_engagement_id in the POST body', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"reservation_id":"rsv","granted":true}' },
      { statusCode: 200, body: JSON.stringify(happyPlanResponse) },
    ]);
    await handleSubmitPlan(mkDeps(t.fn), validInput);
    const planCall = t.calls[1];
    expect(planCall).toBeDefined();
    if (planCall === undefined) return;
    const parsed = JSON.parse(planCall.body ?? '{}') as Record<string, unknown>;
    expect(parsed.pending_engagement_id).toBe('eng-1');
  });
});

describe('handleSubmitPlan — Grounding (FR-018)', () => {
  it('every returned Finding.grounding parses as the Grounding union', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"reservation_id":"rsv","granted":true}' },
      { statusCode: 200, body: JSON.stringify(happyPlanResponse) },
    ]);
    const res = await handleSubmitPlan(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const f of res.value.initial_findings) {
      const parsed = groundingSchema.safeParse(f.grounding);
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects a backend response with a generic / unknown grounding kind', async () => {
    const bad = {
      ...happyPlanResponse,
      initial_findings: [
        {
          ...validFindingPayload,
          grounding: { kind: 'generic_question_no_grounding' },
        },
      ],
    };
    const t = fakeTransport([
      { statusCode: 200, body: '{"reservation_id":"rsv","granted":true}' },
      { statusCode: 200, body: JSON.stringify(bad) },
    ]);
    const res = await handleSubmitPlan(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('schema-mismatch');
  });
});

describe('handleSubmitPlan — backend error pass-through', () => {
  it('propagates pending-engagement-not-found', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"reservation_id":"rsv","granted":true}' },
      {
        statusCode: 404,
        body: '{"code":"pending-engagement-not-found","message":"unknown engagement"}',
      },
    ]);
    const res = await handleSubmitPlan(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('pending-engagement-not-found');
  });
});

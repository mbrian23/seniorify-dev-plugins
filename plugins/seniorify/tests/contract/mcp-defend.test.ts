// T022 — contract test for `defend` MCP tool.
// Verifies finding-immutable error after sign, optional follow-up emission,
// and budget gating on follow-up generation.

import { describe, expect, it, vi } from 'vitest';

import { BackendClient } from '../../src/backend/client.js';
import { BudgetReservationClient } from '../../src/budget/reservation.js';
import { defendInputSchema, handleDefend } from '../../src/mcp/tools/defend.js';

import type { TenantId, UserId } from '../../src/shared/types.js';

const fakeTransport = (responses: { statusCode: number; body: string }[]) => {
  const calls: { url: string; method: string; body?: string }[] = [];
  let i = 0;
  return {
    calls,
    fn: vi.fn((url: unknown, opts: unknown) => {
      const o = opts as { method: string; body?: string };
      calls.push({
        url: String(url),
        method: o.method,
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

const findingPayload = {
  finding_id: 'fnd-1',
  plan_id: 'plan-1',
  tenant_id: 'tnt-1',
  question: 'Q',
  grounding: { kind: 'plan_artifact', path: 'src/x.ts', excerpt: 'foo' },
  defense: null,
  override: null,
  follow_up: null,
  created_at: '2026-05-03T00:00:00Z',
};

const followUpPayload = {
  ...findingPayload,
  finding_id: 'fnd-2',
  question: 'Follow-up question',
};

const mkDeps = (transport: ReturnType<typeof fakeTransport>['fn']) => {
  const client = new BackendClient({
    baseUrl: 'http://backend.test',
    authToken: 'tok',
    tenantId: 'tnt-1',
    transport: transport as never,
    newIdempotencyKey: () => 'fixed',
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
  plan_id: 'plan-1',
  finding_id: 'fnd-1',
  text: 'Because we need axios for retry semantics',
  surface: 'inline' as const,
};

describe('defend input schema (Zod)', () => {
  it('accepts valid input', () => {
    expect(defendInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('rejects empty text', () => {
    expect(defendInputSchema.safeParse({ ...validInput, text: '' }).success).toBe(false);
  });

  it('rejects text over 4k chars', () => {
    expect(
      defendInputSchema.safeParse({ ...validInput, text: 'x'.repeat(4_001) }).success,
    ).toBe(false);
  });

  it("rejects surface other than 'inline' | 'page'", () => {
    expect(
      defendInputSchema.safeParse({ ...validInput, surface: 'web' }).success,
    ).toBe(false);
  });
});

describe('handleDefend — happy paths', () => {
  it('returns updated finding with no follow-up when backend says null', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"reservation_id":"rsv","granted":true}' },
      {
        statusCode: 200,
        body: JSON.stringify({ finding: findingPayload, follow_up_finding: null }),
      },
    ]);
    const res = await handleDefend(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.follow_up_finding).toBeNull();
    }
  });

  it('returns updated finding with optional follow-up when backend emits one', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"reservation_id":"rsv","granted":true}' },
      {
        statusCode: 200,
        body: JSON.stringify({
          finding: findingPayload,
          follow_up_finding: followUpPayload,
        }),
      },
    ]);
    const res = await handleDefend(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(true);
    if (res.ok && res.value.follow_up_finding !== null) {
      expect(res.value.follow_up_finding.finding_id).toBe('fnd-2');
    }
  });
});

describe('handleDefend — error paths', () => {
  it('propagates finding-immutable when plan is already signed', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"reservation_id":"rsv","granted":true}' },
      {
        statusCode: 409,
        body: '{"code":"finding-immutable","message":"plan already signed"}',
      },
    ]);
    const res = await handleDefend(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('finding-immutable');
  });

  it('refuses tenant_id mismatch with cross-tenant-rejection', async () => {
    const t = fakeTransport([{ statusCode: 200, body: '{}' }]);
    const res = await handleDefend(mkDeps(t.fn), { ...validInput, tenant_id: 'tnt-X' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cross-tenant-rejection');
    expect(t.calls).toHaveLength(0);
  });
});

describe('handleDefend — budget gating on follow-up generation', () => {
  it('does NOT issue defense POST when reservation refused', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: '{"granted":false,"reason":"per-seat-ceiling-reached"}' },
    ]);
    const res = await handleDefend(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('budget-exhausted');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toContain('/v1/budget/reservations');
  });
});

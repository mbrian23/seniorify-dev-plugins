// T024 — contract test for `sign_plan` MCP tool.
// Verifies the unaddressed-findings server gate, idempotency on retry, and
// hash-chain stability (the plugin verifies but does not produce hashes —
// we assert pass-through fidelity).

import { describe, expect, it, vi } from 'vitest';

import { BackendClient } from '../../src/backend/client.js';
import { handleSignPlan, signPlanInputSchema } from '../../src/mcp/tools/sign-plan.js';

import type { TenantId, UserId } from '../../src/shared/types.js';

const fakeTransport = (responses: { statusCode: number; body: string }[]) => {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
    [];
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

const happySig = {
  signature: {
    plan_id: 'plan-1',
    tenant_id: 'tnt-1',
    user_id: 'usr-1',
    signed_at: '2026-05-03T00:00:00Z',
    hash: 'sha256:abcd1234',
    kind: 'sign',
  },
  engagement_event_id: 'eng-signed-1',
};

const mkDeps = (
  transport: ReturnType<typeof fakeTransport>['fn'],
  newIdempotencyKey?: () => string,
) => {
  const client = new BackendClient({
    baseUrl: 'http://backend.test',
    authToken: 'tok',
    tenantId: 'tnt-1',
    transport: transport as never,
    newIdempotencyKey: () => 'transport-key',
    maxRetries: 1,
  });
  return {
    client,
    resolvedTenantId: 'tnt-1' as TenantId,
    resolvedUserId: 'usr-1' as UserId,
    ...(newIdempotencyKey !== undefined ? { newIdempotencyKey } : {}),
  };
};

const validInput = {
  tenant_id: 'tnt-1',
  user_id: 'usr-1',
  plan_id: 'plan-1',
  surface: 'inline' as const,
};

describe('sign_plan input schema (Zod)', () => {
  it('accepts valid input without acknowledgment', () => {
    expect(signPlanInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('accepts override-and-sign acknowledgment', () => {
    expect(
      signPlanInputSchema.safeParse({
        ...validInput,
        unaddressed_findings_acknowledgment: 'override-and-sign',
      }).success,
    ).toBe(true);
  });

  it('rejects bogus acknowledgment values', () => {
    expect(
      signPlanInputSchema.safeParse({
        ...validInput,
        unaddressed_findings_acknowledgment: 'sign-anyway',
      }).success,
    ).toBe(false);
  });
});

describe('handleSignPlan — server gate (unaddressed findings)', () => {
  it('propagates unaddressed-findings-without-override error', async () => {
    const t = fakeTransport([
      {
        statusCode: 409,
        body: '{"code":"unaddressed-findings-without-override","message":"defend or override first"}',
      },
    ]);
    const res = await handleSignPlan(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('unaddressed-findings-without-override');
  });

  it('passes through acknowledgment to backend body', async () => {
    const t = fakeTransport([{ statusCode: 200, body: JSON.stringify(happySig) }]);
    await handleSignPlan(mkDeps(t.fn), {
      ...validInput,
      unaddressed_findings_acknowledgment: 'override-and-sign',
    });
    const body = JSON.parse(t.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.unaddressed_findings_acknowledgment).toBe('override-and-sign');
  });

  it('passes null acknowledgment when omitted', async () => {
    const t = fakeTransport([{ statusCode: 200, body: JSON.stringify(happySig) }]);
    await handleSignPlan(mkDeps(t.fn), validInput);
    const body = JSON.parse(t.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.unaddressed_findings_acknowledgment).toBeNull();
  });
});

describe('handleSignPlan — idempotency on retry', () => {
  it('reuses the same idempotency key across the underlying retry-on-503', async () => {
    let counter = 0;
    const newKey = vi.fn(() => `key-${(counter += 1).toString()}`);
    const t = fakeTransport([
      { statusCode: 503, body: '' },
      { statusCode: 200, body: JSON.stringify(happySig) },
    ]);
    const res = await handleSignPlan(mkDeps(t.fn, newKey), validInput);
    expect(res.ok).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.headers['idempotency-key']).toBe(t.calls[1]?.headers['idempotency-key']);
    expect(newKey).toHaveBeenCalledTimes(1);
  });
});

describe('handleSignPlan — hash-chain stability', () => {
  it('returns the backend signature.hash bit-for-bit (plugin does not rewrite it)', async () => {
    const t = fakeTransport([{ statusCode: 200, body: JSON.stringify(happySig) }]);
    const res = await handleSignPlan(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.signature.hash).toBe('sha256:abcd1234');
  });

  it('rejects a backend response missing hash', async () => {
    const t = fakeTransport([
      {
        statusCode: 200,
        body: JSON.stringify({
          signature: { ...happySig.signature, hash: '' },
          engagement_event_id: 'eng-1',
        }),
      },
    ]);
    const res = await handleSignPlan(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('schema-mismatch');
  });
});

describe('handleSignPlan — cross-tenant gate', () => {
  it('refuses tenant_id mismatch without issuing POST', async () => {
    const t = fakeTransport([{ statusCode: 200, body: '{}' }]);
    const res = await handleSignPlan(mkDeps(t.fn), { ...validInput, tenant_id: 'tnt-X' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cross-tenant-rejection');
    expect(t.calls).toHaveLength(0);
  });
});

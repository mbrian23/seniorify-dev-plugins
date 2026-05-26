// T023 — contract test for `override` MCP tool.
// Verifies required reason, no follow-up emission, and finding-immutable error.

import { describe, expect, it, vi } from 'vitest';

import { BackendClient } from '../../src/backend/client.js';
import { handleOverride, overrideInputSchema } from '../../src/mcp/tools/override.js';

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

const overriddenFinding = {
  finding_id: 'fnd-1',
  plan_id: 'plan-1',
  tenant_id: 'tnt-1',
  question: 'Q',
  grounding: { kind: 'plan_artifact', path: 'src/x.ts', excerpt: 'foo' },
  defense: null,
  override: {
    finding_id: 'fnd-1',
    text: 'proceeding anyway, scope-limited',
    surface: 'inline',
    user_id: 'usr-1',
    tenant_id: 'tnt-1',
    created_at: '2026-05-03T00:00:00Z',
    permanent: true,
  },
  follow_up: null,
  created_at: '2026-05-03T00:00:00Z',
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
    resolvedTenantId: 'tnt-1' as TenantId,
    resolvedUserId: 'usr-1' as UserId,
  };
};

const validInput = {
  tenant_id: 'tnt-1',
  user_id: 'usr-1',
  plan_id: 'plan-1',
  finding_id: 'fnd-1',
  text: 'proceeding anyway, scope-limited',
  surface: 'inline' as const,
};

describe('override input schema (Zod)', () => {
  it('accepts valid input', () => {
    expect(overrideInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('rejects empty reason text (override REQUIRES a reason)', () => {
    expect(overrideInputSchema.safeParse({ ...validInput, text: '' }).success).toBe(false);
  });

  it('rejects text over 4k chars', () => {
    expect(
      overrideInputSchema.safeParse({ ...validInput, text: 'x'.repeat(4_001) }).success,
    ).toBe(false);
  });
});

describe('handleOverride — happy path', () => {
  it('returns finding with override populated', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: JSON.stringify({ finding: overriddenFinding }) },
    ]);
    const res = await handleOverride(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.finding.override?.permanent).toBe(true);
    }
  });

  it('does NOT consult budget reservation (override is not metered)', async () => {
    const t = fakeTransport([
      { statusCode: 200, body: JSON.stringify({ finding: overriddenFinding }) },
    ]);
    await handleOverride(mkDeps(t.fn), validInput);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).not.toContain('/v1/budget/reservations');
    expect(t.calls[0]?.url).toContain('/overrides');
  });
});

describe('handleOverride — error paths', () => {
  it('propagates finding-immutable when plan is already signed', async () => {
    const t = fakeTransport([
      {
        statusCode: 409,
        body: '{"code":"finding-immutable","message":"plan already signed"}',
      },
    ]);
    const res = await handleOverride(mkDeps(t.fn), validInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('finding-immutable');
  });

  it('refuses cross-tenant calls without issuing the backend POST', async () => {
    const t = fakeTransport([{ statusCode: 200, body: '{}' }]);
    const res = await handleOverride(mkDeps(t.fn), { ...validInput, tenant_id: 'tnt-X' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cross-tenant-rejection');
    expect(t.calls).toHaveLength(0);
  });
});

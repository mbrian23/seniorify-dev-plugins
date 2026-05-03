// Contract test for `GET /v1/whoami`. Drift entry to plan 001 (2026-05-03):
// the hosted-SaaS pivot moves tenant + user resolution from manual env vars
// to a token-derived backend lookup. The plugin must be able to call this
// endpoint and convert its three failure modes into the existing
// BackendError vocabulary — no new error codes.

import { describe, expect, it, vi } from 'vitest';

import { BackendClient } from '../../src/backend/client.js';

interface FakeResponse { statusCode: number; body: string }

const mockTransport = (responses: FakeResponse[]): {
  fn: (...args: unknown[]) => Promise<{ statusCode: number; body: { text: () => Promise<string> } }>;
  calls: { url: string; method: string; headers: Record<string, string>; body?: string }[];
} => {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
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
    }),
  };
};

const mkClient = (
  transport: ReturnType<typeof mockTransport>['fn'],
): BackendClient =>
  new BackendClient({
    // tenantId is intentionally a placeholder: whoami's whole purpose is to
    // *learn* the tenant. The client requires a string here; the contract
    // forbids sending X-Tenant-Id on the whoami request itself.
    baseUrl: 'http://backend.test',
    authToken: 'tok',
    tenantId: 'unresolved',
    transport: transport as never,
    newIdempotencyKey: () => 'fixed-uuid',
    maxRetries: 0,
  });

const validWhoamiBody = JSON.stringify({
  user_id: 'usr-1',
  tenant_id: 'tnt-1',
  email: 'admin@example.com',
  tier: 'enterprise',
  role: 'admin',
});

describe('BackendClient.whoami', () => {
  it('happy path: 200 with valid WhoamiResponse → ok', async () => {
    const t = mockTransport([{ statusCode: 200, body: validWhoamiBody }]);
    const client = mkClient(t.fn);
    const res = await client.whoami();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.user_id).toBe('usr-1');
      expect(res.value.tenant_id).toBe('tnt-1');
      expect(res.value.email).toBe('admin@example.com');
      expect(res.value.tier).toBe('enterprise');
      expect(res.value.role).toBe('admin');
    }
    // Path is /v1/whoami; Authorization is Bearer; X-Tenant-Id MUST NOT be sent.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.url).toBe('http://backend.test/v1/whoami');
    expect(t.calls[0]?.method).toBe('GET');
    expect(t.calls[0]?.headers.authorization).toBe('Bearer tok');
    expect(t.calls[0]?.headers['x-tenant-id']).toBeUndefined();
  });

  it('401: invalid/missing token → cross-tenant-rejection (auth-failure code in existing vocabulary)', async () => {
    const t = mockTransport([
      { statusCode: 401, body: '{"code":"cross-tenant-rejection","message":"invalid token"}' },
    ]);
    const client = mkClient(t.fn);
    const res = await client.whoami();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('cross-tenant-rejection');
      expect(res.error.status).toBe(401);
    }
  });

  it('schema mismatch: 200 with garbage body → schema-mismatch', async () => {
    const t = mockTransport([
      { statusCode: 200, body: '{"user_id":42,"tenant_id":null}' },
    ]);
    const client = mkClient(t.fn);
    const res = await client.whoami();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('schema-mismatch');
  });
});

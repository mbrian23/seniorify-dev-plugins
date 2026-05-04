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
  overrides: Partial<{ newIdempotencyKey: () => string; maxRetries: number }> = {},
): BackendClient =>
  new BackendClient({
    baseUrl: 'http://backend.test',
    authToken: 'tok',
    tenantId: 'tnt-1',
    transport: transport as never,
    newIdempotencyKey: overrides.newIdempotencyKey ?? (() => 'fixed-uuid'),
    maxRetries: overrides.maxRetries ?? 3,
  });

describe('BackendClient', () => {
  it('attaches Authorization, X-Tenant-Id, Content-Type on every request', async () => {
    const t = mockTransport([{ statusCode: 200, body: '{"ok":true}' }]);
    const client = mkClient(t.fn);
    const res = await client.request({ method: 'GET', path: '/v1/anything' });
    expect(res.ok).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.headers.authorization).toBe('Bearer tok');
    expect(t.calls[0]?.headers['x-tenant-id']).toBe('tnt-1');
    expect(t.calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('emits Idempotency-Key only on mutating requests', async () => {
    const t = mockTransport([
      { statusCode: 200, body: '{}' },
      { statusCode: 200, body: '{}' },
    ]);
    const client = mkClient(t.fn);
    await client.request({ method: 'GET', path: '/v1/anything' });
    await client.request({ method: 'POST', path: '/v1/anything', body: { x: 1 } });
    expect(t.calls[0]?.headers['idempotency-key']).toBeUndefined();
    expect(t.calls[1]?.headers['idempotency-key']).toBe('fixed-uuid');
  });

  it('reuses a caller-supplied idempotency key on retry', async () => {
    const t = mockTransport([
      { statusCode: 503, body: '' },
      { statusCode: 200, body: '{"ok":true}' },
    ]);
    const client = mkClient(t.fn);
    const res = await client.request({
      method: 'POST',
      path: '/v1/anything',
      body: {},
      idempotencyKey: 'caller-supplied',
    });
    expect(res.ok).toBe(true);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.headers['idempotency-key']).toBe('caller-supplied');
    expect(t.calls[1]?.headers['idempotency-key']).toBe('caller-supplied');
  });

  it('retries 5xx up to maxRetries with bounded backoff', async () => {
    const t = mockTransport([
      { statusCode: 500, body: '' },
      { statusCode: 502, body: '' },
      { statusCode: 200, body: '{"ok":true}' },
    ]);
    const client = mkClient(t.fn, { maxRetries: 3 });
    const res = await client.request({ method: 'GET', path: '/v1/anything' });
    expect(res.ok).toBe(true);
    expect(t.calls).toHaveLength(3);
  });

  it('does NOT retry on 4xx', async () => {
    const t = mockTransport([
      { statusCode: 422, body: '{"code":"invalid-input","message":"nope"}' },
      { statusCode: 200, body: '{}' },
    ]);
    const client = mkClient(t.fn);
    const res = await client.request({ method: 'POST', path: '/v1/anything', body: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-input');
      expect(res.error.status).toBe(422);
    }
    expect(t.calls).toHaveLength(1);
  });

  it('returns backend-unavailable when retry budget exhausted on 5xx', async () => {
    const t = mockTransport(Array.from({ length: 10 }, () => ({ statusCode: 503, body: '' })));
    const client = mkClient(t.fn, { maxRetries: 2 });
    const res = await client.request({ method: 'GET', path: '/v1/anything' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('backend-unavailable');
    expect(t.calls).toHaveLength(3);
  });

  it('refuses to start against an incompatible backend major version', async () => {
    const t = mockTransport([{ statusCode: 200, body: '{"major":"v2","minor":"0"}' }]);
    const client = mkClient(t.fn);
    const res = await client.ensureCompatible();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('incompatible-backend-version');
  });

  it('passes version handshake when major is v1', async () => {
    const t = mockTransport([{ statusCode: 200, body: '{"major":"v1","minor":"3"}' }]);
    const client = mkClient(t.fn);
    const res = await client.ensureCompatible();
    expect(res.ok).toBe(true);
  });

  describe('#mapClientError fallback (when typed error body is unparseable)', () => {
    // Exercises the status-only fallback by returning a non-JSON body so
    // #parseErrorBody returns undefined and the caller falls through to
    // the status-keyed mapping. Pins contracts/error-codes.md splits.
    const cases: Array<{ status: number; expectedCode: string }> = [
      { status: 401, expectedCode: 'auth-failed' },
      { status: 403, expectedCode: 'cross-tenant-rejection' },
      { status: 404, expectedCode: 'cross-tenant-rejection' },
      { status: 409, expectedCode: 'already-signed' },
      { status: 422, expectedCode: 'invalid-input' },
    ];
    for (const { status, expectedCode } of cases) {
      it(`HTTP ${status} → ${expectedCode}`, async () => {
        const t = mockTransport([{ statusCode: status, body: 'not-json' }]);
        const client = mkClient(t.fn);
        const res = await client.request({ method: 'GET', path: '/v1/anything' });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe(expectedCode);
      });
    }
  });
});

import { describe, expect, it, vi } from 'vitest';

import { BackendClient } from '../../src/backend/client.js';
import { BudgetReservationClient, withReservation } from '../../src/budget/reservation.js';
import { ok } from '../../src/shared/result.js';

import type {
  ReservationId,
  TenantId,
  UserId,
} from '../../src/shared/types.js';

const fakeTransport = (statusCode: number, body: string) =>
  vi.fn(() =>
    Promise.resolve({
      statusCode,
      body: { text: () => Promise.resolve(body) },
    }),
  ) as unknown as (...args: unknown[]) => Promise<{
    statusCode: number;
    body: { text: () => Promise<string> };
  }>;

const mkBudget = (statusCode: number, body: string): BudgetReservationClient =>
  new BudgetReservationClient(
    new BackendClient({
      baseUrl: 'http://backend.test',
      authToken: 'tok',
      tenantId: 'tnt-1',
      transport: fakeTransport(statusCode, body) as never,
      newIdempotencyKey: () => 'fixed',
      maxRetries: 0,
    }),
  );

const reserveInput = {
  tenant_id: 'tnt-1' as TenantId,
  user_id: 'usr-1' as UserId,
  model: 'claude-haiku-4-5',
  estimated_input_tokens: 1_000,
  estimated_output_tokens: 500,
};

describe('BudgetReservationClient', () => {
  it('returns granted=true with reservation_id on success', async () => {
    const budget = mkBudget(200, '{"reservation_id":"rsv-1","granted":true}');
    const res = await budget.reserve(reserveInput);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.granted).toBe(true);
      if (res.value.granted) expect(res.value.reservation_id).toBe('rsv-1');
    }
  });

  it('returns granted=false with reason when per-seat ceiling is reached', async () => {
    const budget = mkBudget(
      200,
      '{"granted":false,"reason":"per-seat-ceiling-reached"}',
    );
    const res = await budget.reserve(reserveInput);
    expect(res.ok).toBe(true);
    if (res.ok && !res.value.granted) {
      expect(res.value.reason).toBe('per-seat-ceiling-reached');
    }
  });

  it('returns granted=false with reason when tenant cap is reached', async () => {
    const budget = mkBudget(200, '{"granted":false,"reason":"tenant-cap-reached"}');
    const res = await budget.reserve(reserveInput);
    expect(res.ok).toBe(true);
    if (res.ok && !res.value.granted) {
      expect(res.value.reason).toBe('tenant-cap-reached');
    }
  });

  it('rejects malformed responses with schema-mismatch', async () => {
    const budget = mkBudget(200, '{"granted":"yes"}');
    const res = await budget.reserve(reserveInput);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('schema-mismatch');
  });
});

describe('withReservation (Constitution §VIII NON-NEGOTIABLE)', () => {
  it('does NOT issue the metered call when reservation is refused', async () => {
    const budget = mkBudget(200, '{"granted":false,"reason":"per-seat-ceiling-reached"}');
    const meteredSpy = vi.fn(() => Promise.resolve(ok('SHOULD-NEVER-RETURN')));
    const res = await withReservation(budget, reserveInput, meteredSpy);
    expect(meteredSpy).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('budget-exhausted');
  });

  it('issues the metered call exactly once when reservation is granted', async () => {
    const budget = mkBudget(200, '{"reservation_id":"rsv-7","granted":true}');
    const meteredSpy = vi.fn((rid: ReservationId) => Promise.resolve(ok({ rid })));
    const res = await withReservation(budget, reserveInput, meteredSpy);
    expect(meteredSpy).toHaveBeenCalledTimes(1);
    expect(meteredSpy).toHaveBeenCalledWith('rsv-7');
    expect(res.ok).toBe(true);
  });

  it('propagates backend errors without issuing the metered call', async () => {
    const budget = mkBudget(503, '');
    const meteredSpy = vi.fn(() => Promise.resolve(ok('NEVER')));
    const res = await withReservation(budget, reserveInput, meteredSpy);
    expect(meteredSpy).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });
});

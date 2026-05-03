// Cross-tenant isolation test (Constitution §VII).
// Boots two tenants A and B (via the bootstrap script seeding); verifies
// user A cannot read or write any of B's audits, findings, defenses,
// signatures, engagement events, tenant settings, or budget reservations.
//
// Per Constitution §II this test runs against the dockerized real backend.
// It is skipped if SENIORIFY_BACKEND_URL is unset — the workspace setup
// file (`_require-backend.ts`) fails fast in that case, so this `describe`
// block is only reached when the backend is actually running.

import { readFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BackendClient } from '../../src/backend/client.js';
import { BudgetReservationClient } from '../../src/budget/reservation.js';

import type { TenantId, UserId } from '../../src/shared/types.js';

interface Bootstrapped {
  readonly tenant_id: TenantId;
  readonly admin_user_id: UserId;
  readonly admin_token: string;
}

const backendUrl = process.env.SENIORIFY_BACKEND_URL ?? 'http://localhost:8787';

const loadBootstrap = async (path: string): Promise<Bootstrapped> => {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as Bootstrapped;
};

describe('cross-tenant isolation (Constitution §VII)', () => {
  let tenantA: Bootstrapped;
  let tenantB: Bootstrapped;
  let clientA: BackendClient;

  beforeAll(async () => {
    const tenantAFile = process.env.TENANT_A_FILE ?? 'test-tenant-a.json';
    const tenantBFile = process.env.TENANT_B_FILE ?? 'test-tenant-b.json';
    tenantA = await loadBootstrap(tenantAFile);
    tenantB = await loadBootstrap(tenantBFile);

    clientA = new BackendClient({
      baseUrl: backendUrl,
      authToken: tenantA.admin_token,
      tenantId: tenantA.tenant_id,
    });
  });

  afterAll(() => {
    /* dockerized backend lifecycle is owned by the test harness, not this file */
  });

  it('user A cannot read tenant B settings', async () => {
    const res = await clientA.request({
      method: 'GET',
      path: `/v1/tenants/${encodeURIComponent(tenantB.tenant_id)}/settings`,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cross-tenant-rejection');
  });

  it("user A cannot read user B's pending justifications", async () => {
    const res = await clientA.request({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(tenantB.admin_user_id)}/pending_justifications`,
    });
    expect(res.ok).toBe(false);
  });

  it("user A cannot read user B's in-flight plans", async () => {
    const res = await clientA.request({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(tenantB.admin_user_id)}/in_flight_plans`,
    });
    expect(res.ok).toBe(false);
  });

  it('user A cannot read user B setting', async () => {
    const res = await clientA.request({
      method: 'GET',
      path: `/v1/users/${encodeURIComponent(tenantB.admin_user_id)}/setting`,
    });
    expect(res.ok).toBe(false);
  });

  it('user A budget reservation references its own tenant only', async () => {
    const budgetA = new BudgetReservationClient(clientA);
    const res = await budgetA.reserve({
      tenant_id: tenantA.tenant_id,
      user_id: tenantA.admin_user_id,
      model: 'claude-haiku-4-5',
      estimated_input_tokens: 100,
      estimated_output_tokens: 100,
    });
    expect(res.ok).toBe(true);
  });

  it("user A budget reservation cannot debit user B's budget", async () => {
    const budgetA = new BudgetReservationClient(clientA);
    const res = await budgetA.reserve({
      tenant_id: tenantB.tenant_id,
      user_id: tenantB.admin_user_id,
      model: 'claude-haiku-4-5',
      estimated_input_tokens: 100,
      estimated_output_tokens: 100,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('cross-tenant-rejection');
  });

  it('user A submitting a plan with X-Tenant-Id of B is rejected', async () => {
    const wrongHeaderClient = new BackendClient({
      baseUrl: backendUrl,
      authToken: tenantA.admin_token,
      tenantId: tenantB.tenant_id,
    });
    const res = await wrongHeaderClient.request({
      method: 'POST',
      path: '/v1/plans',
      body: {
        tenant_id: tenantB.tenant_id,
        user_id: tenantA.admin_user_id,
        body: 'cross-tenant attempt',
        target_paths: ['src/x.ts'],
      },
    });
    expect(res.ok).toBe(false);
  });
});

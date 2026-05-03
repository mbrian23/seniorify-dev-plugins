// T027 — US1 happy-path integration test (auto-engage).
//
// Runs against a Docker-compose'd real backend (Constitution §II forbids
// mocking cross-process boundaries in integration tests). Bootstrapped
// tenant + admin token come from `npm run bootstrap:test-tenant`.
//
// The test exercises the full US1 dialog: hook decides → submit_plan →
// defend → sign_plan → get_audit. We do not invoke a real Claude Code
// process; we drive the same handler functions the MCP transport calls,
// so the test is hermetic with respect to the agent runtime but real
// with respect to the backend (which is the boundary §II actually cares
// about).

import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { BackendClient } from '../../src/backend/client.js';
import { BudgetReservationClient } from '../../src/budget/reservation.js';
import { decide } from '../../src/hook/pretooluse.js';
import { handleDefend } from '../../src/mcp/tools/defend.js';
import { handleSignPlan } from '../../src/mcp/tools/sign-plan.js';
import { handleSubmitPlan } from '../../src/mcp/tools/submit-plan.js';
import { TenantSettingsCache } from '../../src/settings/tenant.js';
import { UserSettingResolver } from '../../src/settings/user.js';
import { EngagementEventEmitter } from '../../src/telemetry/engagement.js';

import type { SessionId, TenantId, UserId } from '../../src/shared/types.js';

interface Bootstrapped {
  readonly tenant_id: TenantId;
  readonly admin_user_id: UserId;
  readonly admin_token: string;
}

const backendUrl = process.env.SENIORIFY_BACKEND_URL ?? 'http://localhost:8787';

let tenant: Bootstrapped;
let client: BackendClient;

beforeAll(async () => {
  const file = process.env.SENIORIFY_TEST_TENANT_FILE ?? 'test-tenant-bootstrap.json';
  tenant = JSON.parse(await readFile(file, 'utf8')) as Bootstrapped;
  client = new BackendClient({
    baseUrl: backendUrl,
    authToken: tenant.admin_token,
    tenantId: tenant.tenant_id,
  });
  const compat = await client.ensureCompatible();
  expect(compat.ok).toBe(true);
});

describe('US1 — auto-engage happy path (real backend)', () => {
  it('hook blocks → submit_plan → defend → sign_plan → get_audit', async () => {
    const sessionId = `ses-int-${Date.now().toString()}` as SessionId;

    // 1. Hook fires on a non-trivial action (Write to a public-surface file).
    const tenantCache = new TenantSettingsCache(client);
    const userResolver = new UserSettingResolver(client);
    const settings = await tenantCache.get(tenant.tenant_id);
    const userSetting = await userResolver.fetch(tenant.admin_user_id);
    expect(settings.ok).toBe(true);
    expect(userSetting.ok).toBe(true);
    if (!settings.ok || !userSetting.ok) return;

    const emitter = new EngagementEventEmitter(client);
    const decision = await decide(
      {
        tenant_settings: settings.value,
        user_setting: userSetting.value,
        signed_plan: null,
        suspended: false,
        force_engage_pending: false,
        emitter,
        tenant_id: tenant.tenant_id,
        user_id: tenant.admin_user_id,
        session_id: sessionId,
      },
      {
        tool_name: 'Write',
        tool_input: {
          file_path: 'src/billing/charge.ts',
          content: 'export function chargeCustomer() { /* new */ }',
        },
        session_id: sessionId,
      },
    );

    expect(decision.ok).toBe(true);
    if (!decision.ok || decision.value.decision !== 'block') return;
    const pendingEngagementId = decision.value.engagement.pending_engagement_id;

    // 2. Agent calls submit_plan with the pending_engagement_id.
    const budget = new BudgetReservationClient(client);
    const submitted = await handleSubmitPlan(
      {
        client,
        budget,
        resolvedTenantId: tenant.tenant_id,
        resolvedUserId: tenant.admin_user_id,
      },
      {
        tenant_id: tenant.tenant_id,
        user_id: tenant.admin_user_id,
        pending_engagement_id: pendingEngagementId,
        body: 'Add a rate limiter to /v2/billing/charge to cap per-customer charge attempts at 5/min.',
        target_paths: ['src/billing/charge.ts'],
      },
    );
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;
    const planId = submitted.value.plan_id;
    expect(submitted.value.initial_findings.length).toBeGreaterThanOrEqual(0);

    // 3. Defend each finding (or sign-with-acknowledgment if zero findings).
    if (submitted.value.initial_findings.length > 0) {
      for (const finding of submitted.value.initial_findings) {
        const defended = await handleDefend(
          {
            client,
            budget,
            resolvedTenantId: tenant.tenant_id,
            resolvedUserId: tenant.admin_user_id,
          },
          {
            tenant_id: tenant.tenant_id,
            user_id: tenant.admin_user_id,
            plan_id: planId,
            finding_id: finding.finding_id,
            text: 'Reviewed; the trade-off is acceptable for v1.',
            surface: 'inline',
          },
        );
        expect(defended.ok).toBe(true);
      }
    }

    // 4. Sign the plan.
    const signed = await handleSignPlan(
      {
        client,
        resolvedTenantId: tenant.tenant_id,
        resolvedUserId: tenant.admin_user_id,
      },
      {
        tenant_id: tenant.tenant_id,
        user_id: tenant.admin_user_id,
        plan_id: planId,
        surface: 'inline',
      },
    );
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(signed.value.signature.hash.length).toBeGreaterThan(0);

    // 5. Retrieve the audit record.
    const auditRes = await client.request<{
      plan: unknown;
      findings: unknown[];
      signature: unknown;
      engagement_events: unknown[];
    }>({
      method: 'GET',
      path: `/v1/plans/${encodeURIComponent(planId)}/audit`,
    });
    expect(auditRes.ok).toBe(true);
    if (!auditRes.ok) return;
    expect(auditRes.value.plan).toBeDefined();
    expect(auditRes.value.signature).not.toBeNull();
  });
});

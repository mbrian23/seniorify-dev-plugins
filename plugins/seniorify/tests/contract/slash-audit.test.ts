// T026 — contract test for `/seniorify-audit` slash command.
// Verifies the force-engage flag is armed and that an optional body is
// surfaced as an agent_instruction (NOT submitted directly — the metered
// submit_plan path runs at the MCP boundary per Constitution §VIII).

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAuditCmd } from '../../src/commands/audit.js';

import type { SessionId } from '../../src/shared/types.js';

let dir: string;
const originalRoot = process.env.CLAUDE_PLUGIN_ROOT;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'seniorify-audit-test-'));
  process.env.CLAUDE_PLUGIN_ROOT = dir;
});

afterEach(async () => {
  if (originalRoot === undefined) {
    delete process.env.CLAUDE_PLUGIN_ROOT;
  } else {
    process.env.CLAUDE_PLUGIN_ROOT = originalRoot;
  }
  await rm(dir, { recursive: true, force: true });
});

describe('runAuditCmd — force-engage flag arming', () => {
  it('writes force_engage_pending=true to the session state file', async () => {
    const sessionId = 'ses-test-1' as SessionId;
    const out = await runAuditCmd({ session_id: sessionId, body: '' });
    const state = JSON.parse(
      await readFile(join(dir, '.state', `${sessionId}.json`), 'utf8'),
    ) as { force_engage_pending: boolean };
    expect(state.force_engage_pending).toBe(true);
    expect(out.user_message).toContain('Force-audit armed');
    expect(out.agent_instruction).toBeNull();
  });

  it('arms the flag AND emits agent_instruction when body provided', async () => {
    const out = await runAuditCmd({
      session_id: 'ses-test-2' as SessionId,
      body: 'Add rate limiter to /v2/billing/charge',
    });
    expect(out.user_message).toContain('Force-audit armed');
    expect(out.agent_instruction).not.toBeNull();
    if (out.agent_instruction !== null) {
      expect(out.agent_instruction).toContain('submit_plan');
      expect(out.agent_instruction).toContain('Add rate limiter');
      expect(out.agent_instruction).toContain('pending_engagement_id');
    }
  });

  it('does NOT call any backend or MCP path itself (slash commands MUST NOT call LLMs)', async () => {
    // Indirect assertion: the function imports do not include BackendClient
    // or any tool handler. The presence of those would mean the slash command
    // runs a metered path before the MCP boundary, violating the contract.
    // This test verifies behavior end-to-end: arming completes without env
    // vars (SENIORIFY_BACKEND_URL etc.) being set.
    delete process.env.SENIORIFY_BACKEND_URL;
    delete process.env.SENIORIFY_TOKEN;
    const out = await runAuditCmd({ session_id: 'ses-no-env' as SessionId, body: '' });
    expect(out.user_message).toContain('Force-audit armed');
  });
});

// `/seniorify-audit [body...]` — force-arm the auditor for the next
// code-modifying action (FR-002). The slash-command markdown surface lives
// in `commands/seniorify-audit.md`; this file is the shared logic.
//
// Two modes:
//   1. No args: write the per-session force-engage flag. The next PreToolUse
//      hook reads + clears it, emits `force-engaged`, and blocks.
//   2. Args (body): print structured instruction to the agent telling it to
//      call the `submit_plan` MCP tool directly. The script does NOT call
//      submit_plan itself — that path is metered (Constitution §VIII), and
//      the budget reservation MUST be checked at the MCP tool boundary, not
//      duplicated here.

import { armForceEngage } from '../hook/state-store.js';

import type { SessionId } from '../shared/types.js';

export interface AuditCmdInput {
  readonly session_id: SessionId;
  readonly body: string;
}

export interface AuditCmdOutput {
  readonly user_message: string;
  readonly agent_instruction: string | null;
}

export const runAuditCmd = async (input: AuditCmdInput): Promise<AuditCmdOutput> => {
  await armForceEngage(input.session_id);

  if (input.body.length === 0) {
    return {
      user_message:
        'Force-audit armed. Next code-modifying action will trigger a plan-audit dialog.',
      agent_instruction: null,
    };
  }

  // Body provided — instruct the agent to call submit_plan directly.
  // The agent will receive the pending_engagement_id from the next hook
  // invocation (which fires as soon as it tries a code-modifying action).
  return {
    user_message: `Force-audit armed with body. The agent will submit the plan on its next action.`,
    agent_instruction: [
      'A user-supplied plan body is queued. On your next code-modifying action,',
      'you will receive a PreToolUse block with a `pending_engagement_id`.',
      'Call the `submit_plan` MCP tool with:',
      `  body: ${JSON.stringify(input.body)}`,
      '  target_paths: [<paths from your planned action>]',
      '  pending_engagement_id: <from the block message>',
    ].join('\n'),
  };
};

const readArgv = (): { session_id: string; body: string } => {
  const argv = process.argv.slice(2);
  const session = process.env.CLAUDE_SESSION_ID ?? argv[0] ?? '';
  // Body is the rest of argv joined with spaces (or argv[1]+ if env-set session).
  const startIdx = process.env.CLAUDE_SESSION_ID !== undefined ? 0 : 1;
  const body = argv.slice(startIdx).join(' ').trim();
  return { session_id: session, body };
};

export const main = async (): Promise<void> => {
  const { session_id, body } = readArgv();
  if (session_id.length === 0) {
    process.stderr.write(
      'seniorify-audit: missing CLAUDE_SESSION_ID env or session_id arg\n',
    );
    process.exit(2);
  }
  const out = await runAuditCmd({ session_id: session_id as SessionId, body });
  process.stdout.write(out.user_message);
  if (out.agent_instruction !== null) {
    process.stdout.write(`\n\n---\n${out.agent_instruction}`);
  }
  process.stdout.write('\n');
};

if (process.argv[1]?.endsWith('audit.js') === true) {
  main().catch((e: unknown) => {
    process.stderr.write(`seniorify-audit: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

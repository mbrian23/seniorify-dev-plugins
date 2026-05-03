// MCP server entrypoint. Wires the audit-dialog tools into the MCP transport.
//
// Architecture: each tool handler in `tools/*.ts` is a pure async function
// `(deps, input) → Result<output, BackendError>` — that shape is what the
// contract tests exercise directly. This file ONLY translates between the
// MCP request envelope and those handlers, so tests bypass the transport.
//
// Per contracts/mcp-tools.md cross-cutting rules:
//  - every input is Zod-validated at the boundary (rejection = structured error)
//  - every metered tool wraps the metered call in `withReservation`
//  - tool descriptions are terse — context-window discipline (FR-017)

import { randomUUID } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { type ZodTypeAny } from 'zod';

import { BackendClient } from '../backend/client.js';
import { BudgetReservationClient } from '../budget/reservation.js';
import { err, ok, type Result } from '../shared/result.js';

import { defendInputSchema, handleDefend } from './tools/defend.js';
import { handleOverride, overrideInputSchema } from './tools/override.js';
import { handleSignPlan, signPlanInputSchema } from './tools/sign-plan.js';
import { handleSubmitPlan, submitPlanInputSchema } from './tools/submit-plan.js';

import type { BackendError } from '../backend/errors.js';
import type { TenantId, UserId } from '../shared/types.js';
import type { z} from 'zod';

export interface ServerDeps {
  readonly client: BackendClient;
  readonly budget: BudgetReservationClient;
  readonly resolvedTenantId: TenantId;
  readonly resolvedUserId: UserId;
}

export interface ToolDescriptor<TInput> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodTypeAny;
  readonly call: (deps: ServerDeps, parsed: TInput) => Promise<Result<unknown, BackendError>>;
}

// Tools registered by US1. Skip / get_audit / get_pending_justifications /
// get_pending_justifications come in later phases.
export const US1_TOOLS: readonly ToolDescriptor<unknown>[] = [
  {
    name: 'submit_plan',
    description:
      'Submit a plan for audit. Call this in response to a PreToolUse hook block message — pass `pending_engagement_id` from the block.',
    inputSchema: submitPlanInputSchema,
    call: (deps, parsed) =>
      handleSubmitPlan(deps, parsed as z.infer<typeof submitPlanInputSchema>),
  },
  {
    name: 'defend',
    description:
      'Record the dev’s defense of a finding. May trigger one follow-up question per finding.',
    inputSchema: defendInputSchema,
    call: (deps, parsed) => handleDefend(deps, parsed as z.infer<typeof defendInputSchema>),
  },
  {
    name: 'override',
    description:
      'Explicit override on a finding. Required reason. Permanent — no follow-up emitted.',
    inputSchema: overrideInputSchema,
    call: (deps, parsed) => handleOverride(deps, parsed as z.infer<typeof overrideInputSchema>),
  },
  {
    name: 'sign_plan',
    description:
      'Sign the plan. Permanent. Requires every finding to be defended or overridden, OR set unaddressed_findings_acknowledgment="override-and-sign".',
    inputSchema: signPlanInputSchema,
    call: (deps, parsed) =>
      handleSignPlan(
        { ...deps, newIdempotencyKey: () => randomUUID() },
        parsed as z.infer<typeof signPlanInputSchema>,
      ),
  },
];

/**
 * Pure dispatch — takes a tool name + raw input, validates with Zod, calls
 * the handler. Used by the MCP transport AND by contract tests directly.
 */
export const dispatch = async (
  deps: ServerDeps,
  toolName: string,
  rawInput: unknown,
  registry: readonly ToolDescriptor<unknown>[] = US1_TOOLS,
): Promise<Result<unknown, BackendError>> => {
  const tool = registry.find((t) => t.name === toolName);
  if (tool === undefined) {
    return err({ code: 'invalid-input', message: `unknown tool: ${toolName}` });
  }
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      code: 'invalid-input',
      message: `invalid input for ${toolName}`,
      details: { issues: parsed.error.issues },
    });
  }
  return tool.call(deps, parsed.data as unknown);
};

const SERVER_INFO = {
  name: 'seniorify',
  version: '0.1.0',
} as const;

export const buildServer = (deps: ServerDeps): Server => {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: US1_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema),
      })),
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await dispatch(deps, req.params.name, req.params.arguments ?? {});
    if (result.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value) }],
      };
    }
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }],
    };
  });

  return server;
};

const zodToJsonSchema = (schema: ZodTypeAny): Record<string, unknown> => {
  // The MCP SDK accepts a JSON Schema object; for v1 we ship a minimal
  // hand-rolled projection per tool. The Zod schema remains the source of
  // truth — this is just an MCP-side hint for the agent.
  // The real shape is documented in contracts/mcp-tools.md.
  return {
    type: 'object',
    additionalProperties: false,
    description: schema.description ?? '',
  };
};

interface ServerEnv {
  readonly SENIORIFY_BACKEND_URL: string;
  readonly SENIORIFY_AUTH_TOKEN: string;
  readonly SENIORIFY_TENANT_ID: string;
  readonly SENIORIFY_USER_ID: string;
}

const requireEnv = (): Result<ServerEnv, BackendError> => {
  const env = process.env;
  const url = env.SENIORIFY_BACKEND_URL;
  const token = env.SENIORIFY_AUTH_TOKEN;
  const tenant = env.SENIORIFY_TENANT_ID;
  const user = env.SENIORIFY_USER_ID;
  if (
    url === undefined ||
    token === undefined ||
    tenant === undefined ||
    user === undefined ||
    url.length === 0 ||
    token.length === 0 ||
    tenant.length === 0 ||
    user.length === 0
  ) {
    return err({
      code: 'tenant-unresolved',
      message:
        'MCP server requires SENIORIFY_BACKEND_URL, SENIORIFY_AUTH_TOKEN, SENIORIFY_TENANT_ID, SENIORIFY_USER_ID',
    });
  }
  return ok({
    SENIORIFY_BACKEND_URL: url,
    SENIORIFY_AUTH_TOKEN: token,
    SENIORIFY_TENANT_ID: tenant,
    SENIORIFY_USER_ID: user,
  });
};

export const main = async (): Promise<void> => {
  const envRes = requireEnv();
  if (!envRes.ok) {
    process.stderr.write(`seniorify mcp: ${envRes.error.message}\n`);
    process.exit(2);
  }
  const env = envRes.value;
  const client = new BackendClient({
    baseUrl: env.SENIORIFY_BACKEND_URL,
    authToken: env.SENIORIFY_AUTH_TOKEN,
    tenantId: env.SENIORIFY_TENANT_ID,
  });
  const compat = await client.ensureCompatible();
  if (!compat.ok) {
    process.stderr.write(`seniorify mcp: ${compat.error.message}\n`);
    process.exit(3);
  }
  const deps: ServerDeps = {
    client,
    budget: new BudgetReservationClient(client),
    resolvedTenantId: env.SENIORIFY_TENANT_ID as TenantId,
    resolvedUserId: env.SENIORIFY_USER_ID as UserId,
  };
  const server = buildServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

// Run when invoked as a script.
if (process.argv[1]?.endsWith('server.js') === true) {
  main().catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`seniorify mcp fatal: ${msg}\n`);
    process.exit(1);
  });
}

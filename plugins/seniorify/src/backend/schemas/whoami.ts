// `GET /v1/whoami` — token-derived identity. Drift entry to plan 001
// (2026-05-03): the hosted-SaaS pivot replaces manual SENIORIFY_TENANT_ID
// + SENIORIFY_USER_ID env vars with this server-side resolution.

import { z } from 'zod';

import { tenantIdSchema, userIdSchema } from './primitives.js';

export const whoamiResponseSchema = z.object({
  user_id: userIdSchema,
  tenant_id: tenantIdSchema,
  email: z.string().email(),
  tier: z.enum(['enterprise', 'education']),
  role: z.enum(['admin', 'member']),
});

export type WhoamiResponse = z.infer<typeof whoamiResponseSchema>;

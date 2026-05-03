import { z } from 'zod';

import {
  iso8601Schema,
  planIdSchema,
  tenantIdSchema,
  userIdSchema,
} from './primitives.js';

export const signatureSchema = z.object({
  plan_id: planIdSchema,
  tenant_id: tenantIdSchema,
  user_id: userIdSchema,
  signed_at: iso8601Schema,
  hash: z.string().min(1),
  kind: z.enum(['sign', 'override-and-sign']),
});

export type Signature = z.infer<typeof signatureSchema>;

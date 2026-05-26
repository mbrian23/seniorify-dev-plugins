import { z } from 'zod';

import { aggressivenessSchema, gatingStrengthSchema } from './engagement-event.js';
import { iso8601Schema, tenantIdSchema, userIdSchema } from './primitives.js';


export const userSettingSchema = z.object({
  tenant_id: tenantIdSchema,
  user_id: userIdSchema,
  aggressiveness: aggressivenessSchema.optional(),
  gating_strength: gatingStrengthSchema.optional(),
  updated_at: iso8601Schema,
});

export type UserSetting = z.infer<typeof userSettingSchema>;

// `GET /v1/users/{id}/setting` returns either the setting or { not_set: true }.
export const userSettingResponseSchema = z.union([
  userSettingSchema,
  z.object({ not_set: z.literal(true) }),
]);

export type UserSettingResponse = z.infer<typeof userSettingResponseSchema>;

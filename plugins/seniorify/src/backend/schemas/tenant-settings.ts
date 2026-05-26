import { z } from 'zod';

import { aggressivenessSchema, gatingStrengthSchema } from './engagement-event.js';
import {
  iso8601Schema,
  tenantIdSchema,
} from './primitives.js';


export const trivialClassSchema = z.enum([
  'read-only',
  'single-file-rename',
  'comment-typo',
  'formatter-autofix',
  'lockfile-regen',
  'whitespace-only',
  'small-edit-no-public-surface',
]);

export type TrivialClass = z.infer<typeof trivialClassSchema>;

export const tierSchema = z.enum(['enterprise', 'education']);
export type Tier = z.infer<typeof tierSchema>;

export const tenantSettingsSchema = z.object({
  tenant_id: tenantIdSchema,
  tier: tierSchema,
  aggressiveness: aggressivenessSchema,
  gating_strength: gatingStrengthSchema,
  max_follow_up_depth: z.union([z.literal(0), z.literal(1)]),
  trivial_classes: z.array(trivialClassSchema),
  updated_at: iso8601Schema,
});

export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

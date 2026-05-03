// Zod parsers for branded primitive types. These are the ONLY supported
// construction sites for branded IDs — every value entering the plugin
// from outside (HTTP, hook payload, MCP input) flows through one of these.

import { z } from 'zod';

import type {
  EngagementEventId,
  FindingId,
  ISO8601,
  PlanId,
  ReservationId,
  SessionId,
  TenantId,
  UserId,
} from '../../shared/types.js';

const nonEmpty = z.string().min(1).max(256);

export const tenantIdSchema = nonEmpty.transform((s) => s as TenantId);
export const userIdSchema = nonEmpty.transform((s) => s as UserId);
export const planIdSchema = nonEmpty.transform((s) => s as PlanId);
export const findingIdSchema = nonEmpty.transform((s) => s as FindingId);
export const engagementEventIdSchema = nonEmpty.transform((s) => s as EngagementEventId);
export const sessionIdSchema = nonEmpty.transform((s) => s as SessionId);
export const reservationIdSchema = nonEmpty.transform((s) => s as ReservationId);

// RFC 3339; we don't ship a regex — Date.parse + non-NaN is enough at the boundary,
// the backend is the source of truth for timestamp shape.
export const iso8601Schema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid ISO 8601 timestamp' })
  .transform((s) => s as ISO8601);

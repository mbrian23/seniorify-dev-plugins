// Branded primitive types prevent cross-entity ID confusion at compile time.
// Per data-model.md. Construction lives in the schema layer (Zod parsers brand
// the parsed string). Code outside the schema layer never casts directly.
//
// We use a string-literal brand (not `unique symbol`) so the brand survives
// `tsc --declaration` emit cleanly across modules.

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type TenantId = Brand<string, 'TenantId'>;
export type UserId = Brand<string, 'UserId'>;
export type PlanId = Brand<string, 'PlanId'>;
export type FindingId = Brand<string, 'FindingId'>;
export type EngagementEventId = Brand<string, 'EngagementEventId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type ReservationId = Brand<string, 'ReservationId'>;
export type ISO8601 = Brand<string, 'ISO8601'>;

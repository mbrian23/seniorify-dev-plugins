// Structured backend errors. Crossing module boundaries as Result<T, BackendError>
// per Constitution §III. Never thrown.

export type BackendErrorCode =
  | 'auth-failed'
  | 'tenant-unresolved'
  | 'user-unresolved'
  | 'cross-tenant-rejection'
  | 'pending-engagement-not-found'
  | 'pending-engagement-already-resolved'
  | 'finding-immutable'
  | 'unaddressed-findings-without-override'
  | 'already-signed'
  | 'gating-strength-disallows-skip'
  | 'plan-not-found'
  | 'budget-exhausted'
  | 'backend-unavailable'
  | 'audit-log-unavailable'
  | 'incompatible-backend-version'
  | 'schema-mismatch'
  | 'tenant-drift'
  | 'invalid-input';

export interface BackendError {
  readonly code: BackendErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;
}

export const backendError = (
  code: BackendErrorCode,
  message: string,
  extra?: { status?: number; details?: Record<string, unknown> },
): BackendError => ({
  code,
  message,
  ...(extra?.status !== undefined ? { status: extra.status } : {}),
  ...(extra?.details !== undefined ? { details: extra.details } : {}),
});

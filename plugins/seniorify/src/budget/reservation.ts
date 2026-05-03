// Per-user budget reservation. Constitution §VIII (NON-NEGOTIABLE):
// every metered call site consults this BEFORE issuing the external call.
// The backend atomically debits on `granted: true`. There is NO path
// where a metered call escapes without a granted reservation.
//
// This module is the choke point. The MCP tool layer wraps every metered
// path through `reserve()` and refuses to proceed on `granted: false`.

import { z } from 'zod';

import { reservationIdSchema } from '../backend/schemas/primitives.js';
import { err, ok, type Result } from '../shared/result.js';

import type { BackendClient } from '../backend/client.js';
import type { BackendError } from '../backend/errors.js';
import type {
  ReservationId,
  TenantId,
  UserId,
} from '../shared/types.js';

const grantedSchema = z.object({
  reservation_id: reservationIdSchema,
  granted: z.literal(true),
});

const refusedSchema = z.object({
  reservation_id: reservationIdSchema.optional(),
  granted: z.literal(false),
  reason: z.enum(['per-seat-ceiling-reached', 'tenant-cap-reached']),
});

const reservationResponseSchema = z.discriminatedUnion('granted', [grantedSchema, refusedSchema]);

export type Reservation =
  | { readonly granted: true; readonly reservation_id: ReservationId }
  | {
      readonly granted: false;
      readonly reason: 'per-seat-ceiling-reached' | 'tenant-cap-reached';
    };

export interface ReserveInput {
  readonly tenant_id: TenantId;
  readonly user_id: UserId;
  readonly model: string;
  readonly estimated_input_tokens: number;
  readonly estimated_output_tokens: number;
}

export class BudgetReservationClient {
  readonly #client: BackendClient;

  constructor(client: BackendClient) {
    this.#client = client;
  }

  async reserve(input: ReserveInput): Promise<Result<Reservation, BackendError>> {
    const res = await this.#client.request<unknown>({
      method: 'POST',
      path: '/v1/budget/reservations',
      body: input,
    });
    if (!res.ok) return res;
    const parsed = reservationResponseSchema.safeParse(res.value);
    if (!parsed.success) {
      return err({
        code: 'schema-mismatch',
        message: 'budget reservation response did not parse',
        details: { issues: parsed.error.issues },
      });
    }
    if (parsed.data.granted) {
      return ok({ granted: true, reservation_id: parsed.data.reservation_id });
    }
    return ok({ granted: false, reason: parsed.data.reason });
  }
}

/**
 * Helper for MCP tool sites: wraps a metered call. If the reservation is
 * not granted, the metered call is NEVER issued and an error is returned.
 * Constitution §VIII NON-NEGOTIABLE.
 */
export const withReservation = async <T>(
  budget: BudgetReservationClient,
  input: ReserveInput,
  metered: (reservation_id: ReservationId) => Promise<Result<T, BackendError>>,
): Promise<Result<T, BackendError>> => {
  const reservation = await budget.reserve(input);
  if (!reservation.ok) return reservation;
  if (!reservation.value.granted) {
    return err({
      code: 'budget-exhausted',
      message: `budget reservation refused: ${reservation.value.reason}`,
      details: { reason: reservation.value.reason },
    });
  }
  return metered(reservation.value.reservation_id);
};

// Cost-telemetry emitter. Constitution §VIII: every metered call site emits
// a cost event tagged with tenant_id, user_id, plan_id, model, tokens, and
// cost_estimate. Per `contracts/backend-client.md`, this endpoint is
// fire-and-forget on success but uses an in-memory replay queue on failure.
// On Claude Code exit, unflushed entries are dumped to a local file so
// support can recover and reconcile.
//
// The dump-on-exit behavior is wired by the SessionContext lifecycle —
// this module only exposes `flushToFile()`.

import { writeFile } from 'node:fs/promises';

import type { BackendClient } from '../backend/client.js';
import type { PlanId, ReservationId, TenantId, UserId } from '../shared/types.js';

export interface CostEvent {
  readonly tenant_id: TenantId;
  readonly user_id: UserId;
  readonly plan_id: PlanId | null;
  readonly reservation_id: ReservationId;
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_estimate: number;
  readonly recorded_at: string;
}

export class CostTelemetryEmitter {
  readonly #client: BackendClient;
  readonly #queue: CostEvent[] = [];
  readonly #maxQueue: number;

  constructor(client: BackendClient, maxQueue = 1_000) {
    this.#client = client;
    this.#maxQueue = maxQueue;
  }

  /**
   * Fire-and-forget. Returns a promise that the caller MAY await for backpressure
   * but does not need to. On failure, queues for replay.
   */
  async emit(event: CostEvent): Promise<void> {
    const res = await this.#client.request({
      method: 'POST',
      path: '/v1/cost_telemetry',
      body: event,
    });
    if (!res.ok) {
      this.#enqueue(event);
    } else {
      await this.#drain();
    }
  }

  #enqueue(event: CostEvent): void {
    if (this.#queue.length >= this.#maxQueue) {
      this.#queue.shift();
    }
    this.#queue.push(event);
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const next = this.#queue[0];
      if (next === undefined) break;
      const res = await this.#client.request({
        method: 'POST',
        path: '/v1/cost_telemetry',
        body: next,
      });
      if (!res.ok) return;
      this.#queue.shift();
    }
  }

  /** Called on Claude Code exit. Returns the path it wrote, or null if queue empty. */
  async flushToFile(filePath: string): Promise<string | null> {
    if (this.#queue.length === 0) return null;
    await writeFile(filePath, JSON.stringify({ pending_cost_events: this.#queue }, null, 2), 'utf8');
    return filePath;
  }

  pendingCount(): number {
    return this.#queue.length;
  }
}

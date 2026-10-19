// The verifier: compares what clients were told was accepted, what the
// database says happened, and what the receiver actually got.
//
// The guarantee under test (docs/reliability-design.md): once POST /events
// returns 2xx, every delivery of that event ends `delivered` or `dead`, and
// `delivered` means the receiver really has it. Delivery is at-least-once,
// so duplicates are measured and reported, never treated as failures.
import { isProcessed, type Receipt } from "./receiver.js";

export interface VerifyInput {
  // Event ids that POST /events answered with 2xx.
  accepted: string[];
  // Every endpoint subscribes to all event types, so each accepted event
  // must fan out to all of them.
  endpoints: string[];
  eventsInDb: string[];
  deliveries: { event_id: string; endpoint: string; status: string; attempts: number }[];
  receipts: Receipt[];
  maxAttempts: number;
  idempotencyMismatches: number;
}

export interface Violation {
  kind:
    | "event_missing" // accepted, but not in the events table
    | "delivery_missing" // accepted, but no delivery row for an endpoint
    | "stuck_pending" // never reached delivered or dead
    | "delivered_not_received" // database says delivered, receiver has no record
    | "dead_before_max_attempts" // dead-lettered without using its retries
    | "bad_signature" // receiver rejected a signature Dispatchly sent
    | "idempotency_mismatch"; // the same Idempotency-Key returned a different event
  event_id?: string;
  endpoint?: string;
  detail?: string;
}

export interface VerifyReport {
  pass: boolean;
  accepted_events: number;
  expected_deliveries: number;
  delivered: number;
  dead: number;
  dead_by_endpoint: Record<string, number>;
  missing: number;
  // Dead in the database, yet the receiver processed it anyway: the 200 or
  // the result write was lost on that attempt and every later one failed.
  dead_but_received: number;
  // Processed by the receiver for an event no client was told was accepted.
  unaccepted_received: number;
  receiver_requests: number;
  processed_receipts: number;
  unique_received: number;
  duplicate_receipts: number;
  duplicate_rate: number;
  duplicates_after_lost_ack: number;
  max_copies: number;
  violations: Violation[];
}

const key = (eventId: string, endpoint: string) => `${eventId} ${endpoint}`;

export function verify(input: VerifyInput): VerifyReport {
  const violations: Violation[] = [];
  const accepted = new Set(input.accepted);
  const inDb = new Set(input.eventsInDb);

  // Receipts grouped per (event, endpoint), in arrival order.
  const processed = new Map<string, Receipt[]>();
  for (const r of [...input.receipts].sort((a, b) => a.t - b.t)) {
    if (r.behavior === "bad_signature") {
      violations.push({ kind: "bad_signature", event_id: r.webhook_id, endpoint: r.endpoint });
    }
    if (!isProcessed(r)) continue;
    const k = key(r.webhook_id, r.endpoint);
    const list = processed.get(k) ?? [];
    list.push(r);
    processed.set(k, list);
  }

  const rows = new Map(input.deliveries.map((d) => [key(d.event_id, d.endpoint), d]));

  let delivered = 0;
  let dead = 0;
  const deadByEndpoint: Record<string, number> = {};
  let deadButReceived = 0;
  let missing = 0;
  for (const eventId of accepted) {
    if (!inDb.has(eventId)) violations.push({ kind: "event_missing", event_id: eventId });
    for (const endpoint of input.endpoints) {
      const k = key(eventId, endpoint);
      const row = rows.get(k);
      const got = processed.has(k);
      if (!row) {
        missing++;
        violations.push({ kind: "delivery_missing", event_id: eventId, endpoint });
      } else if (row.status === "delivered") {
        delivered++;
        if (!got) {
          missing++;
          violations.push({ kind: "delivered_not_received", event_id: eventId, endpoint });
        }
      } else if (row.status === "dead") {
        dead++;
        deadByEndpoint[endpoint] = (deadByEndpoint[endpoint] ?? 0) + 1;
        if (got) deadButReceived++;
        if (row.attempts < input.maxAttempts) {
          violations.push({
            kind: "dead_before_max_attempts",
            event_id: eventId,
            endpoint,
            detail: `attempts=${row.attempts}`,
          });
        }
      } else {
        missing++;
        violations.push({
          kind: "stuck_pending",
          event_id: eventId,
          endpoint,
          detail: `status=${row.status} attempts=${row.attempts}`,
        });
      }
    }
  }

  if (input.idempotencyMismatches > 0) {
    violations.push({
      kind: "idempotency_mismatch",
      detail: `${input.idempotencyMismatches} repeated keys returned a different event id`,
    });
  }

  let processedReceipts = 0;
  let duplicatesAfterLostAck = 0;
  let maxCopies = 0;
  let unacceptedReceived = 0;
  for (const [k, list] of processed) {
    processedReceipts += list.length;
    maxCopies = Math.max(maxCopies, list.length);
    if (!accepted.has(k.split(" ")[0])) unacceptedReceived++;
    // A copy that follows an ack_lost copy is explained by the lost 200.
    // Others come from a worker killed or paused after the receiver answered,
    // or from a result write that failed while the database was down.
    for (let i = 1; i < list.length; i++) {
      if (list[i - 1].behavior === "ack_lost") duplicatesAfterLostAck++;
    }
  }
  const uniqueReceived = processed.size;
  const duplicateReceipts = processedReceipts - uniqueReceived;

  return {
    pass: violations.length === 0,
    accepted_events: accepted.size,
    expected_deliveries: accepted.size * input.endpoints.length,
    delivered,
    dead,
    dead_by_endpoint: deadByEndpoint,
    missing,
    dead_but_received: deadButReceived,
    unaccepted_received: unacceptedReceived,
    receiver_requests: input.receipts.length,
    processed_receipts: processedReceipts,
    unique_received: uniqueReceived,
    duplicate_receipts: duplicateReceipts,
    duplicate_rate: uniqueReceived === 0 ? 0 : duplicateReceipts / uniqueReceived,
    duplicates_after_lost_ack: duplicatesAfterLostAck,
    max_copies: maxCopies,
    violations,
  };
}

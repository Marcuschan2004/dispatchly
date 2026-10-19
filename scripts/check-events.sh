BASE="${BASE:-http://localhost:3000}"
PSQL="${PSQL:-docker compose exec -T db psql -U dispatchly -d dispatchly -tAc}"
PASS=0; FAIL=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

sql()   { $PSQL "$1" | tr -d '[:space:]'; }
uuid()  { grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$1" | head -1; }
check() { # name, expected, actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"
  else FAIL=$((FAIL+1)); echo "FAIL  $1  (expected: $2, got: $3)"; fi
}
post_event() { # outfile, body, [idempotency key]  -> prints HTTP status
  if [ -n "$3" ]; then
    curl -s -m 10 -o "$1" -w '%{http_code}' -X POST "$BASE/events" \
      -H 'content-type: application/json' -H "Idempotency-Key: $3" -d "$2"
  else
    curl -s -m 10 -o "$1" -w '%{http_code}' -X POST "$BASE/events" \
      -H 'content-type: application/json' -d "$2"
  fi
}
new_endpoint() { # event_types JSON array -> prints endpoint id
  curl -s -m 10 -X POST "$BASE/endpoints" -H 'content-type: application/json' \
    -d "{\"url\":\"https://example.com/hook\",\"event_types\":$1}" > "$TMP/ep"
  uuid "$TMP/ep"
}

echo "== setup"
curl -sf "$BASE/health" > /dev/null || { echo "Server not reachable at $BASE. Is npm run dev running?"; exit 1; }
sql "TRUNCATE endpoints, events CASCADE" > /dev/null 2>&1
ALL=$(new_endpoint '[]')                 # subscribes to everything
PAID=$(new_endpoint '["order.paid"]')    # only order.paid
USER=$(new_endpoint '["user.created"]')  # only user.created
OFF=$(new_endpoint '[]')                 # subscribes to everything, but inactive
sql "UPDATE endpoints SET active = false WHERE id = '$OFF'" > /dev/null
echo "      4 endpoints: all-events, order.paid, user.created, inactive"

echo "== new event"
CODE=$(post_event "$TMP/r1" '{"type":"order.paid","payload":{"order_id":1}}' key-1)
E1=$(uuid "$TMP/r1")
check "new event returns 201" 201 "$CODE"
check "response contains the event id" 1 "$(sql "SELECT count(*) FROM events WHERE id = '$E1'")"
check "fan-out: 2 deliveries (all-events + order.paid)" 2 "$(sql "SELECT count(*) FROM deliveries WHERE event_id = '$E1'")"
check "skips endpoint subscribed to other types" 0 "$(sql "SELECT count(*) FROM deliveries WHERE event_id = '$E1' AND endpoint_id = '$USER'")"
check "skips inactive endpoint" 0 "$(sql "SELECT count(*) FROM deliveries WHERE event_id = '$E1' AND endpoint_id = '$OFF'")"
check "deliveries start as pending" 2 "$(sql "SELECT count(*) FROM deliveries WHERE event_id = '$E1' AND status = 'pending'")"

echo "== idempotency"
CODE=$(post_event "$TMP/r2" '{"type":"order.paid","payload":{"order_id":1}}' key-1)
check "same key returns 200" 200 "$CODE"
check "same key returns the same event id" "$E1" "$(uuid "$TMP/r2")"
check "same key creates no new event" 1 "$(sql "SELECT count(*) FROM events WHERE idempotency_key = 'key-1'")"
check "same key creates no new deliveries" 2 "$(sql "SELECT count(*) FROM deliveries")"

echo "== no idempotency key"
post_event "$TMP/r3" '{"type":"invoice.sent","payload":{}}' > /dev/null
post_event "$TMP/r4" '{"type":"invoice.sent","payload":{}}' > /dev/null
check "requests without a key are never deduplicated" 2 "$(sql "SELECT count(*) FROM events WHERE type = 'invoice.sent'")"
check "type with no specific subscribers -> 1 delivery each (all-events only)" 2 "$(sql "SELECT count(*) FROM deliveries d JOIN events e ON e.id = d.event_id WHERE e.type = 'invoice.sent'")"

echo "== validation"
check "missing type -> 400" 400 "$(post_event "$TMP/v1" '{"payload":{}}')"
check "payload not an object -> 400" 400 "$(post_event "$TMP/v2" '{"type":"order.paid","payload":"nope"}')"
check "malformed JSON -> 400" 400 "$(post_event "$TMP/v3" '{"type":')"
check "rejected requests created nothing" 3 "$(sql "SELECT count(*) FROM events")"

echo "== concurrency: up to 5 rounds x 50 simultaneous requests with the same key"
ROUNDS=0; BAD=""
for round in 1 2 3 4 5; do
  curl -s -m 8 -Z --parallel-immediate --parallel-max 50 -X POST "$BASE/events?n=[1-50]" \
    -H 'content-type: application/json' -H "Idempotency-Key: race-$round" \
    -d '{"type":"order.paid","payload":{"order_id":2}}' \
    -o "$TMP/r${round}_#1" -w '%{http_code}\n' > "$TMP/codes$round"
  ROUNDS=$round
  N201=$(grep -c '^201$' "$TMP/codes$round")
  N200=$(grep -c '^200$' "$TMP/codes$round")
  EVENTS=$(sql "SELECT count(*) FROM events WHERE idempotency_key = 'race-$round'")
  DELIV=$(sql "SELECT count(*) FROM deliveries d JOIN events e ON e.id = d.event_id WHERE e.idempotency_key = 'race-$round'")
  IDS=$(for f in "$TMP"/r${round}_*; do uuid "$f"; done | sort -u | wc -l | tr -d ' ')
  if [ "$N201" != 1 ] || [ "$N200" != 49 ] || [ "$EVENTS" != 1 ] || [ "$DELIV" != 2 ] || [ "$IDS" != 1 ]; then
    BAD="round $round: 201s=$N201 200s=$N200 events=$EVENTS deliveries=$DELIV distinct_ids=$IDS"
    break
  fi
done
if [ -z "$BAD" ]; then
  check "5 rounds: one event, one 201, 49x 200, same id, 2 deliveries" ok ok
else
  check "concurrent requests with one key behave correctly" ok "$BAD"
  echo "      status codes seen: $(sort "$TMP/codes$ROUNDS" | uniq -c | tr -s ' ' | tr '\n' ' ')"
  echo "      500 = request crashed (likely a race between check and insert)"
  echo "      000 = request hung for 8s (likely pool deadlock: pool.query while holding a client)"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
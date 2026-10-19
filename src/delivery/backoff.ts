// Capped exponential backoff with full jitter:
//   delay_n = random(0, min(cap, base * 2^(n-1)))
// Jitter matters most when a receiver comes back after an outage: without it,
// every delivery that failed during the outage retries in the same instant and
// knocks the receiver over again. Full jitter spreads them across the window.
// See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
export function backoffDelayMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: () => number = Math.random
): number {
  // 2 ** n overflows to Infinity for large n; Math.min still returns the cap.
  const ceiling = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

// Retry-After is either delta-seconds or an HTTP date. Returns null when the
// header is missing or unparseable.
export function parseRetryAfterMs(
  header: string | null,
  now: number = Date.now()
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

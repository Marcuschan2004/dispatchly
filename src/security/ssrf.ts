import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { Agent } from "undici";

// SSRF guard. Endpoint URLs come from API callers, so without this a caller
// could make Dispatchly POST to its own database, cloud metadata at
// 169.254.169.254, or anything else on the private network.
//
// Two layers:
// 1. checkUrl() on the parsed URL, at registration and before every attempt.
//    It catches bad schemes, ports and userinfo, and hosts that are IP
//    literals. Node never calls lookup for an IP literal, so layer 2 can't
//    see those.
// 2. The undici Agent from createGuardedAgent() validates the addresses DNS
//    returns inside the connection's lookup step. The socket connects to the
//    address that was checked, so a DNS answer that changes between check
//    and connect (DNS rebinding) can't get past it.

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], //        "this host"; 0.0.0.0 reaches localhost
  ["10.0.0.0", 8], //       private
  ["100.64.0.0", 10], //    carrier-grade NAT, used inside some clouds
  ["127.0.0.0", 8], //      loopback
  ["169.254.0.0", 16], //   link-local, including cloud metadata
  ["172.16.0.0", 12], //    private
  ["192.0.0.0", 24], //     IETF protocol assignments
  ["192.0.2.0", 24], //     documentation
  ["192.168.0.0", 16], //   private
  ["198.18.0.0", 15], //    benchmarking
  ["198.51.100.0", 24], //  documentation
  ["203.0.113.0", 24], //   documentation
  ["224.0.0.0", 4], //      multicast
  ["240.0.0.0", 4], //      reserved, including 255.255.255.255
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], //           unspecified
  ["::1", 128], //          loopback
  ["64:ff9b::", 96], //     NAT64, can wrap a private IPv4 address
  ["2001::", 32], //        Teredo, tunnels to an embedded IPv4 address
  ["2001:db8::", 32], //    documentation
  ["2002::", 16], //        6to4, same problem as NAT64
  ["fc00::", 7], //         unique local (private)
  ["fe80::", 10], //        link-local
  ["ff00::", 8], //         multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}
// IPv4-mapped IPv6 (::ffff:127.0.0.1) needs no rule of its own: BlockList
// checks it against the IPv4 rules.

export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // not an IP at all: never connect
  return blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

export interface EgressPolicy {
  // false = https only. Plain http sends the signature and payload in the
  // clear, so it's for local development.
  allowHttp: boolean;
  allowedPorts: number[];
  // Addresses exempt from the block list. Empty in production; tests and
  // local demos use it to deliver to a receiver on 127.0.0.1.
  allowedIps: string[];
}

export const DEFAULT_POLICY: EgressPolicy = {
  allowHttp: false,
  allowedPorts: [443, 80],
  allowedIps: [],
};

const list = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export function egressPolicyFromEnv(env = process.env): EgressPolicy {
  const ports = list(env.ENDPOINT_ALLOW_PORTS).map(Number);
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error(`invalid ENDPOINT_ALLOW_PORTS: ${env.ENDPOINT_ALLOW_PORTS}`);
  }
  const ips = list(env.ENDPOINT_ALLOW_IPS);
  const bad = ips.find((ip) => isIP(ip) === 0);
  if (bad) throw new Error(`invalid ENDPOINT_ALLOW_IPS entry: ${bad}`);
  return {
    allowHttp: env.ENDPOINT_ALLOW_HTTP === "true",
    allowedPorts: [...DEFAULT_POLICY.allowedPorts, ...ports],
    allowedIps: ips,
  };
}

export class SsrfError extends Error {
  override name = "SsrfError";
}

function isAllowedIp(ip: string, policy: EgressPolicy): boolean {
  return !isBlockedIp(ip) || policy.allowedIps.includes(ip);
}

// URL.hostname keeps the brackets around IPv6 literals.
function hostIp(url: URL): string | null {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  return isIP(host) ? host : null;
}

// Always works on the parsed URL. new URL() normalizes http://2130706433,
// http://0x7f.1 and http://017700000001 to 127.0.0.1, so checking the raw
// string would miss them.
export function checkUrl(url: URL, policy: EgressPolicy): void {
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowHttp)) {
    throw new SsrfError(
      policy.allowHttp
        ? `scheme ${url.protocol} is not allowed; use http or https`
        : `scheme ${url.protocol} is not allowed; use https`
    );
  }
  if (url.username || url.password) {
    throw new SsrfError("credentials in the URL are not allowed");
  }
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!policy.allowedPorts.includes(port)) {
    throw new SsrfError(`port ${port} is not allowed`);
  }
  const ip = hostIp(url);
  if (ip !== null && !isAllowedIp(ip, policy)) {
    throw new SsrfError(`address ${ip} is in a blocked range`);
  }
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

export const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true });

const REGISTRATION_DNS_TIMEOUT_MS = 2_000;

// Registration check: fast feedback for the caller, not the real defense
// (DNS can change after this runs). A name that doesn't resolve right now is
// accepted, since it may resolve later and every attempt is checked anyway.
export async function validateEndpointUrl(
  raw: string,
  policy: EgressPolicy,
  resolve: Resolver = systemResolver
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("not a valid URL");
  }
  checkUrl(url, policy);
  if (hostIp(url) !== null) return url;

  let addresses: LookupAddress[];
  try {
    addresses = await withTimeout(resolve(url.hostname), REGISTRATION_DNS_TIMEOUT_MS);
  } catch {
    return url;
  }
  const bad = addresses.find((a) => !isAllowedIp(a.address, policy));
  if (bad) {
    throw new SsrfError(`${url.hostname} resolves to ${bad.address}, which is in a blocked range`);
  }
  return url;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void;

// A drop-in for dns.lookup that refuses to hand a blocked address to the
// socket. It rejects if ANY address is blocked, not just the first: with
// several A records, which one gets used is up to the connecting code.
export function createGuardedLookup(policy: EgressPolicy, resolve: Resolver = systemResolver) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          const err = Object.assign(new Error(`no addresses for ${hostname}`), {
            code: "ENOTFOUND",
          });
          return callback(err, []);
        }
        const bad = addresses.find((a) => !isAllowedIp(a.address, policy));
        if (bad) {
          return callback(
            new SsrfError(`destination blocked: ${hostname} resolved to ${bad.address}`),
            []
          );
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (err: NodeJS.ErrnoException) => callback(err, [])
    );
  };
}

// The dispatcher every delivery goes through. It talks to receivers directly,
// never through an HTTP proxy: through a proxy, the lookup above would check
// the proxy's address instead of the receiver's.
export function createGuardedAgent(
  policy: EgressPolicy,
  opts: { resolve?: Resolver; connectTimeoutMs?: number } = {}
): Agent {
  return new Agent({
    connect: {
      lookup: createGuardedLookup(policy, opts.resolve),
      timeout: opts.connectTimeoutMs ?? 5_000,
    },
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

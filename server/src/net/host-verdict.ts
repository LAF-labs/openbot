import { lookup } from "node:dns/promises";

/**
 * One answer to "may this deployment send a request there", for every caller that has to ask.
 *
 * THERE USED TO BE TWO. `computer/target.ts` decided it for the Bot's browser with a check on IPv4
 * ranges; `plugins/catalogue.ts` decided it for "add an MCP server" with a deny-list of names. Two
 * lists of the same addresses, neither knowing about the other, and each missing what the other had:
 * browsing allowed `https://vault.internal/`, and adding a server allowed any public NAME that
 * resolves to 10.0.0.5, because nothing resolved it.
 *
 * So the ranges, the names and the resolution live here, and the two callers compose the parts they
 * are entitled to. They are deliberately NOT given one function: navigating is synchronous and has a
 * documented opt-in for a laptop deployment browsing its own services; adding a server is an
 * administrator's act that can afford a DNS round trip and has no opt-out at all. Sharing the
 * predicates is what stops them disagreeing; sharing one entry point would have forced one of them
 * to pretend to be the other.
 *
 * Refusals are fact-coded. The sentence a person reads belongs to the surface that shows it, and the
 * two callers here phrase the same fact differently on purpose — one is talking to somebody watching
 * a Bot browse, the other to an administrator filling in a form.
 */

/**
 * Why a NAME was refused for where it points, as a value the caller phrases rather than as prose.
 *
 * Only the resolved half has codes, because only the resolved half returns a verdict. The rules that
 * read the string are predicates — the caller composing them already knows which one said no, and
 * a code there would be a second name for a branch it is standing in.
 */
export type HostFact =
  /** The name resolves to an address inside this network. */
  | "laf:host_resolves_privately"
  /** Nothing could be learned about where the name points, so nothing may be sent to it. */
  | "laf:host_unresolvable";

export type HostVerdict =
  | { allowed: true }
  | { allowed: false; fact: HostFact };

/**
 * A hostname as every comparison here expects one: lower case, and without the root dot.
 *
 * The trailing dot is the root-anchored spelling of the same name and resolves to the same place, so
 * stripping it once here is what keeps `localhost.` from walking through an equality test and
 * `vault.internal.` from walking through a suffix test. `database.` is the one that catches people
 * out: the dot it picks up is exactly what the single-label test keys on.
 */
export const normalizeHostname = (hostname: string): string =>
  hostname.toLowerCase().replace(/\.+$/, "");

/**
 * Addresses no deployment may ever open, including one that opted into private hosts.
 *
 * Reading instance metadata is how a container's cloud credentials leave it, and there is no
 * development task that needs it, so it is not covered by the private-host escape hatch.
 *
 * `metadata.goog` is Google's own short alias, published beside `metadata.google.internal`. It
 * carries a dot and none of the internal suffixes, so it read as an ordinary vendor name until it
 * was named here.
 */
const CLOUD_METADATA_HOSTNAMES = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
]);

/** Is this a hostname that holds the deployment's own cloud credentials? */
export function isCloudMetadataHostname(hostname: string): boolean {
  return CLOUD_METADATA_HOSTNAMES.has(normalizeHostname(hostname));
}

/** Hostnames that mean this machine. Reachable only where a caller opts in. */
const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

export function isLoopbackHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return LOOPBACK_HOSTNAMES.has(host) || host.endsWith(".localhost");
}

/**
 * A literal address where a hostname belongs.
 *
 * Bracketed IPv6 arrives with the brackets already stripped by `URL`, so the colon test catches it.
 */
export function isAddressLiteral(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return host.includes(":") || /^[0-9.]+$/.test(host);
}

/**
 * A name that only means something inside this network.
 *
 * `.svc` is how a Kubernetes service is addressed from inside the cluster; it carries dots and none
 * of the other suffixes, so without it that reads as an ordinary vendor name. A single label with no
 * dot at all is the same class of thing: a search-domain name, resolved by the resolver's own
 * configuration into something on this network.
 */
export function isNotPubliclyRoutableName(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  return (
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".svc") ||
    !host.includes(".")
  );
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, includes metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * The IPv6 half, which only the resolved path needs.
 *
 * A resolver answers with whatever the name has, and a name with an AAAA record pointing at `::1` or
 * into `fc00::/7` reaches this deployment's own network exactly as an A record would. The
 * IPv4-mapped form (`::ffff:10.0.0.5`) is the one that would otherwise slip past both halves, so it
 * is unwrapped and asked again.
 */
function isPrivateIpv6(address: string): boolean {
  const host =
    address
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";
  if (host === "::1" || host === "::") return true;
  const mapped = /^::ffff:(.+)$/.exec(host)?.[1];
  if (mapped) {
    return mapped.includes(".")
      ? isPrivateIpv4(mapped)
      : // `::ffff:a00:5` is the same address written in hextets. Two groups, high half first.
        isPrivateIpv4(hextetsToIpv4(mapped));
  }
  // Unique local (fc00::/7) and link-local (fe80::/10), by their first hextet.
  const [first = ""] = host.split(":");
  const leading = Number.parseInt(first.padStart(4, "0"), 16);
  if (Number.isNaN(leading)) return false;
  if ((leading & 0xfe00) === 0xfc00) return true;
  if ((leading & 0xffc0) === 0xfe80) return true;
  return false;
}

/** `a00:5` → `10.0.0.5`, so an IPv4-mapped address in hextet form is asked the same question. */
function hextetsToIpv4(hextets: string): string {
  const [high = "0", low = "0"] = hextets.split(":");
  const value =
    ((Number.parseInt(high, 16) || 0) << 16) + (Number.parseInt(low, 16) || 0);
  return [24, 16, 8, 0].map((shift) => (value >> shift) & 0xff).join(".");
}

/** Is this literal address one inside this deployment's own network? */
export function isPrivateAddress(address: string): boolean {
  return address.includes(":")
    ? isPrivateIpv6(address)
    : isPrivateIpv4(address);
}

/** How a name is turned into addresses. Injected by tests, which never touch a real resolver. */
export type HostResolver = (hostname: string) => Promise<string[]>;

const resolveWithSystem: HostResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
};

/**
 * How long a resolution is worth waiting for, and how long its answer is worth keeping.
 *
 * Short on both counts. The wait is short because this runs inside an administrator pressing Add and
 * a resolver that is not answering is itself an answer; the memory is short because the whole point
 * is where a name points NOW, and a long-lived cache would be a second, staler opinion about that.
 */
const RESOLVE_TIMEOUT_MS = 2_000;
const RESOLVE_CACHE_MS = 30_000;
/** Small on purpose: this is a convenience for a form being retried, not a resolver of our own. */
const RESOLVE_CACHE_MAX = 256;

const resolved = new Map<string, { addresses: string[] | null; at: number }>();

async function addressesFor(
  hostname: string,
  resolver: HostResolver,
): Promise<string[] | null> {
  const cached = resolved.get(hostname);
  if (cached && Date.now() - cached.at < RESOLVE_CACHE_MS) {
    return cached.addresses;
  }

  const addresses = await Promise.race([
    resolver(hostname).catch(() => null),
    new Promise<null>((settle) => {
      // `unref`, so a resolution nobody is waiting for cannot hold the process open.
      setTimeout(() => settle(null), RESOLVE_TIMEOUT_MS).unref?.();
    }),
  ]);

  // Cleared rather than evicted one at a time: this holds nothing worth a policy, and a whole clear
  // is one line that cannot leak.
  if (resolved.size >= RESOLVE_CACHE_MAX) resolved.clear();
  resolved.set(hostname, { addresses, at: Date.now() });
  return addresses;
}

/** Forget every cached resolution. For tests, which must not inherit each other's answers. */
export function forgetResolvedHosts(): void {
  resolved.clear();
}

/**
 * Where the name actually points, checked against the same ranges as a literal.
 *
 * WHY THE STRING IS NOT ENOUGH. Every rule above reads the name somebody typed, and a name is not an
 * address: `mcp.example.com` is an ordinary public hostname right up until its A record says
 * 10.0.0.5, and an attacker who controls a DNS zone controls that entirely. Adding an MCP server is
 * the one place in this product where a person hands the deployment an arbitrary address to keep and
 * to send a credential to, so it is the one place worth a round trip.
 *
 * A name that will not resolve is REFUSED rather than allowed. This deployment would have nothing to
 * send the request to either way; refusing says so at the moment somebody can act on it, and failing
 * open here would mean a resolver being slow is all it takes to skip the check.
 *
 * This is not a defence against rebinding. The answer is checked once, when the server is added, and
 * a zone that answers publicly now and privately at call time defeats it — that one is answered by
 * the call path refusing redirects and, eventually, by pinning what a server resolved to.
 */
export async function resolvedHostVerdict(
  hostname: string,
  options: { resolve?: HostResolver } = {},
): Promise<HostVerdict> {
  const host = normalizeHostname(hostname);
  const addresses = await addressesFor(
    host,
    options.resolve ?? resolveWithSystem,
  );
  if (addresses === null || addresses.length === 0) {
    return { allowed: false, fact: "laf:host_unresolvable" };
  }
  /*
   * EVERY answer, not the first one. A name with two A records where only one is private is the
   * whole trick: checking the first would make the outcome whoever writes the zone file's to choose,
   * and a resolver is free to reorder them between two lookups anyway.
   *
   * The metadata endpoint needs no separate test here — 169.254.169.254 is inside the link-local
   * range, so it is already refused by the line below rather than by a name.
   */
  if (addresses.some(isPrivateAddress)) {
    return { allowed: false, fact: "laf:host_resolves_privately" };
  }
  return { allowed: true };
}

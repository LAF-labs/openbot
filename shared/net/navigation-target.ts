import {
  type HostResolver,
  isAddressLiteral,
  isCloudMetadataHostname,
  isLoopbackHostname,
  isNotPubliclyRoutableName,
  isPrivateAddress,
  normalizeHostname,
  resolvedHostVerdict,
} from "./host-verdict";

/**
 * What a Bot's browser is allowed to navigate to.
 *
 * A computer-use browser is an SSRF engine pointed at your own network unless something stops it.
 * The Bot runs inside the deployment, so `http://localhost:5432`, the cloud metadata endpoint at
 * 169.254.169.254, and every RFC1918 address are all reachable from it and none of them are reachable
 * from the person's laptop. A model that has been talked into "check what is on 10.0.0.5" would
 * otherwise do exactly that and screenshot the result back into the transcript.
 *
 * This is an allow-list of schemes plus a deny-list of destinations, applied before the request is
 * made rather than after. {@link checkNavigationTarget} reads the string only; the browser's own
 * guard asks {@link resolvedNavigationTarget}, which also resolves the name, because a string is
 * not an address (security review 2026-09-25 F1: `127.0.0.1.nip.io` passed). The gateway sits in front
 * of every action, which is where policy per Bot belongs; this is the floor that holds even without it.
 *
 * The ranges and the names come from {@link ../net/host-verdict}, which is also what "add an MCP
 * server" asks. They used to be two lists of the same addresses that did not know about each other.
 * What stays here is the DECISION, which is not the same on both paths: this one is synchronous
 * because a navigation cannot wait on a resolver, and it has an opt-in a deployment on a laptop
 * needs. Adding a server has neither, and does resolve the name.
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export type TargetVerdict =
  | { allowed: true; url: string }
  | { allowed: false; reason: string };

/**
 * Decide whether a Bot may navigate here.
 *
 * Returns a reason rather than throwing, because the caller renders it to a person: "that address is
 * inside the deployment" is actionable, and a stack trace is not.
 */
export function checkNavigationTarget(
  raw: string,
  options: { allowPrivateHosts?: boolean } = {},
): TargetVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "That is not a web address." };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      allowed: false,
      reason: `Only web addresses are allowed, and that one is ${url.protocol.replace(":", "")}.`,
    };
  }

  /*
   * Normalised once, which closes a gap the two lists used to have between them.
   *
   * This function used to lower-case the hostname and no more, while the helper the MCP catalogue
   * borrowed from it also stripped the root dot — so `metadata.google.internal.` was refused when
   * somebody added it as a server and opened when a Bot browsed to it. It is the same address.
   */
  const hostname = normalizeHostname(url.hostname);

  // Checked before the opt-in, so no configuration can reach it.
  if (isCloudMetadataHostname(hostname)) {
    return {
      allowed: false,
      reason:
        "That address holds this deployment's own cloud credentials, so the assistant is never allowed to open it.",
    };
  }

  // A local deployment legitimately browses its own services. It is opt-in, never the default, so a
  // production deployment cannot reach its own network by forgetting to set something.
  if (options.allowPrivateHosts) {
    return { allowed: true, url: url.toString() };
  }

  if (isLoopbackHostname(hostname) || isPrivateAddress(hostname)) {
    return {
      allowed: false,
      reason:
        "That address is inside this deployment's own network, so the assistant is not allowed to open it.",
    };
  }

  /*
   * AND THE NAMES, which this half had never asked about.
   *
   * The two callers were merged so they would stop disagreeing, and then this one went on composing
   * only the ADDRESS predicates: `http://vault.internal/` was refused when an administrator added it
   * as an MCP server and opened when a Bot browsed to it. Worse, the single-label rule is what covers
   * every compose service name on this deployment's own network — `server`, `postgres`, `agent-bot`,
   * `agent-computer` — and the Bot's browser sits on that network. "Check what is on postgres:5432"
   * is one sentence away.
   *
   * Asked only of names. An IPv6 literal arrives from `URL` as `[2606:4700::1111]`, which carries no
   * dot and would read as a single label — the address predicates above are what judge those, and
   * `plugins/catalogue.ts` composes the same two in the same order for the same reason.
   */
  if (!isAddressLiteral(hostname) && isNotPubliclyRoutableName(hostname)) {
    return {
      allowed: false,
      reason:
        "That name only means something inside this deployment's own network, so the assistant is not allowed to open it.",
    };
  }

  return { allowed: true, url: url.toString() };
}

/**
 * The floor, plus where the name actually points. What the browser's guard asks of every hop.
 *
 * WHY THE STRING WAS NOT ENOUGH HERE EITHER. Measured 2026-09-25 (security review F1):
 * `http://127.0.0.1.nip.io/` passed {@link checkNavigationTarget}, because nip.io is an ordinary
 * public name whose A record says 127.0.0.1, and Chromium then resolved it and opened this
 * deployment's own loopback. "Add an MCP server" had resolved names since the two lists were merged;
 * the browser, which a page drives hop by hop, never had. So the same {@link resolvedHostVerdict}
 * now answers for both, every answer checked, an unresolvable name refused.
 *
 * NOT A DEFENCE AGAINST REBINDING, and not the last line. Chromium resolves the name again itself,
 * a moment later, and a zone answering 1.2.3.4 to this lookup and 169.254.169.254 to that one
 * defeats any check made here. That half is answered twice more: the guard checks the address the
 * browser actually connected to on every document response (`navigation-guard.ts`), and the
 * host's firewall refuses private and metadata destinations to every request, subresources
 * included (the host's rules on the `laf-browser` bridge, checked by `agent-computer/src/egress-guard.ts`).
 *
 * A literal address is not resolved — {@link checkNavigationTarget} already judged it — and nor is
 * anything under the private-host opt-in, which exists for a laptop browsing its own services.
 */
export async function resolvedNavigationTarget(
  raw: string,
  options: { allowPrivateHosts?: boolean; resolve?: HostResolver } = {},
): Promise<TargetVerdict> {
  const verdict = checkNavigationTarget(raw, options);
  if (!verdict.allowed || options.allowPrivateHosts) return verdict;
  const hostname = normalizeHostname(new URL(verdict.url).hostname);
  if (isAddressLiteral(hostname)) return verdict;
  const resolved = await resolvedHostVerdict(hostname, {
    resolve: options.resolve,
  });
  if (resolved.allowed) return verdict;
  return {
    allowed: false,
    reason:
      resolved.fact === "laf:host_resolves_privately"
        ? "That name points inside this deployment's own network, so the assistant is not allowed to open it."
        : "Nothing could be found at that address, so the assistant did not open it.",
  };
}

import {
  isAddressLiteral,
  isCloudMetadataHostname,
  isLoopbackHostname,
  isNotPubliclyRoutableName,
  isPrivateAddress,
  normalizeHostname,
} from "../net/host-verdict";

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
 * made rather than after. It is deliberately dumb: no DNS resolution, no redirect following, no
 * cleverness that could disagree with what the browser eventually does. The gateway sits in front
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

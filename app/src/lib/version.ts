import { queryOptions } from "@tanstack/react-query";
import { shellVersion } from "@/lib/notifications/shell";

/**
 * What this deployment is running, read from `GET /api/version`.
 *
 * The server bakes three facts at build time (`shared/log.ts`, `buildOf`): the build (`version`,
 * `vX.Y.Z` or `edge`), the commit (`revision`) and the compose channel it was pulled by
 * (`channel`, e.g. `stable`). The surface owns the words; this module owns none of the numbers.
 */
export type Build = {
  version: string;
  revision?: string;
  channel?: string;
};

/** Null when the server could not say — a footer with no version is honest; a made-up one is not. */
export async function readBuild(): Promise<Build | null> {
  try {
    const response = await fetch("/api/version", { credentials: "include" });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<Build>;
    if (typeof body.version !== "string" || !body.version) return null;
    return {
      version: body.version,
      ...(typeof body.revision === "string" && body.revision
        ? { revision: body.revision }
        : {}),
      ...(typeof body.channel === "string" && body.channel
        ? { channel: body.channel }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Once per page load: a build does not change under a running page. */
export const buildQueryOptions = () =>
  queryOptions({
    queryKey: ["build"],
    queryFn: readBuild,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

/** The shell's own version, or null in a browser tab. Same lifetime as the build above. */
export const shellVersionQueryOptions = () =>
  queryOptions({
    queryKey: ["shell-version"],
    queryFn: shellVersion,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

/** How many characters of a commit hash a person can read back over the phone. */
const SHORT_REVISION = 7;

/**
 * One string for the build: `v0.4.5 (dba36c3)`, with the channel after it only when it names
 * something the version does not — `v0.4.5 (dba36c3) · stable` says which channel delivered that
 * build, while `edge (dba36c3) · edge` would say it twice.
 */
export function describeBuild(build: Build): string {
  const revision = build.revision
    ? ` (${build.revision.slice(0, SHORT_REVISION)})`
    : "";
  const channel =
    build.channel && build.channel !== build.version
      ? ` · ${build.channel}`
      : "";
  return `${build.version}${revision}${channel}`;
}

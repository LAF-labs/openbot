import { queryOptions } from "@tanstack/react-query";
import { t } from "@/lib/i18n";
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

/** The parts of `navigator` the two readings below use, so a test can hand one over. */
export type NavigatorFacts = {
  userAgent?: string;
  /** User-Agent Client Hints, where the browser offers them (Chromium). Absent elsewhere. */
  userAgentData?: { platform?: string };
};

/**
 * The operating system, as a person would name it to somebody helping them — or null.
 *
 * The browser's own statement first, where it makes one; the user-agent string otherwise, in an
 * order that matters: an iPhone says "like Mac OS X" and Android says "Linux", so each is asked
 * about before the system it would otherwise be mistaken for. A Mac's version is not read, because
 * every engine now reports 10_15_7 whatever the machine runs, and a precise wrong number is worse
 * for a support thread than none.
 */
export function platformOf(nav: NavigatorFacts): string | null {
  const stated = nav.userAgentData?.platform?.trim();
  if (stated) return stated === "Chrome OS" ? "ChromeOS" : stated;
  const agent = nav.userAgent ?? "";
  if (/iPhone|iPod/.test(agent)) return "iOS";
  if (/iPad/.test(agent)) return "iPadOS";
  if (/Android/.test(agent)) return "Android";
  if (/CrOS/.test(agent)) return "ChromeOS";
  if (/Windows NT/.test(agent)) return "Windows";
  if (/Macintosh|Mac OS X/.test(agent)) return "macOS";
  if (/Linux/.test(agent)) return "Linux";
  return null;
}

/**
 * The browser, by family and major version, for a line copied from a browser tab — or null.
 *
 * The ones built on Chromium carry `Chrome/` in their string as well as their own name, so their
 * own names are looked for first: 네이버 웨일 and 삼성 인터넷 are common here, and "Chrome" would be
 * the wrong thing to tell somebody reproducing a problem. The shell's webview names no browser at
 * all, and none is invented for it.
 */
export function browserOf(nav: NavigatorFacts): string | null {
  const agent = nav.userAgent ?? "";
  const families: Array<[string, RegExp]> = [
    ["Whale", /Whale\/(\d+)/],
    ["Samsung Internet", /SamsungBrowser\/(\d+)/],
    ["Edge", /Edg(?:e|A|iOS)?\/(\d+)/],
    ["Firefox", /(?:Firefox|FxiOS)\/(\d+)/],
    ["Chrome", /(?:Chrome|CriOS)\/(\d+)/],
    ["Safari", /Version\/(\d+)[\d.]*(?: Mobile\/\S+)? Safari\//],
  ];
  for (const [family, pattern] of families) {
    const major = pattern.exec(agent)?.[1];
    if (major) return `${family} ${major}`;
  }
  return null;
}

/**
 * The one line a person pastes to whoever runs the product: what is running, and where.
 *
 * The same build the version line draws, the shell's own version when there is a shell — and when
 * there is not, that it is a browser and which — then the system. Labels through `t()` so the line
 * reads in the language the person is using; the facts inside it are the facts, untranslated.
 */
export function supportLine(facts: {
  product: string;
  build: Build;
  shell: string | null;
  browser: string | null;
  platform: string | null;
}): string {
  return [
    facts.product,
    t("server {build}", { build: describeBuild(facts.build) }),
    facts.shell
      ? t("app {shell}", { shell: facts.shell })
      : facts.browser
        ? t("browser {browser}", { browser: facts.browser })
        : t("browser"),
    facts.platform ?? t("unknown system"),
  ].join(" · ");
}

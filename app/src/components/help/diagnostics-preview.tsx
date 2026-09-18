import { activeLocale, t } from "@/lib/i18n";
import {
  checkName as connectionCheckName,
  failedCount,
} from "@/lib/support/connection-check";
import type { DiagnosticBundle, DiagnosticEvent } from "@/lib/support/feedback";

/** A health check's name, in the screen's words. The server's names are `health.ts`'s probes. */
const checkName = (name: string): string => {
  switch (name) {
    case "database":
      return t("Database");
    case "agentBot":
      return t("Bot service");
    case "computer":
      return t("The Bots' computer");
    default:
      return name;
  }
};

/** How long a run or a silence took, as the person reads a duration. */
const duration = (ms: number): string =>
  t("{seconds}s", { seconds: Math.round(ms / 100) / 10 });

/**
 * Which part of the screen a `screen_failed` record is about, in the screen's words.
 *
 * The section's id is a fact and is printed as one in the exact fold below; on the line itself
 * `sidebar` means nothing to the person deciding whether to send it, and "봇 목록" does. An id this
 * build does not know is printed as the id.
 */
const sectionName = (section: string): string => {
  switch (section) {
    case "sidebar":
      return t("The list of Bots");
    case "main":
      return t("The main screen");
    case "conversation":
      return t("The conversation");
    case "transcript":
      return t("The conversation's messages");
    case "detail":
      return t("The side panel");
    case "computer":
      return t("The Bot's screen");
    case "live_screen":
      return t("The Bot's screen, full size");
    case "settings_page":
      return t("A Settings page");
    case "admin_page":
      return t("An admin page");
    case "notices":
      return t("The notices at the top");
    case "connection_check":
      return t("Connection check");
    case "route_screen":
      return t("The whole screen");
    case "window_error":
    case "unhandled_rejection":
      return t("Something the app was doing");
    default:
      return section;
  }
};

/**
 * One event as a line: when, what, and the code and duration when it has them. The event's name and
 * its code are the facts themselves, printed as they will be sent — a translation of `run_failed`
 * would be a sentence about the bundle rather than the bundle.
 */
const eventLine = (event: DiagnosticEvent, time: Intl.DateTimeFormat) => {
  // A part of the screen that failed: which part, and what kind of error. The rest is in the fold.
  if (event.event === "screen_failed") {
    return [
      time.format(new Date(event.at)),
      event.event,
      typeof event.section === "string"
        ? t("Where it happened: {name}", { name: sectionName(event.section) })
        : null,
      typeof event.kind === "string" ? event.kind : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · ");
  }
  const ms =
    typeof event.ms === "number"
      ? event.ms
      : typeof event.silentForMs === "number"
        ? event.silentForMs
        : null;
  return [
    time.format(new Date(event.at)),
    event.event,
    typeof event.code === "string" ? event.code : null,
    ms === null ? null : duration(ms),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
};

/**
 * WHAT "진단 정보 같이 보내기" WILL SEND, SHOWN BEFORE IT IS.
 *
 * Folded, because most people will tick the box and send, and a page of event names would push the
 * send button off a small screen; one press opens it. Everything in it is drawn from the bundle the
 * server assembled and will store — nothing summarised away that goes, and nothing shown that does
 * not — and the last fold is the bundle itself, exactly as it is kept, for anybody who wants to
 * read it that way.
 */
export const DiagnosticsPreview = ({
  bundle,
}: {
  bundle: DiagnosticBundle;
}) => {
  const time = new Intl.DateTimeFormat(activeLocale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const version = bundle.version.revision
    ? `${bundle.version.version} (${bundle.version.revision.slice(0, 7)})`
    : bundle.version.version;
  const checks = Object.entries(bundle.health.checks);
  // Two events can be the same fact at the same moment; the count keeps their keys apart.
  const seen = new Map<string, number>();
  const lines = bundle.events.map((event) => {
    const text = eventLine(event, time);
    const base = `${event.at}|${event.source}|${text}`;
    const repeat = seen.get(base) ?? 0;
    seen.set(base, repeat + 1);
    return { key: `${base}|${repeat}`, text };
  });

  return (
    <details
      className="rounded-md border border-border px-3 py-2 text-xs"
      data-testid="diagnostics-preview"
    >
      <summary className="cursor-pointer text-muted-foreground">
        {t("See what will be sent")}
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("App version")}</dt>
        <dd className="break-all">{version}</dd>
        <dt className="text-muted-foreground">{t("Server")}</dt>
        <dd>
          {bundle.health.status === "ok"
            ? t("Working")
            : t("Partly not working")}
          {checks.length > 0 ? (
            <span className="block text-muted-foreground">
              {checks
                .map(([name, state]) =>
                  state === "ok"
                    ? t("{name}: working", { name: checkName(name) })
                    : t("{name}: not working", { name: checkName(name) }),
                )
                .join(" · ")}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">
          {t("Failures in the last {days} days", {
            days: bundle.failureWindowDays,
          })}
        </dt>
        <dd>
          {bundle.failures.length === 0 ? (
            t("None")
          ) : (
            <ul>
              {bundle.failures.map((failure) => (
                <li className="break-all" key={failure.code}>
                  {t("{code}, {count} times", {
                    code: failure.code,
                    count: failure.count,
                  })}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("Recent records")}</dt>
        <dd>{t("{count} records", { count: bundle.events.length })}</dd>
        {bundle.connectionCheck ? (
          <>
            <dt className="text-muted-foreground">{t("Connection check")}</dt>
            <dd>
              {failedCount(bundle.connectionCheck) === 0
                ? t("No problems found.")
                : t("Problems found in {count} of {total} checks.", {
                    count: failedCount(bundle.connectionCheck),
                    total: bundle.connectionCheck.checks.length,
                  })}
              {failedCount(bundle.connectionCheck) > 0 ? (
                <span className="block text-muted-foreground">
                  {bundle.connectionCheck.checks
                    .filter((check) => check.state === "fail")
                    .map((check) => connectionCheckName(check.id))
                    .join(" · ")}
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {lines.length > 0 ? (
        <ol className="mt-2 max-h-40 overflow-y-auto font-mono leading-5">
          {lines.map((line) => (
            <li className="break-all" key={line.key}>
              {line.text}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="mt-2 text-muted-foreground">
        {t(
          "Only names, codes and times. Never a conversation, anything you typed, an address or an email.",
        )}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-muted-foreground">
          {t("Exactly as it will be sent")}
        </summary>
        <pre
          className="mt-1 max-h-48 overflow-auto whitespace-pre font-mono"
          data-testid="diagnostics-exact"
        >
          {JSON.stringify(bundle, null, 2)}
        </pre>
      </details>
    </details>
  );
};

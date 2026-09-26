import {
  replaceWithheldMarks,
  type WithheldKind,
  type WithheldMark,
  withheldMarksIn,
} from "@shared/tools/withheld";
import { IconKey } from "@tabler/icons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * THE CODE A MAIL HELD, FOR THE OWNER'S EYES AND NOT THE BOT'S.
 *
 * A mail tool's result reaches the Bot with its one-time codes, password-reset links and sign-in
 * links taken out (`server/src/plugins/mail-secrets.ts`) — each replaced by a mark carrying a short
 * reference. This draws, on that call's own line, one row per mark with a 보기 button that asks the
 * server for the value, which answers only the person the call was made for and only for a quarter
 * of an hour. The value is held in this component's state and nowhere else: not in the transcript,
 * not in the tool result the Bot reads, not in storage.
 *
 * A mark with no reference is a routine's: nobody was watching, so the value was kept nowhere, and
 * the row says so rather than offering a button that would find nothing.
 */
export function WithheldSecrets({
  botId,
  text,
}: {
  botId: string;
  text: string;
}) {
  const marks = withheldMarksIn(text);
  if (marks.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {marks.map((mark) => (
        <WithheldRow
          botId={botId}
          key={mark.id ?? `kind:${mark.kind}`}
          mark={mark}
        />
      ))}
    </div>
  );
}

function WithheldRow({ botId, mark }: { botId: string; mark: WithheldMark }) {
  const [value, setValue] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleShow = async () => {
    if (!mark.id) return;
    setIsLoading(true);
    setProblem(null);
    const response = await fetch(
      `/api/plugins/for/${encodeURIComponent(botId)}/withheld/${encodeURIComponent(mark.id)}`,
      { credentials: "include", cache: "no-store" },
    ).catch(() => null);
    const body = response?.ok
      ? ((await response.json().catch(() => null)) as {
          value?: unknown;
        } | null)
      : null;
    setIsLoading(false);
    if (typeof body?.value === "string") {
      setValue(body.value);
      return;
    }
    setProblem(
      response?.status === 404
        ? t("It is no longer kept. Ask the site to send a new one.")
        : t("It could not be shown. Try again."),
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs">
      <IconKey aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{whatWasWithheld(mark.kind)}</span>
      {value ? (
        <code className="select-all break-all rounded bg-background px-1.5 py-0.5 font-mono">
          {value}
        </code>
      ) : mark.id ? (
        <Button
          className="h-6 px-2 text-xs"
          disabled={isLoading}
          onClick={() => void handleShow()}
          size="sm"
          variant="outline"
        >
          {t("Show me")}
        </Button>
      ) : (
        <span className="text-muted-foreground">
          {t("Not kept: it was read while nobody was watching.")}
        </span>
      )}
      {problem ? (
        <span className="basis-full text-destructive" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

/** What the mark stood for, said to the owner. */
function whatWasWithheld(kind: WithheldKind): string {
  if (kind === "reset_link") {
    return t("This mail had a password reset link. Only you can see it.");
  }
  if (kind === "login_link") {
    return t("This mail had a sign-in link. Only you can see it.");
  }
  return t("This mail had a one-time code. Only you can see it.");
}

/** The result as the owner reads it on the line: each mark said as what it hides. */
export function withheldForDisplay(text: string): string {
  return replaceWithheldMarks(text, (mark) =>
    mark.kind === "code"
      ? t("[one-time code, hidden from the Bot]")
      : mark.kind === "reset_link"
        ? t("[password reset link, hidden from the Bot]")
        : t("[sign-in link, hidden from the Bot]"),
  );
}

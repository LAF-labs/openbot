import {
  IconCircleCheck,
  IconCircleDashed,
  IconCircleMinus,
  IconCircleX,
  IconLoader2,
} from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { activeLocale, t } from "@/lib/i18n";
import {
  adviceFor,
  browserCheckIO,
  CHECK_TOTAL,
  CONNECTION_CHECKS,
  type CheckIO,
  type ConnectionCheckFacts,
  type ConnectionCheckId,
  type ConnectionCheckResult,
  checkName,
  connectionCheckText,
  failedCount,
  rememberConnectionCheck,
  resultDetail,
  runConnectionCheck,
} from "@/lib/support/connection-check";
import { cn } from "@/lib/utils";

/** How long 복사했어요 stays before the button says 복사 again — the version line's figure. */
const COPIED_MS = 1_500;

type RowState = "waiting" | "running" | ConnectionCheckResult["state"];

const StateMark = ({ state }: { state: RowState }) => {
  const className = "mt-0.5 size-4 shrink-0";
  switch (state) {
    case "pass":
      return (
        <IconCircleCheck
          aria-hidden="true"
          className={cn(className, "text-success")}
        />
      );
    case "fail":
      return (
        <IconCircleX
          aria-hidden="true"
          className={cn(className, "text-destructive")}
        />
      );
    case "skip":
      return (
        <IconCircleMinus
          aria-hidden="true"
          className={cn(className, "text-muted-foreground")}
        />
      );
    case "running":
      return (
        <IconLoader2
          aria-hidden="true"
          className={cn(className, "animate-spin text-muted-foreground")}
        />
      );
    default:
      return (
        <IconCircleDashed
          aria-hidden="true"
          className={cn(className, "text-muted-foreground/60")}
        />
      );
  }
};

/** The state in words, for whoever cannot see the mark. */
const stateWords = (state: RowState): string => {
  switch (state) {
    case "pass":
      return t("Passed");
    case "fail":
      return t("Failed");
    case "skip":
      return t("Skipped");
    case "running":
      return t("Checking…");
    default:
      return t("Waiting");
  }
};

/**
 * 연결 점검, drawn: every check as a row that fills in as its answer arrives, what the run found, and
 * 복사.
 *
 * THE RUN STARTS WHEN THIS IS DRAWN. It is reached from a line saying the connection was lost, from
 * the help page and from the 문의·의견 box — each a person pressing a button named after it — so
 * a second button to start it would be a press that only confirms the first. 다시 점검 runs it again.
 *
 * EVERY ROW IS DRAWN FROM THE START, waiting, so the list does not grow under the person reading it,
 * and the one being asked says so. A row that did not pass says in one sentence what it probably
 * means and what to try (`adviceFor`) — worked out here from the result, never kept in it.
 *
 * 복사 COPIES THE RESULT, NOT THE SCREEN: codes and numbers (`connectionCheckText`), which is what
 * the person pasting it to support needs and all they could hand over. What will be copied is one
 * press away, folded, and it opens by itself when the clipboard refuses — in the installed app's
 * window as in a tab, a copy that did not happen leaves the text there to select.
 *
 * `io` is how the tests hand in a world of their own; the app never passes it.
 */
export const ConnectionCheckPanel = ({
  io = browserCheckIO,
}: {
  io?: () => CheckIO;
}) => {
  const [results, setResults] = useState<ConnectionCheckResult[]>([]);
  const [running, setRunning] = useState<ConnectionCheckId | null>(null);
  const [facts, setFacts] = useState<ConnectionCheckFacts | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const run = useRef<AbortController | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleRun = useCallback(() => {
    run.current?.abort();
    const controller = new AbortController();
    run.current = controller;
    setResults([]);
    setFacts(null);
    setCopyState("idle");
    setRunning(CONNECTION_CHECKS[0]);
    void runConnectionCheck(io(), {
      signal: controller.signal,
      onStart: (id) => {
        if (!controller.signal.aborted) setRunning(id);
      },
      onResult: (result) => {
        if (!controller.signal.aborted) {
          setResults((done) => [...done, result]);
        }
      },
    }).then((finished) => {
      if (controller.signal.aborted || !finished) return;
      rememberConnectionCheck(finished);
      setFacts(finished);
      setRunning(null);
    });
  }, [io]);

  useEffect(() => {
    handleRun();
    return () => {
      run.current?.abort();
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    };
  }, [handleRun]);

  const text = facts ? connectionCheckText(facts) : "";

  const handleCopy = async () => {
    if (!facts) return;
    if (!(await copyText(text))) {
      setCopyState("failed");
      return;
    }
    setCopyState("copied");
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopyState("idle"), COPIED_MS);
  };

  const isRunning = facts === null;
  const failures = facts ? failedCount(facts) : 0;
  const checkedAt = facts
    ? new Intl.DateTimeFormat(activeLocale, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(facts.at))
    : "";

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="connection-check">
      <p aria-live="polite" className="text-sm" role="status">
        {isRunning
          ? t("Checking… {done} of {total}", {
              done: results.length,
              total: CHECK_TOTAL,
            })
          : failures > 0
            ? t("Problems found in {count} of {total} checks.", {
                count: failures,
                total: CHECK_TOTAL,
              })
            : t("No problems found.")}
        {facts ? " " : null}
        {facts ? (
          <span className="text-muted-foreground text-xs">
            {t("Checked at {time}", { time: checkedAt })}
          </span>
        ) : null}
      </p>
      <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {CONNECTION_CHECKS.map((id) => {
          const result = results.find((done) => done.id === id);
          const state: RowState = result
            ? result.state
            : running === id
              ? "running"
              : "waiting";
          const advice = result ? adviceFor(result, results) : null;
          return (
            <li
              className="flex min-w-0 gap-2.5 px-3 py-2.5"
              data-check={id}
              data-state={state}
              key={id}
            >
              <StateMark state={state} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="font-medium text-sm">
                    {checkName(id)}
                    <span className="sr-only"> — {stateWords(state)}</span>
                  </span>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      state === "fail"
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    {result
                      ? resultDetail(result)
                      : state === "running"
                        ? t("Checking…")
                        : t("Waiting")}
                  </span>
                </div>
                {advice ? (
                  <p className="mt-0.5 text-pretty text-muted-foreground text-xs leading-5">
                    {advice}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={isRunning}
          onClick={handleRun}
          size="sm"
          type="button"
          variant="outline"
        >
          {t("Run the check again")}
        </Button>
        <Button
          aria-label={
            copyState === "copied"
              ? t("Copied to the clipboard")
              : t("Copy the result")
          }
          disabled={isRunning}
          onClick={() => void handleCopy()}
          size="sm"
          type="button"
          variant="outline"
        >
          {copyState === "copied" ? t("Copied to the clipboard") : t("Copy")}
        </Button>
      </div>
      {copyState === "failed" ? (
        <p className="text-destructive text-xs" role="alert">
          {t(
            "The result could not be copied. Select the text below and copy it.",
          )}
        </p>
      ) : null}
      {facts ? (
        <details
          className="rounded-md border border-border px-3 py-2 text-xs"
          open={copyState === "failed" ? true : undefined}
        >
          <summary className="cursor-pointer text-muted-foreground">
            {t("See what is copied")}
          </summary>
          <pre
            className="mt-2 select-all whitespace-pre-wrap break-all font-mono leading-5"
            data-testid="connection-check-text"
          >
            {text}
          </pre>
          <p className="mt-2 text-muted-foreground">
            {t(
              "Only which checks ran, how they came out, how long they took and the kind of error. Never anything you typed, and no sign-in details.",
            )}
          </p>
        </details>
      ) : null}
    </div>
  );
};

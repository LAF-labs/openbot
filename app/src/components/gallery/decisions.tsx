import { PERSONAS } from "@shared/persona";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { authKeys } from "@/lib/auth/queries";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { t } from "@/lib/i18n";
import { PERSONA_LABELS } from "@/lib/persona/labels";
import { useServerOwnsTurn } from "@/lib/turns/answers";
import { isSavedByPress, typedAnswerIn } from "@/lib/turns/typed-answer";
import { Badge, GalleryFrame } from "./frame";

/**
 * Human-in-the-loop gallery components. `respond` resolves the suspended Bot run, and completed
 * cards render the recorded answer rather than active controls.
 *
 * A CARD SAYS HOW ITS QUESTION STANDS, AND OFFERS A PRESS ONLY WHILE A PRESS DOES SOMETHING. Pressed
 * on the running app, 2026-10-02: the Bot asked with a choice card and the turn was stopped before
 * anybody answered. The card went on reading "답을 기다려요", its options looking as live as before;
 * pressing one did nothing at all — no request, no change. A call that ended without the person's
 * answer is `complete` like any other, with a code where the answer would be, and the cards read
 * "no answer in the result" as "still waiting". There are four ways a question can stand, and
 * `standingOf` is where they are told apart.
 */

/** What the render props carry. Narrowed here so each component reads as its own small contract. */
export type Waiting<T> =
  | {
      status: "inProgress";
      args: Partial<T>;
      respond: undefined;
      result: undefined;
    }
  | {
      status: "executing";
      args: T;
      /**
       * Absent while nothing here can take an answer: a turn the server owns is not waiting on this
       * card in this conversation (`lib/turns/answers.tsx`), and no result is in yet.
       */
      respond: ((result: unknown) => Promise<void>) | undefined;
      result: undefined;
    }
  | { status: "complete"; args: T; respond: undefined; result: string };

/**
 * How a question stands: being asked, answered, passed without an answer, or — for the moment
 * between a call and its wait — not yet anybody's to answer.
 */
type Standing = "asking" | "answered" | "passed" | "idle";

function standingOf(
  props: { status: string; respond?: unknown },
  isAnswered: boolean,
): Standing {
  if (props.status === "complete") return isAnswered ? "answered" : "passed";
  return props.respond ? "asking" : "idle";
}

/** The badge for a question nobody is being asked any more, or yet. Null while it has its own. */
function standingBadge(standing: Standing) {
  if (standing === "asking") {
    return <Badge tone="caution">{t("Waiting on you")}</Badge>;
  }
  // Stopped, or nobody answered in time: said, so it is not mistaken for a question still open.
  if (standing === "passed") return <Badge>{t("Not answered")}</Badge>;
  return null;
}

export const ApprovalCardProps = z.object({
  title: z.string().describe("What is being approved, in a few words"),
  summary: z
    .string()
    .describe("What the person is agreeing to, in one or two sentences"),
  details: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional()
    .describe(
      "The facts they need in order to decide, e.g. amount, vendor, date",
    ),
  approveLabel: z.string().optional().describe("Defaults to Approve"),
  rejectLabel: z.string().optional().describe("Defaults to Decline"),
});

type ApprovalArgs = z.infer<typeof ApprovalCardProps>;

export function ApprovalCard(props: Waiting<ApprovalArgs> & { name?: string }) {
  const { args, status, respond } = props;
  const [note, setNote] = useState("");
  const [sending, setSending] = useState<"approved" | "declined" | null>(null);

  const answer = async (decision: "approved" | "declined") => {
    if (!respond) return;
    setSending(decision);
    // Include the note in the same tool result that resumes the Bot.
    await respond({ decision, note: note.trim() || undefined });
  };

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? t("Waiting for the Bot…")}>
        <p className="text-sm text-muted-foreground">
          {t("Preparing the request…")}
        </p>
      </GalleryFrame>
    );
  }

  const decided =
    status === "complete" ? readDecision(props.result) : undefined;
  const standing = standingOf(props, decided !== undefined);

  return (
    <GalleryFrame
      action={
        decided ? (
          <Badge tone={decided === "approved" ? "positive" : "negative"}>
            {decided === "approved" ? t("Approved") : t("Declined")}
          </Badge>
        ) : (
          standingBadge(standing)
        )
      }
      title={args.title}
    >
      <p className="text-sm">{args.summary}</p>

      {args.details?.length ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
          {args.details.map((detail) => (
            <div className="contents" key={detail.label}>
              <dt className="truncate text-muted-foreground">{detail.label}</dt>
              <dd className="min-w-0 break-words">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {standing !== "asking" ? null : (
        <div className="mt-4 space-y-2">
          <input
            aria-label={t("A reason, if you want to give one")}
            className="w-full rounded-md border border-border bg-transparent px-3 py-1.5 text-sm"
            disabled={Boolean(sending)}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("A reason, if you want to give one")}
            value={note}
          />
          <div className="flex gap-2">
            <Button
              disabled={Boolean(sending)}
              onClick={() => void answer("approved")}
              size="sm"
            >
              {sending === "approved"
                ? t("Sending…")
                : (args.approveLabel ?? t("Approve"))}
            </Button>
            <Button
              disabled={Boolean(sending)}
              onClick={() => void answer("declined")}
              size="sm"
              variant="outline"
            >
              {sending === "declined"
                ? t("Sending…")
                : (args.rejectLabel ?? t("Decline"))}
            </Button>
          </div>
        </div>
      )}
    </GalleryFrame>
  );
}

export const ChoiceCardProps = z.object({
  title: z.string().describe("The question being asked"),
  summary: z
    .string()
    .optional()
    .describe("Any context the person needs to choose"),
  options: z
    .array(
      z.object({
        id: z
          .string()
          .describe("What comes back to you when this one is picked"),
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .describe(
      'The options, in the order they should be offered. Ignored when saves is "persona"',
    ),
  saves: z
    .enum(["persona"])
    .optional()
    .describe(
      'Set to "persona" only to ask whether the person is a student, an office worker, a business owner or something else. The card then shows those four fixed choices itself and your options are ignored; the answer is saved only when the person presses one',
    ),
});

type ChoiceArgs = z.infer<typeof ChoiceCardProps>;

/**
 * The four answers a persona question offers, in the surface's own words and ids.
 *
 * A BOT ASKS, A PERSON ANSWERS. With `saves: "persona"` the Bot's `options` are never drawn: a Bot
 * that labelled `owner` as 학생 would otherwise have a person save the opposite of what they
 * pressed. The server takes only these four ids and writes only once somebody pressed one
 * (`server/src/turns/chat-tools.ts`).
 */
export function choiceOptions(
  args: Partial<ChoiceArgs>,
): { id: string; label: string; description?: string }[] {
  if (args.saves === "persona") {
    return PERSONAS.map((persona) => ({
      id: persona,
      label: t(PERSONA_LABELS[persona]),
    }));
  }
  return args.options ?? [];
}

export function ChoiceCard(props: Waiting<ChoiceArgs>) {
  const { args, status, respond } = props;
  const queryClient = useQueryClient();
  const [sending, setSending] = useState<string | null>(null);
  /*
   * Words are taken as the answer only by a turn the server owns (`lib/turns/typed-answer.ts`). In
   * a conversation the window drives, what is typed waits for the turn to end, as it always has.
   */
  const isServerTurn = useServerOwnsTurn();

  if (status === "inProgress") {
    return (
      <GalleryFrame title={args.title ?? t("Waiting for the Bot…")}>
        <p className="text-sm text-muted-foreground">
          {t("Preparing the question…")}
        </p>
      </GalleryFrame>
    );
  }

  const chosen = status === "complete" ? readChoice(props.result) : undefined;
  /** Their own words, typed under the card instead of a press (`lib/turns/typed-answer.ts`). */
  const typed =
    status === "complete" ? typedAnswerIn(readResult(props.result)) : undefined;
  const standing = standingOf(
    props,
    chosen !== undefined || typed !== undefined,
  );
  const isAsking = standing === "asking";

  return (
    <GalleryFrame
      action={
        standing === "answered" ? (
          <Badge tone="positive">{t("Answered")}</Badge>
        ) : (
          standingBadge(standing)
        )
      }
      caption={args.summary}
      title={args.title}
    >
      <ul className="space-y-2">
        {choiceOptions(args).map((option) => {
          const picked = chosen === option.id;
          return (
            <li key={option.id}>
              <button
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  picked
                    ? "border-success/40 bg-success/10"
                    : isAsking
                      ? "border-border hover:bg-foreground/5"
                      : "border-border opacity-50"
                }`}
                disabled={!isAsking || Boolean(sending)}
                onClick={async () => {
                  if (!respond) return;
                  setSending(option.id);
                  await respond({ choice: option.id, label: option.label });
                  // The server saved it on this answer; the screens that order by it read /api/me.
                  if (args.saves === "persona") {
                    void queryClient.invalidateQueries({
                      queryKey: authKeys.currentUser(),
                    });
                  }
                }}
                type="button"
              >
                <span className="font-medium">{option.label}</span>
                {option.description ? (
                  <span className="block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {typed ? (
        <p className="mt-3 text-sm">
          {t("Your answer: {answer}", { answer: typed })}
        </p>
      ) : null}
      {/*
       * The options are the Bot's guess at what the answer might be, and the answer is often not
       * among them. Said only where words are taken: the choice that saves who somebody is takes a
       * press, and nothing else.
       */}
      {isAsking && isServerTurn && !isSavedByPress(args.saves) ? (
        <p className="mt-3 text-muted-foreground text-xs">
          {t("None of these? Type your answer below.")}
        </p>
      ) : null}
    </GalleryFrame>
  );
}

/**
 * Read completed answers defensively from the runtime's serialized tool result.
 */
function readResult(
  result: string | undefined,
): Record<string, unknown> | undefined {
  if (!result) return undefined;
  try {
    const parsed = JSON.parse(result);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readDecision(
  result: string | undefined,
): "approved" | "declined" | undefined {
  const value = readResult(result)?.decision;
  return value === "approved" || value === "declined" ? value : undefined;
}

function readChoice(result: string | undefined): string | undefined {
  const value = readResult(result)?.choice;
  return typeof value === "string" ? value : undefined;
}

/**
 * `kind: "decision"` is what makes these suspend the run: they are registered with
 * `useHumanInTheLoop` rather than as ordinary tools, and the person's answer IS the tool result, so
 * there is no confirmation line to give the model.
 */
export const GALLERY: GalleryComponent[] = [
  {
    name: "askApproval",
    title: "Approval",
    kind: "decision",
    description:
      "Ask the person to approve or decline something, and WAIT for their answer. Use before doing anything you cannot undo, spending money, sending a message, changing a record. You are given their decision and any reason they typed.",
    parameters: ApprovalCardProps,
    Component: ApprovalCard as GalleryComponent["Component"],
  },
  {
    name: "askChoice",
    title: "Choice",
    kind: "decision",
    description:
      "Ask the person to pick one of several options, and WAIT for their answer. Use when you cannot sensibly guess which one they meant. You are given the id of the option they chose, or, when none of them fitted and they typed an answer of their own, their words as `answer`.",
    parameters: ChoiceCardProps,
    Component: ChoiceCard as GalleryComponent["Component"],
  },
];

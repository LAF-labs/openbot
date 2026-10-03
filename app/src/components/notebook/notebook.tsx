import {
  MAX_GUIDANCE_LENGTH as GUIDANCE_LENGTH,
  MAX_MEMORY_LENGTH,
  NOTEBOOK_SLOTS,
  type NotebookSlot,
} from "@shared/notebook";
import {
  IconChevronRight,
  IconMessageCircle,
  IconPencil,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { PageSection } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  confirmLine,
  forgetGuidance,
  forgetLine,
  reviseGuidance,
  reviseLine,
  writeLine,
} from "@/lib/agents/notebook";
import {
  type AgentMemory,
  agentMemoriesQueryOptions,
  type GuidanceLine,
} from "@/lib/agents/queries";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { requestJump } from "@/lib/channels/jump";
import { ensure } from "@/lib/ensure";
import { activeLocale, t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";
import { readLineOf } from "@/lib/read-line";
import { settledOf, useReading } from "@/lib/reading";
import { BUSINESS_KINDS, dailyPlaceById } from "@/lib/shop/catalogue";

/** The surface's name for each shop slot. The prompt's are in `shared/notebook.ts`. */
export const SLOT_WORDS: Record<
  NotebookSlot,
  { name: string; example: string; write: string }
> = {
  shop_name: {
    name: "Shop name",
    example: "e.g. Miso Café",
    write: "Write the shop name",
  },
  hours: {
    name: "Opening hours",
    example: "e.g. Weekdays 10:00–21:00, closed Sundays",
    write: "Write the opening hours",
  },
  offer: {
    name: "What you sell",
    example: "e.g. Americano, latte, bakery",
    write: "Write what you sell",
  },
};

/** One press at a time on this page, named by what it is about. */
type Busy = string | null;

/**
 * 수첩 — WHAT THE BOT KNOWS ABOUT THE SHOP AND ABOUT YOU, IN ONE PLACE.
 *
 * It replaces the profile's "기억하는 내용", which could only show and forget. A Bot that learned
 * something wrong is the ordinary case, and the fix used to be "forget it and tell it again in a
 * conversation"; here a line is corrected where it is read, and the correction reaches a running
 * conversation on its next message as a reminder (`server/src/context/conversations.ts`).
 *
 * The shop's facts were split between memories and 내 가게. The three a shop is asked about most —
 * its name, its hours, what it sells — are lines here; the rest of 내 가게 is shown from there and
 * changed there, so nothing is kept twice.
 *
 * THE PAGE SAYS LESS (2026-10-04, the owner: too many characters, and words where an icon would
 * do). It opened on a sentence, and each of its three sections on another: 149 characters of the
 * page explaining itself before a line of what the Bot knows. A title stands alone, with one
 * exception that is a consequence rather than an explanation: 일하는 방식 still says a change there
 * reaches the Bot the next day. 수정 is the pencil this app draws for changing a thing, named.
 * 지우기 and 잊기 keep their words: a forgotten line cannot be written back, and no icon this app
 * draws says that.
 */
export function Notebook({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const notebook = useQuery(agentMemoriesQueryOptions(agentId));
  const reading = useReading(notebook, {
    isEmpty: () => false,
    unavailable: { "laf:agent_not_found": "not_allowed" },
  });
  const settled = settledOf(reading);
  const [busy, setBusy] = useState<Busy>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  /** Every write on the page: one at a time, its refusal said, its success said once. */
  const handleWrite = async (
    key: string,
    work: () => Promise<string | null>,
    done: string,
  ): Promise<boolean> => {
    if (busy) return false;
    setBusy(key);
    setProblem(null);
    setSaid(null);
    let isDone = false;
    await ensure(
      () =>
        work().then((refusal) => {
          if (refusal) {
            setProblem(refusal);
            return;
          }
          isDone = true;
          setSaid(done);
        }),
      () => setBusy(null),
    );
    return isDone;
  };

  const lines = settled?.state === "ready" ? settled.data.memories : [];
  const guidance =
    settled?.state === "ready" ? (settled.data.guidance ?? []) : [];
  const slotLines = new Map(
    lines.flatMap((line) => (line.slot ? [[line.slot, line] as const] : [])),
  );
  const memories = lines.filter((line) => !line.slot);

  return (
    <>
      <ReadNotice
        line={readLineOf(reading, {
          failed: t("The Notebook could not be loaded."),
          notHere: t(
            "Bots here do not keep what they learn between conversations, so there is nothing to show.",
          ),
        })}
        onRetry={() => void notebook.refetch()}
      />
      {settled?.state === "ready" ? (
        <Gauge cap={settled.data.cap} used={settled.data.used} />
      ) : reading.state === "loading" ? (
        <Skeleton className="mt-6 h-10 w-full rounded-lg" />
      ) : null}

      <div className="mt-4 min-h-5">
        <LiveRegion as="p" className="text-destructive text-sm" tone="alert">
          {problem}
        </LiveRegion>
        <LiveRegion as="p" className="text-muted-foreground text-sm">
          {problem ? null : said}
        </LiveRegion>
      </div>

      <PageSection className="mt-6" title={t("The shop")}>
        <div className="mt-4 flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
          {NOTEBOOK_SLOTS.map((slot) => (
            <SlotRow
              busy={busy}
              isLoading={reading.state === "loading"}
              key={slot}
              line={slotLines.get(slot) ?? null}
              onForget={(line) =>
                handleWrite(
                  line.id,
                  () => forgetLine(queryClient, agentId, line.id),
                  t("Cleared. Your Bot no longer reads it."),
                )
              }
              onWrite={(content) =>
                handleWrite(
                  slot,
                  () => writeLine(queryClient, agentId, content, slot),
                  t("Saved. Your Bot knows from your next message."),
                )
              }
              slot={slot}
            />
          ))}
          <MyInfoRow />
        </div>
      </PageSection>

      <PageSection title={t("What it remembers")}>
        <AddLine
          busy={busy}
          onWrite={(content) =>
            handleWrite(
              "new",
              () => writeLine(queryClient, agentId, content),
              t("Written down. Your Bot knows from your next message."),
            )
          }
        />
        {settled?.state === "ready" && memories.length === 0 ? (
          <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-muted-foreground text-sm">
            {t("What your Bot learns in conversations appears here.")}
          </p>
        ) : null}
        {reading.state === "loading" ? (
          <Skeleton className="mt-4 h-24 w-full rounded-lg" />
        ) : null}
        {memories.length > 0 ? (
          <ul className="mt-4 flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
            {memories.map((line) => (
              <MemoryRow
                busy={busy}
                key={line.id}
                line={line}
                onConfirm={() =>
                  handleWrite(
                    line.id,
                    () => confirmLine(queryClient, agentId, line.id),
                    t("Marked as right."),
                  )
                }
                onForget={() =>
                  handleWrite(
                    line.id,
                    () => forgetLine(queryClient, agentId, line.id),
                    t("Forgotten. Your Bot no longer reads it."),
                  )
                }
                onRevise={(content) =>
                  handleWrite(
                    line.id,
                    () => reviseLine(queryClient, agentId, line.id, content),
                    t("Corrected. Your Bot knows from your next message."),
                  )
                }
              />
            ))}
          </ul>
        ) : null}
      </PageSection>

      {/*
       * HOW YOU LIKE TO WORK — the nightly dream's reading of the day's conversation, one line each
       * (`server/src/agents/dream.ts`). It reaches the Bot the next day, never mid-conversation, and
       * the page says so: a change here that seemed to do nothing until tomorrow would read as broken.
       *
       * THE ONE SENTENCE A SECTION KEEPS, cut to that. Where the lines come from went; what a change
       * here does, and when, is something to know before making one.
       */}
      <PageSection
        description={t("Changes here reach your Bot from the next day.")}
        title={t("How you like to work")}
      >
        {settled?.state === "ready" && guidance.length === 0 ? (
          <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-muted-foreground text-sm">
            {t(
              "After a day of conversations, your Bot notes here how you like to work.",
            )}
          </p>
        ) : null}
        {guidance.length > 0 ? (
          <ul className="mt-4 flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
            {guidance.map((line) => (
              <GuidanceRow
                busy={busy}
                key={line.id}
                line={line}
                onForget={() =>
                  handleWrite(
                    line.id,
                    () => forgetGuidance(queryClient, agentId, line.id),
                    t("Removed. Your Bot stops reading it from the next day."),
                  )
                }
                onRevise={(content) =>
                  handleWrite(
                    line.id,
                    () =>
                      reviseGuidance(queryClient, agentId, line.id, content),
                    t("Saved. Your Bot reads it from the next day."),
                  )
                }
              />
            ))}
          </ul>
        ) : null}
      </PageSection>
    </>
  );
}

/**
 * One line of how the owner likes to work: the words, and edit and remove beside them.
 *
 * WHO WROTE IT IS SAID ONLY WHERE IT IS NOT THE BOT. Every line here is the Bot's nightly note
 * unless its person rewrote it, and "봇이 대화에서 알아챔" under each of them was one sentence five
 * times over (45 of the page's 509 characters, measured 2026-10-04). The exception is marked.
 */
function GuidanceRow({
  busy,
  line,
  onForget,
  onRevise,
}: {
  busy: Busy;
  line: GuidanceLine;
  onForget: () => Promise<boolean>;
  onRevise: (content: string) => Promise<boolean>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5" data-guidance={line.source}>
      {isEditing ? (
        <LineEditor
          initial={line.content}
          isBusy={busy === line.id}
          label={t("Edit how you like to work")}
          maxLength={GUIDANCE_LENGTH}
          onCancel={() => setIsEditing(false)}
          onSave={async (content) => {
            const saved = await onRevise(content);
            if (saved) setIsEditing(false);
            return saved;
          }}
          placeholder={line.content}
          saveLabel={t("Save")}
        />
      ) : (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-pretty pt-1 text-sm">
            {line.content}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <EditButton
              disabled={Boolean(busy)}
              label={t("Edit")}
              onClick={() => setIsEditing(true)}
            />
            <ForgetButton
              disabled={Boolean(busy)}
              label={t("Clear it")}
              onConfirm={() => void onForget()}
            />
          </div>
        </div>
      )}
      {line.source === "owner" ? (
        <span className="text-muted-foreground text-xs">
          {t("You wrote this")}
        </span>
      ) : null}
    </li>
  );
}

/**
 * 수정, as the pencil this app already draws for changing a thing (the Bot's name, its profile):
 * its name is in `aria-label` and in the tooltip.
 */
function EditButton({
  disabled,
  label,
  onClick,
}: {
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={label}
      data-notebook-edit
      disabled={disabled}
      onClick={onClick}
      size="icon-sm"
      title={label}
      variant="ghost"
    >
      <IconPencil aria-hidden="true" />
    </Button>
  );
}

/**
 * How full the memory is. The cap is characters because that is what stands in front of every
 * turn; the bar is a native `<progress>` so its width needs no inline style.
 *
 * THE BAR AND ITS COUNT. It was headed 수첩 공간 over them; the count says what the bar is, and the
 * heading is the bar's own name now, for a screen reader.
 */
function Gauge({ cap, used }: { cap: number; used: number }) {
  const isNearlyFull = used >= cap * 0.9;
  return (
    <div className="mt-6 flex flex-col gap-1.5">
      <progress
        aria-label={t("Room in the Notebook")}
        className="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
        max={cap}
        value={Math.min(used, cap)}
      />
      <span
        className={`self-end text-xs ${isNearlyFull ? "text-destructive" : "text-muted-foreground"}`}
        data-notebook-room
      >
        {t("{used} of {cap} characters", {
          used: used.toLocaleString(activeLocale),
          cap: cap.toLocaleString(activeLocale),
        })}
      </span>
    </div>
  );
}

/** A line being written or rewritten: its box, its count, and its two buttons. */
export function LineEditor({
  initial,
  isBusy,
  label,
  maxLength = MAX_MEMORY_LENGTH,
  onCancel,
  onSave,
  placeholder,
  saveLabel,
}: {
  initial: string;
  isBusy: boolean;
  label: string;
  maxLength?: number;
  onCancel?: () => void;
  onSave: (content: string) => Promise<boolean>;
  placeholder: string;
  saveLabel: string;
}) {
  const [draft, setDraft] = useState(initial);
  const trimmed = draft.trim();
  const isChanged = trimmed !== initial.trim();
  const isTooLong = trimmed.length > maxLength;

  const handleSave = async () => {
    if (!trimmed || !isChanged || isTooLong || isBusy) return;
    const saved = await onSave(trimmed);
    if (saved && !onCancel) setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label={label}
        className="min-h-10"
        disabled={isBusy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          /*
           * The Enter that accepts a Korean syllable is not the Enter that saves the line, and the
           * Escape that abandons one is not the Escape that closes the editor (`lib/ime.ts`). This
           * was the one keydown handler in the app without the check: a line written in Korean
           * was saved on the keystroke that finished its last syllable, as whatever had been
           * assembled by then.
           */
          if (isImeKey(event)) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void handleSave();
          }
          if (event.key === "Escape" && onCancel) onCancel();
        }}
        placeholder={placeholder}
        value={draft}
      />
      <div className="flex items-center gap-2">
        <Button
          disabled={isBusy || !trimmed || !isChanged || isTooLong}
          onClick={() => void handleSave()}
          size="sm"
          type="button"
        >
          {isBusy ? t("Saving…") : saveLabel}
        </Button>
        {onCancel ? (
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            {t("Cancel")}
          </Button>
        ) : null}
        {/* Once there is something to count: "0/400" under an empty box is a number about nothing. */}
        {trimmed ? (
          <span
            className={`ml-auto text-xs ${isTooLong ? "text-destructive" : "text-muted-foreground"}`}
            data-line-count
          >
            {`${trimmed.length}/${maxLength}`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function AddLine({
  busy,
  onWrite,
}: {
  busy: Busy;
  onWrite: (content: string) => Promise<boolean>;
}) {
  return (
    <div className="mt-4">
      <LineEditor
        initial=""
        isBusy={busy === "new"}
        label={t("Write something down for your Bot")}
        onSave={onWrite}
        // Anybody's example, not a shop's: the persona is a hint, and this box is everybody's.
        placeholder={t("e.g. I have meetings on Friday afternoons.")}
        saveLabel={t("Write it down")}
      />
    </div>
  );
}

/**
 * One of the shop's named lines: its value, or a pencil to write it.
 *
 * AN EMPTY LINE'S PRESS IS THE PENCIL. It was a button saying the row's own name again — 가게 이름
 * beside 가게 이름 적기, 영업시간 beside 영업시간 적기 — on all three, for everybody who has no shop.
 * The words are the pencil's name now.
 */
function SlotRow({
  busy,
  isLoading,
  line,
  onForget,
  onWrite,
  slot,
}: {
  busy: Busy;
  isLoading: boolean;
  line: AgentMemory | null;
  onForget: (line: AgentMemory) => Promise<boolean>;
  onWrite: (content: string) => Promise<boolean>;
  slot: NotebookSlot;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const words = SLOT_WORDS[slot];
  const isBusy = busy === slot || (line !== null && busy === line.id);

  return (
    <div
      // Being written, the box takes the row's width under its name on a phone; read, the name,
      // the line and its presses share one row at every width.
      className={
        isEditing
          ? "flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-4"
          : "flex items-start gap-4 px-3 py-2.5"
      }
      data-notebook-slot={slot}
    >
      <span className="shrink-0 pt-1 font-medium text-sm sm:w-28">
        {t(words.name)}
      </span>
      {isEditing ? (
        <div className="min-w-0 flex-1">
          <LineEditor
            initial={line?.content ?? ""}
            isBusy={isBusy}
            label={t(words.name)}
            onCancel={() => setIsEditing(false)}
            onSave={async (content) => {
              const saved = await onWrite(content);
              if (saved) setIsEditing(false);
              return saved;
            }}
            placeholder={t(words.example)}
            saveLabel={t("Save")}
          />
        </div>
      ) : (
        <>
          <div className="min-w-0 flex-1 pt-1">
            {isLoading ? (
              <Skeleton className="h-5 w-40" />
            ) : line ? (
              <p className="text-pretty text-sm">{line.content}</p>
            ) : null}
          </div>
          {isLoading ? null : (
            <div className="flex shrink-0 items-center gap-1">
              <EditButton
                disabled={Boolean(busy)}
                label={line ? t("Edit") : t(words.write)}
                onClick={() => setIsEditing(true)}
              />
              {line ? (
                <ForgetButton
                  disabled={Boolean(busy)}
                  label={t("Clear it")}
                  onConfirm={() => void onForget(line)}
                />
              ) : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * What 내 정보 holds, read here and changed there. Kept on 내 정보 because the first run writes it
 * and the Bot's browser follows the location; a second copy here would be two answers to one
 * question.
 *
 * ONE ROW. It was three labelled rows — 하는 일, 매일 쓰는 곳, 위치 — each saying 아직 없음 until it
 * was set, and a link under them: 31 characters to say nothing on an account that had set none
 * (measured 2026-10-04). What is set is listed, and reads as what it is without its label
 * (음식점·카페 · 네이버 스마트스토어 · 춘천); what is not set is not drawn. The way to 내 정보 is the
 * chevron this app draws on a row that leads somewhere, named.
 */
function MyInfoRow() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const kind = BUSINESS_KINDS.find((entry) => entry.id === user?.shop?.kind);
  const places = (user?.shop?.places ?? [])
    .map((id) => dailyPlaceById(id))
    .filter((place) => place !== null)
    .map((place) => t(place.name));
  const set = [
    kind && kind.id !== "other" ? t(kind.name) : null,
    places.length > 0 ? places.join(", ") : null,
    user?.whereabouts?.place ?? null,
  ].filter((value) => value !== null);

  return (
    <div className="flex items-start gap-4 px-3 py-2.5" data-notebook-my-info>
      <span className="shrink-0 pt-1 font-medium text-sm sm:w-28">
        {t("My shop")}
      </span>
      <span className="min-w-0 flex-1 text-pretty pt-1 text-muted-foreground text-sm">
        {set.join(" · ")}
      </span>
      <Link
        aria-label={t("Change these on My shop")}
        className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
        title={t("Change these on My shop")}
        to="/settings/shop"
      >
        <IconChevronRight aria-hidden="true" />
      </Link>
    </div>
  );
}

/**
 * 어디서 알게 됐나 — the owner's own words the Bot learned a line from, and a way back to them in the
 * conversation. The words are the server's redacted excerpt of the owner's message; the jump is the
 * one 오늘 uses (`lib/channels/jump.ts`), so the transcript shows that message once it is drawn.
 */
function LearnedFrom({
  channelId,
  excerpt,
  messageId,
}: {
  channelId: string | null;
  excerpt: string;
  messageId: string | null;
}) {
  const navigate = useNavigate();
  /*
   * THE JUMP IS LEFT AFTER THE CONVERSATION IS ON SCREEN, not before. Left first — the way 오늘 does
   * it from beside the conversation — it was dropped on the way: measured in Chromium from 수첩, the
   * transcript mounted, unmounted and mounted again as the route settled, and the unmount drops a
   * jump named for it (`dropJump`), so the row was never marked.
   */
  const handleShow = async () => {
    if (!channelId || !messageId) return;
    await navigate({ params: { channelId }, to: "/channel/$channelId" });
    requestJump({ channelId, messageId });
  };
  return (
    /*
     * THE WORDS IT LEARNED FROM, AND THE WAY BACK TO THEM, ON ONE LINE. It was headed 어디서 알게
     * 됐나 over the quotation, with 대화에서 보기 under it: the quotation marks say whose words these
     * are, the heading is the box's tooltip, and the way back is the speech bubble this app draws
     * for the conversation, named.
     */
    <div
      className="flex items-start gap-1 rounded-md bg-muted/60 py-1 pr-1 pl-2.5 text-xs"
      data-notebook-learned
      title={t("Where it learned this")}
    >
      <q className="min-w-0 flex-1 text-pretty py-1 text-foreground">
        {excerpt}
      </q>
      {channelId && messageId ? (
        <Button
          aria-label={t("Show it in the conversation")}
          className="text-muted-foreground"
          onClick={() => void handleShow()}
          size="icon-xs"
          title={t("Show it in the conversation")}
          variant="ghost"
        >
          <IconMessageCircle aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

/** One thing the Bot remembers: the words, who wrote them, and what can be done about them. */
function MemoryRow({
  busy,
  line,
  onConfirm,
  onForget,
  onRevise,
}: {
  busy: Busy;
  line: AgentMemory;
  onConfirm: () => Promise<boolean>;
  onForget: () => Promise<boolean>;
  onRevise: (content: string) => Promise<boolean>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const isBusy = busy === line.id;
  const when = new Date(line.createdAt).toLocaleDateString(activeLocale, {
    month: "short",
    day: "numeric",
  });
  const origin =
    line.source === "owner"
      ? t("You wrote this · {date}", { date: when })
      : t("Your Bot wrote this in a conversation · {date}", { date: when });
  const evidence = line.evidence;

  return (
    <li className="flex flex-col gap-2 px-3 py-3" data-memory={line.source}>
      {isEditing ? (
        <LineEditor
          initial={line.content}
          isBusy={isBusy}
          label={t("Edit what your Bot remembers")}
          onCancel={() => setIsEditing(false)}
          onSave={async (content) => {
            const saved = await onRevise(content);
            if (saved) setIsEditing(false);
            return saved;
          }}
          placeholder={line.content}
          saveLabel={t("Save")}
        />
      ) : (
        <p className="text-pretty text-sm">{line.content}</p>
      )}
      {line.source === "bot" && evidence?.excerpt && !isEditing ? (
        <LearnedFrom
          channelId={evidence.channelId}
          excerpt={evidence.excerpt}
          messageId={evidence.messageId}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground text-xs">{origin}</span>
        {line.source === "bot" && line.confirmed ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
            {t("You said it is right")}
          </span>
        ) : evidence?.trust === "evidence" ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
            {t("Matches what you said")}
          </span>
        ) : null}
        {line.carried ? null : (
          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive text-xs">
            {t("Over the limit, so your Bot does not read it")}
          </span>
        )}
        {isEditing ? null : (
          <div className="ml-auto flex items-center gap-1">
            {line.confirmed ? null : (
              <Button
                disabled={Boolean(busy)}
                onClick={() => void onConfirm()}
                size="sm"
                variant="outline"
              >
                {t("That's right")}
              </Button>
            )}
            <EditButton
              disabled={Boolean(busy)}
              label={t("Edit")}
              onClick={() => setIsEditing(true)}
            />
            <ForgetButton
              disabled={Boolean(busy)}
              label={t("Forget")}
              onConfirm={() => void onForget()}
            />
          </div>
        )}
      </div>
    </li>
  );
}

/** How long the second press counts, after the first one arms it. */
const FORGET_ARMED_MS = 4_000;

/*
 * FORGETTING IS FOR GOOD, SO IT TAKES TWO PRESSES. Since 0.5.5 a forgotten line also leaves the day's
 * summary and cannot be written back word for word — there is no undo to offer. The 0.5.5 QA found
 * one press did it at once. The first press arms the button for a few seconds and says so; the
 * second forgets. No dialog: the confirmation stays where the finger already is (Q6, modal-less).
 */
export function ForgetButton({
  disabled,
  label,
  onConfirm,
}: {
  disabled: boolean;
  label: string;
  onConfirm: () => void;
}) {
  const [isArmed, setIsArmed] = useState(false);

  useEffect(() => {
    if (!isArmed) return;
    const timer = setTimeout(() => setIsArmed(false), FORGET_ARMED_MS);
    return () => clearTimeout(timer);
  }, [isArmed]);

  function handleClick() {
    if (!isArmed) {
      setIsArmed(true);
      return;
    }
    setIsArmed(false);
    onConfirm();
  }

  return (
    <Button
      disabled={disabled}
      onClick={handleClick}
      size="sm"
      variant={isArmed ? "destructive" : "ghost"}
    >
      {isArmed ? t("Press again to forget") : label}
    </Button>
  );
}

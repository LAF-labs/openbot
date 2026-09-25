import {
  MAX_GUIDANCE_LENGTH as GUIDANCE_LENGTH,
  MAX_MEMORY_LENGTH,
  NOTEBOOK_SLOTS,
  type NotebookSlot,
} from "@shared/notebook";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { PageSection } from "@/components/layout/page-shell";
import { ReadNotice } from "@/components/layout/read-states";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
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

      <PageSection
        className="mt-6"
        description={t(
          "What your Bot reads about the shop before every conversation.",
        )}
        title={t("The shop")}
      >
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
          <ShopProfileRows />
        </div>
      </PageSection>

      <PageSection
        description={t(
          "What your Bot has learned in conversations, and what you wrote down. Edit anything that is wrong.",
        )}
        title={t("What it remembers")}
      >
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
            {t(
              "Nothing yet. What your Bot learns in conversations appears here.",
            )}
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
       */}
      <PageSection
        description={t(
          "Each night your Bot notes how you like to work from the day's conversations. Changes here reach it from the next day.",
        )}
        title={t("How you like to work")}
      >
        {settled?.state === "ready" && guidance.length === 0 ? (
          <p className="mt-4 rounded-lg bg-muted px-3 py-2 text-muted-foreground text-sm">
            {t(
              "Nothing yet. After a day of conversations, your Bot notes here how you like to work.",
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

/** One line of how the owner likes to work: the words, who wrote them, edit and remove. */
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
    <li className="flex flex-col gap-2 px-3 py-3">
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
        <p className="text-pretty text-sm">{line.content}</p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground text-xs">
          {line.source === "owner"
            ? t("You wrote this")
            : t("Your Bot noticed this in your conversations")}
        </span>
        {isEditing ? null : (
          <div className="ml-auto flex gap-1">
            <Button
              disabled={Boolean(busy)}
              onClick={() => setIsEditing(true)}
              size="sm"
              variant="ghost"
            >
              {t("Edit")}
            </Button>
            <Button
              disabled={Boolean(busy)}
              onClick={() => void onForget()}
              size="sm"
              variant="ghost"
            >
              {t("Clear it")}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * How full the memory is. The cap is characters because that is what stands in front of every
 * turn; the bar is a native `<progress>` so its width needs no inline style.
 */
function Gauge({ cap, used }: { cap: number; used: number }) {
  const isNearlyFull = used >= cap * 0.9;
  return (
    <div className="mt-6 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{t("Room in the Notebook")}</span>
        <span
          className={
            isNearlyFull ? "text-destructive" : "text-muted-foreground"
          }
        >
          {t("{used} of {cap} characters", {
            used: used.toLocaleString(activeLocale),
            cap: cap.toLocaleString(activeLocale),
          })}
        </span>
      </div>
      <progress
        aria-label={t("Room in the Notebook")}
        className="h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
        max={cap}
        value={Math.min(used, cap)}
      />
    </div>
  );
}

/** A line being written or rewritten: its box, its count, and its two buttons. */
function LineEditor({
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
        <span
          className={`ml-auto text-xs ${isTooLong ? "text-destructive" : "text-muted-foreground"}`}
        >
          {`${trimmed.length}/${maxLength}`}
        </span>
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
        placeholder={t(
          "e.g. Parcels go by the post office. Regulars get a free drink.",
        )}
        saveLabel={t("Write it down")}
      />
    </div>
  );
}

/** One of the shop's named lines: its value, or an invitation to write it. */
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
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-4">
      <span className="shrink-0 font-medium text-sm sm:w-28 sm:pt-1">
        {t(words.name)}
      </span>
      <div className="min-w-0 flex-1">
        {isEditing ? (
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
        ) : isLoading ? (
          <Skeleton className="h-5 w-40" />
        ) : line ? (
          <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
            <p className="min-w-0 flex-1 text-pretty text-sm sm:pt-1">
              {line.content}
            </p>
            <div className="flex shrink-0 gap-1">
              <Button
                disabled={Boolean(busy)}
                onClick={() => setIsEditing(true)}
                size="sm"
                variant="ghost"
              >
                {t("Edit")}
              </Button>
              <Button
                disabled={Boolean(busy)}
                onClick={() => void onForget(line)}
                size="sm"
                variant="ghost"
              >
                {t("Clear it")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            disabled={Boolean(busy)}
            onClick={() => setIsEditing(true)}
            size="sm"
            variant="outline"
          >
            {t(words.write)}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * What 내 가게 holds, read here and changed there. Kept on 내 가게 because the first run writes it
 * and the Bot's browser follows the location; a second copy here would be two answers to one
 * question.
 */
function ShopProfileRows() {
  const { data: user } = useQuery(currentUserQueryOptions());
  const kind = BUSINESS_KINDS.find((entry) => entry.id === user?.shop?.kind);
  const places = (user?.shop?.places ?? [])
    .map((id) => dailyPlaceById(id))
    .filter((place) => place !== null)
    .map((place) => t(place.name));
  const location = user?.whereabouts?.place ?? null;
  const rows: Array<[string, string | null]> = [
    [t("What you do"), kind && kind.id !== "other" ? t(kind.name) : null],
    [
      t("Places you use every day"),
      places.length > 0 ? places.join(", ") : null,
    ],
    [t("Shop location"), location],
  ];

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      {rows.map(([name, value]) => (
        <div
          className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4"
          key={name}
        >
          <span className="shrink-0 font-medium text-sm sm:w-28">{name}</span>
          <span
            className={`min-w-0 flex-1 text-pretty text-sm ${value ? "" : "text-muted-foreground"}`}
          >
            {value ?? t("Not set")}
          </span>
        </div>
      ))}
      <Link
        className={`mt-1 self-start text-muted-foreground text-sm underline underline-offset-2 hover:text-foreground ${focusRing}`}
        to="/settings/shop"
      >
        {t("Change these on My shop")}
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
    <div className="flex flex-col gap-1 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs">
      <span className="text-muted-foreground">
        {t("Where it learned this")}
      </span>
      <q className="text-pretty text-foreground">{excerpt}</q>
      {channelId && messageId ? (
        <button
          className={`self-start rounded-sm text-link underline-offset-4 hover:underline ${focusRing}`}
          onClick={() => void handleShow()}
          type="button"
        >
          {t("Show it in the conversation")}
        </button>
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
    <li className="flex flex-col gap-2 px-3 py-3">
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
          <div className="ml-auto flex gap-1">
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
            <Button
              disabled={Boolean(busy)}
              onClick={() => setIsEditing(true)}
              size="sm"
              variant="ghost"
            >
              {t("Edit")}
            </Button>
            <Button
              disabled={Boolean(busy)}
              onClick={() => void onForget()}
              size="sm"
              variant="ghost"
            >
              {t("Forget")}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

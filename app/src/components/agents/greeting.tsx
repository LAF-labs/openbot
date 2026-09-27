import {
  effectivePersona,
  FOLLOW_UP_MAX_LENGTH,
  type Persona,
  PERSONAS,
  STUDENT_STAGES,
  WORK_FIELDS,
} from "@shared/persona";
import { PLACE_MAX_CHARS } from "@shared/whereabouts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { LiveRegion } from "@/components/layout/live-region";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { focusRing } from "@/components/ui/focus";
import { Input } from "@/components/ui/input";
import { MessageContent, Message as MessageRow } from "@/components/ui/message";
import { writeLine } from "@/lib/agents/notebook";
import { useMyBots } from "@/lib/agents/my-bots";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ensure } from "@/lib/ensure";
import { t } from "@/lib/i18n";
import { isImeKey } from "@/lib/ime";
import { hasFinalConsonant } from "@/lib/josa";
import { PERSONA_LABELS } from "@/lib/persona/labels";
import { savePersona } from "@/lib/persona/queries";
import { BUSINESS_KINDS, type BusinessKindId } from "@/lib/shop/catalogue";
import { saveShop } from "@/lib/shop/queries";
import { savePlace } from "@/lib/whereabouts/queries";

/**
 * THE BOT SPEAKS FIRST — drawn by the app, with no model call and no cost.
 *
 * The owner, 2026-09-27: "처음에 학생/직장인/사장님/기타를 먼저 묻고 시작한다. 빠르게 개인화할 수
 * 있도록." So a new conversation opens on the Bot introducing itself in two bubbles, then asking who
 * the person is, with the four answers drawn inside its bubble as rows to press — the pattern Muse's
 * first run uses, in our own words (`~/laf/docs/muse-ux-teardown-2026-09-27.md` §1). One tailored
 * follow-up comes after, then the first things to ask.
 *
 * NOTHING HERE IS A MESSAGE. The model is not called until the person presses a task or types: the
 * greeting and the answers are not stored in the conversation (`muse-shape-plan` §3.1), which keeps
 * `isFirstConversation` and the `/` redirect on their one rule, and keeps server prose off the
 * surface. A press is still SHOWN as the person's answer — a bubble on their side, the card locked
 * with the other rows dimmed — so the screen reads like a reply was given, because one was: to the
 * app, through the person's own session (`PUT /api/me/persona`, `/shop`, `/place`, the 수첩's pen).
 *
 * TWO PLACES DRAW IT. `compose` is the empty conversation, where the follow-up and the chips are.
 * `head` is the top of the conversation once something has been said, drawn only when the oldest
 * page is loaded (`ChatTranscript`'s `head`): the introduction and the answer, locked, with a way to
 * change it. A question still unanswered stays pressable in both.
 *
 * A TYPED ANSWER HAS ITS OWN FIELD, INSIDE THE BUBBLE — not the composer. The composer means "ask the
 * Bot"; if it meant "answer the greeting" while a follow-up waited, "오늘 날씨 알려줘" typed at that
 * moment would become somebody's 전공. Muse's "something else" row that focuses the composer belongs
 * to the Bot's own question card (`askChoice`), which is a later phase.
 */

type Option = { id: string; name: string };

/** The Bot's side: a grey bubble, left. */
function BotSays({
  children,
  delay = 0,
  animate,
  reveal = false,
}: {
  children: ReactNode;
  delay?: number;
  animate: boolean;
  /** Scroll it into view on arrival: a step the person's press just caused. */
  reveal?: boolean;
}) {
  return (
    <Said align="start" animate={animate} delay={delay} reveal={reveal}>
      <Bubble align="start" className="chat-prose" variant="agent">
        <BubbleContent>{children}</BubbleContent>
      </Bubble>
    </Said>
  );
}

/** The person's side: what they pressed or typed, drawn as their answer. Never sent to the Bot. */
function PersonSays({ children }: { children: ReactNode }) {
  return (
    <Said align="end" animate reveal>
      <Bubble align="end" className="chat-prose" variant="user">
        <BubbleContent>
          <span className="whitespace-pre-wrap">{children}</span>
        </BubbleContent>
      </Bubble>
    </Said>
  );
}

/**
 * One row of the greeting, arriving the way a transcript row does: a fade and a short rise, the rise
 * dropped under reduced motion. `data-slot` because `MessageContent` right-aligns its data-slot
 * children (see `Arriving` in `chat-transcript.tsx`).
 */
function Said({
  align,
  animate,
  children,
  delay = 0,
  reveal,
}: {
  align: "start" | "end";
  animate: boolean;
  children: ReactNode;
  delay?: number;
  reveal: boolean;
}) {
  const shouldReduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    ref.current?.scrollIntoView?.({
      block: "nearest",
      behavior: shouldReduceMotion ? "auto" : "smooth",
    });
  }, [reveal, shouldReduceMotion]);
  return (
    <MessageRow align={align} className="py-0.5">
      <MessageContent>
        <motion.div
          animate={{ opacity: 1, transform: "translateY(0px)" }}
          className="flex w-full flex-col"
          data-slot="greeting-row"
          initial={
            animate
              ? {
                  opacity: 0,
                  transform: shouldReduceMotion ? "none" : "translateY(8px)",
                }
              : false
          }
          ref={ref}
          transition={{
            delay: shouldReduceMotion ? 0 : delay,
            duration: 0.24,
            ease: [0.22, 1, 0.36, 1],
          }}
        >
          {children}
        </motion.div>
      </MessageContent>
    </MessageRow>
  );
}

/**
 * The answers, inside the Bot's bubble: dashed rows, one press each.
 *
 * LOCKED ONCE PICKED, like Muse's option card: the chosen row turns solid and says so to a reader
 * (`aria-pressed`), the others dim, and none can be pressed again here — the answer is changed on
 * 내 정보, which is what 바꾸기 opens.
 */
function OptionRows({
  chosen,
  disabled = false,
  labelledBy,
  onPick,
  options,
}: {
  chosen: string | null;
  disabled?: boolean;
  labelledBy: string;
  onPick: (id: string) => void;
  options: readonly Option[];
}) {
  const locked = chosen !== null;
  return (
    <fieldset
      aria-labelledby={labelledBy}
      className="mt-2 flex min-w-[min(16rem,100%)] flex-col gap-1.5"
    >
      {options.map((option) => {
        const isChosen = chosen === option.id;
        return (
          <button
            aria-pressed={isChosen}
            className={`flex min-h-11 w-full items-center rounded-xl border border-foreground/25 border-dashed px-3 py-2 text-left transition-colors enabled:hover:border-foreground/50 enabled:hover:bg-background/60 disabled:cursor-default data-[chosen=true]:border-foreground/60 data-[chosen=true]:border-solid data-[chosen=true]:bg-background/70 data-[dimmed=true]:opacity-45 ${focusRing}`}
            data-chosen={isChosen}
            data-dimmed={locked && !isChosen}
            disabled={locked || disabled}
            key={option.id}
            onClick={() => onPick(option.id)}
            type="button"
          >
            {t(option.name)}
          </button>
        );
      })}
    </fieldset>
  );
}

/** A line typed inside the Bot's bubble, with 저장 and 건너뛰기. Enter saves; IME composition does not. */
function TypedAnswer({
  busy,
  label,
  maxLength,
  onSave,
  onSkip,
  placeholder,
}: {
  busy: boolean;
  label: string;
  maxLength: number;
  onSave: (text: string) => void;
  onSkip: () => void;
  placeholder: string;
}) {
  const [text, setText] = useState("");
  const inputId = useId();
  const handleSave = () => {
    if (busy || !text.trim()) return;
    onSave(text.trim());
  };
  return (
    <div className="mt-2 flex min-w-[min(16rem,100%)] flex-col gap-2">
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <Input
        className="bg-background"
        disabled={busy}
        id={inputId}
        maxLength={maxLength}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (isImeKey(event)) return;
          if (event.key === "Enter") {
            event.preventDefault();
            handleSave();
          }
        }}
        placeholder={placeholder}
        value={text}
      />
      <div className="flex items-center gap-2">
        <Button
          className="h-9"
          disabled={busy || !text.trim()}
          onClick={handleSave}
          size="sm"
          type="button"
        >
          {busy ? t("Saving…") : t("Save")}
        </Button>
        <Button
          className="h-9"
          disabled={busy}
          onClick={onSkip}
          size="sm"
          type="button"
          variant="ghost"
        >
          {t("Skip")}
        </Button>
      </div>
    </div>
  );
}

/** What went wrong with a save, said where it was pressed. Mounted with the step, so it is heard. */
function Problem({ text }: { text: string | null }) {
  return (
    <LiveRegion as="p" className="mt-1 text-destructive text-xs" tone="alert">
      {text}
    </LiveRegion>
  );
}

const personaOptions: readonly Option[] = PERSONAS.map((persona) => ({
  id: persona,
  name: PERSONA_LABELS[persona],
}));

/**
 * 학생·직장인·사장님·기타, asked once. Stored the moment it is pressed; the rows lock at once and
 * unlock only if the save failed.
 */
function PersonaQuestion({
  animate,
  delay,
  persona,
}: {
  animate: boolean;
  delay: number;
  persona: Persona | null;
}) {
  const queryClient = useQueryClient();
  const questionId = useId();
  const [pressed, setPressed] = useState<Persona | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = persona ?? pressed;

  const handlePick = async (id: string) => {
    const picked = PERSONAS.find((known) => known === id);
    if (!picked || chosen) return;
    setProblem(null);
    setPressed(picked);
    await savePersona(picked, queryClient).catch((caught: unknown) => {
      setPressed(null);
      setProblem(
        caught instanceof Error
          ? caught.message
          : t("That was not saved. Try again."),
      );
    });
  };

  return (
    <>
      <BotSays animate={animate} delay={delay}>
        <p id={questionId}>
          {t("First, one question. Which of these are you?")}
        </p>
        <OptionRows
          chosen={chosen}
          labelledBy={questionId}
          onPick={(id) => void handlePick(id)}
          options={personaOptions}
        />
        <Problem text={problem} />
      </BotSays>
      {chosen ? <PersonSays>{t(PERSONA_LABELS[chosen])}</PersonSays> : null}
      {persona ? (
        <p className="px-1 text-right text-muted-foreground text-xs">
          <Link
            className={`underline underline-offset-2 hover:text-foreground ${focusRing}`}
            to="/settings/shop"
          >
            {t("Change")}
          </Link>
        </p>
      ) : null}
    </>
  );
}

/**
 * 사장님's follow-up: the kind of business, then where it is — the same two answers Settings keeps,
 * through the same doors (`PUT /api/me/shop`, `PUT /api/me/place`). Each step shows while its answer
 * is missing, and stays on screen, locked, once answered here.
 */
function OwnerFollowUp() {
  const queryClient = useQueryClient();
  const { data: user } = useQuery(currentUserQueryOptions());
  const kindQuestionId = useId();
  const shop = user?.shop;
  const placeKnown = Boolean(
    user?.whereabouts?.place?.trim() || user?.whereabouts?.coordinates,
  );
  // What was answered on this screen, so the step stays drawn — locked — after its answer lands.
  const [kindHere, setKindHere] = useState<BusinessKindId | null>(null);
  const [placeHere, setPlaceHere] = useState<string | null>(null);
  const [placeSkipped, setPlaceSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!shop) return null;
  const kind = shop.kind;
  const showKind = kind === null || kindHere !== null;
  const showPlace =
    kind !== null && !placeSkipped && (!placeKnown || placeHere !== null);

  const handleKind = async (id: string) => {
    const picked = BUSINESS_KINDS.find((known) => known.id === id);
    if (!picked || kind !== null || busy) return;
    setProblem(null);
    setKindHere(picked.id);
    setBusy(true);
    await ensure(
      () =>
        saveShop({ kind: picked.id, places: shop.places }, queryClient).catch(
          (caught: unknown) => {
            setKindHere(null);
            setProblem(
              caught instanceof Error
                ? caught.message
                : t("That was not saved. Try again."),
            );
          },
        ),
      () => setBusy(false),
    );
  };

  const handlePlace = async (place: string) => {
    setProblem(null);
    setBusy(true);
    await ensure(
      () =>
        savePlace(
          { place, coordinates: user?.whereabouts?.coordinates ?? null },
          queryClient,
        )
          .then(() => setPlaceHere(place))
          .catch((caught: unknown) => {
            setProblem(
              caught instanceof Error
                ? caught.message
                : t("That was not saved. Try again."),
            );
          }),
      () => setBusy(false),
    );
  };

  const chosenKind = kindHere ?? kind;
  return (
    <>
      {showKind ? (
        <>
          <BotSays animate reveal>
            <p id={kindQuestionId}>{t("What kind of business do you run?")}</p>
            <OptionRows
              chosen={chosenKind}
              disabled={busy}
              labelledBy={kindQuestionId}
              onPick={(id) => void handleKind(id)}
              options={BUSINESS_KINDS}
            />
            {showPlace ? null : <Problem text={problem} />}
          </BotSays>
          {chosenKind ? (
            <PersonSays>
              {t(
                BUSINESS_KINDS.find((known) => known.id === chosenKind)?.name ??
                  "",
              )}
            </PersonSays>
          ) : null}
        </>
      ) : null}
      {showPlace ? (
        <>
          <BotSays animate reveal>
            <p>
              {t(
                "Which neighbourhood is the shop in? The weather and places nearby are looked up there.",
              )}
            </p>
            {placeHere === null ? (
              <TypedAnswer
                busy={busy}
                label={t("Shop location")}
                maxLength={PLACE_MAX_CHARS}
                onSave={(text) => void handlePlace(text)}
                onSkip={() => setPlaceSkipped(true)}
                placeholder={t("e.g. Mapo-gu, Seoul")}
              />
            ) : null}
            <Problem text={problem} />
          </BotSays>
          {placeHere !== null ? <PersonSays>{placeHere}</PersonSays> : null}
        </>
      ) : null}
    </>
  );
}

/**
 * 학생's, 직장인's and 기타's follow-up: one press and one typed line, written to 수첩 as the person's
 * own line — through the notebook's owner pen (`writeLine`), so it is marked 내가 적음, carried into
 * every run, and theirs to fix there. No new column: that is what 수첩 already is.
 *
 * Nothing is written until the last step: the line is the pick and the words together. 건너뛰기 on
 * the typed half writes the pick alone; 그 밖에 with nothing typed writes nothing.
 */
function NotebookFollowUp({
  agentId,
  persona,
}: {
  agentId: string;
  persona: "student" | "worker" | "other";
}) {
  const queryClient = useQueryClient();
  const questionId = useId();
  const [pick, setPick] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const options: readonly Option[] =
    persona === "student"
      ? STUDENT_STAGES
      : persona === "worker"
        ? WORK_FIELDS
        : [];
  const pickName = options.find((option) => option.id === pick)?.name ?? null;
  // "그 밖에" is not a fact about anybody; it is left out of the line.
  const pickWords = pick && pick !== "other" && pickName ? t(pickName) : null;

  const lineFor = (detail: string | null): string | null => {
    const parts = [pickWords, detail].filter((part): part is string =>
      Boolean(part),
    );
    if (parts.length === 0) return null;
    const joined = parts.join(", ");
    if (persona === "worker") return t("Work: {detail}", { detail: joined });
    if (persona === "other") {
      return t("What I want help with: {detail}", { detail: joined });
    }
    return pick === "other"
      ? t("Student: {detail}", { detail: joined })
      : joined;
  };

  const handleFinish = async (detail: string | null) => {
    const line = lineFor(detail);
    if (detail) setTyped(detail);
    if (!line) {
      setSkipped(true);
      return;
    }
    setProblem(null);
    setBusy(true);
    await ensure(
      async () => {
        const refused = await writeLine(queryClient, agentId, line);
        if (refused) {
          setTyped(null);
          setProblem(refused);
          return;
        }
        setWritten(line);
      },
      () => setBusy(false),
    );
  };

  if (skipped && written === null && typed === null) return null;

  const typedQuestion =
    persona === "student"
      ? t(
          "If you have a major or an exam you are preparing for, write it here.",
        )
      : persona === "worker"
        ? t("What industry is the company in? You can leave this out.")
        : t("Tell me in one line what you would like me for.");
  const typedExample =
    persona === "student"
      ? t("e.g. Business, TOEIC in December")
      : persona === "worker"
        ? t("e.g. Food distribution")
        : t("e.g. Running a blog after retiring");
  const pickQuestion =
    persona === "student"
      ? t("What are you studying?")
      : t("What kind of work do you do?");
  const needsPick = options.length > 0;
  const showTyped = !needsPick || pick !== null;

  return (
    <>
      {needsPick ? (
        <>
          <BotSays animate reveal>
            <p id={questionId}>{pickQuestion}</p>
            <OptionRows
              chosen={pick}
              labelledBy={questionId}
              onPick={setPick}
              options={options}
            />
          </BotSays>
          {pickName ? <PersonSays>{t(pickName)}</PersonSays> : null}
        </>
      ) : null}
      {showTyped ? (
        <>
          <BotSays animate reveal>
            <p>{typedQuestion}</p>
            {typed === null && written === null ? (
              <TypedAnswer
                busy={busy}
                label={typedQuestion}
                maxLength={FOLLOW_UP_MAX_LENGTH}
                onSave={(text) => void handleFinish(text)}
                onSkip={() => void handleFinish(null)}
                placeholder={typedExample}
              />
            ) : null}
            <Problem text={problem} />
          </BotSays>
          {typed !== null ? <PersonSays>{typed}</PersonSays> : null}
        </>
      ) : null}
      {written !== null ? (
        <BotSays animate reveal>
          <p>
            {t("I wrote it in the Notebook, where you can change it any time.")}{" "}
            <Link
              className={`underline underline-offset-2 ${focusRing}`}
              to="/notebook"
            >
              {t("Open the Notebook")}
            </Link>
          </p>
        </BotSays>
      ) : null}
    </>
  );
}

/**
 * The greeting, for one Bot.
 *
 * `after` is what the compose screen puts under it once the persona is known — the first things to
 * ask. The head of a conversation passes nothing: the chips are for a Bot nobody has spoken to.
 */
export function Greeting({
  after,
  agentId,
  mode,
}: {
  after?: ReactNode;
  agentId: string;
  mode: "compose" | "head";
}) {
  const mine = useMyBots();
  const { data: user } = useQuery(currentUserQueryOptions());
  const bot = mine.bots?.find((candidate) => candidate.id === agentId);
  if (!bot || !user) return null;

  const persona = user.persona ?? null;
  const effective = effectivePersona(persona, user.shop);
  // The introduction arrives as a sequence on the empty conversation; as history it is simply there.
  const animate = mode === "compose";
  const name = bot.name;

  return (
    <section
      aria-label={t("{name}'s greeting", { name })}
      className="flex w-full flex-col"
      data-greeting={mode}
    >
      <BotSays animate={animate}>
        <p>
          {t(
            "Hello, I'm {name}. Ask me, and I'll look things up, sort them out and get them done myself.",
            { name, copula: hasFinalConsonant(name) ? "이에요" : "예요" },
          )}
        </p>
      </BotSays>
      <BotSays animate={animate} delay={0.35}>
        <p>{t("This is how I work:")}</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>
            {t(
              "Anything that cannot be undone — paying, sending, posting — I ask you first, unless you have allowed it ahead of time.",
            )}
          </li>
          <li>
            {t(
              "I have a computer and a browser of my own, so what you hand me gets finished even with the app closed.",
            )}
          </li>
          <li>
            {t(
              "At the times you set, I check on things by myself and tell you.",
            )}
          </li>
        </ul>
      </BotSays>
      <PersonaQuestion animate={animate} delay={0.7} persona={persona} />
      {mode === "compose" && persona === "owner" ? <OwnerFollowUp /> : null}
      {mode === "compose" &&
      (persona === "student" || persona === "worker" || persona === "other") ? (
        <NotebookFollowUp agentId={agentId} key={persona} persona={persona} />
      ) : null}
      {mode === "compose" && effective && after ? (
        <>
          <BotSays animate reveal={persona !== null}>
            <p>{t("Good. Shall we start with one of these?")}</p>
          </BotSays>
          <div className="px-1 pt-2 pb-4">{after}</div>
        </>
      ) : null}
    </section>
  );
}

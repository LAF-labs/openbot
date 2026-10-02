import type { Message } from "@ag-ui/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { BotAvatarState } from "@/components/avatar/bot-avatar";
import { workingKeys } from "./working";

/**
 * WHAT THE BOT IS DOING, AS ONE WORD UNDER ITS FACE (UI/UX audit 0.5.3, item 18).
 *
 * The header named the Bot and nothing else. Whether it was working, waiting on the person or idle
 * was spread over four places — the transcript's last line, a banner that comes and goes, a card
 * somewhere up the conversation, a dot in the sidebar — and a person who had scrolled up could not
 * tell a Bot that stopped to ask from a Bot that stopped. The pill says it in one word, from facts
 * the app already has; nothing here asks the server for anything new:
 *
 *  - the turn, published by the conversation that is running it (`publishTurn` below);
 *  - the browser task the banner shows (`lib/computer/browsing-now.ts`);
 *  - the approvals this tab is holding open (`lib/approvals.ts`, `openQuestions`);
 *  - a help request, read from the computer's control state (`useControl`);
 *  - a routine running, from the working poll the sidebar already makes;
 *  - a turn going with no conversation on this screen to tell it, from the same poll (below).
 *
 * The derivation is a pure function so the order it decides in is tested, not remembered.
 */

/** Where a turn is, told apart from the messages it has written so far. */
export type TurnPhase = "idle" | "thinking" | "working" | "answering";

export type PresenceFacts = {
  turn: TurnPhase;
  /** The Bot's browser has a task open (the banner's fact). */
  isBrowsing: boolean;
  /** Approvals this tab is waiting on for this Bot. */
  approvals: number;
  /** The Bot has asked the person to take over, or to type a secret. */
  isHelpWanted: boolean;
  /** A routine of this Bot's is running now (the sidebar's working poll). */
  isRoutineRunning: boolean;
  /** The Bot's turn is going on the server and nothing on this screen is telling it. */
  isTurnOffScreen: boolean;
};

export type PresenceKind =
  | "approval"
  | "help"
  | "working"
  | "routine"
  | "answering"
  | "thinking"
  | "idle";

export type Presence = {
  kind: PresenceKind;
  /** English key for `t()`; the Korean is in `i18n-ko.ts`, and a test walks this table. */
  label: string;
  /** How the pill is drawn: amber for the person's turn, the Bot's colour while busy, grey idle. */
  tone: "attention" | "active" | "quiet";
  /** The face's expression for it, before `useBotMood` adds "just finished" and "asleep". */
  face: BotAvatarState;
};

/** The words, one per kind — read through `t(variable)`, so `presence.test.ts` checks each has Korean. */
export const PRESENCE_LABELS: Readonly<Record<PresenceKind, string>> = {
  approval: "Needs your OK",
  help: "Needs your help",
  working: "Busy working",
  routine: "Running a routine",
  answering: "Answering",
  thinking: "Thinking",
  idle: "Ready",
};

/**
 * THE ORDER IS THE POINT. The person's turn beats everything: a Bot waiting on an approval is
 * also, technically, in the middle of a turn with its browser open, and "일하는 중" over a card that
 * cannot move until somebody presses it is the exact lie this pill exists to stop. An approval before
 * a help request only because it expires. Then the browser (the most visible work), a routine (work
 * nobody in this window started), and the turn's own phases — told by the conversation while it is
 * on screen, and by the server's list once it is not: where in the turn it is, nobody here knows,
 * so it is "working" and no finer.
 */
export function presenceOf(facts: PresenceFacts): Presence {
  const is = (
    kind: PresenceKind,
    tone: Presence["tone"],
    face: BotAvatarState,
  ) => ({
    kind,
    label: PRESENCE_LABELS[kind],
    tone,
    face,
  });
  if (facts.approvals > 0) return is("approval", "attention", "blocked");
  if (facts.isHelpWanted) return is("help", "attention", "blocked");
  if (facts.isBrowsing || facts.turn === "working") {
    return is("working", "active", "searching");
  }
  if (facts.isRoutineRunning) return is("routine", "active", "working");
  if (facts.turn === "answering") return is("answering", "active", "working");
  if (facts.turn === "thinking") return is("thinking", "active", "thinking");
  if (facts.isTurnOffScreen) return is("working", "active", "working");
  return is("idle", "quiet", "idle");
}

/**
 * Where a running turn is, from the thread it is writing.
 *
 * Nothing after the person's message yet: thinking. A tool call is the last thing, or a tool's
 * result is (the Bot is choosing its next step): working. Words are the last thing: answering.
 * A turn that is not running is idle whatever the thread ends with.
 */
export function turnPhaseOf(
  messages: readonly Message[],
  isRunning: boolean,
): TurnPhase {
  if (!isRunning) return "idle";
  const last = messages.at(-1);
  if (!last || last.role === "user") return "thinking";
  if (last.role === "tool") return "working";
  if (last.role === "assistant") {
    const calls = "toolCalls" in last ? last.toolCalls : undefined;
    if (calls && calls.length > 0) return "working";
    const content = typeof last.content === "string" ? last.content : "";
    return content.trim() ? "answering" : "thinking";
  }
  return "thinking";
}

// —— The turn, told by the conversation that runs it ————————————————————————————————————————

const turns = new Map<string, TurnPhase>();
const watchers = new Set<() => void>();

/**
 * Said by the conversation screen whenever its phase changes, and taken back to idle when it goes
 * away — a header that outlived the conversation which told it "answering" would say so forever.
 */
export function publishTurn(botId: string, phase: TurnPhase): void {
  if ((turns.get(botId) ?? "idle") === phase) return;
  if (phase === "idle") turns.delete(botId);
  else turns.set(botId, phase);
  for (const watcher of watchers) watcher();
}

function watchTurns(onChange: () => void): () => void {
  watchers.add(onChange);
  return () => {
    watchers.delete(onChange);
  };
}

export function readTurn(botId: string | undefined): TurnPhase {
  return botId ? (turns.get(botId) ?? "idle") : "idle";
}

export function useTurnPhase(botId: string | undefined): TurnPhase {
  const read = () => readTurn(botId);
  return useSyncExternalStore(watchTurns, read, read);
}

// —— The turn, once the conversation that was telling it has left the screen ————————————————

/*
 * MEASURED 2026-10-02, on the running app: a question that takes a web search was sent and 소식 was
 * opened a second later. Seven seconds in, the server's list had the Bot's chat run going and the
 * conversation's row in the sidebar read "처리 중…" — and the pill under the Bot's name, an inch
 * above it, read "쉬는 중". So did the tray. The turn is the server's (`lib/turns`); the phase above
 * was only ever told by a mounted conversation, and "taken back to idle when it goes away" was
 * written when leaving the conversation ended the turn. It no longer does.
 *
 * So two more facts are kept: whether a conversation of the Bot's is on this screen at all, and
 * what the last one to leave knew — its turn going or not — and when. With one on screen, its word
 * is the only one: the list is a poll and is the staler of the two. With none, the server's list
 * says whether a turn is going, once it is newer than that last word; until then the last word
 * stands, whichever way it went.
 */

/** How many mounted conversations are telling each Bot's turn. */
const tellers = new Map<string, number>();

/** What the last conversation to leave knew of the turn, and when it left. */
export type LastWord = { at: number; going: boolean };
const lastWords = new Map<string, LastWord>();

function tellersChanged(): void {
  for (const watcher of watchers) watcher();
}

/** A conversation of this Bot's has come on screen: its word on the turn is the one that counts. */
export function startTelling(botId: string): void {
  tellers.set(botId, (tellers.get(botId) ?? 0) + 1);
  lastWords.delete(botId);
  tellersChanged();
}

/** It is no longer telling: it has gone, or it has stopped knowing how its turn stands. */
export function stopTelling(botId: string): void {
  const left = (tellers.get(botId) ?? 1) - 1;
  if (left > 0) tellers.set(botId, left);
  else tellers.delete(botId);
  tellersChanged();
}

/**
 * A conversation has left the screen, at `at`, with its turn going or not: the last thing this
 * screen knew first-hand. Not kept while another conversation of the Bot's is still telling.
 */
export function leaveWord(botId: string, at: number, going: boolean): void {
  if ((tellers.get(botId) ?? 0) > 0) return;
  lastWords.set(botId, { at, going });
  tellersChanged();
}

export function isTurnTold(botId: string | undefined): boolean {
  return botId ? (tellers.get(botId) ?? 0) > 0 : false;
}

export function readLastWord(botId: string | undefined): LastWord | null {
  return botId ? (lastWords.get(botId) ?? null) : null;
}

export function useIsTurnTold(botId: string | undefined): boolean {
  const read = () => isTurnTold(botId);
  return useSyncExternalStore(watchTurns, read, read);
}

/** The same object until the next leaving, so it is a snapshot React can compare. */
export function useLastWord(botId: string | undefined): LastWord | null {
  const read = () => readLastWord(botId);
  return useSyncExternalStore(watchTurns, read, read);
}

/**
 * Whether the Bot's turn is going where this screen cannot see it.
 *
 * Never while a conversation is telling it. Once it has left, whichever is newer decides: the
 * conversation's last word, or the server's list. A list that arrived before the conversation left
 * is the older of the two both ways round — it cannot say the turn left behind has ended, and it
 * cannot bring back a turn the conversation saw end. With no conversation ever on this screen, the
 * list is all there is.
 *
 * `listedAt` is when the list ARRIVED. That it was also asked for after the leaving is
 * `usePublishTurn`'s doing: it drops whatever was in flight as the conversation goes.
 */
export function turnOffScreen(facts: {
  isTold: boolean;
  /** The server's list has a turn of this Bot's going. */
  isListed: boolean;
  /** When that list was read. Zero when it never has been. */
  listedAt: number;
  lastWord: LastWord | null;
}): boolean {
  if (facts.isTold) return false;
  if (facts.lastWord && facts.listedAt < facts.lastWord.at) {
    return facts.lastWord.going;
  }
  return facts.isListed;
}

/**
 * Publishes a phase for as long as the caller is mounted; idle again when it is not.
 *
 * `isHeard` is whether the caller knows how its turn stands. A conversation that has just come on
 * screen does not, until its stream has answered: its "idle" then is "not told yet", and counting it
 * as a word on the turn made the pill read 쉬는 중 for a quarter of a second on every return to a
 * conversation whose Bot was mid-turn (measured 2026-10-02: 일하는 중 → 쉬는 중 → 일하는 중). Until it
 * has heard, whatever spoke before it — the list, the last word — goes on speaking.
 *
 * THREE EFFECTS, AND THE LAST ONE IS THE LEAVING. Publishing a phase, being counted as telling, and
 * going away are separate things with separate lifetimes. They were two, with the leaving folded
 * into the telling — so a conversation that left before it had heard never took its phase back:
 * a send still on its way had published "thinking", and the pill said 생각 중 from then on (review
 * of this change, third round).
 */
export function usePublishTurn(
  botId: string | undefined,
  phase: TurnPhase,
  isHeard = true,
) {
  const queryClient = useQueryClient();
  /** Read as the caller leaves, which is after the last render and so not a thing to close over. */
  const heard = useRef(isHeard);
  useEffect(() => {
    heard.current = isHeard;
  }, [isHeard]);

  useEffect(() => {
    if (!botId) return;
    publishTurn(botId, phase);
  }, [botId, phase]);

  useEffect(() => {
    if (!botId || !isHeard) return;
    startTelling(botId);
    return () => stopTelling(botId);
  }, [botId, isHeard]);

  // Declared last, so it runs last as the caller goes: after the telling above has been released.
  useEffect(() => {
    if (!botId) return;
    return () => {
      const wasGoing = readTurn(botId) !== "idle";
      publishTurn(botId, "idle");
      /*
       * What this screen knew as it left. One that had heard knows either way. One that had not
       * knows only what it did itself — a send on its way is a turn going — and its "idle" is not
       * knowledge, so it leaves the word that was there before it alone.
       */
      if (heard.current || wasGoing) leaveWord(botId, Date.now(), wasGoing);
      if (wasGoing) {
        /*
         * The server's word on the turn left behind, now rather than at the poll's next tick — and
         * ASKED AFTER THE LEAVING. A list already on its way may have been written before the turn
         * began; it would arrive after the leaving and be read as news of it, and the pill would say
         * "쉬는 중" until the next poll. Invalidating does not replace such a request while the list
         * has never been answered — the library keeps a first fetch going rather than start a
         * second (query-core, `Query.fetch`) — so what is in flight is dropped first.
         */
        void queryClient
          .cancelQueries({ queryKey: workingKeys.all })
          .then(() =>
            queryClient.invalidateQueries({ queryKey: workingKeys.all }),
          );
      }
    };
  }, [botId, queryClient]);
}

import type { Message } from "@ag-ui/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
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
 * when the last one left with its turn still going. With one on screen, its word is the only one —
 * the list is a poll and is the staler of the two. With none, the server's list says whether a turn
 * is going; and in the moment between leaving and that list being read again, the turn that was
 * going when the conversation left is still going.
 */

/** How many mounted conversations are telling each Bot's turn. */
const tellers = new Map<string, number>();
/** When the last of them left with the turn still going. */
const leftGoing = new Map<string, number>();

function tellersChanged(): void {
  for (const watcher of watchers) watcher();
}

/** A conversation of this Bot's has come on screen: its word on the turn is the one that counts. */
export function startTelling(botId: string): void {
  tellers.set(botId, (tellers.get(botId) ?? 0) + 1);
  leftGoing.delete(botId);
  tellersChanged();
}

/** It has left. `goingAt` is the moment, when its turn was still going; null when it was not. */
export function stopTelling(botId: string, goingAt: number | null): void {
  const left = (tellers.get(botId) ?? 1) - 1;
  if (left > 0) {
    tellers.set(botId, left);
  } else {
    tellers.delete(botId);
    if (goingAt === null) leftGoing.delete(botId);
    else leftGoing.set(botId, goingAt);
  }
  tellersChanged();
}

export function isTurnTold(botId: string | undefined): boolean {
  return botId ? (tellers.get(botId) ?? 0) > 0 : false;
}

export function readLeftGoingAt(botId: string | undefined): number | null {
  return botId ? (leftGoing.get(botId) ?? null) : null;
}

export function useIsTurnTold(botId: string | undefined): boolean {
  const read = () => isTurnTold(botId);
  return useSyncExternalStore(watchTurns, read, read);
}

export function useLeftGoingAt(botId: string | undefined): number | null {
  const read = () => readLeftGoingAt(botId);
  return useSyncExternalStore(watchTurns, read, read);
}

/**
 * Whether the Bot's turn is going where this screen cannot see it.
 *
 * Never while a conversation is telling it. Otherwise the server's list decides — and a list read
 * before the conversation left cannot say the turn it left behind has ended.
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
  leftGoingAt: number | null;
}): boolean {
  if (facts.isTold) return false;
  if (facts.isListed) return true;
  return facts.leftGoingAt !== null && facts.listedAt < facts.leftGoingAt;
}

/** Publishes a phase for as long as the caller is mounted; idle again when it is not. */
export function usePublishTurn(botId: string | undefined, phase: TurnPhase) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!botId) return;
    publishTurn(botId, phase);
  }, [botId, phase]);
  useEffect(() => {
    if (!botId) return;
    startTelling(botId);
    return () => {
      const wasGoing = readTurn(botId) !== "idle";
      stopTelling(botId, wasGoing ? Date.now() : null);
      publishTurn(botId, "idle");
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

import type { Message } from "@ag-ui/core";
import { useEffect, useSyncExternalStore } from "react";
import type { BotAvatarState } from "@/components/avatar/bot-avatar";

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
 *  - a routine running, from the working poll the sidebar already makes.
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
 * nobody in this window started), and the turn's own phases.
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

/** Publishes a phase for as long as the caller is mounted; idle again when it is not. */
export function usePublishTurn(botId: string | undefined, phase: TurnPhase) {
  useEffect(() => {
    if (!botId) return;
    publishTurn(botId, phase);
  }, [botId, phase]);
  useEffect(() => {
    if (!botId) return;
    return () => publishTurn(botId, "idle");
  }, [botId]);
}

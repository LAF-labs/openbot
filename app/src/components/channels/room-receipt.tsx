import { motion, useReducedMotion } from "motion/react";
import { BotAvatar } from "@/components/avatar/bot-avatar";
import { focusRing } from "@/components/ui/focus";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ReceiptOutcome } from "@/lib/channels/room-receipts";
import { t } from "@/lib/i18n";
import { EASE_OUT, ENTRANCE_SECONDS } from "@/lib/motion";

/** One member on a receipt, resolved to a name and a face by the room. */
export type ReceiptFace = {
  memberId: string;
  name: string;
  avatarSeed?: string;
  outcome: ReceiptOutcome;
  /** The person's message the turn answered. */
  questionId: string;
};

/**
 * What a member's face on a receipt says, in words. The face says it first; these are for the
 * label and the list a press opens, and for a reader who cannot see the face.
 */
export function receiptStatus(outcome: ReceiptOutcome): string {
  switch (outcome) {
    case "passed":
      return t("Read it");
    case "timed_out":
      return t("Ran out of time");
    case "failed":
      return t("Could not answer");
  }
}

/**
 * "리뷰봇 · 읽었어요, 재고봇 · 답하지 못했어요" — the receipt as one sentence, for its label and for
 * the announcement when a turn ends.
 *
 * The name and the status side by side with a dot rather than inside one sentence: a Korean
 * sentence about a name somebody else chose needs a particle this surface would have to guess at.
 */
export function receiptLabel(faces: readonly ReceiptFace[]): string {
  return faces
    .map((face) => `${face.name} · ${receiptStatus(face.outcome)}`)
    .join(", ");
}

/** The shared-layout id a member's face carries while the turn it works in is live. */
export function roomFaceLayoutId(memberId: string): string {
  return `room-face-${memberId}`;
}

/**
 * The receipt under a room turn: who read the question and had nothing to add, and who could not
 * answer it.
 *
 * WHY FACES AND NOT A LINE. A line saying "리뷰봇: 보탤 말 없음" was the obvious fix and the owner
 * turned it down: a sentence in the flow of the conversation that nobody said, repeated under every
 * turn, reads as the product narrating. Korean messengers already taught everybody the quieter
 * version — a read mark at the end of the message — so this is that, with the member's own face.
 * The words are in the label, in the list a press or a hover opens, and in the announcement.
 *
 * FAILURE IS NOT SILENCE. A member that could not answer wears the face that asks for help — the
 * one the roster shows for a Bot waiting on its person — with a warning ring, and beside it a way to
 * ask again. Silence is calm and needs nothing; this needs something, and says so without scolding.
 *
 * `live` is the turn still running or just ended: its faces carry a shared-layout id, which is what
 * lets the face that was working (`MemberWorking` in chat-transcript.tsx) travel into the receipt
 * when its member finishes, rather than vanishing from one place and appearing in another. Older
 * receipts carry none, so a member's face cannot fly out of last week's turn.
 */
export function RoomReceipt({
  faces,
  live = false,
  delay = 0,
  onAskAgain,
}: {
  faces: readonly ReceiptFace[];
  live?: boolean;
  /**
   * The entrance delay of the message it sits under. Opening a room cascades the newest turns in
   * (`createFirstPaintDelays`), and a receipt drawn at once sat alone at the bottom of an empty
   * pane for the moment before the bubble it belongs to arrived — measured on the first reload.
   */
  delay?: number;
  /** Ask the members that could not answer, again. Absent draws no button — nothing can be asked. */
  onAskAgain?: (memberIds: string[]) => void;
}) {
  const reduceMotion = useReducedMotion();
  const quiet = faces.filter((face) => face.outcome === "passed");
  const stuck = faces.filter((face) => face.outcome !== "passed");
  const label = receiptLabel(faces);
  const shared = live && !reduceMotion;

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="flex justify-end pt-1 pr-1"
      data-slot="room-receipt"
      initial={{ opacity: 0 }}
      transition={{
        delay: reduceMotion ? 0 : delay + ENTRANCE_SECONDS,
        duration: ENTRANCE_SECONDS,
        ease: EASE_OUT,
      }}
    >
      <div className="flex items-center gap-2">
        <Popover>
          <PopoverTrigger
            aria-label={label}
            className={`flex items-center gap-1.5 rounded-full p-0.5 ${focusRing}`}
            delay={250}
            openOnHover
          >
            {stuck.length > 0 ? (
              <span className="flex items-center" data-receipt="needs-help">
                {stuck.map((face) => (
                  <ReceiptFaceMark
                    face={face}
                    key={face.memberId}
                    shared={shared}
                  />
                ))}
              </span>
            ) : null}
            {quiet.length > 0 ? (
              <span className="flex items-center" data-receipt="read">
                {quiet.map((face) => (
                  <ReceiptFaceMark
                    face={face}
                    key={face.memberId}
                    shared={shared}
                  />
                ))}
              </span>
            ) : null}
          </PopoverTrigger>
          {/*
           * Below, the popover's own default: above would lay the list over the very message the
           * receipt belongs to — measured, under the person's own question when nobody answered.
           */}
          <PopoverContent align="end" className="w-auto min-w-44 gap-2 p-2.5">
            <ul className="flex flex-col gap-1.5">
              {faces.map((face) => (
                <li className="flex items-center gap-2" key={face.memberId}>
                  <BotAvatar
                    paused
                    seed={face.avatarSeed}
                    size={16}
                    state={face.outcome === "passed" ? "happy" : "blocked"}
                  />
                  <span className="text-sm">{face.name}</span>
                  <span
                    className={`ml-auto pl-3 text-xs ${face.outcome === "passed" ? "text-muted-foreground" : "text-warning"}`}
                  >
                    {receiptStatus(face.outcome)}
                  </span>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
        {stuck.length > 0 && onAskAgain ? (
          <button
            aria-label={t("Ask {names} again", {
              names: stuck.map((face) => face.name).join(", "),
            })}
            className={`rounded text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline ${focusRing}`}
            onClick={() => onAskAgain(stuck.map((face) => face.memberId))}
            type="button"
          >
            {t("Ask again")}
          </button>
        ) : null}
      </div>
    </motion.div>
  );
}

/**
 * One face on the receipt.
 *
 * A ring of the page's own ground between overlapping faces, as the group avatar draws them, so two
 * characters do not read as one blob — and a warning ring instead on a face that could not answer.
 * The needs-help face is left moving: it is a status somebody should notice, where a quiet face is
 * a label and holds still.
 */
function ReceiptFaceMark({
  face,
  shared,
}: {
  face: ReceiptFace;
  shared: boolean;
}) {
  const passed = face.outcome === "passed";
  return (
    <motion.span
      className={`-ml-1 inline-flex rounded-full bg-background ring-2 first:ml-0 ${passed ? "ring-background" : "ring-warning/70"}`}
      data-outcome={face.outcome}
      layoutId={shared ? roomFaceLayoutId(face.memberId) : undefined}
    >
      <BotAvatar
        paused={passed}
        seed={face.avatarSeed}
        size={16}
        state={passed ? "happy" : "blocked"}
      />
    </motion.span>
  );
}

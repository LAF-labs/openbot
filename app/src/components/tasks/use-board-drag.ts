import { type PointerEvent, useEffect, useRef, useState } from "react";
import { dropIndex, TASK_STAGES, type TaskStage } from "@/lib/hub/tasks";

/**
 * Dragging a card on 업무판, with pointer events and nothing else — one code path for a mouse, a pen
 * and a finger.
 *
 * THE CARD STAYS WHERE IT WAS, DIMMED, while a copy follows the pointer. The element that took the
 * pointer (`setPointerCapture`) is never unmounted mid-drag, so every move and the release reach it
 * whatever is under the pointer; the copy is `pointer-events: none`, so what is under the pointer is
 * the column and the cards, read with `elementFromPoint`. Where the card would land is the column's
 * cards' vertical middles (`dropIndex`), drawn as a line between two cards.
 *
 * A MOUSE DRAGS THE WHOLE CARD; A FINGER DRAGS THE GRIP. A finger on the rest of the card scrolls the
 * board, as a finger expects — the grip alone is `touch-action: none`. A press that moves less than
 * a few pixels is a click and opens the task; one that became a drag does not.
 *
 * Where the copy is drawn is two CSS variables on the board, set from the handlers rather than from
 * render, as the home panel's edge does (`layout/home-panel.tsx`): a re-render per pointer move would
 * be sixty a second.
 *
 * Escape puts the card back. The keyboard's way to move a card is the card's menu, not this.
 */

/** How far a press moves before it is a drag rather than a click. */
const DRAG_START_PX = 5;
/** Near this close to the board's left or right edge, a drag scrolls the board that way. */
const EDGE_PX = 48;
const EDGE_STEP_PX = 14;

export type DropTarget = { stage: TaskStage; index: number };

type Session = {
  taskId: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** Where in the card the pointer took it, so the copy does not jump to its corner. */
  offsetX: number;
  offsetY: number;
  width: number;
  isDragging: boolean;
  target: DropTarget | null;
};

const isStage = (value: string | undefined): value is TaskStage =>
  TASK_STAGES.includes(value as TaskStage);

/** Where a card dropped at this point would land, read off the page under the pointer. */
function targetAt(x: number, y: number, taskId: string): DropTarget | null {
  const column = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>("[data-task-column]");
  const stage = column?.dataset.taskColumn;
  if (!column || !isStage(stage)) return null;
  const middles = [...column.querySelectorAll<HTMLElement>("[data-task-card]")]
    .filter((card) => card.dataset.taskCard !== taskId)
    .map((card) => {
      const box = card.getBoundingClientRect();
      return box.top + box.height / 2;
    });
  return { stage, index: dropIndex(middles, y) };
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a?.stage === b?.stage && a?.index === b?.index;

export function useBoardDrag(input: {
  /** The board's element: the copy's position is set on it, and its scroller is scrolled. */
  board: () => HTMLElement | null;
  onDrop: (taskId: string, target: DropTarget) => void;
  /** Whether this card may be dragged now (not while its last move is still on its way). */
  canDrag: (taskId: string) => boolean;
}) {
  const session = useRef<Session | null>(null);
  const swallowClick = useRef(false);
  /** The card being dragged and where it would land: what the board draws differently. */
  const [drag, setDrag] = useState<{
    taskId: string;
    target: DropTarget | null;
  } | null>(null);

  const place = (x: number, y: number, current: Session) => {
    const board = input.board();
    if (!board) return;
    board.style.setProperty("--drag-x", `${x - current.offsetX}px`);
    board.style.setProperty("--drag-y", `${y - current.offsetY}px`);
    board.style.setProperty("--drag-w", `${current.width}px`);
  };

  const end = (dropped: boolean) => {
    const current = session.current;
    session.current = null;
    if (!current) return;
    if (current.isDragging) {
      // The click this release makes, if it makes one, comes before any timer: swallowed, then
      // forgotten, so the next Enter on a card is not.
      swallowClick.current = true;
      setTimeout(() => {
        swallowClick.current = false;
      }, 0);
      setDrag(null);
      if (dropped && current.target)
        input.onDrop(current.taskId, current.target);
    }
  };

  // Escape while dragging puts the card back where it was.
  const isDragging = drag !== null;
  useEffect(() => {
    if (!isDragging) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // `end(false)`, spelled out: only refs and a state setter, so the effect needs nothing else.
      const current = session.current;
      session.current = null;
      if (current?.isDragging) {
        swallowClick.current = true;
        setDrag(null);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isDragging]);

  const handlePointerDown = (
    event: PointerEvent<HTMLElement>,
    taskId: string,
  ) => {
    if (event.button !== 0 || session.current) return;
    const isGrip =
      (event.target as HTMLElement).closest("[data-task-grip]") !== null;
    // A finger scrolls from anywhere but the grip; the grip is the finger's handle.
    if (event.pointerType === "touch" && !isGrip) return;
    if ((event.target as HTMLElement).closest("[data-task-menu]")) return;
    if (!input.canDrag(taskId)) return;
    const card = event.currentTarget.closest<HTMLElement>("[data-task-card]");
    if (!card) return;
    const box = card.getBoundingClientRect();
    swallowClick.current = false;
    session.current = {
      taskId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - box.left,
      offsetY: event.clientY - box.top,
      width: box.width,
      isDragging: false,
      target: null,
    };
    // The grip: no text selection, no scroll starting under the finger.
    if (isGrip) event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = session.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.isDragging) {
      const moved = Math.hypot(
        event.clientX - current.startX,
        event.clientY - current.startY,
      );
      if (moved < DRAG_START_PX) return;
      current.isDragging = true;
      /*
       * Taken only now, not on the press: a captured pointer's release is the card's, so the click
       * after it lands on the card and not on the title inside it — which is what keeps a drag from
       * opening the task, and why a press that never moved (no capture) still opens it.
       */
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    place(event.clientX, event.clientY, current);
    const scroller = input
      .board()
      ?.querySelector<HTMLElement>("[data-task-scroller]");
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      if (event.clientX < box.left + EDGE_PX)
        scroller.scrollLeft -= EDGE_STEP_PX;
      if (event.clientX > box.right - EDGE_PX)
        scroller.scrollLeft += EDGE_STEP_PX;
    }
    const target = targetAt(event.clientX, event.clientY, current.taskId);
    if (!sameTarget(target, current.target) || drag === null) {
      current.target = target;
      setDrag({ taskId: current.taskId, target });
    }
  };

  const handlePointerUp = (event: PointerEvent<HTMLElement>) => {
    if (session.current?.pointerId !== event.pointerId) return;
    end(true);
  };

  /** Cancelled by the browser, or the capture lost: the card goes back. */
  const handlePointerCancel = (event: PointerEvent<HTMLElement>) => {
    if (session.current?.pointerId !== event.pointerId) return;
    end(false);
  };

  /** Whether the click that ends a press should open the task: not when the press was a drag. */
  const isClick = () => {
    if (!swallowClick.current) return true;
    swallowClick.current = false;
    return false;
  };

  /** On the card; a press on its grip (`data-task-grip`) is a finger's drag too. */
  const cardHandlers = (taskId: string) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) =>
      handlePointerDown(event, taskId),
    onPointerMove: handlePointerMove,
    onPointerUp: handlePointerUp,
    onPointerCancel: handlePointerCancel,
    // Only the card's own capture ending: a finger's press is captured by the grip's icon until the
    // drag takes it for the card, and that hand-over is not the drag ending.
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => {
      if (event.target === event.currentTarget) handlePointerCancel(event);
    },
  });

  return { drag, cardHandlers, isClick };
}

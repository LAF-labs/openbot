/**
 * What the Bot has asked a person for, read and answered: the help it asked for, closed with
 * 다 했어요 or 건너뛰기, and the value it asked for, typed into the masked box.
 *
 * The file keeps its old name. It also took the wheel, and converted a click on the picture to a
 * point on the Bot's page, until nobody could drive the Bot's browser (owner, 2026-10-09).
 */
import { refusalText, SECRET_REFUSALS } from "@/lib/computer/refusals";
import { t } from "@/lib/i18n";

export type ControlState = {
  /** Always the Bot: nobody else drives its browser. Still on the wire; see `server/src/computer/schema.ts`. */
  holder: "bot";
  since: string;
  reason?: string;
  requested: boolean;
  /** What the Bot is waiting for, by name only. Present means show the masked prompt. */
  secretWanted?: string;
  /**
   * Where the value goes, as the SERVER resolved it — never as the Bot described it.
   *
   * `secretWanted` is a label the model wrote, and a model steered by a page can write "네이버
   * 비밀번호" above a box on any site at all. The host and the control's own label come from the
   * snapshot the server holds, so the masked box can say which page is asking.
   */
  secretInto?: { host: string; element: { role: string; name: string } };
};

/**
 * WHAT AN ANSWER WAS ANSWERED, TOLD TO EVERY VIEW OF THAT COMPUTER AT ONCE.
 *
 * The views learn what the Bot is asking for from one shared poll (`control-poll.ts`), which reads
 * once a second at most, so a card answered in one place went on asking in another for up to a
 * second more. (Measured 2026-09-24 on the take this file used to make: 803 ms between the press
 * and the screen agreeing.) The answer to the press IS the new state; `useControl` starts from the
 * last one and hears each one as it comes.
 */
const answered = new Map<string, ControlState>();
const answerListeners = new Map<string, Set<(state: ControlState) => void>>();

/** The last state this tab was told for a computer, by a press or by the poll. */
export function lastControlState(computerId: string): ControlState | null {
  return answered.get(computerId) ?? null;
}

/** Remember a state read by the poll, so a view mounted next does not start from nothing. */
export function rememberControlState(
  computerId: string,
  state: ControlState,
): void {
  answered.set(computerId, state);
}

/** Test seam: back to a tab that has been told nothing. */
export function forgetControlStates(): void {
  answered.clear();
}

/** Hear every take or release answered for one computer. Returns the unsubscribe. */
export function onControlAnswered(
  computerId: string,
  listener: (state: ControlState) => void,
): () => void {
  const listeners = answerListeners.get(computerId) ?? new Set();
  listeners.add(listener);
  answerListeners.set(computerId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) answerListeners.delete(computerId);
  };
}

async function callControl(
  computerId: string,
  path: string,
  init?: RequestInit,
): Promise<ControlState | null> {
  const response = await fetch(`/api/computers/${computerId}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!response.ok) return null;
  const state = (await response.json()) as ControlState;
  answered.set(computerId, state);
  for (const listener of answerListeners.get(computerId) ?? []) {
    listener(state);
  }
  return state;
}

/**
 * The control state, or the fact that there is no control surface at all.
 *
 * A deployment without a computer does not mount these routes, so every read is a 404 — a different
 * fact from a transient failure, and one the caller should stop asking about rather than retry every
 * second forever. `absent` says so; `state: null` alone still means "try again shortly".
 */
export async function readControl(
  computerId: string,
): Promise<{ state: ControlState | null; absent: boolean }> {
  const response = await fetch(`/api/computers/${computerId}/control`, {
    credentials: "include",
  });
  if (response.status === 404) return { state: null, absent: true };
  if (!response.ok) return { state: null, absent: false };
  return {
    state: (await response.json()) as ControlState,
    absent: false,
  };
}

/** Close what the Bot asked for: 다 했어요, or 건너뛰기 once the waiting turn has been told. */
export function releaseControl(computerId: string) {
  return callControl(computerId, "/control/release", { method: "POST" });
}

/**
 * Supply a secret synchronously and never echo the value back to the UI.
 */
export async function supplySecret(
  computerId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`/api/computers/${computerId}/human/secret`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => null)) as {
      code?: string;
    } | null;
    return {
      ok: false,
      error: refusalText(
        SECRET_REFUSALS,
        body?.code,
        t("That could not be sent to the page. Try again."),
      ),
    };
  } catch {
    return {
      ok: false,
      // Under the box a person is typing a password into, so in their language as well.
      error: t("The Bot's computer could not be reached."),
    };
  }
}

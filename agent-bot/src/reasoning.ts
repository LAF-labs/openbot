/**
 * The model's reasoning on a turn that called a tool, carried to the requests after it.
 *
 * WHY. Xiaomi's MiMo docs (OpenAI API compatibility, Deep Thinking) say that in thinking mode an
 * assistant message with tool calls must keep its `reasoning_content` in every later request, turns
 * after it included — on the direct API a missing one is a 400, and through OpenRouter it is a
 * quieter model. OpenRouter's documented way in is `reasoning_details` on the assistant message,
 * passed back unmodified ("Preserving reasoning blocks", reasoning-tokens docs); it forwards them to
 * the provider as that provider's own field. Measured 2026-09-25 on both of MiMo's providers: a
 * passed-back block reaches the prompt (+8 tokens for an 8-token thought), and it is still rendered
 * after a later user message, so the prefix a provider cached stays the prefix it is sent.
 *
 * WHAT IT CHANGES, BY PROVIDER (measured the same day, the real stack's request replayed). Xiaomi
 * already restores the reasoning of a call it minted when the call comes back under that id —
 * stripped and passed back read the same prompt tokens (897 / 897), and a renamed id read 888 / 897.
 * DeepInfra, the fallback, does not (872 / 881). So on Xiaomi the rendered prompt, and its cache, are
 * what they were; on DeepInfra this is the only way the reasoning arrives; and neither depends on how
 * long Xiaomi keeps its own copy, which nothing documents.
 *
 * HOW IT TRAVELS. This service holds nothing between runs, and a tool the surface executes ends the
 * run, so the reasoning rides the conversation: AG-UI's `REASONING_ENCRYPTED_VALUE` attaches it to
 * the assistant message as `encryptedValue`, the client keeps it there and sends it back with the
 * next run's input, and the thread store files it with the message like any other field. The value
 * is not encrypted — AG-UI's name is for what a provider hands out opaque; this one is readable
 * text and is stored where the transcript it came from is.
 *
 * Only turns that called a tool carry it: that is what both documents ask for, and a text answer's
 * reasoning is never read again. Handed back to the model that wrote it and no other — a thought in
 * one model's format is not the next model's input, and a model change starts a new prefix anyway.
 */

/** One entry of OpenRouter's `reasoning_details`, as its SDK types them. */
export type ReasoningDetail = {
  type: string;
  text?: string;
  summary?: string;
  data?: string;
  signature?: string | null;
  format?: string;
  id?: string | null;
  index?: number;
  [key: string]: unknown;
};

/**
 * One chunk's `reasoning_details`, merged into what came before — exactly as OpenRouter's own AI SDK
 * provider does it (`@openrouter/ai-sdk-provider` 3.1.0, `doStream`): consecutive `reasoning.text`
 * fragments join into one block, their first signature and format kept; consecutive summaries join
 * the same way; anything else (`reasoning.encrypted`) is kept as it came. The stream sends a
 * thought a few words at a time (measured: MiMo, one `reasoning.text` per fragment, index 0), and
 * handing back hundreds of fragments would be sending back something the model never wrote.
 */
export function mergeReasoningDetails(
  accumulated: ReasoningDetail[],
  incoming: unknown,
): void {
  if (!Array.isArray(incoming)) return;
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    const detail = raw as ReasoningDetail;
    if (typeof detail.type !== "string") continue;
    const last = accumulated.at(-1);
    if (detail.type === "reasoning.text" && last?.type === "reasoning.text") {
      last.text = (last.text ?? "") + (detail.text ?? "");
      last.signature = last.signature || detail.signature;
      last.format = last.format || detail.format;
      continue;
    }
    if (
      detail.type === "reasoning.summary" &&
      last?.type === "reasoning.summary"
    ) {
      last.summary = (last.summary ?? "") + (detail.summary ?? "");
      last.format = last.format || detail.format;
      continue;
    }
    accumulated.push({ ...detail });
  }
}

type Carried = { model: string; reasoning_details: ReasoningDetail[] };

/** The reasoning as it rides the assistant message: which model wrote it, and what it wrote. */
export function carriedReasoning(
  model: string,
  details: readonly ReasoningDetail[],
): string | null {
  if (details.length === 0) return null;
  const carried: Carried = { model, reasoning_details: [...details] };
  return JSON.stringify(carried);
}

/**
 * What goes back to the provider for a message carrying `encryptedValue`: its `reasoning_details`
 * if this model wrote them, and nothing otherwise. Anything unreadable is nothing — a value this
 * service did not write, or wrote in a shape it no longer knows, must never become a 400.
 */
export function reasoningDetailsOf(
  encryptedValue: unknown,
  model: string,
): ReasoningDetail[] | null {
  if (typeof encryptedValue !== "string" || !encryptedValue) return null;
  try {
    const parsed = JSON.parse(encryptedValue) as Partial<Carried>;
    if (!parsed || parsed.model !== model) return null;
    const details = parsed.reasoning_details;
    if (!Array.isArray(details) || details.length === 0) return null;
    return details.every(
      (detail) =>
        detail && typeof detail === "object" && typeof detail.type === "string",
    )
      ? details
      : null;
  } catch {
    return null;
  }
}

/**
 * What a person's message actually says, when its content is not a plain string.
 *
 * AG-UI 0.0.57 types a user message's `content` as `string | InputContentPart[]`, where a part is
 * `{type:"text"}` or `{type:"image"}`. Every other role is a plain string. Both AG-UI services read
 * that field with `String(message.content ?? "")`, which is right for the string case and SILENTLY
 * WRONG for the other: `String([{type:"text",…}])` is `"[object Object]"`. Nothing throws, nothing
 * logs, and the model is handed a sentence nobody wrote.
 *
 * This is the floor, not the feature. Nothing in this product produces array content yet, so an
 * image part is named rather than sent — sending one means a provider-shaped content array, and
 * that belongs in the change that lets somebody attach a picture in the first place, where it can
 * be tested against a real provider. Naming it keeps "what is this?" from arriving as an empty
 * question.
 *
 * In `shared/` because it is a reading of the AG-UI contract rather than one service's code. It had
 * a second reader until 2026-08 — an upstream LangGraph runtime, deleted with the rest of the
 * per-Bot container plane — and a Bot that answered differently depending on which runtime read the
 * message is the failure it exists to prevent, whenever there is a second one again.
 */

/**
 * One part of a user's message, in the shape AG-UI's `InputContentSchema` produces.
 *
 * `text` is the only part read. Everything else AG-UI 0.0.57 allows — image, audio, video,
 * document, binary — is named by its kind rather than typed out in full, because this file does
 * not send any of them and a type that enumerated their sources would be a promise of support it
 * does not keep.
 */
type InputPart =
  | { type: "text"; text: string }
  | { type: string; source?: unknown; metadata?: unknown };

export type MessageContent = string | InputPart[] | null | undefined;

/**
 * The readable text of a message. Anything that is not text is NAMED, never stringified and never
 * dropped — "[image]" or "[audio]" keeps "what is this?" from arriving as an empty question.
 */
export function textOf(content: MessageContent): string {
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((part) =>
      part.type === "text" ? (part as { text: string }).text : `[${part.type}]`,
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

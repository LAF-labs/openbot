/**
 * A snapshot as the model reads it: one line per thing it can act on.
 *
 * The browser and this server keep the element objects — the gateway judges a click by the element's
 * role and name, and masks secret fields on them — but the model was handed those objects too, as
 * JSON: `{"ref":"e3","role":"link","name":"본문 바로가기"}`, the key names repeated two hundred
 * times. A Naver news snapshot was 9,819 characters of that (agent-harness-review §5, R10). The same
 * facts as `e3 link 본문 바로가기` are the line format Playwright MCP's own snapshots use
 * (`- link "본문 바로가기" [ref=e3]`), shorter still.
 *
 * Both paths that hand a snapshot to a model come through here: the surface's `/snapshot` route and
 * the routine executor. Nothing about what the gateway decides changes.
 */
import { readableName } from "../../../shared/element-label";
import type { SnapshotElement, SnapshotResult } from "./schema";

/**
 * A name longer than this is cut on the model's side only. A headline is a hundred characters and
 * its first sixty are enough to choose it; the gateway still reads the whole name before a click.
 */
const NAME_CHARS = 60;

export function elementLine(element: SnapshotElement): string {
  // Letter-spacing closed up and a name said twice said once (`shared/element-label.ts`): the
  // model reads the words a person would, and "앱 다 운 로 드 앱 다 운 로 드" is neither.
  const flat = readableName(element.name);
  const name =
    flat.length > NAME_CHARS ? `${flat.slice(0, NAME_CHARS - 1)}…` : flat;
  const parts = [element.ref, element.role];
  if (name) parts.push(name);
  if (element.value !== undefined) {
    parts.push(`= ${JSON.stringify(element.value.replace(/\s+/g, " "))}`);
  }
  if (element.type === "password") parts.push("(password)");
  if (element.checked === true) parts.push("[checked]");
  if (element.checked === false) parts.push("[unchecked]");
  if (element.disabled) parts.push("[disabled]");
  return parts.join(" ");
}

export type ModelSnapshot = Omit<
  SnapshotResult,
  "elements" | "truncated" | "opaqueFrames"
> & {
  /** One element per line, `ref role name`, in page order. */
  elements: string;
  /** How many lines, for the surface's card; the model has the lines. */
  count: number;
  truncated?: true;
  opaqueFrames?: number;
};

/**
 * The snapshot, as sent to a model. What is always false or zero is left out, so a field present
 * means something happened: `truncated` only when elements were cut, `opaqueFrames` only when a
 * frame could not be seen into.
 */
export function snapshotForModel(result: SnapshotResult): ModelSnapshot {
  const { elements, truncated, opaqueFrames, ...rest } = result;
  return {
    ...rest,
    elements: elements.map(elementLine).join("\n"),
    count: elements.length,
    ...(truncated ? { truncated: true as const } : {}),
    ...(opaqueFrames ? { opaqueFrames } : {}),
  };
}

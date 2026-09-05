import type { AllowanceScope } from "@/lib/approvals";
import { t } from "@/lib/i18n";

/**
 * What the wider button promises, in the words of the thing it actually covers.
 *
 * Written here rather than sent from the server, which speaks English: this is the sentence somebody
 * is consenting to, so it has to be in the language they read. The server sends the two facts —
 * which kind of thing, and which one — and the surface owns the words, as `lib/approvals.ts` says.
 *
 * Shared by the two cards on purpose. A one-to-one chat draws the question on the tool call's line
 * and a room draws it above the composer, and the same press must mean the same thing on both: two
 * copies of this would drift, and the drift would be two buttons promising different amounts for
 * one grant.
 *
 * "Always allow" on its own is never enough. The same press covers one website, one file or one
 * tool depending on what the Bot was doing, and the difference between those is the whole decision.
 */
export function alwaysLabel(scope: AllowanceScope): string {
  if (scope.kind === "host") {
    return t("Always allow {site}", { site: scope.value });
  }
  if (scope.kind === "file") {
    return t("Always allow this file");
  }
  return t("Always allow this tool");
}

/**
 * The middle button: the same thing, for this conversation only.
 *
 * Names the scope for the same reason `alwaysLabel` does — the width is the decision — and names
 * the conversation because that is the whole difference between this button and the one beside
 * it. The day it also runs out after is said in the note under the buttons, not here: a button
 * that tried to say everything would say nothing legibly.
 */
export function duringLabel(scope: AllowanceScope): string {
  if (scope.kind === "host") {
    return t("Allow {site} for this conversation", { site: scope.value });
  }
  if (scope.kind === "file") {
    return t("Allow this file for this conversation");
  }
  return t("Allow this tool for this conversation");
}

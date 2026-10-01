/**
 * What the model is told when a gallery card goes on screen, and what a card reads for itself.
 *
 * These were written beside each component in the app (`components/gallery/*.tsx`), which was the
 * only place a card's call was ever carried out. A turn the server owns carries it out on the
 * server (`server/src/turns/chat-tools.ts`), and a Bot must read the same sentence whichever side
 * did — so the sentences live here, and the gallery specs name them from here.
 */

/** The sentence a card's call answers the model with, by the card's name. */
export const GALLERY_CONFIRMATIONS: Readonly<Record<string, string>> = {
  showRecord: "The record is now on screen for the person.",
  showMetrics: "The figures are now on screen for the person.",
  showChecklist: "The checklist is now on screen for the person.",
  showNotice: "The notice is now on screen for the person.",
  showBarChart: "The bar chart is now on screen for the person.",
  showPieChart: "The donut chart is now on screen for the person.",
  showLineChart: "The line chart is now on screen for the person.",
  showAreaChart: "The area chart is now on screen for the person.",
  showProgress: "The progress chart is now on screen for the person.",
  showConnection:
    "The switches this deployment offers are on screen; one it does not offer is left out, so name the services only as switches to turn on, not as shown. Nothing is connected until the person turns one on, so do not say it is connected.",
  showActivityReport:
    "The report is on screen for the person, filled with figures read from this deployment. You were not given the figures.",
  showFile:
    "The file card is on screen for the person, with its name, its size and a button to download it. Do not paste the file's contents into your answer again.",
};

/**
 * The card that hands the person a file from the Bot's folder (`components/gallery/file.tsx`).
 *
 * Named here because it is the one card whose confirmation is conditional: the sentence above is
 * only true of a file that is there, so a turn checks before it says it
 * (`server/src/turns/chat-tools.ts`), and a refused one is not filed under 만든 것.
 */
export const FILE_CARD = "showFile";

/** What a card that is not in the table above — a component authored in the browser — answers. */
export const ON_SCREEN = "It is now on screen for the person.";

/**
 * The cards whose call IS a question to the person: the call waits for their answer, and the answer
 * is its result. No confirmation, because there is nothing to confirm until somebody chooses.
 */
export const GALLERY_DECISIONS: ReadonlySet<string> = new Set([
  "askApproval",
  "askChoice",
]);

/** Which server-side function each activity report reads. Not the model's choice. */
export const ACTIVITY_REPORT_FUNCTIONS: Readonly<Record<string, string>> = {
  activity: "botActivity",
  refusals: "recentRefusals",
};

/**
 * The data functions a card's call will read, checked against the card's grants before it is
 * drawn. Only the activity report reads anything; every other card draws what it was handed.
 */
export function galleryReads(
  name: string,
  args: Record<string, unknown>,
): readonly string[] {
  if (name !== "showActivityReport") return [];
  const report = typeof args.report === "string" ? args.report : undefined;
  const functionName = report ? ACTIVITY_REPORT_FUNCTIONS[report] : undefined;
  return functionName ? [functionName] : [];
}

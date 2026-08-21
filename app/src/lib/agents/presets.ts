/**
 * A Bot you could have, described in one line.
 *
 * Creating a colleague from an empty form asks somebody to invent a job title and a paragraph of
 * standing instructions before they have seen the product do anything. These are the jobs people
 * actually hand to a Bot first — the morning digest and the inbox are the two the field reports
 * name most often — written out so that picking one fills the form and the next click is Get
 * started.
 *
 * Not templates in any deeper sense: a preset writes three fields and then it is gone. What it
 * produces is an ordinary Bot, editable like any other.
 */
export type AgentPreset = {
  id: string;
  /** The face it arrives wearing. A tile id from mascot-art. */
  avatarSeed: string;
  name: string;
  title: string;
  roleDescription: string;
};

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: "night-shift",
    avatarSeed: "r2c4",
    name: "Night Shift",
    title: "Overnight prep",
    roleDescription:
      "Work overnight and have a digest ready by morning: what arrived, what changed, and the two or three things worth my attention first.",
  },
  {
    id: "inbox-triage",
    avatarSeed: "r1c6",
    name: "Inbox Triage",
    title: "Email",
    roleDescription:
      "Sort my email into what needs me, what can wait, and what is noise. Draft replies in my voice for the ones that need one, and never send without asking.",
  },
  {
    id: "meeting-prep",
    avatarSeed: "r0c2",
    name: "Meeting Prep",
    title: "Calendar",
    roleDescription:
      "Before each meeting, gather what I need: who is coming, what we said last time, and any document that has changed since. One page, no longer.",
  },
  {
    id: "receipts",
    avatarSeed: "r3c2",
    name: "Expense Manager",
    title: "Finance operations",
    roleDescription:
      "Review receipts, categorise expenses and prepare reimbursement reports. Flag anything that looks duplicated or out of policy rather than filing it.",
  },
] as const;

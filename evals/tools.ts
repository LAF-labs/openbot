/**
 * The product's tools, as the surface actually sends them to a Bot.
 *
 * Names, descriptions and parameter schemas mirror the live registrations —
 * `app/src/lib/copilot/self-tools.tsx` and `app/src/lib/copilot/computer-tools.tsx` —
 * because that wording is half of what is being measured: the remember/update_state
 * split exists in those descriptions, and an eval that paraphrases them certifies a
 * product that does not exist. When a registration changes, change this with it.
 */

type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required });

export const REMEMBER: Tool = {
  name: "remember",
  description:
    "Record one durable fact about the person you work for, so you still know it in later " +
    "conversations. This is the tool for anything they ask you to remember. Use it for things " +
    "that stay true — how their business runs, its hours, who they deal with, their standing " +
    "preferences about how they want things done. One fact per call, in your own words. NOT for " +
    "a duty they hand YOU — 'take charge of X' is a change to your own job, and your name, job " +
    "and routines are `update_state`. " +
    "Do not record passwords, card numbers, or anything they typed into a login.",
  parameters: object(
    {
      fact: {
        type: "string",
        description:
          "The one thing to remember, written as a short sentence to your future self",
      },
    },
    ["fact"],
  ),
};

export const UPDATE_STATE: Tool = {
  name: "update_state",
  description:
    "Change what you ARE: your own profile, or the routines you run on a schedule. " +
    "Use it when the person tells you what you are for or asks for something regular. " +
    "A duty handed to you — 'take charge of X', 'from now on you handle X' — is what you are " +
    "FOR, so it belongs here even when it sounds like something to remember. " +
    "NOT for facts you learn about them — their hours, their suppliers, their preferences go to " +
    "`remember`, which is what you KNOW rather than what you are. Send only what changes. " +
    "This edits you and no one else.",
  parameters: object(
    {
      target: {
        type: "string",
        enum: ["profile", "routine"],
        description:
          "'profile' for who you are — your name, your job, how hard you think. 'routine' ONLY when they named an actual schedule (a time, a day, an interval); a duty with no time attached is your profile, not a routine",
      },
      action: {
        type: "string",
        enum: ["set", "create", "delete", "pause", "resume"],
        description:
          "For routine: create, delete, pause or resume. For profile: set (the default).",
      },
      name: {
        type: "string",
        description: "Your new name, or the routine's name when creating one",
      },
      description: {
        type: "string",
        description:
          "What you are for, in a sentence or two, written as your standing role",
      },
      title: {
        type: "string",
        description: "A short role label, such as 'Finance operations'",
      },
      instruction: {
        type: "string",
        description:
          "What the routine does every time it fires, written to your future self",
      },
    },
    ["target"],
  ),
};

export const NAVIGATE: Tool = {
  name: "computer_navigate",
  description:
    "Open a web page on your own computer so the person can watch. Use this when asked to look " +
    "at, visit, open or check a website. Returns the page title and its readable text, so answer " +
    "from what comes back rather than telling the person to go and look.",
  parameters: object(
    {
      url: {
        type: "string",
        description: "Full web address to open, including https://",
      },
    },
    ["url"],
  ),
};

export const SNAPSHOT: Tool = {
  name: "computer_snapshot",
  description:
    "List every field, button and link on the current page with a ref you can act on. Call this " +
    "before computer_type or computer_click, and again whenever the page changes.",
  parameters: object({}),
};

export const TYPE: Tool = {
  name: "computer_type",
  description:
    "Enter text into a field on the page. Give the ref of the field from your most recent " +
    "snapshot and the snapshotId it came from. This replaces whatever the field already contains. " +
    "Set submit to true to press Enter afterwards.",
  parameters: object(
    {
      ref: {
        type: "string",
        description: "Ref of the field, from your most recent snapshot",
      },
      snapshotId: {
        type: "number",
        description: "The snapshotId that ref came from",
      },
      text: { type: "string", description: "The text to enter" },
      submit: {
        type: "boolean",
        description: "Press Enter after typing, to submit a single-field form",
      },
    },
    ["ref", "snapshotId", "text"],
  ),
};

export const CLICK: Tool = {
  name: "computer_click",
  description:
    "Click something on the page: a button, a link, a checkbox or a radio option. Give the ref " +
    "from your most recent snapshot and the snapshotId it came from.",
  parameters: object(
    {
      ref: {
        type: "string",
        description:
          "Ref of the element to click, from your most recent snapshot",
      },
      snapshotId: {
        type: "number",
        description: "The snapshotId that ref came from",
      },
    },
    ["ref", "snapshotId"],
  ),
};

export const REQUEST_SECRET: Tool = {
  name: "computer_request_secret",
  description:
    "Ask the person for ONE value you must not be told: a password, a one-time code, a card number. " +
    "Focus the field first with computer_click, then call this with the ref of that field and a " +
    "short label for what you need. They type it into a masked box that goes straight to the page. " +
    "You will never see the value, and you must not ask for it any other way. Prefer this over a " +
    "full takeover when you only need one field filled in. The value is only TYPED into the field: " +
    "if the form needs submitting, do that yourself afterwards with computer_click.",
  parameters: object(
    {
      label: {
        type: "string",
        description:
          "What you need, in a few words, e.g. 'the code sent to your phone'",
      },
      ref: {
        type: "string",
        description:
          "Ref of the field it goes in, from your most recent snapshot",
      },
      snapshotId: {
        type: "number",
        description: "The snapshotId that ref came from",
      },
    },
    ["label", "ref", "snapshotId"],
  ),
};

export const REQUEST_HELP: Tool = {
  name: "computer_request_help",
  description:
    "Ask the person to take control of your computer and do something you cannot: sign in, enter a " +
    "password or a one-time code, or clear a CAPTCHA. Say specifically what you need done. They " +
    "will drive the browser themselves and hand it back, and you carry on in the same session. " +
    "Use this INSTEAD of giving up, and instead of ever asking them to type a password to you.",
  parameters: object(
    {
      reason: {
        type: "string",
        description:
          "What you need the person to do, in one sentence, e.g. 'This page is asking for a code sent to your phone.'",
      },
    },
    ["reason"],
  ),
};

export const LIST_FILES: Tool = {
  name: "computer_list_files",
  description:
    "List what is in your workspace: every file and folder you have saved, with sizes. Call this " +
    "FIRST when you are asked what files you have, or before reading a file whose exact name you " +
    "are not sure of. Never guess a filename.",
  parameters: object({
    path: {
      type: "string",
      description: "Optional folder to list. Omit for the whole workspace.",
    },
  }),
};

export const READ_FILE: Tool = {
  name: "computer_read_file",
  description:
    "Read a file you saved earlier in your own workspace. Paths are relative to your workspace, " +
    "such as notes.md or reports/august.csv. Your workspace survives between conversations, so use " +
    "this to pick up notes you made before.",
  parameters: object(
    {
      path: {
        type: "string",
        description: "Path relative to your workspace, such as notes.md",
      },
    },
    ["path"],
  ),
};

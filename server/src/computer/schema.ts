/**
 * The computer-use contract.
 *
 * One place that says what a tool call looks like, so neither the surface nor the computer has to
 * read the other's code to find out. Changing a name or a parameter here is a breaking change for
 * both sides: add, do not repurpose.
 *
 * The read-only tools sit alongside the acting ones, and every acting tool goes through the gateway,
 * so each is policy checked and written to the audit trail before it runs. Names are never
 * repurposed: this file only ever grows.
 */

/*
 * THE TOOL NAME LISTS THAT USED TO BE HERE ARE GONE.
 *
 * `COMPUTER_TOOLS`, `COMPUTER_ACTING_TOOLS` and `isActingTool` had no importers at all — the
 * gateway hardcodes the name in each method, which is the thing that actually decides — so they
 * were a contract nobody was held to, and it had already drifted: `computer_screenshot` was listed
 * as a tool and registered nowhere in the product. What a Bot may call now has exactly one source,
 * `shared/tools/computer.ts`, which the surface, the unattended loop and the eval pack all read.
 *
 * The wire shapes below are still the contract between the two services and stay here.
 */

export type NavigateInput = { url: string };
export type NavigateResult = {
  url: string;
  title: string;
  /**
   * The readable text of the page, truncated.
   *
   * Navigation returns content because a Bot that can open a page but not read it can only answer
   * "I opened it, go and look yourself", which is worse than not having the tool: the person asked
   * a question and got homework. The screenshot is for the human to watch; this is what the Bot
   * reads. They are not interchangeable, and a picture is not something a model should be made to
   * squint at to answer "what is the top story".
   */
  text: string;
  /** True when the page was longer than the extract, so the Bot can say so rather than guess. */
  truncated: boolean;
  /**
   * The iframes whose text was merged in, and the ones that would not answer.
   *
   * A Korean site puts its real content in an iframe more often than not. `code:
   * "laf:frame_opaque"` marks one that could not be read — a payment or 본인인증 window, usually —
   * which is a different fact from there being nothing in it.
   */
  frames?: { url: string; chars: number; code?: string }[];
  /** Wall-clock ms the navigation took, for the progress line in the transcript. */
  elapsedMs: number;
  notes?: ComputerNote[];
};

export type ScreenshotResult = {
  /** PNG, base64. The transcript renders it; nothing else interprets it. */
  base64: string;
  width: number;
  height: number;
  capturedAt: string;
  /**
   * The page this is a picture of, or `about:blank` for a browser that has not been sent anywhere.
   *
   * Optional because it was added after the first computers shipped, and an agent-computer that has
   * not been redeployed does not send it. Treat a missing value as "some page", never as blank: the
   * failure that matters is a real screenshot being hidden behind a placeholder.
   */
  url?: string;
};

/** The current page as text, without opening anything. Same shape as a navigation, minus the trip. */
export type ReadResult = Omit<NavigateResult, "elapsedMs">;

/**
 * One thing on the page a Bot can act on.
 *
 * This is the accessibility-tree view, not the pixels: a Bot fills in a form by reading a list of
 * labelled fields and naming one, which is why form-filling needs no vision model. See the build
 * doc's open decision 2 (accessibility tree first, pixels as fallback).
 */
export type SnapshotElement = {
  /** Opaque handle, valid only for the snapshot that produced it. Never construct one. */
  ref: string;
  /** ARIA role where the page declares one, otherwise the tag name. */
  role: string;
  /** What a person reads as this control's label, resolved the way a screen reader resolves it. */
  name: string;
  /** Current contents, for form controls. Lets a Bot tell an empty field from a filled one. */
  value?: string;
  /** An `input`'s type, so a Bot does not try to type into a checkbox. */
  type?: string;
  disabled?: boolean;
  checked?: boolean;
};

/**
 * One tab the Bot's browser has open.
 *
 * Mirrors `TabSummary` in `agent-computer/src/profiles.ts`, duplicated for the same reason
 * `SnapshotElement` is: two deployables with no code in common.
 */
export type TabSummary = {
  /** Position in the browser's own list. What `computer_switch_tab` takes. */
  index: number;
  title: string;
  url: string;
  /** The one the next action lands on. */
  active: boolean;
};

/**
 * Something the browser noticed that nothing asked about.
 *
 * A dialog the page opened, a file it downloaded, a secret request lost to a restart. Each is a
 * `code` and its facts — never a sentence: the Korean a model reads is looked up from the code in
 * `shared/prompt/tool-results.ko.ts`, and the words a person reads come from `t()`.
 */
export type ComputerNote = { code: string } & Record<string, unknown>;

export type SnapshotResult = {
  /**
   * Which snapshot these refs belong to. Must be sent back with every action.
   *
   * This field makes refs from superseded snapshots refusals instead of actions.
   * A page that re-rendered between the snapshot and the click has moved its controls, and the
   * failure mode without this check is not an error, it is clicking the wrong button.
   */
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  /** True when the page had more interactive elements than the snapshot describes. */
  truncated: boolean;
  /**
   * Every tab, so a Bot can see the one a `target=_blank` link just opened.
   *
   * Optional because a computer that has not been redeployed does not send it; an absent list means
   * "this computer does not report tabs", never "there is only one".
   */
  tabs?: TabSummary[];
  /** Anything the browser noticed since the last call. See {@link ComputerNote}. */
  notes?: ComputerNote[];
};

export type SwitchTabInput = { index: number };
export type SwitchTabResult = {
  action: "switch_tab";
  index: number;
  tabs: TabSummary[];
  url: string;
  notes?: ComputerNote[];
};

/** A file from the Bot's own workspace, handed to a file input on the page. */
export type UploadFileInput = ActionTarget & { path: string };
export type UploadFileResult = {
  action: "upload_file";
  ref: string;
  /** As the Bot named it, relative to its workspace. Never the path inside the container. */
  path: string;
  url: string;
  element?: { role: string; name: string };
  notes?: ComputerNote[];
};

/** Common to every acting call: which element, and which snapshot the ref came from. */
export type ActionTarget = { ref: string; snapshotId: number };

export type ClickInput = ActionTarget;
export type TypeInput = ActionTarget & {
  text: string;
  /** Press Enter afterwards. How a Bot submits a single-field form without hunting for the button. */
  submit?: boolean;
};
export type KeyInput = Partial<ActionTarget> & { key: string };
export type ScrollInput = { deltaY?: number };

/**
 * What an action reports back.
 *
 * Typed text is absent. This value is read by the model and written to the
 * audit trail, and the contents of a form field is exactly where a password, a card number or a
 * one-time code lives. The caller already knows what it sent, so echoing it buys nothing and puts a
 * secret into two places that keep it. `characters` is enough to confirm the field was filled.
 */
export type ActionResult = {
  action: "click" | "type" | "key" | "scroll";
  ref?: string;
  /**
   * The label of the element acted on, as the gateway resolved it.
   *
   * The ref is an internal handle, so the response carries the readable element label.
   */
  element?: { role: string; name: string };
  /** For `type`: how much was entered, never what. */
  characters?: number;
  submitted?: boolean;
  key?: string;
  deltaY?: number;
  /** Where the page ended up, which is how a Bot notices that its click navigated. */
  url: string;
  elapsedMs: number;
  /**
   * What the browser noticed while this ran.
   *
   * A click that opens `alert("로그인이 필요합니다")` returns exactly as a click that did nothing:
   * Playwright answers the dialog before the call comes back. The reason rides here.
   */
  notes?: ComputerNote[];
};

/** Absent path means the whole workspace. */
export type ListFilesInput = { path?: string };

/** One thing in the workspace. Folders included, so a Bot can see the shape, not just the leaves. */
export type WorkspaceEntry = {
  /** Relative to the workspace root, which is the only form a request may use. */
  path: string;
  kind: "file" | "folder";
  bytes?: number;
};

export type ListFilesResult = {
  path: string;
  entries: WorkspaceEntry[];
  /** True when there was more in the workspace than the listing describes. */
  truncated: boolean;
};

export type ReadFileInput = { path: string };
export type ReadFileResult = {
  path: string;
  text: string;
  /** True when the file was longer than the extract, so the Bot can say so rather than guess. */
  truncated: boolean;
  /** The file's real size, even when the text was cut. */
  bytes: number;
};

export type WriteFileInput = {
  path: string;
  contents: string;
  /** Add to the end instead of replacing, for a Bot keeping a running log. */
  append?: boolean;
};

/**
 * What a write reports back.
 *
 * The contents are not echoed, for the same reason typed text is not: a Bot may well be saving
 * something it was told in confidence, and a value repeated into the transcript and the audit trail
 * now lives in three places instead of one.
 */
export type WriteFileResult = {
  path: string;
  bytes: number;
  appended: boolean;
};

/**
 * Who is driving the computer.
 *
 * The expand overlay is where control lands. One browser, two possible drivers, never at once: while a person holds the wheel every acting call from the Bot
 * is refused rather than queued, because a queued click arrives after the person has moved on.
 */
export type ControlHolder = "bot" | "human";

export type ControlState = {
  holder: ControlHolder;
  /** ISO timestamp of the last handover, so the surface can say how long this has been going on. */
  since: string;
  /** Why the Bot asked for help, in its own words. Shown to the person being handed the wheel. */
  reason?: string;
  /** The Bot has asked and nobody has taken over yet. */
  requested: boolean;
  /** What the Bot asked a person to type, in the Bot's own words. Present while a request is open. */
  secretWanted?: string;
  /** The field it goes in, as a ref from the snapshot the request named. */
  secretRef?: string;
  /**
   * Where that field is, as THIS SERVER resolved it — never as the Bot described it.
   *
   * `secretWanted` is a label the model wrote, and a model steered by a page can write "네이버
   * 비밀번호" above a box on any site at all. The host and the control's own label are the facts a
   * person needs beside it, and they come from the snapshot this process took, so the masked box
   * can say which page is asking.
   */
  secretInto?: { host: string; element: { role: string; name: string } };
};

/**
 * A value the Bot needs and must not be told: a password, a one-time code.
 *
 * `label` is what the person is asked for, and it is the only part of this that is ever stored or
 * recorded. `ref` names the field it goes in, because a secret typed into whatever happens to have
 * focus goes nowhere when nothing does, and reports success while doing it.
 */
export type SecretRequest = { label: string; ref: string; snapshotId: number };

/**
 * What supplying a secret reports back.
 *
 * `characters` and nothing else. The value is not returned, not logged and not audited: the point of
 * the whole mechanism is that it exists in one place, the page it was typed into.
 */
/**
 * One Bot's computer, as the admin surface lists it.
 *
 * A Bot that has a profile has a computer, whether or not a browser is running for it this second.
 * That distinction is the point of the page: "not running" is the normal resting state of a computer
 * nobody is using, and it is not a fault.
 */
export type ComputerProfile = {
  botId: string;
  running: boolean;
  startedAt: string | null;
  /**
   * The host its traffic leaves through, or null for direct.
   *
   * Host only. A proxy is usually handed out as a URL with credentials in it, and this field is
   * read by people and rendered in a browser.
   */
  egress: string | null;
};

export type SecretResult = {
  supplied: boolean;
  characters: number;
  url: string;
};

/** What a person did with their mouse or keyboard. Coordinates are viewport pixels. */
export type HumanInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; deltaY?: number };

/**
 * What a person's input reports back.
 *
 * Never the text. A takeover exists so a person can type the thing the Bot must not have, a password,
 * a one-time code. That value goes from their keyboard to the browser and stops; it is not returned
 * here, not written to the audit trail, and not on any path the model can read.
 */
export type HumanInputResult = {
  action: "human_click" | "human_type" | "human_key" | "human_scroll";
  characters?: number;
  key?: string;
  deltaY?: number;
  url: string;
};

/** Lifecycle states a Bot's computer can be in, as the UI must render them. */
export const COMPUTER_STATES = [
  "absent",
  "starting",
  "ready",
  "unreachable",
] as const;

export type ComputerState = (typeof COMPUTER_STATES)[number];

export type ComputerStatus = {
  botId: string;
  state: ComputerState;
  /** Set when state is "unreachable", in words a person can act on. */
  reason?: string;
};

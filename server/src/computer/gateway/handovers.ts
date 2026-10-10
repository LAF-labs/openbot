/**
 * A person and the Bot's browser: answering what it asked, stopping it, wiping it.
 *
 * NOT TAKING THE WHEEL. A person could take over the Bot's browser until 2026-10-09; the owner ended
 * that on every surface, so nobody clicks or types on its page but the Bot, and a value a page needs
 * reaches it only through the masked box (`secrets.ts`). Rows from before still say
 * `computer.control_taken`, and the trail keeps them.
 *
 * Apart from the acting calls because none of these goes through `govern`, and that is a decision
 * rather than an omission (see `requestHelp`). A reader checking that every Bot action is judged
 * reads `acts.ts`; a reader checking that every person's reach into a browser is recorded reads this.
 */
import type { AuditStore } from "../../audit";
import { computerIdOf } from "../bot-id";
import type { ComputerClient } from "../client";
import type { ActionActor } from "./caller";
import type { Secrets } from "./secrets";
import type { SnapshotCache } from "./snapshots";
import { writeControlEvent } from "./trail";

export function createHandovers(deps: {
  client: ComputerClient;
  /** The computer, addressed as the Bot that is asking. See `createComputerGateway`. */
  as: (computerId: string, botId?: string) => ComputerClient;
  auditStore: AuditStore;
  secrets: Pick<
    Secrets,
    | "forgetTypedInto"
    | "targetOf"
    | "valuesSeen"
    | "valuesLetGo"
    | "holdsValues"
  >;
  snapshots: Pick<SnapshotCache, "forget">;
}) {
  const { client, as, auditStore, secrets, snapshots } = deps;

  return {
    /**
     * The Bot asking a person for a hand, recorded but not policy-gated.
     *
     * The policy constrains what a Bot may do; asking a person is not doing anything, and a rule able
     * to stop a Bot from saying it is stuck would hide the very moments a person most needs to know
     * about. So this writes the row and does not ask. What a hand is, now that nobody takes the
     * wheel: something done outside the Bot's screen — a phone to approve on, an app to confirm in.
     */
    async requestHelp(
      computerId: string,
      botId: string,
      actor: ActionActor,
      reason: string,
    ) {
      const state = await as(computerId, botId).requestControl(reason);
      await writeControlEvent(auditStore, "computer.help_requested", {
        botId,
        actor,
        computerId,
        reason,
      });
      return state;
    },

    /**
     * A person answering the ask: 다 했어요, or 건너뛰기 (which the surface tells the waiting turn
     * first). The row keeps its old name, `computer.control_released`, because the trail is
     * append-only and readers of it already know that name; it now records an answer, not a hand-back.
     */
    async releaseControl(
      computerId: string,
      botId: string,
      actor: ActionActor,
    ) {
      const state = await as(computerId, botId).releaseControl();
      await writeControlEvent(auditStore, "computer.control_released", {
        botId,
        actor,
        computerId,
      });
      return state;
    },

    async control(botId: string) {
      const said = await as(botId).control();
      // What this server may have forgotten by starting again (`secrets.ts`, `valueRuns`). Read
      // off what the COMPUTER said: the line below adds this server's own note, and learning
      // from that would turn a page that was only read into a value to be ended.
      if (said.valuesHeld) secrets.valuesSeen(botId);
      /*
       * AND WHAT ONLY THIS SERVER KNOWS: a page showed a saved password to a run still going
       * (`secrets.ts`, `shownRuns`). The computer put nothing in and holds nothing, so it does not
       * say so — and the one reader of this field is the window deciding whether to take a
       * picture (`app/src/lib/computer/last-frame.ts`), for which the two are the same fact.
       */
      const state: typeof said = secrets.holdsValues(botId)
        ? { ...said, valuesHeld: true }
        : said;
      // The open request's target, resolved when it was made. Attached only while the request is
      // open, so a stale entry cannot describe a box that is no longer asking.
      const into = secrets.targetOf(botId);
      return state.secretWanted && into
        ? { ...state, secretInto: into }
        : state;
    },

    /**
     * The computers, for the admin surface. A read, so no audit row.
     *
     * Said, not inferred: every Bot shares the account's one browser, which looks identical on
     * every screen to each having its own — same cards, same trail, same screenshots. A reader has
     * to be told which arrangement they are looking at.
     */
    async computers() {
      return { isolation: "shared" as const, ...(await client.computers()) };
    },

    /**
     * Stop a computer's browser, keeping what it knows.
     *
     * Audited, unlike the read above, because a person reached in and stopped something. Recorded
     * whether or not a browser was actually running: "she pressed stop and nothing was running" is a
     * fact worth having, and a trail that only records effective actions cannot tell you what somebody
     * tried.
     */
    /**
     * Open a background browser for this Bot, under a name the caller chooses (piece 5-3,
     * `agent-computer/src/browsers.ts`). `opened: false` is the computer saying it has no room:
     * an answer, for the caller to wait on or go without. The computer's id to act in it by is
     * `computerIdOf(botId, browser)`.
     */
    openBrowser(botId: string, browser: string) {
      return as(computerIdOf(botId, browser), botId).openBrowser();
    },

    /**
     * Let a background browser go: the computer closes it and throws its profile away, and what
     * this server kept about it — the last page seen there, what was typed where, a value it held
     * — is forgotten with it, so nothing later is judged against a page that no longer exists.
     */
    async releaseBrowser(botId: string, browser: string) {
      const computerId = computerIdOf(botId, browser);
      const result = await as(computerId, botId).releaseBrowser();
      snapshots.forget(computerId);
      secrets.forgetTypedInto(computerId);
      secrets.valuesLetGo(botId, computerId);
      return result;
    },

    async stopComputer(computerId: string, botId: string, actor: ActionActor) {
      const result = await as(computerId, botId).stopComputer();
      // The pages those refs named are gone, and a restarted browser counts its refs from `e1` again.
      secrets.forgetTypedInto(computerId);
      secrets.valuesLetGo(botId, computerId);
      await writeControlEvent(auditStore, "computer.stopped", {
        botId,
        actor,
        computerId,
        reason: result.wasRunning
          ? "browser was running"
          : "no browser was running",
      });
      return result;
    },

    /**
     * Wipe the computer's profile.
     *
     * The most destructive button we have. Every login on the one browser this account's Bots share
     * is gone — not just the Bot on the row somebody pressed it from — and no undo exists, so the row
     * is written whatever happens next, and it says which of those two it was.
     */
    async resetComputer(computerId: string, botId: string, actor: ActionActor) {
      const result = await as(computerId, botId).resetComputer();
      secrets.forgetTypedInto(computerId);
      secrets.valuesLetGo(botId, computerId);
      await writeControlEvent(auditStore, "computer.reset", {
        botId,
        actor,
        computerId,
        reason:
          "every saved login on this account's one computer was deleted, for all of its Bots",
      });
      return result;
    },
  };
}

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

/**
 * What opening a background browser comes to: one opened, fresh; or none — the computer has no
 * room, or the one the run before left under the name could not be let go of. Each refusal is a
 * row (`computer.browser_refused`), and the caller answers the run with the fact.
 */
export type BrowserOpened =
  | { opened: true; open: number; cap: number }
  | { opened: false; because: "no_room"; open: number; cap: number }
  | { opened: false; because: "not_let_go" };

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

  /**
   * The background browsers this process has let go of — confirmed by the computer — and not
   * opened since, by name. Nothing is open under such a name.
   *
   * A BACKGROUND BROWSER IS OPENED FRESH, OR NOT AT ALL (Codex's read of "루틴 옮기기"). The
   * computer refreshes a browser already open under a name rather than replacing it, and its idle
   * rule gives a place away only to a DIFFERENT name (`agent-computer/src/browsers.ts`, `open`,
   * `unused`) — so a routine's browser whose letting-go never reached the computer, or was not
   * waited for, was the one the next routine under that name was handed: the last run's tabs,
   * cookies and sign-ins, under a record that promises a profile thrown away with every run. So
   * an open lets go of the name first wherever this process has not confirmed a letting-go since
   * the last open: after one that failed, and at the first open of the name since this server
   * started, when what an earlier process left on the computer is not known. Letting go of
   * nothing costs one answer (`released: false`). A letting-go that fails here refuses the open:
   * the run is answered as it is when there is no room, with a row, and never handed a browser
   * that is somebody's.
   *
   * By name and not by `bot@name`, as the computer holds them: the browser is the deployment's,
   * and the run another Bot's routine left is as much the next run's to let go of.
   */
  const letGoOf = new Set<string>();
  /**
   * How many times each name has been opened here: a letting-go marks the name let go of only
   * where no open has happened since it began, so one that answers late — after the lane moved
   * on and the next run opened the name — cannot mark that run's browser as gone.
   */
  const opens = new Map<string, number>();

  /** What this server keeps about one of the Bot's browsers: forgotten with the browser. */
  const forget = (botId: string, computerId: string): void => {
    snapshots.forget(computerId);
    secrets.forgetTypedInto(computerId);
    secrets.valuesLetGo(botId, computerId);
  };

  /**
   * Let a background browser go: the computer closes it and throws its profile away, and what
   * this server kept about it — the last page seen there, what was typed where, a value it held
   * — is forgotten with it, so nothing later is judged against a page that no longer exists.
   * Throws as the computer does: a letting-go the computer did not confirm leaves the name owed,
   * and the next open lets go first (`letGoOf`).
   */
  const release = async (
    botId: string,
    browser: string,
    within?: AbortSignal,
  ) => {
    const computerId = computerIdOf(botId, browser);
    const began = opens.get(browser) ?? 0;
    const result = await as(computerId, botId).releaseBrowser(within);
    if ((opens.get(browser) ?? 0) === began) letGoOf.add(browser);
    forget(botId, computerId);
    return result;
  };

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
     * `agent-computer/src/browsers.ts`) — fresh, or not at all (`letGoOf`). `opened: false` is an
     * answer, for the caller to wait on or go without, and a row: the computer has no room, or
     * the browser the run before left under the name could not be let go of. The row carries
     * which browser, for whom, and how full — never a page or anything typed. The computer's id
     * to act in it by is `computerIdOf(botId, browser)`.
     */
    async openBrowser(
      botId: string,
      browser: string,
      actor: ActionActor,
    ): Promise<BrowserOpened> {
      const computerId = computerIdOf(botId, browser);
      const refused = async (reason: string) => {
        await writeControlEvent(auditStore, "computer.browser_refused", {
          botId,
          actor,
          computerId,
          reason,
        });
      };
      if (!letGoOf.has(browser)) {
        try {
          await release(botId, browser);
        } catch {
          await refused(
            "the browser from the run before could not be let go of",
          );
          return { opened: false, because: "not_let_go" };
        }
      }
      // Whatever an earlier run of this Bot's saw or put in there is gone with its browser.
      forget(botId, computerId);
      letGoOf.delete(browser);
      opens.set(browser, (opens.get(browser) ?? 0) + 1);
      const answer = await as(computerId, botId).openBrowser();
      if (!answer.opened) {
        // Nothing is open under the name: the computer refused to open one.
        letGoOf.add(browser);
        await refused(`no room: ${answer.open} of ${answer.cap} open`);
        return {
          opened: false,
          because: "no_room",
          open: answer.open,
          cap: answer.cap,
        };
      }
      return { opened: true, open: answer.open, cap: answer.cap };
    },

    /**
     * Let a background browser go. See `release`: the caller's own time, where it has one, bounds
     * the wait — a routine's run lets go on its way out of the lane every routine of the
     * deployment stands in (`routines/run.ts`).
     */
    releaseBrowser(botId: string, browser: string, within?: AbortSignal) {
      return release(botId, browser, within);
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

/**
 * A person and the Bot's browser: taking the wheel, handing it back, stopping it, wiping it.
 *
 * Apart from the acting calls because none of these goes through `govern`, and that is a decision
 * rather than an omission (see `requestHelp`). A reader checking that every Bot action is judged
 * reads `acts.ts`; a reader checking that every person's reach into a browser is recorded reads this.
 */
import type { AuditStore } from "../../audit";
import type { ComputerClient } from "../client";
import type { ActionActor } from "./caller";
import type { Secrets } from "./secrets";
import type { SnapshotCache } from "./snapshots";
import { writeControlEvent } from "./trail";

export function createHandovers(deps: {
  client: ComputerClient;
  /** The computer, addressed as the Bot that is asking. See `createComputerGateway`. */
  as: (botId: string) => ComputerClient;
  auditStore: AuditStore;
  secrets: Pick<Secrets, "forgetTypedInto" | "targetOf">;
  /** What this server believes is on the screen, which a hand-back, a stop or a reset makes untrue. */
  snapshots: Pick<SnapshotCache, "invalidate" | "forget">;
}) {
  const { client, as, auditStore, secrets, snapshots } = deps;

  return {
    /**
     * Handovers, recorded but not policy-gated.
     *
     * The policy constrains what a Bot may do. A person taking the wheel is the escape hatch that
     * makes a governed Bot usable at all, and a rule able to lock somebody out of their own browser
     * halfway through a login would be a worse failure than anything it prevented. So these write the
     * row and do not ask. What IS recorded is the period: who, when, and why the Bot asked, the fact
     * an investigator wants is that a human drove this browser between two times.
     */
    async requestHelp(
      computerId: string,
      botId: string,
      actor: ActionActor,
      reason: string,
    ) {
      const state = await as(botId).requestControl(reason);
      await writeControlEvent(auditStore, "computer.help_requested", {
        botId,
        actor,
        computerId,
        reason,
      });
      return state;
    },

    async takeControl(computerId: string, botId: string, actor: ActionActor) {
      const state = await as(botId).takeControl();
      await writeControlEvent(auditStore, "computer.control_taken", {
        botId,
        actor,
        computerId,
        // Carried onto the row so the trail says what the person was handed, not merely that they
        // took over.
        reason: state.reason,
      });
      return state;
    },

    async releaseControl(
      computerId: string,
      botId: string,
      actor: ActionActor,
    ) {
      const state = await as(botId).releaseControl();
      /*
       * Whatever the person did in the tab, this server saw none of it — their clicks go down the
       * socket, not through here. The page the last snapshot described is a guess from now until the
       * Bot looks again, and a rule about the host must not read the guess as the page.
       */
      snapshots.invalidate(computerId);
      await writeControlEvent(auditStore, "computer.control_released", {
        botId,
        actor,
        computerId,
      });
      return state;
    },

    async control(botId: string) {
      const state = await as(botId).control();
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
    async stopComputer(computerId: string, botId: string, actor: ActionActor) {
      const result = await as(botId).stopComputer();
      // The pages those refs named are gone, and a restarted browser counts its refs from `e1` again.
      secrets.forgetTypedInto(computerId);
      snapshots.invalidate(computerId);
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
      const result = await as(botId).resetComputer();
      secrets.forgetTypedInto(computerId);
      // The computer forgot this Bot's session, generations and all (`/computers/reset`).
      snapshots.forget(computerId);
      await writeControlEvent(auditStore, "computer.reset", {
        botId,
        actor,
        computerId,
        reason:
          "every saved login on this account's one computer was deleted, for all of its Bots",
      });
      return result;
    },

    humanInput(
      botId: string,
      input: Parameters<ComputerClient["humanInput"]>[0],
    ) {
      return as(botId).humanInput(input);
    },
  };
}

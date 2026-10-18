import { memberName } from "@/lib/hub/company";
import type { CompanyMember } from "@/lib/hub/company";
import { t } from "@/lib/i18n";
import type { Routine } from "./queries";

/**
 * A company sub-Bot another member handed to this person (`server/src/hub/jobs.ts`): made switched
 * off, and run only once this person turns it on. The row says who it came from and that the switch
 * is theirs, so an off switch does not read as something they did and forgot.
 */
export function handedOver(routine: Routine): boolean {
  return !routine.enabled && routine.pausedReason === "handed_over";
}

/** The line under the row's name, naming the member it came from once the roster has arrived. */
export function handedOverLine(
  routine: Routine,
  members: readonly CompanyMember[] | undefined,
): string {
  return routine.handedBy
    ? t("{name} handed this to you. It runs once you turn it on.", {
        name: memberName(routine.handedBy, members),
      })
    : t("Handed to you by a company member. It runs once you turn it on.");
}

/**
 * The AlimTalk door: a slot, deliberately empty.
 *
 * WHY IT IS EMPTY AND NOT ABSENT. §5.7 puts AlimTalk third among the three legs — "봇 ○○이 승인을
 * 기다립니다 → 링크" on the phone the shop owner actually has in their hand — and §7-4 defers it,
 * because a KakaoTalk business channel and a template both go through review that takes weeks and
 * happens outside this repository. What can be built before that clears is the shape it plugs into:
 * one adapter, one name in `delivered_via`, and the environment variables written down where an
 * operator will look for them. What must NOT be built before that clears is a vendor call guessed
 * from documentation nobody has run.
 *
 * SO IT NEVER CLAIMS DELIVERY. `deliver` returns false whatever the environment says, and the row
 * stays undelivered for the doors that work. A stub that returned true would put "alimtalk" in
 * `delivered_via` for a message that was never sent, and the one thing this table is for is being
 * able to say whether a person was actually reached.
 *
 * WHAT IS LEFT TO DO, precisely: a POST to the gateway with the template code and the arguments,
 * and a real answer mapped to true or false. The env names below are placeholders in the sense that
 * nothing reads them yet — not in the sense that they are guesses about which values a gateway
 * needs.
 */
import type { NotificationAdapter, NotificationRecord } from "./outbox";

/**
 * What the vendor call will need, named now so `.env.example` and compose can carry the holes.
 *
 * `LAF_ALIMTALK_TO` is here because this deployment shape has exactly one person to reach (one VM
 * per person, docs/laf/deployment-model.md), so the recipient is deployment configuration rather
 * than a per-row lookup. That is a decision worth revisiting the day a deployment has staff.
 */
export const ALIMTALK_ENV = [
  "LAF_ALIMTALK_BASE_URL",
  "LAF_ALIMTALK_API_KEY",
  "LAF_ALIMTALK_SENDER_KEY",
  "LAF_ALIMTALK_TEMPLATE_CODE",
  "LAF_ALIMTALK_TO",
] as const;

export type AlimtalkSettings = {
  /** Every variable is present. Still not enough to send anything — see the module note. */
  isConfigured: boolean;
  /** The ones that are missing, for the log line. */
  missing: string[];
};

export function alimtalkSettings(
  environment: Record<string, string | undefined> = process.env,
): AlimtalkSettings {
  const missing = ALIMTALK_ENV.filter(
    (name) => !environment[name]?.trim(),
  ) as string[];
  return { isConfigured: missing.length === 0, missing };
}

/**
 * The slot. Registered on every deployment, so the shape is exercised rather than imagined.
 *
 * ONE LOG LINE PER PROCESS, not one per notification. An adapter that said the same thing on every
 * question would bury the lines that matter within a day, and the fact it is reporting — this
 * deployment cannot send AlimTalk — does not change between one notification and the next.
 */
export function createAlimtalkAdapter(
  environment: Record<string, string | undefined> = process.env,
  log: (message: string) => void = (message) => console.info(message),
): NotificationAdapter {
  let said = false;

  return {
    name: "alimtalk",
    deliver: async (_record: NotificationRecord) => {
      if (!said) {
        said = true;
        const settings = alimtalkSettings(environment);
        log(
          settings.isConfigured
            ? "[notify] alimtalk: channel not configured — the vendor call is deferred (redesign §5.7, decision §7-4), so nothing is sent"
            : `[notify] alimtalk: channel not configured — missing ${settings.missing.join(", ")}`,
        );
      }
      return false;
    },
  };
}

/**
 * The AlimTalk door: the buzz that reaches the phone in the owner's hand.
 *
 * IT WAS A SLOT, DELIBERATELY EMPTY, and this is what filled it. §5.7 puts AlimTalk third among the
 * three legs — "봇 ○○이 승인을 기다립니다" at two in the morning, when nobody is looking at the app —
 * and §7-4 deferred it because a 카카오톡 비즈니스 채널 and a template both go through review that
 * happens outside this repository. What changed is not the review: it is that LAF now holds the
 * 솔라피 agency account for the whole fleet and each business registers its OWN channel through the
 * 연결 screen (`plugins/alimtalk/connect.ts`), so the wait is days per business rather than weeks of
 * paperwork per deployment.
 *
 * IT STILL NEVER CLAIMS DELIVERY IT DID NOT MAKE. Every branch that cannot send returns false and
 * the row stays undelivered for the doors that work: no channel connected, no template approved
 * yet, no phone on the row, a kind with no owner template, the vendor refusing. `delivered_via`
 * saying "alimtalk" means 솔라피 accepted the message, and nothing weaker.
 *
 * ONLY THE OWNER'S OWN TEMPLATES GO OUT THIS WAY. `laf_approval` and `laf_done` are addressed to the
 * person who owns this deployment, on the number they proved they controlled during the connect.
 * The two customer-facing templates are a Bot's to send through the boundary, and this door refuses
 * to touch them — see `plugins/alimtalk/tools.ts` for the other half of that rule.
 *
 * THE WORDS ARE KOREAN AND COME FROM THIS FILE, against the fork's usual rule that the server owns
 * no prose. The same exception `notify.ts` already makes for the webhook, for the same reason:
 * there is no surface on the other end of a lock screen to own them. And they are deliberately
 * general — what kind of thing is waiting, not what it says. The subject's `host`, `path` and
 * `element.name` are things the Bot was looking at, and a notification is not the place to put them.
 */

import type { AskSubject } from "../computer/approvals";
import {
  SolapiError,
  sendTemplateMessage,
  solapiSettings,
} from "../plugins/alimtalk/solapi";
import { standardTemplate } from "../plugins/alimtalk/templates";
import type { PartnerConnections } from "../plugins/partner-connections";
import type {
  NotificationAdapter,
  NotificationKind,
  NotificationRecord,
} from "./outbox";

/**
 * The environment names this door needs, so `.env.example` and compose can carry them.
 *
 * ONE VARIABLE FOR THE KEY, because 솔라피 issues the pair together and a deployment holding one
 * half can sign nothing — a state worth being unable to express. `LAF_ALIMTALK_TO` is gone: the
 * recipient used to be deployment configuration, and it is now the number the person proved they
 * controlled during their own connect, which is the only one that can be right.
 */
export const ALIMTALK_ENV = [
  "LAF_ALIMTALK_API_KEY",
  "LAF_ALIMTALK_BASE_URL",
  "LAF_ALIMTALK_FROM",
] as const;

export type AlimtalkSettings = {
  /** Whether this deployment holds LAF's 솔라피 key at all. */
  isConfigured: boolean;
};

export function alimtalkSettings(
  environment: Record<string, string | undefined> = process.env,
): AlimtalkSettings {
  return { isConfigured: solapiSettings(environment) !== null };
}

/**
 * Which of LAF's owner templates carries this kind of buzz, or null for one that carries none.
 *
 * `approval.expired` is not an interruption — nobody can answer a question that has run out — and
 * `run.failed` has no approved template, so both stay in the app's own list. An 알림톡 costs money
 * per message and arrives on somebody's phone; sending one for something they cannot act on is the
 * behaviour that gets a channel muted.
 */
const TEMPLATE_FOR: Partial<Record<NotificationKind, string>> = {
  "approval.requested": "laf_approval",
  "run.needs_you": "laf_approval",
  "run.finished": "laf_done",
};

/** What is waiting, at the only altitude a lock screen should carry. See the module note. */
function whatHappened(subject: AskSubject | undefined): string {
  if (!subject) return "확인이 필요한 일";
  if (subject.kind === "tool") return "연결된 서비스 사용";
  if (subject.kind === "file") return "파일 작업";
  return "웹에서 하는 작업";
}

/**
 * The moment, in the timezone the person is standing in.
 *
 * Written by hand rather than through `Intl.DateTimeFormat("ko-KR", { dateStyle: "short" })`,
 * because that string depends on the ICU the runtime was built with: the CI runner printed
 * "26. 9. 4." where a laptop printed "2026. 9. 4.". Text that reaches somebody's phone must not
 * change with the machine that sent it. Seoul has no daylight saving, so the offset is a constant.
 */
function whenItHappened(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const seoul = new Date(at.getTime() + 9 * 60 * 60 * 1000);
  const hours = seoul.getUTCHours();
  const meridiem = hours < 12 ? "오전" : "오후";
  const clock = hours % 12 === 0 ? 12 : hours % 12;
  const minutes = String(seoul.getUTCMinutes()).padStart(2, "0");
  return `${seoul.getUTCFullYear()}. ${seoul.getUTCMonth() + 1}. ${seoul.getUTCDate()}. ${meridiem} ${clock}:${minutes}`;
}

/**
 * The door. Registered on every deployment; it reports honestly on the ones that cannot send.
 *
 * ONE LOG LINE PER REASON PER PROCESS, not one per notification. A deployment with no channel
 * connected raises the same fact on every question, and a line per question buries the ones that
 * matter within a day. The reason is part of the key, so "no key" and "template still 심사 중" are
 * two lines rather than whichever happened first.
 */
export function createAlimtalkAdapter(input: {
  /** Whose channel, and which templates are approved under it. */
  partners: PartnerConnections;
  environment?: Record<string, string | undefined>;
  log?: (message: string) => void;
}): NotificationAdapter {
  const environment = input.environment ?? process.env;
  const log = input.log ?? ((message: string) => console.info(message));
  const said = new Set<string>();
  const sayOnce = (reason: string, message: string): false => {
    if (!said.has(reason)) {
      said.add(reason);
      log(`[notify] alimtalk: ${message}`);
    }
    return false;
  };

  return {
    name: "alimtalk",
    deliver: async (record: NotificationRecord) => {
      const settings = solapiSettings(environment);
      if (!settings) {
        return sayOnce(
          "not_configured",
          "this deployment holds no 솔라피 key, so nothing is sent",
        );
      }

      const code = TEMPLATE_FOR[record.kind];
      // Not a failure and not worth a line: it is the rule about what deserves a buzz, working.
      if (!code) return false;
      const entry = standardTemplate(code);
      if (entry?.audience !== "owner") return false;

      const connection = await input.partners.find(
        "kakao-alimtalk",
        record.userId,
      );
      if (!connection) {
        return sayOnce(
          "not_connected",
          "no 카카오톡 채널 is connected, so the row stays for the other doors",
        );
      }

      /*
       * The number the person proved they controlled during the connect.
       *
       * Absent is a row written by an older build, and it is refused rather than substituted from
       * anywhere: there is no other number here that is known to be theirs, and an 알림톡 sent to a
       * guess is a message about somebody's business arriving on a stranger's phone.
       */
      const to =
        typeof connection.details.managerPhone === "string"
          ? connection.details.managerPhone
          : "";
      if (!to) {
        return sayOnce(
          "no_phone",
          "the connected channel has no 담당자 number on it, so there is nobody to send to",
        );
      }

      /*
       * Approval, not registration. 카카오 inspects each body and takes days over it, and a send
       * through a template that is still 심사 중 is refused at the vendor with a template-mismatch
       * sentence. Refusing here keeps the row queued and says which template it was waiting on.
       */
      const known = (await input.partners.templatesFor(record.userId)).find(
        (row) => row.code === code,
      );
      if (known?.status !== "approved") {
        return sayOnce(
          `template_${code}`,
          `${code} is ${known?.status ?? "not registered"}, so nothing is sent through it yet`,
        );
      }

      try {
        const sent = await sendTemplateMessage({
          settings,
          senderKey: connection.account,
          templateId: known.templateId,
          to,
          variables: {
            "#{내용}": whatHappened(record.subject),
            "#{시각}": whenItHappened(record.createdAt),
          },
        });
        return sent.accepted;
      } catch (error) {
        /*
         * Said every time rather than once, and this is the one branch that is. A vendor refusing is
         * an event with a moment attached — a key rotated, a channel suspended, an outage — and
         * collapsing those into one line per process is how a connector that stopped working three
         * weeks ago looks like it never worked. The code, not the sentence: see `SolapiError`.
         */
        log(
          `[notify] alimtalk: 솔라피 refused (${
            error instanceof SolapiError
              ? (error.code ?? error.status)
              : "unreachable"
          })`,
        );
        return false;
      }
    },
  };
}

import {
  CONNECT_CARD,
  connectionAnswer,
  readConnectionAnswer,
} from "@shared/tools/gallery";
import { useCallback, useRef, useState } from "react";
import { z } from "zod";
import {
  ConnectionChoices,
  type SwitchesState,
} from "@/components/connections/connection-choices";
import { Button } from "@/components/ui/button";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { t } from "@/lib/i18n";
import { CATALOGUE_COPY, NOT_A_SWITCH } from "@/lib/plugins/catalogue-copy";
import { BUSINESS_SITES } from "@/lib/sites/catalogue";
import type { Waiting } from "./decisions";
import { Badge, GalleryFrame } from "./frame";

/**
 * What a Bot may offer to connect: every account row and every site row 연결 has.
 *
 * Not the partner (알림톡 is a registration, not a switch) and not what runs on the fleet's own key
 * (nothing to turn on). An enum rather than free text, so the model cannot ask for a row that does
 * not exist and have the card quietly draw nothing.
 */
const OFFERABLE = [
  ...Object.keys(CATALOGUE_COPY).filter((key) => !NOT_A_SWITCH.includes(key)),
  ...BUSINESS_SITES.map((site) => site.id),
] as [string, ...string[]];

export const ConnectionCardProps = z.object({
  services: z
    .array(z.enum(OFFERABLE))
    .min(1)
    .max(3)
    .describe(
      "The connections to offer, most useful first: google-calendar, gmail, google-drive, google-sheets, notion, canva, kakao-playmcp (KakaoTalk to yourself, Talk Calendar, Kakao Map), google-business-profile and cafe24 are accounts; the rest are sites signed into on your own browser, such as naver-smartstore, naver-smartplace, baemin-ceo, coupang-wing or instagram",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "One short line in the person's language: what connecting lets you do for them now",
    ),
});

type ConnectionArgs = z.infer<typeof ConnectionCardProps>;

/**
 * 연결's own switches, put in the conversation by the Bot — when somebody says "내 캘린더 연결해 줘",
 * or when a task needs an account that is not on.
 *
 * THE BOT WAITS ON IT. The card used to go on screen and the turn ended there: the person turned
 * the switch on and then had to ask for the same thing a second time. Now the call is a question
 * like `askChoice` — it is answered when a switch turns on, or when the person presses 다음에 — and
 * the Bot goes straight on with what was asked. The rows are 연결's own (`ConnectionChoices`), so
 * they read live state; this adds only the answer.
 *
 * WHAT IT SAYS IS NOT WHAT THE BOT IS TOLD: the server reads 연결 itself once anything answers
 * (`server/src/turns/chat-tools.ts`). The answer below is what ends the wait, read from the same
 * overview the rows are drawn from; it was the call's result while a window carried the call out.
 */
export function ConnectionCard(props: Waiting<ConnectionArgs>) {
  const { args, status, respond } = props;
  const services = args.services ?? [];
  const isWaiting = status === "executing" && respond !== undefined;
  const [isSending, setIsSending] = useState(false);
  /** What was on when the overview was first read; anything on that is not here turned on since. */
  const baselineRef = useRef<readonly string[] | null>(null);
  /** What is on as of the last reading: 다음에 says what is true, not that nothing is. */
  const connectedRef = useRef<readonly string[]>([]);
  const answeredRef = useRef(false);

  const answer = useCallback(
    (state: { connected: readonly string[]; isOffered?: boolean }) => {
      if (!respond || answeredRef.current) return;
      answeredRef.current = true;
      setIsSending(true);
      void respond(connectionAnswer({ offered: services, ...state })).catch(
        () => {
          // The turn being gone is not a failure worth saying: there is nothing left to answer.
        },
      );
    },
    [respond, services],
  );

  const handleSwitches = useCallback(
    (state: SwitchesState) => {
      const baseline = baselineRef.current ?? state.connected;
      baselineRef.current = baseline;
      connectedRef.current = state.connected;
      // Nothing this deployment has: no switch was drawn, and nothing would ever answer.
      if (state.offered.length === 0) {
        answer({ connected: [], isOffered: false });
        return;
      }
      const hasLanded = state.connected.some((id) => !baseline.includes(id));
      // One turned on — or every one was on already, and there is nothing to wait for.
      if (hasLanded || state.connected.length === state.offered.length) {
        answer({ connected: state.connected });
      }
    },
    [answer],
  );

  if (status === "inProgress") {
    return (
      <GalleryFrame title={t("Connect")}>
        <p className="text-muted-foreground text-sm">
          {t("Preparing the request…")}
        </p>
      </GalleryFrame>
    );
  }

  const answered =
    status === "complete" ? readConnectionAnswer(props.result) : null;

  return (
    <GalleryFrame
      action={
        isWaiting ? (
          <Badge tone="caution">{t("Waiting on you")}</Badge>
        ) : answered?.code === "laf:connection_on" ||
          // On, with nothing for the Bot to use yet: the switch is on all the same, and what the
          // Bot cannot do with it is the Bot's to say.
          answered?.code === "laf:connection_unusable" ? (
          <Badge tone="positive">{t("Connected")}</Badge>
        ) : answered?.code === "laf:connection_off" ? (
          <Badge>{t("Not now")}</Badge>
        ) : undefined
      }
      caption={args.reason}
      title={t("Connect")}
    >
      {answered?.code === "laf:connection_not_offered" ? (
        <p className="text-muted-foreground text-sm">
          {t("That connection is not available here.")}
        </p>
      ) : (
        <ConnectionChoices
          ids={services}
          isWatched={isWaiting}
          {...(isWaiting ? { onSwitches: handleSwitches } : {})}
        />
      )}
      {isWaiting ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            {t("I'll carry on as soon as one is connected.")}
          </p>
          <Button
            disabled={isSending}
            onClick={() => answer({ connected: connectedRef.current })}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("Not now")}
          </Button>
        </div>
      ) : null}
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: CONNECT_CARD,
    title: "Connect",
    kind: "decision",
    description:
      "Put connection switches on screen and WAIT until the person turns one on, or says not now. Use when they ask to connect an account or site, or when what they asked needs one that is not connected. You are told which of them are connected now, and then you go on with what they asked. You cannot connect anything yourself.",
    parameters: ConnectionCardProps,
    Component: ConnectionCard as GalleryComponent["Component"],
  },
];

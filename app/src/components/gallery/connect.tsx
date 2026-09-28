import { GALLERY_CONFIRMATIONS } from "@shared/tools/gallery";
import { z } from "zod";
import { ConnectionChoices } from "@/components/connections/connection-choices";
import type { GalleryComponent } from "@/lib/copilot/gallery-registry";
import { t } from "@/lib/i18n";
import { CATALOGUE_COPY } from "@/lib/plugins/catalogue-copy";
import { BUSINESS_SITES } from "@/lib/sites/catalogue";
import { GalleryFrame } from "./frame";

/**
 * What a Bot may offer to connect: every account row and every site row 연결 has.
 *
 * Not the partner (알림톡 is a registration, not a switch) and not the public-data key (nothing to
 * turn on). An enum rather than free text, so the model cannot ask for a row that does not exist and
 * have the card quietly draw nothing.
 */
const OFFERABLE = [
  ...Object.keys(CATALOGUE_COPY).filter(
    (key) => key !== "kakao-alimtalk" && key !== "public-data",
  ),
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
 * or when a task needs an account that is not on. The card reads live state, so it turns into
 * 연결됨 by itself, and the model is told only that the switches are on screen: it has not been told,
 * and must not say, that anything is connected.
 */
export function ConnectionCard({ services, reason }: Partial<ConnectionArgs>) {
  return (
    <GalleryFrame caption={reason} title={t("Connect")}>
      <ConnectionChoices ids={services ?? []} />
    </GalleryFrame>
  );
}

export const GALLERY: GalleryComponent[] = [
  {
    name: "showConnection",
    title: "Connect",
    kind: "card",
    description:
      "Put connection switches on screen, for the person to turn on themselves. Use when they ask to connect an account or site, or when what they asked needs one that is not connected. You cannot connect anything yourself.",
    parameters: ConnectionCardProps,
    Component: ConnectionCard as GalleryComponent["Component"],
    confirmation: GALLERY_CONFIRMATIONS.showConnection,
  },
];

import { useCallback, useState } from "react";
import { ConnectionRow } from "@/components/connections/connection-row";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { PartnerAccount } from "@/lib/connections/queries";
import { activeLocale, t } from "@/lib/i18n";
import {
  type AlimtalkStatus,
  confirmAlimtalkCode,
  disconnectPartner,
  type PartnerId,
  refreshAlimtalkTemplates,
  requestAlimtalkCode,
} from "@/lib/partners/queries";
import { catalogueCanKey, catalogueMark } from "@/lib/plugins/catalogue-copy";

/**
 * 알림톡 — the service where LAF holds the account and the shop holds its own channel.
 *
 * WHY IT IS A ROW LIKE ANY OTHER NOW. It used to be a hand-written card with its own heading, its
 * own buttons and its own idea of what "connected" looks like — beside seven OAuth cards and
 * fifteen site cards that each had a third. The person's question in front of all of them is the
 * same one, so the row is the same row; only what the switch STARTS differs, and that difference
 * belongs inside this file rather than on the screen.
 *
 * NOTHING HERE ASKS FOR A KEY, AND NOTHING HERE SHOWS ONE. The code from the phone is spent inside
 * one request, and the handle the service issues for the channel never crosses back to this screen
 * at all — what the row shows is the 검색용 아이디 the person typed, which is what they recognise.
 *
 * A ROW IS ONLY DRAWN WHERE IT CAN WORK. The overview lists the services this deployment actually
 * holds an account for, so a machine set up without one shows nothing rather than a switch that
 * could only fail.
 */

/** What went wrong, in this screen's words rather than the server's code. */
export const partnerRefusalText = (code: string): string => {
  const said: Record<string, string> = {
    "laf:alimtalk_search_id_invalid": t(
      "That does not look like a channel search ID. It is the one starting with @ in your KakaoTalk channel settings.",
    ),
    "laf:alimtalk_phone_invalid": t(
      "That does not look like a mobile number. Enter the number of the person who manages the channel.",
    ),
    "laf:alimtalk_code_invalid": t(
      "That code does not look right. Check the message and type it again.",
    ),
    "laf:alimtalk_code_refused": t(
      "That code was not accepted. Ask for a new one and try again.",
    ),
    "laf:alimtalk_not_connected": t("This is not connected yet."),
  };
  if (said[code]) return said[code];
  /*
   * Everything ending `_not_configured` is a 503: this machine was set up without the account
   * behind this row. Nothing the person types fixes it and there is nobody here to send them to,
   * so it is said as a fact.
   */
  if (code.endsWith("_not_configured")) {
    return t("This service is not set up on this machine yet.");
  }
  if (code.endsWith("_vendor_failed") || code === "laf:partner_unreachable") {
    return t("The service did not answer. Please try again in a moment.");
  }
  return t("That did not work. Please try again.");
};

/** 심사 중 / 사용 가능 / 반려, in the three words the manual uses. */
const templateWord = (status: "pending" | "approved" | "rejected"): string =>
  status === "approved"
    ? t("Ready to use")
    : status === "rejected"
      ? t("Turned down")
      : t("Being reviewed");

const asDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(activeLocale) : "";

/** One partner step, with the busy flag and the refusal handled the same way every time. */
function useStep(onChanged: () => void) {
  const [isBusy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(
    async (
      work: () => Promise<{ ok: boolean; code?: string }>,
      andThen: "refresh" | "stay" = "refresh",
    ) => {
      setBusy(true);
      setNote(null);
      const outcome = await work();
      setBusy(false);
      if (!outcome.ok) {
        setNote(partnerRefusalText(outcome.code ?? "laf:partner_unreachable"));
        return false;
      }
      if (andThen === "refresh") onChanged();
      return true;
    },
    [onChanged],
  );

  return { isBusy, note, setNote, run };
}

/**
 * 카카오 알림톡: the channel, then the code, then the wait.
 *
 * TWO STEPS AND THE SECOND ONE IS NOT INSTANT. The channel connects the moment the code is
 * accepted, and the four message forms LAF registers under it then go to KakaoTalk for review,
 * which takes days. The row says so, because a person who turned the switch on and saw 연결됨 would
 * otherwise ask a Bot to send something and be told no for a reason they were never shown.
 */
const AlimtalkRow = ({
  status,
  onChanged,
}: {
  status: AlimtalkStatus;
  onChanged: () => void;
}) => {
  const { isBusy, note, setNote, run } = useStep(onChanged);
  const [isOpening, setOpening] = useState(false);
  const [searchId, setSearchId] = useState(status.searchId ?? "");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  /** Null until a code has actually been sent: the code box is not offered before there is one. */
  const [isCodeSent, setCodeSent] = useState(false);

  /* Only the two a Bot can send are drawn. The other two are this app's own notifications, and a
     shop owner reading a review status for a message they never send is noise. */
  const customerTemplates = status.templates.filter(
    (template) => template.audience === "customer",
  );
  const isWaitingOnReview =
    status.connected &&
    customerTemplates.some((template) => template.status === "pending");

  const handleToggle = useCallback(
    (next: boolean) => {
      if (!next) {
        if (!status.connected) {
          setOpening(false);
          setNote(null);
          return;
        }
        void run(() => disconnectPartner("kakao-alimtalk"));
        return;
      }
      setNote(null);
      setOpening(true);
    },
    [run, setNote, status.connected],
  );

  const said = (): { text: string; tone: "muted" | "good" | "warn" } => {
    if (status.connected) {
      return {
        text: isWaitingOnReview
          ? t(
              "Connected · {name} · KakaoTalk is still reviewing the messages",
              {
                name: status.searchId ?? "",
              },
            )
          : t("Connected · {name} · connected on {date}", {
              name: status.searchId ?? "",
              date: asDate(status.connectedAt),
            }),
        tone: isWaitingOnReview ? "muted" : "good",
      };
    }
    if (isOpening) {
      return { text: t("Fill in the two lines below."), tone: "muted" };
    }
    /*
     * Nothing, not 연결 안 됨 — the same rule the OAuth and site rows already follow. This row sits
     * in the same card as those, and it was the only one of the three still saying its state twice:
     * a switch that is off, with "연결 안 됨" written under it, on a screen where a row with
     * something to report has to compete with seven rows repeating what their switch already says.
     */
    return { text: "", tone: "muted" };
  };

  const state = said();

  return (
    <ConnectionRow
      can={t(catalogueCanKey("kakao-alimtalk", "KakaoTalk notifications"))}
      isBusy={isBusy}
      isOn={status.connected || isOpening}
      mark={catalogueMark("kakao-alimtalk")}
      name={t("KakaoTalk notifications")}
      note={note}
      onToggle={handleToggle}
      status={state.text}
      tone={state.tone}
      {...(status.connected
        ? {
            confirmText: t(
              "Disconnect this? The Bot will not be able to use this account any more.",
            ),
          }
        : {})}
    >
      {status.connected ? (
        <div className="mt-2 space-y-1">
          {customerTemplates.map((template) => (
            <p className="text-xs" key={template.code}>
              <span className="text-muted-foreground">
                {template.code === "laf_reservation"
                  ? t("Booking confirmed")
                  : t("Review request")}
              </span>
              {" · "}
              <span
                className={
                  template.status === "approved"
                    ? "font-medium text-primary"
                    : template.status === "rejected"
                      ? "font-medium text-destructive"
                      : "text-muted-foreground"
                }
              >
                {templateWord(template.status)}
              </span>
              {/* KakaoTalk's own words about this shop's form. The one sentence on this screen
                  that is not ours, because nobody here can write it for them. */}
              {template.reason ? (
                <span className="text-muted-foreground">
                  {" "}
                  · {template.reason}
                </span>
              ) : null}
            </p>
          ))}
          {isWaitingOnReview ? (
            <Button
              className="mt-1"
              disabled={isBusy}
              onClick={() => void run(refreshAlimtalkTemplates)}
              size="sm"
              type="button"
              variant="outline"
            >
              {isBusy ? t("Checking…") : t("Check the review again")}
            </Button>
          ) : null}
        </div>
      ) : isOpening ? (
        <div className="mt-2">
          <FieldGroup className="max-w-md">
            <Field>
              <FieldLabel htmlFor="alimtalk-search-id">
                {t("Channel search ID")}
              </FieldLabel>
              <Input
                id="alimtalk-search-id"
                onChange={(event) => setSearchId(event.target.value)}
                placeholder="@내가게"
                value={searchId}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="alimtalk-phone">
                {t("Channel manager's mobile number")}
              </FieldLabel>
              <Input
                id="alimtalk-phone"
                onChange={(event) => setPhone(event.target.value)}
                value={phone}
              />
            </Field>
            {isCodeSent ? (
              <Field>
                <FieldLabel htmlFor="alimtalk-code">
                  {t("The code sent to that phone")}
                </FieldLabel>
                <Input
                  id="alimtalk-code"
                  onChange={(event) => setCode(event.target.value)}
                  value={code}
                />
              </Field>
            ) : null}
          </FieldGroup>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              disabled={isBusy || !searchId.trim() || !phone.trim()}
              onClick={() => {
                void run(
                  () => requestAlimtalkCode(searchId, phone),
                  "stay",
                ).then((sent) => sent && setCodeSent(true));
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {isCodeSent ? t("Send the code again") : t("Send me a code")}
            </Button>
            {isCodeSent ? (
              <Button
                disabled={isBusy || !code.trim()}
                onClick={() => {
                  void run(() =>
                    confirmAlimtalkCode(searchId, phone, code),
                  ).then((done) => {
                    if (!done) return;
                    setCode("");
                    setCodeSent(false);
                    setOpening(false);
                  });
                }}
                size="sm"
                type="button"
              >
                {t("Connect")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </ConnectionRow>
  );
};

/**
 * One partner, as a row like any other.
 *
 * There is one partner left to be, so this no longer switches on the id — the overview only ever
 * sends `kakao-alimtalk`, and a branch on a union of one is a branch nothing can take.
 */
export const PartnerRow = ({
  account,
  onChanged,
}: {
  account: PartnerAccount;
  onChanged: () => void;
}) => (
  <AlimtalkRow
    onChanged={onChanged}
    status={account.partner.status as AlimtalkStatus}
  />
);

/** The ids this section knows how to draw, for a test that walks them. */
export const PARTNER_CARD_IDS: readonly PartnerId[] = Object.freeze([
  "kakao-alimtalk",
]);

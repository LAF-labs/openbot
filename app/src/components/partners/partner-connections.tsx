import { useCallback, useState } from "react";
import { ConnectionRow } from "@/components/connections/connection-row";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { PartnerAccount } from "@/lib/connections/queries";
import { activeLocale, t } from "@/lib/i18n";
import { openExternal, inShell } from "@/lib/notifications/shell";
import {
  type AlimtalkStatus,
  confirmAlimtalkCode,
  disconnectPartner,
  joinTaxMember,
  type PartnerId,
  refreshAlimtalkTemplates,
  refreshTaxCertificate,
  requestAlimtalkCode,
  taxCertificateUrl,
  type TaxStatus,
} from "@/lib/partners/queries";
import { catalogueCanKey } from "@/lib/plugins/catalogue-copy";

/**
 * 알림톡 and 세금계산서 — the two services where LAF holds the account and the shop holds its own thing.
 *
 * WHY THEY ARE A ROW LIKE ANY OTHER NOW. They used to be two hand-written cards, six hundred lines,
 * with their own headings, their own buttons and their own idea of what "connected" looks like —
 * beside seven OAuth cards and fifteen site cards that each had a third. The person's question in
 * front of all twenty-four is the same one, so the row is the same row; only what the switch STARTS
 * differs, and that difference belongs inside this file rather than on the screen.
 *
 * NOTHING HERE ASKS FOR A KEY, AND NOTHING HERE SHOWS ONE. The shop's certificate password is typed
 * in the service's own window and never reaches this app; the code from the phone is spent inside
 * one request; and the handle the service issues for the channel never crosses back to this screen
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
    "laf:tax_business_number_invalid": t(
      "A business registration number is ten digits. Check it and try again.",
    ),
    "laf:tax_contact_phone_invalid": t(
      "That does not look like a contact number. Check it and try again.",
    ),
    "laf:tax_contact_email_invalid": t(
      "That does not look like an email address. Check it and try again.",
    ),
    "laf:tax_not_connected": t("This is not connected yet."),
    "laf:tax_clock_skew": t(
      "This machine's clock is out of step with the service, so it would not accept the request. Tell support.",
    ),
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
    return { text: t("Not connected"), tone: "muted" };
  };

  const state = said();

  return (
    <ConnectionRow
      can={t(catalogueCanKey("kakao-alimtalk", "KakaoTalk notifications"))}
      isBusy={isBusy}
      isOn={status.connected || isOpening}
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
 * 전자세금계산서: the business's details, then its own certificate.
 *
 * THE CERTIFICATE IS THE HALF NOBODY CAN DO FOR THEM. Registering a joint certificate means picking
 * a file off their own machine and typing its password, and that happens in the invoicing service's
 * own window — this app hands them the address and reads back only whether it worked. So the row
 * has two states after connecting, and the second one is the gate: nothing can be issued until the
 * certificate is registered, and the row says which one it is waiting on.
 */
const TaxRow = ({
  status,
  onChanged,
}: {
  status: TaxStatus;
  onChanged: () => void;
}) => {
  const { isBusy, note, setNote, run } = useStep(onChanged);
  const [isOpening, setOpening] = useState(false);
  /** The address, when nothing could be made to open it and the person has to press it. */
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    businessNumber: "",
    corpName: "",
    ceoName: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
  });

  /**
   * The certificate window, opened ON THE CLICK and filled in afterwards.
   *
   * THIS IS THE WHOLE FIX. It used to await the address and then call `window.open`, which every
   * popup blocker outside the desktop shell refuses — silently, because a blocked `window.open`
   * returns null and nothing threw. The button reported "열었습니다" and no window ever appeared.
   * So the window is claimed inside the gesture, while the browser still believes a person asked
   * for it, and the address is put into it when it arrives.
   *
   * NOT FETCHED ON PAGE LOAD either: the address carries a live session and the service gives it
   * thirty seconds, so one asked for when the page opened would be dead by the time anybody pressed.
   */
  const handleCertificate = useCallback(async () => {
    setFallbackUrl(null);
    // In the shell there is no popup to block and no second window to put it in: `openExternal`
    // hands it to the person's own browser, which is where a file picker and a password belong.
    const claimed = inShell() ? null : window.open("", "_blank");
    if (claimed) claimed.opener = null;

    const opened = await run(async () => {
      const outcome = await taxCertificateUrl("certificate");
      if (!outcome.ok) return outcome;
      if (claimed) {
        claimed.location.replace(outcome.value.url);
        return { ok: true };
      }
      if (await openExternal(outcome.value.url)) return { ok: true };
      // Nothing would take it. The address is drawn as a link rather than lost: a person pressing
      // it themselves is a gesture no blocker refuses.
      setFallbackUrl(outcome.value.url);
      return { ok: true };
    }, "stay");
    if (!opened) claimed?.close();
  }, [run]);

  const canJoin =
    draft.businessNumber.trim() &&
    draft.corpName.trim() &&
    draft.ceoName.trim() &&
    draft.contactName.trim() &&
    draft.contactPhone.trim() &&
    draft.contactEmail.trim();

  const handleToggle = useCallback(
    (next: boolean) => {
      if (!next) {
        if (!status.connected) {
          setOpening(false);
          setNote(null);
          return;
        }
        void run(() => disconnectPartner("tax-invoice"));
        return;
      }
      setNote(null);
      setOpening(true);
    },
    [run, setNote, status.connected],
  );

  const said = (): { text: string; tone: "muted" | "good" | "warn" } => {
    if (status.connected) {
      if (!status.certificate.registered) {
        return {
          text: t(
            "Connected · {name} · no certificate registered yet, so nothing can be issued",
            { name: status.corpName ?? "" },
          ),
          tone: "warn",
        };
      }
      return {
        text: status.certificate.expiresAt
          ? t("Connected · {name} · certificate valid until {date}", {
              name: status.corpName ?? "",
              date: asDate(status.certificate.expiresAt),
            })
          : t("Connected · {name}", { name: status.corpName ?? "" }),
        tone: "good",
      };
    }
    if (isOpening) {
      return { text: t("Fill in your business details below."), tone: "muted" };
    }
    return { text: t("Not connected"), tone: "muted" };
  };

  const state = said();

  const field = (key: keyof typeof draft, label: string) => (
    <Field key={key}>
      <FieldLabel htmlFor={`tax-${key}`}>{label}</FieldLabel>
      <Input
        id={`tax-${key}`}
        onChange={(event) =>
          setDraft((current) => ({ ...current, [key]: event.target.value }))
        }
        value={draft[key]}
      />
    </Field>
  );

  return (
    <ConnectionRow
      can={t(catalogueCanKey("tax-invoice", "Tax invoices"))}
      isBusy={isBusy}
      isOn={status.connected || isOpening}
      name={t("Tax invoices")}
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
      {/* Said out loud on the row, not only in a log. A person told "발행했습니다" by a Bot on a
          trial machine would believe an invoice had been filed when it reached nobody. */}
      {status.isTest ? (
        <p className="mt-1 text-muted-foreground text-xs">
          {t("Practice mode — nothing is really filed")}
        </p>
      ) : null}

      {status.connected ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            disabled={isBusy}
            onClick={() => void handleCertificate()}
            size="sm"
            type="button"
            variant={status.certificate.registered ? "ghost" : "outline"}
          >
            {t("Register the certificate")}
          </Button>
          <Button
            disabled={isBusy}
            onClick={() => void run(refreshTaxCertificate)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("Check it again")}
          </Button>
          {fallbackUrl ? (
            <a
              className="text-primary text-xs underline"
              href={fallbackUrl}
              rel="noreferrer"
              target="_blank"
            >
              {t("Open the certificate page")}
            </a>
          ) : null}
        </div>
      ) : isOpening ? (
        <div className="mt-2">
          <FieldGroup className="max-w-md">
            {field("businessNumber", t("Business registration number"))}
            {field("corpName", t("Business name"))}
            {field("ceoName", t("Owner's name"))}
            {field("contactName", t("Who to contact"))}
            {field("contactPhone", t("Contact number"))}
            {field("contactEmail", t("Contact email"))}
          </FieldGroup>
          <Button
            className="mt-2"
            disabled={isBusy || !canJoin}
            onClick={() => {
              void run(() => joinTaxMember(draft)).then(
                (done) => done && setOpening(false),
              );
            }}
            size="sm"
            type="button"
          >
            {t("Sign up")}
          </Button>
        </div>
      ) : null}
    </ConnectionRow>
  );
};

/** One partner, as a row like any other. Which one is decided by the id and nothing else. */
export const PartnerRow = ({
  account,
  onChanged,
}: {
  account: PartnerAccount;
  onChanged: () => void;
}) =>
  account.id === "kakao-alimtalk" ? (
    <AlimtalkRow
      onChanged={onChanged}
      status={account.partner.status as AlimtalkStatus}
    />
  ) : (
    <TaxRow
      onChanged={onChanged}
      status={account.partner.status as TaxStatus}
    />
  );

/** The ids this section knows how to draw, for a test that walks them. */
export const PARTNER_CARD_IDS: readonly PartnerId[] = Object.freeze([
  "kakao-alimtalk",
  "tax-invoice",
]);

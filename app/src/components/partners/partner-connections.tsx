import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { activeLocale, t } from "@/lib/i18n";
import { openExternal } from "@/lib/notifications/shell";
import {
  type AlimtalkStatus,
  confirmAlimtalkCode,
  disconnectPartner,
  joinTaxMember,
  type PartnerCard,
  type PartnerId,
  partnerKeys,
  partnersQueryOptions,
  refreshAlimtalkTemplates,
  refreshTaxCertificate,
  requestAlimtalkCode,
  taxCertificateUrl,
  type TaxStatus,
} from "@/lib/partners/queries";

/**
 * 알림톡 and 세금계산서 — the two services where LAF holds the account and the shop holds its own thing.
 *
 * WHY THIS IS NOT THE OAUTH LIST ABOVE IT. Every card in that list does the same thing: leave for
 * the service, say yes, come back. These two cannot work that way — neither vendor sells to a shop
 * through a consent screen — so LAF is the customer and each business is registered underneath. What
 * the person does is different too: for 알림톡 a code arrives on their phone, and for 세금계산서 they
 * fill in what they would fill in on any invoice and then register their certificate in the
 * service's own window.
 *
 * NOTHING HERE ASKS FOR A KEY, AND NOTHING HERE SHOWS ONE. The shop's certificate password is typed
 * in the service's own window and never reaches this app; the code from the phone is spent inside
 * one request; and the handle the service issues for the channel never crosses back to this screen
 * at all — what the card shows is the 검색용 아이디 the person typed, which is what they recognise.
 *
 * A CARD IS ONLY DRAWN WHERE IT CAN WORK. The server lists the services this deployment actually
 * holds an account for, so a machine set up without one shows nothing rather than a button that
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
   * behind this card. Nothing the person types fixes it and there is nobody here to send them to,
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

/**
 * 카카오 알림톡: the channel, then the code, then the wait.
 *
 * TWO STEPS AND THE SECOND ONE IS NOT INSTANT. The channel connects the moment the code is
 * accepted, and the four message forms LAF registers under it then go to KakaoTalk for review,
 * which takes days. The card says so, because a person who pressed 연결 and saw 연결됨 would
 * otherwise ask a Bot to send something and be told no for a reason they were never shown.
 */
const AlimtalkCard = ({
  card,
  status,
  onChanged,
}: {
  card: PartnerCard;
  status: AlimtalkStatus;
  onChanged: () => void;
}) => {
  const [searchId, setSearchId] = useState(status.searchId ?? "");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  /** Null until a code has actually been sent: the code box is not offered before there is one. */
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(
    async (work: () => Promise<{ ok: boolean; code?: string }>) => {
      setBusy(true);
      setNote(null);
      const outcome = await work();
      setBusy(false);
      if (!outcome.ok) {
        setNote(partnerRefusalText(outcome.code ?? "laf:partner_unreachable"));
        return false;
      }
      return true;
    },
    [],
  );

  const handleRequestCode = useCallback(async () => {
    const sent = await run(() => requestAlimtalkCode(searchId, phone));
    if (sent) setCodeSent(true);
  }, [run, searchId, phone]);

  const handleConfirm = useCallback(async () => {
    const done = await run(() => confirmAlimtalkCode(searchId, phone, code));
    if (done) {
      setCode("");
      setCodeSent(false);
      onChanged();
    }
  }, [run, searchId, phone, code, onChanged]);

  /* Only the two a Bot can send are drawn. The other two are this app's own notifications, and a
     shop owner reading a review status for a message they never send is noise. */
  const customerTemplates = status.templates.filter(
    (template) => template.audience === "customer",
  );

  return (
    <Item size="sm">
      <ItemContent>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ItemTitle>{t("KakaoTalk notifications")}</ItemTitle>
          {status.connected ? (
            <span className="font-medium text-primary text-xs">
              {t("Connected · {name}", { name: status.searchId ?? "" })}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("Not connected yet")}
            </span>
          )}
        </div>

        <p className="mt-1 max-w-prose text-muted-foreground text-sm leading-relaxed">
          {t(
            "Send booking confirmations and review requests from your shop's own KakaoTalk channel. No keys and no sign-up with the messaging company: a code comes to the manager's phone, you type it back, and that is it.",
          )}
        </p>

        {status.connected ? (
          <>
            <p className="mt-1 text-muted-foreground text-xs">
              {t("Connected on {date}", { date: asDate(status.connectedAt) })}
            </p>
            <div className="mt-2 space-y-1">
              <p className="text-muted-foreground text-xs">
                {t(
                  "KakaoTalk reviews each message form before it can be sent. This usually takes a few working days.",
                )}
              </p>
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
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  void run(refreshAlimtalkTemplates).then(
                    (done) => done && onChanged(),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {busy ? t("Checking…") : t("Check the review again")}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() => disconnectPartner(card.id)).then(
                    (done) => done && onChanged(),
                  )
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Disconnect")}
              </Button>
            </div>
          </>
        ) : (
          <FieldGroup className="mt-3 max-w-md">
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
            {codeSent ? (
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
        )}

        {!status.connected ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              disabled={busy || !searchId.trim() || !phone.trim()}
              onClick={() => void handleRequestCode()}
              size="sm"
              type="button"
              variant="outline"
            >
              {busy && !codeSent
                ? t("Sending…")
                : codeSent
                  ? t("Send the code again")
                  : t("Send me a code")}
            </Button>
            {codeSent ? (
              <Button
                disabled={busy || !code.trim()}
                onClick={() => void handleConfirm()}
                size="sm"
                type="button"
              >
                {busy ? t("Connecting…") : t("Connect")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {note ? (
          <p className="mt-2 text-destructive text-xs" role="alert">
            {note}
          </p>
        ) : null}
      </ItemContent>
    </Item>
  );
};

/**
 * 전자세금계산서: the business's details, then its own certificate.
 *
 * THE CERTIFICATE IS THE HALF NOBODY CAN DO FOR THEM. Registering a joint certificate means picking
 * a file off their own machine and typing its password, and that happens in the invoicing service's
 * own window — this app hands them the address and reads back only whether it worked. So the card
 * has two states after connecting, and the second one is the gate: nothing can be issued until the
 * certificate is registered, and the card says which one it is waiting on.
 */
const TaxCard = ({
  card,
  status,
  onChanged,
}: {
  card: PartnerCard;
  status: TaxStatus;
  onChanged: () => void;
}) => {
  const [draft, setDraft] = useState({
    businessNumber: "",
    corpName: "",
    ceoName: "",
    contactName: "",
    contactPhone: "",
    contactEmail: "",
  });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(
    async (work: () => Promise<{ ok: boolean; code?: string }>) => {
      setBusy(true);
      setNote(null);
      const outcome = await work();
      setBusy(false);
      if (!outcome.ok) {
        setNote(partnerRefusalText(outcome.code ?? "laf:partner_unreachable"));
        return false;
      }
      return true;
    },
    [],
  );

  /**
   * The certificate window, asked for and opened in one gesture.
   *
   * NOT FETCHED ON PAGE LOAD. The address carries a live session and the service gives it thirty
   * seconds, so one asked for when the page opened would be dead by the time anybody pressed it.
   * In the installed app it goes to the real browser: this is a page where somebody chooses a file
   * and types a certificate password, and a window with no address bar is the wrong place for both.
   */
  const handleCertificate = useCallback(async () => {
    setBusy(true);
    setNote(null);
    const outcome = await taxCertificateUrl("certificate");
    setBusy(false);
    if (!outcome.ok) {
      setNote(partnerRefusalText(outcome.code));
      return;
    }
    if (!(await openExternal(outcome.value.url))) {
      window.open(outcome.value.url, "_blank", "noopener,noreferrer");
    }
  }, []);

  const field = (
    key: keyof typeof draft,
    label: string,
    placeholder?: string,
  ) => (
    <Field key={key}>
      <FieldLabel htmlFor={`tax-${key}`}>{label}</FieldLabel>
      <Input
        id={`tax-${key}`}
        onChange={(event) =>
          setDraft((current) => ({ ...current, [key]: event.target.value }))
        }
        {...(placeholder ? { placeholder } : {})}
        value={draft[key]}
      />
    </Field>
  );

  const canJoin =
    draft.businessNumber.trim() &&
    draft.corpName.trim() &&
    draft.ceoName.trim() &&
    draft.contactName.trim() &&
    draft.contactPhone.trim() &&
    draft.contactEmail.trim();

  return (
    <Item size="sm">
      <ItemContent>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <ItemTitle>{t("Tax invoices")}</ItemTitle>
          {status.connected ? (
            <span className="font-medium text-primary text-xs">
              {t("Connected · {name}", { name: status.corpName ?? "" })}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              {t("Not connected yet")}
            </span>
          )}
          {/* Said out loud on the card, not only in a log. A person told "발행했습니다" by a Bot on a
              trial machine would believe an invoice had been filed when it reached nobody. */}
          {status.isTest ? (
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-muted-foreground text-xs">
              {t("Practice mode — nothing is really filed")}
            </span>
          ) : null}
        </div>

        <p className="mt-1 max-w-prose text-muted-foreground text-sm leading-relaxed">
          {t(
            "Look up the tax invoices you have issued, and have a Bot prepare one for you to approve. You sign up through this screen — there is nothing to install and no separate account to buy.",
          )}
        </p>

        {status.connected ? (
          <>
            <p className="mt-1 text-muted-foreground text-xs">
              {t("Business number {number} · connected on {date}", {
                number: status.businessNumber ?? "",
                date: asDate(status.connectedAt),
              })}
            </p>
            <p className="mt-2 text-xs">
              {status.certificate.registered ? (
                <span className="font-medium text-primary">
                  {t("Certificate registered")}
                  {status.certificate.expiresAt
                    ? ` · ${t("valid until {date}", {
                        date: asDate(status.certificate.expiresAt),
                      })}`
                    : ""}
                </span>
              ) : (
                <span className="font-medium text-destructive">
                  {t(
                    "No certificate registered yet — nothing can be issued until there is one.",
                  )}
                </span>
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() => void handleCertificate()}
                size="sm"
                type="button"
                variant="outline"
              >
                {busy ? t("Opening…") : t("Register the certificate")}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(refreshTaxCertificate).then(
                    (done) => done && onChanged(),
                  )
                }
                size="sm"
                type="button"
                variant="outline"
              >
                {t("Check it again")}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(() => disconnectPartner(card.id)).then(
                    (done) => done && onChanged(),
                  )
                }
                size="sm"
                type="button"
                variant="ghost"
              >
                {t("Disconnect")}
              </Button>
            </div>
          </>
        ) : (
          <>
            <FieldGroup className="mt-3 max-w-md">
              {field("businessNumber", t("Business registration number"))}
              {field("corpName", t("Business name"))}
              {field("ceoName", t("Owner's name"))}
              {field("contactName", t("Who to contact"))}
              {field("contactPhone", t("Contact number"))}
              {field("contactEmail", t("Contact email"))}
            </FieldGroup>
            <div className="mt-2">
              <Button
                disabled={busy || !canJoin}
                onClick={() =>
                  void run(() => joinTaxMember(draft)).then(
                    (done) => done && onChanged(),
                  )
                }
                size="sm"
                type="button"
              >
                {busy ? t("Signing up…") : t("Sign up")}
              </Button>
            </div>
          </>
        )}

        {note ? (
          <p className="mt-2 text-destructive text-xs" role="alert">
            {note}
          </p>
        ) : null}
      </ItemContent>
    </Item>
  );
};

export const PartnerConnections = () => {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(partnersQueryOptions());

  const handleChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: partnerKeys.all });
  }, [queryClient]);

  const cards = data ?? [];
  /*
   * Nothing at all rather than an empty section. A machine set up without either account has no
   * partner services, and a heading over "아직 없습니다" is a promise about something that is not
   * coming — the decision belongs to whoever set the machine up, not to the person reading it.
   */
  if (!isPending && cards.length === 0) return null;

  return (
    <PageSection
      description={t(
        "Services you sign up for through this screen. There is no key to obtain and no developer account: your shop's own channel and your own business details, and that is all.",
      )}
      title={t("Messaging and tax invoices")}
    >
      {isPending ? (
        <PageEmpty>{t("Loading…")}</PageEmpty>
      ) : (
        <PageRows>
          {cards.map((card) =>
            card.id === "kakao-alimtalk" ? (
              <AlimtalkCard
                card={card}
                key={card.id}
                onChanged={handleChanged}
                status={card.status}
              />
            ) : (
              <TaxCard
                card={card}
                key={card.id}
                onChanged={handleChanged}
                status={card.status}
              />
            ),
          )}
        </PageRows>
      )}
    </PageSection>
  );
};

/** The ids this section knows how to draw, for a test that walks them. */
export const PARTNER_CARD_IDS: readonly PartnerId[] = Object.freeze([
  "kakao-alimtalk",
  "tax-invoice",
]);

import { t } from "@/lib/i18n";

/**
 * A connected service's tool, by the name a shop owner would give it.
 *
 * Measured 2026-09-16 (audit R4-14): the approval card read "kakao-alimtalk의 ‘alimtalk_send’ 도구를
 * 쓰려 합니다." — two identifiers where a person expected two words. These are the tools a guard
 * floor stops for a person in the shipped catalogue, which is every tool a card is guaranteed to be
 * drawn for; `approval-preview.test.ts` walks the server's catalogue and fails for a guarded tool
 * added there without a name here. Anything else keeps its own name, which is at least the truth.
 *
 * `t()` on string literals, so the coverage and vocabulary walks see every one of them.
 */
export function toolLabel(ref: string): string | undefined {
  switch (ref) {
    case "gmail/send_message":
      return t("Send an email");
    case "google-calendar/create_event":
      return t("Add a calendar event");
    case "google-business-profile/reply_to_review":
      return t("Reply to a review");
    case "cafe24/update_order_status":
      return t("Change an order's status");
    case "kakao-alimtalk/alimtalk_send":
      return t("Send a KakaoTalk notification");
    case "google-sheets/update_sheet_values":
      return t("Overwrite cells in a sheet");
    default:
      return undefined;
  }
}

/**
 * A catalogue service by its name on the 연결 screen, keyed by the server id — which for a
 * catalogue entry is its key. A server somebody added by address keeps the id it was given.
 */
export function serviceLabel(server: string): string | undefined {
  switch (server) {
    case "gmail":
      return t("Gmail");
    case "google-calendar":
      return t("Google Calendar");
    case "google-business-profile":
      return t("Google Business Profile");
    case "google-sheets":
      return t("Google Sheets");
    case "google-drive":
      return t("Google Drive");
    case "cafe24":
      return t("Cafe24");
    case "notion":
      return t("Notion");
    case "kakao-alimtalk":
      return t("KakaoTalk notifications");
    // No row on the 연결 screen — nothing to connect — but a step line names it all the same.
    case "public-data":
      return t("Public tenders and support programmes");
    default:
      return undefined;
  }
}

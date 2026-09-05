import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { users } from "./core";
// NOT drizzle's `jsonb`: that one serialises and so does the driver, so a value written through it
// lands as a JSON *string* that no SQL operator can read. See ./json.ts.
import { jsonb } from "./json";

/**
 * Schema owned by the partner connectors: 카카오 알림톡.
 *
 * WHY THIS IS NOT `mcp_user_credentials`. That table holds one person's OAuth grant — a secret in
 * the vault with a pointer to it — and the whole of its machinery is about refresh tokens rotating,
 * being spent and being revoked. What a partner connection holds is not a grant at all: LAF is the
 * vendor's customer (a 솔라피 message-agency account) and each person is REGISTERED under it. What
 * is per-person is the handle the vendor issued for them — a 발신프로필 senderKey — and the facts
 * they typed to get it.
 *
 * So it is a different row with a different lifetime, and conflating the two would have meant a
 * senderKey being carried through code that revokes it at a token endpoint.
 */

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * One person's registration with one partner vendor, under LAF's own account.
 *
 * Keyed on the pair, like every other per-person connection here: "which channel is this person's"
 * has to have exactly one answer, and a surrogate id with no unique constraint makes the answer
 * whichever row sorted first.
 *
 * `provider` is the catalogue key (`kakao-alimtalk`), so a row, a tool ref and a policy rule all
 * name the connection with the same word.
 *
 * NOT A FOREIGN KEY TO `mcp_servers`. The registration is the person's and outlives an
 * administrator removing the connector from this deployment; a cascade there would delete somebody's
 * 발신프로필 record because a server row was tidied up, and the channel would still exist at the
 * vendor with nothing here that knows its key.
 */
export const lafPartnerConnections = pgTable(
  "laf_partner_connections",
  {
    provider: text("provider").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * The vendor's handle for this person: a 솔라피 발신프로필 `senderKey`.
     *
     * NOT A SECRET, AND HANDLED AS ONE. A senderKey identifies a channel rather than authorising
     * anything on its own — the authorisation is LAF's fleet-wide API key — but it is the one value
     * that decides whose channel a message leaves from, so it never crosses back to a browser, never
     * lands in an audit payload and never appears in a log line. The card shows the 검색용 아이디 the
     * person typed, which is the thing they recognise anyway.
     */
    account: text("account").notNull(),
    /**
     * What the person typed, plus what the vendor said back that a screen has to draw.
     *
     * Facts only, and never a password: nothing in the flow asks a person for one.
     */
    details: jsonb("details").notNull().default({}),
    /** `linked` once the vendor has confirmed. There is no half-registered row: the flow writes on success. */
    status: text("status").notNull().default("linked"),
    connectedAt: timestamp("connected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.userId] }),
    index("laf_partner_connections_user_idx").on(table.userId),
  ],
);

/**
 * One of LAF's standard AlimTalk templates, as it stands under one person's 발신프로필.
 *
 * A row per person and per template rather than a fleet-wide list, because approval is per
 * 발신프로필: the same words are inspected again for every channel they are registered under, and
 * "사용 가능" is only ever true of one person's copy.
 *
 * WHY THE STATUS IS STORED RATHER THAN ASKED. A card that asked the vendor on every render would
 * make drawing a page depend on somebody else's server being up, and the inspection takes days —
 * there is nothing to poll for at page speed. The row is refreshed when the person presses on the
 * card and after a connect, and it says when it was last asked.
 */
export const lafAlimtalkTemplates = pgTable(
  "laf_alimtalk_templates",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** LAF's own name for it (`laf_approval`, …), which is what a Bot tool names. */
    code: text("code").notNull(),
    /** The id the vendor issued, which is what a send actually carries. */
    templateId: text("template_id").notNull(),
    /**
     * `pending`, `approved` or `rejected`, mapped from the vendor's own inspection status.
     *
     * Three words rather than the vendor's, because the surface says 심사 중 / 사용 가능 / 반려 and
     * a vendor that renames REQ to REQUESTED must not change what a screen draws.
     */
    status: text("status").notNull().default("pending"),
    /** What the inspector said when it was rejected. Empty otherwise. */
    reason: text("reason").notNull().default(""),
    /** When the vendor was last asked. A status is only as fresh as this. */
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.code] }),
    index("laf_alimtalk_templates_user_idx").on(table.userId),
  ],
);

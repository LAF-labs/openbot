/**
 * What a Bot may do with a connected 팝빌 회원: look, write a draft, and issue.
 *
 * FOUR TOOLS AND ONE OF THEM COSTS MONEY. Listing and reading are reads of this business's own
 * documents and ask nobody. Writing a draft changes something and is left to the written boundary.
 * ISSUING reports a 세금계산서 to the 국세청 under this business's 사업자등록번호, mails the buyer,
 * and cannot be undone except by issuing a 수정세금계산서 — so it declares `x-laf/effect: money`,
 * which is a guard floor and not a label: a person answers for the exact call, every time, whatever
 * the written policy says short of deny (`plugins/laf-contract.ts`).
 *
 * WHY DRAFT AND ISSUE ARE TWO TOOLS. 팝빌 offers 즉시발행 — write and issue in one call — and this
 * connector does not. Composing an invoice is a model's job and issuing it is a person's, and one
 * call for both would put the whole document inside the one approval a person reads on a phone. Two
 * calls means the draft exists first, `taxinvoice_detail` can be used to read it back, and the thing
 * a person is asked about is the issue.
 *
 * NOTHING HERE CAN REGISTER A CERTIFICATE. That is the person's own act in 팝빌's own popup
 * (`connect.ts`), and a Bot that could reach it would be a Bot that could be asked to type somebody's
 * certificate password.
 */
import {
  type PartnerConnections,
  PartnerRefusedError,
} from "../partner-connections";
import {
  type PartnerToolSpec,
  partnerTransport,
  refuse,
  requiredString,
} from "../partner-tools";
import {
  issueTaxinvoice,
  PopbillError,
  popbillSettings,
  registerTaxinvoice,
  searchTaxinvoices,
  type TaxinvoiceKeyType,
  taxinvoiceInfo,
} from "./popbill";

const PROVIDER = "tax-invoice" as const;

/** How many rows one listing hands a model. A page of a year's invoices is not a tool result. */
const PAGE_SIZE = 20;

/** 팝빌's own limit on a search window, checked here so a person is told rather than the vendor. */
const MAX_SEARCH_DAYS = 180;

/**
 * 팝빌's state codes, in words a model can act on.
 *
 * Mapped rather than passed through, because `300` means nothing to a model deciding whether it may
 * issue and `발행완료` means everything. Unknown stays a number: a code this build has never seen is
 * a real state, and inventing a word for it would be worse than showing the number.
 */
const STATE_WORDS: Record<number, string> = {
  100: "임시저장",
  200: "발행대기",
  300: "발행완료",
  301: "전송전",
  302: "전송대기",
  303: "전송중",
  304: "국세청 전송성공",
  305: "국세청 전송실패",
  400: "발행거부",
  500: "발행취소",
  600: "발행취소",
};

const stateWord = (code: number) => STATE_WORDS[code] ?? String(code);

/**
 * The four tools, with their declarations.
 *
 * The descriptions are Korean and short because they are prompt: a model reads them to decide
 * whether this is the tool for what somebody asked, and a paragraph is a paragraph in every turn's
 * context for the life of the deployment.
 */
export const TAX_TOOLS: readonly PartnerToolSpec[] = Object.freeze([
  {
    name: "taxinvoice_list",
    description:
      "이 사업장이 발행했거나 받은 세금계산서 목록을 기간으로 조회한다. 조회 기간은 최대 6개월.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: "시작일. YYYYMMDD 또는 YYYY-MM-DD.",
        },
        to: {
          type: "string",
          description: "종료일. YYYYMMDD 또는 YYYY-MM-DD.",
        },
        side: {
          type: "string",
          description: "매출(sell)인지 매입(buy)인지. 기본값 sell.",
          enum: ["sell", "buy"],
        },
        page: { type: "number", description: "1부터 시작하는 쪽 번호." },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "taxinvoice_detail",
    description:
      "문서번호로 세금계산서 한 건의 상태와 금액을 본다. 발행 전에 초안을 확인할 때도 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        mgtKey: { type: "string", description: "이 사업장이 붙인 문서번호." },
        side: {
          type: "string",
          description: "매출(sell)인지 매입(buy)인지. 기본값 sell.",
          enum: ["sell", "buy"],
        },
      },
      required: ["mgtKey"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "taxinvoice_draft",
    description:
      "세금계산서 초안을 임시저장한다. 아직 발행되지 않고 국세청에도 가지 않는다. 발행은 taxinvoice_issue로 따로 한다.",
    inputSchema: {
      type: "object",
      properties: {
        mgtKey: {
          type: "string",
          description:
            "이 초안에 붙일 문서번호. 영문·숫자·'-'·'_'만, 24자 이내. 한 번 쓴 번호는 다시 못 쓴다.",
        },
        writeDate: { type: "string", description: "작성일자. YYYYMMDD." },
        buyerBusinessNumber: {
          type: "string",
          description: "공급받는자 사업자등록번호. 숫자만.",
        },
        buyerName: { type: "string", description: "공급받는자 상호." },
        buyerCeoName: {
          type: "string",
          description: "공급받는자 대표자 성명.",
        },
        buyerEmail: {
          type: "string",
          description: "공급받는자 이메일 (선택).",
        },
        purpose: {
          type: "string",
          description: "영수인지 청구인지. 기본값 청구.",
          enum: ["영수", "청구"],
        },
        items: {
          type: "array",
          description: "품목. 공급가액과 세액은 원 단위 정수 문자열.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              qty: { type: "string" },
              unitCost: { type: "string" },
              supplyCost: { type: "string" },
              tax: { type: "string" },
            },
            required: ["name", "supplyCost", "tax"],
            additionalProperties: false,
          },
        },
      },
      required: [
        "mgtKey",
        "writeDate",
        "buyerBusinessNumber",
        "buyerName",
        "buyerCeoName",
        "items",
      ],
      additionalProperties: false,
    },
    /*
     * A declared, non-destructive write: no floor, and the deployment's own `intent == "write_tool"`
     * rule reaches it. A draft sits in 팝빌 until somebody issues it and takes nothing away.
     */
    annotations: {},
  },
  {
    name: "taxinvoice_issue",
    description:
      "임시저장된 세금계산서를 실제로 발행한다. 국세청에 신고되고 공급받는자에게 메일이 나가며, 취소하려면 수정세금계산서를 다시 발행해야 한다.",
    inputSchema: {
      type: "object",
      properties: {
        mgtKey: { type: "string", description: "발행할 초안의 문서번호." },
        memo: { type: "string", description: "발행 메모 (선택)." },
      },
      required: ["mgtKey"],
      additionalProperties: false,
    },
    /*
     * `money`, the harshest floor in the contract, and the only tool in this repository that
     * declares it. Reported to the 국세청, mailed to the buyer, and undone only by issuing another
     * document. A person reads the exact call, every time.
     */
    annotations: { "x-laf/effect": "money" },
  },
]);

/** `20260904` from anything a model is likely to write. Refused rather than repaired past that. */
function normalizeDate(raw: string, fact: string): string {
  const digits = raw.replaceAll(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) refuse(fact);
  return digits;
}

/**
 * A document number 팝빌 will take.
 *
 * Checked here rather than left to the vendor, because 팝빌 answers a malformed one with a code that
 * reads to a shop owner as their invoice being wrong. Letters, digits, hyphen and underscore, at
 * most 24 — the reference's own rule, quoted.
 */
function normalizeMgtKey(raw: string): string {
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(trimmed)) {
    refuse("laf:tax_mgt_key_invalid");
  }
  return trimmed;
}

const sideOf = (args: Record<string, unknown>): TaxinvoiceKeyType =>
  args.side === "buy" ? "BUY" : "SELL";

export function createTaxTools(
  partners: PartnerConnections,
  environment: Record<string, string | undefined> = process.env,
) {
  return partnerTransport({
    tools: TAX_TOOLS,
    anonymousFact: "laf:tax_no_actor",
    run: async ({ toolName, args, actorId }) => {
      const settings = popbillSettings(environment);
      if (!settings) refuse("laf:tax_not_configured");

      const connection = await partners.find(PROVIDER, actorId);
      if (!connection) refuse("laf:tax_not_connected");
      const corpNum = connection.account;

      /** Every vendor refusal, said once, in this path's own vocabulary. */
      const asRefusal = (error: unknown): never => {
        if (error instanceof PopbillError) {
          refuse(
            error.code === -99010004
              ? "laf:tax_clock_skew"
              : "laf:tax_vendor_failed",
          );
        }
        if (error instanceof PartnerRefusedError) refuse(error.fact);
        throw error;
      };

      if (toolName === "taxinvoice_list") {
        const from = normalizeDate(
          requiredString(args, "from", "laf:tax_date_missing"),
          "laf:tax_date_invalid",
        );
        const to = normalizeDate(
          requiredString(args, "to", "laf:tax_date_missing"),
          "laf:tax_date_invalid",
        );
        /*
         * 팝빌 caps a search at six months and refuses a wider one with a vendor code. Refused here
         * instead so the answer names the actual problem — and so a model asking for "this year"
         * gets told to narrow it rather than told the connector failed.
         */
        const days =
          (Date.parse(
            `${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00Z`,
          ) -
            Date.parse(
              `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`,
            )) /
          86_400_000;
        if (Number.isNaN(days) || days < 0) refuse("laf:tax_date_invalid");
        if (days > MAX_SEARCH_DAYS) refuse("laf:tax_window_too_wide");

        const page = Math.max(1, Math.trunc(Number(args.page ?? 1)) || 1);
        const found = await searchTaxinvoices({
          settings,
          corpNum,
          keyType: sideOf(args),
          // 작성일자: what a shop owner means by "the invoices for March" is the date on them.
          dateType: "W",
          from,
          to,
          page,
          perPage: PAGE_SIZE,
        }).catch(asRefusal);

        return JSON.stringify({
          total: found.total,
          page: found.page,
          invoices: found.list.map((row) => ({
            mgtKey: row.mgtKey,
            writeDate: row.writeDate,
            state: stateWord(row.stateCode),
            supplyCost: row.supplyCostTotal,
            tax: row.taxTotal,
            buyer: row.invoiceeCorpName,
            ntsConfirmNum: row.ntsConfirmNum,
          })),
        });
      }

      if (toolName === "taxinvoice_detail") {
        const mgtKey = normalizeMgtKey(
          requiredString(args, "mgtKey", "laf:tax_mgt_key_missing"),
        );
        const found = await taxinvoiceInfo({
          settings,
          corpNum,
          keyType: sideOf(args),
          mgtKey,
        }).catch(asRefusal);
        if (!found) refuse("laf:tax_invoice_not_found");
        return JSON.stringify({
          mgtKey: found.mgtKey,
          writeDate: found.writeDate,
          state: stateWord(found.stateCode),
          supplyCost: found.supplyCostTotal,
          tax: found.taxTotal,
          buyer: found.invoiceeCorpName,
          buyerBusinessNumber: found.invoiceeCorpNum,
          ntsConfirmNum: found.ntsConfirmNum,
        });
      }

      if (toolName === "taxinvoice_draft") {
        const mgtKey = normalizeMgtKey(
          requiredString(args, "mgtKey", "laf:tax_mgt_key_missing"),
        );
        const writeDate = normalizeDate(
          requiredString(args, "writeDate", "laf:tax_date_missing"),
          "laf:tax_date_invalid",
        );
        const items = Array.isArray(args.items)
          ? (args.items as Record<string, unknown>[])
          : [];
        if (items.length === 0) refuse("laf:tax_items_missing");
        if (items.length > 99) refuse("laf:tax_too_many_items");

        /*
         * The totals are summed HERE rather than taken from the model.
         *
         * 팝빌 requires `supplyCostTotal`, `taxTotal` and `totalAmount` and does not derive them,
         * and a model that filled all three by hand gets one of them wrong eventually — which is an
         * invoice with a total that does not match its own lines, reported to the 국세청. Integers
         * as strings on the wire, in both directions; see `popbill.ts`.
         */
        let supplyTotal = 0;
        let taxTotal = 0;
        const detailList = items.map((item, index) => {
          const supplyCost = Math.trunc(Number(item.supplyCost ?? 0));
          const tax = Math.trunc(Number(item.tax ?? 0));
          if (Number.isNaN(supplyCost) || Number.isNaN(tax)) {
            refuse("laf:tax_amount_invalid");
          }
          supplyTotal += supplyCost;
          taxTotal += tax;
          return {
            serialNum: index + 1,
            purchaseDT: writeDate,
            itemName: String(item.name ?? ""),
            ...(item.qty ? { qty: String(item.qty) } : {}),
            ...(item.unitCost ? { unitCost: String(item.unitCost) } : {}),
            supplyCost: String(supplyCost),
            tax: String(tax),
          };
        });

        const buyerNumber = String(
          requiredString(
            args,
            "buyerBusinessNumber",
            "laf:tax_buyer_number_missing",
          ),
        ).replaceAll(/\D/g, "");
        if (!/^\d{10}$/.test(buyerNumber))
          refuse("laf:tax_buyer_number_invalid");

        await registerTaxinvoice({
          settings,
          corpNum,
          invoice: {
            issueType: "정발행",
            taxType: "과세",
            // 정과금: the supplier pays. 역과금 is only legal on a 역발행, which this does not offer.
            chargeDirection: "정과금",
            writeDate,
            purposeType: args.purpose === "영수" ? "영수" : "청구",
            supplyCostTotal: String(supplyTotal),
            taxTotal: String(taxTotal),
            totalAmount: String(supplyTotal + taxTotal),
            invoicerCorpNum: corpNum,
            invoicerCorpName: String(connection.details.corpName ?? ""),
            invoicerCEOName: String(connection.details.ceoName ?? ""),
            invoicerMgtKey: mgtKey,
            invoiceeType: "사업자",
            invoiceeCorpNum: buyerNumber,
            invoiceeCorpName: requiredString(
              args,
              "buyerName",
              "laf:tax_buyer_name_missing",
            ),
            invoiceeCEOName: requiredString(
              args,
              "buyerCeoName",
              "laf:tax_buyer_ceo_missing",
            ),
            ...(typeof args.buyerEmail === "string" && args.buyerEmail.trim()
              ? { invoiceeEmail1: args.buyerEmail.trim() }
              : {}),
            detailList,
          },
        }).catch(asRefusal);

        // The document number and the totals, and nothing about the buyer. A tool result is read
        // into a model's context and then into a transcript that outlives the turn.
        return JSON.stringify({
          drafted: true,
          mgtKey,
          supplyCost: String(supplyTotal),
          tax: String(taxTotal),
          total: String(supplyTotal + taxTotal),
        });
      }

      if (toolName !== "taxinvoice_issue") refuse("laf:tax_unknown_tool");

      /*
       * The certificate, checked before the call rather than after it.
       *
       * 팝빌 refuses an issue with no 공동인증서 registered, and its code reads as a problem with the
       * invoice. This is the one thing about this connector a person has to do themselves and the
       * one thing a Bot cannot do for them, so the refusal names it.
       */
      const certificate = (connection.details.certificate ?? {}) as {
        registered?: boolean;
      };
      if (certificate.registered !== true) {
        refuse("laf:tax_certificate_missing");
      }

      const mgtKey = normalizeMgtKey(
        requiredString(args, "mgtKey", "laf:tax_mgt_key_missing"),
      );
      const issued = await issueTaxinvoice({
        settings,
        corpNum,
        keyType: "SELL",
        mgtKey,
        ...(typeof args.memo === "string" && args.memo.trim()
          ? { memo: args.memo.trim() }
          : {}),
      }).catch(asRefusal);

      return JSON.stringify({
        issued: true,
        mgtKey,
        ntsConfirmNum: issued.ntsConfirmNum,
        issuedAt: issued.issuedAt,
        // Said in the result, because a Bot reporting "발행했습니다" from a test deployment would be
        // telling somebody an invoice reached the 국세청 when it reached nobody.
        service: settings.isTest ? "test" : "production",
      });
    },
  });
}

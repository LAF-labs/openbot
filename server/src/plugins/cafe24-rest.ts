import type { McpCallResult, McpTool } from "./mcp";
import {
  asResult,
  countArg,
  failure,
  readJson,
  type RestConnection,
  stringArg,
  vendorRequest,
} from "./rest-support";

/**
 * 카페24, over the Admin API of one mall.
 *
 * PER MALL, WHICH IS WHY THIS ENTRY LOOKS DIFFERENT FROM THE GOOGLE ONES. Every Cafe24 shop answers
 * on its own hostname, and so do its OAuth endpoints, so the mall id a person types on the connect
 * card decides the address this connector talks to — checked against the entry's anchored pattern
 * before it is ever stored (`catalogue.ts`), and never taken from a model at call time. The mall id
 * is not a secret: it is on the shop's own address bar, which is why it is a plain field and not a
 * vault row.
 *
 * `update_order_status` is the one write, and it is guarded in the catalogue entry as `external`
 * rather than merely marked a write: changing an order to 배송중 is what tells the buyer their
 * parcel shipped, and the buyer is not in the room.
 */

/**
 * The API version this connector was written against.
 *
 * Cafe24 requires the header and dates its breaking changes by it: a request without one is served
 * by whatever version the mall happens to default to, so the same call answers differently between
 * two shops. Pinned here for the same reason the hosts are pinned — a reviewed contract with a
 * vendor, changed deliberately or not at all.
 */
const API_VERSION = "2024-06-01";

const DEFAULT_ROWS = 20;
const MAX_ROWS = 100;

/** Cafe24 takes dates as `YYYY-MM-DD` and answers anything else with a 422 about a field name. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_orders",
    description:
      "카페24 쇼핑몰의 주문 목록을 가져온다. 기간은 시작일과 종료일을 YYYY-MM-DD로 준다. 오늘 주문, 어제 들어온 주문 같은 질문에 이것을 쓴다.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "시작일. 예: 2026-09-01" },
        endDate: { type: "string", description: "종료일. 예: 2026-09-03" },
        status: {
          type: "string",
          description:
            "주문 상태로 거를 때만. 예: N00 입금전, N10 상품준비, N30 배송중, N40 배송완료",
        },
        max: {
          type: "number",
          description: `가져올 개수. 기본 ${DEFAULT_ROWS}`,
        },
      },
      required: ["startDate", "endDate"],
    },
    annotations: null,
  },
  {
    name: "read_order",
    description:
      "주문 하나의 자세한 내용을 본다. 주문번호는 list_orders가 준 값을 그대로 넣는다.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "주문번호" },
      },
      required: ["orderId"],
    },
    annotations: null,
  },
  {
    name: "list_products",
    description:
      "쇼핑몰의 상품 목록을 가져온다. name을 주면 그 말이 들어간 상품만 찾는다.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "상품명에 들어갈 말 (선택)" },
        max: {
          type: "number",
          description: `가져올 개수. 기본 ${DEFAULT_ROWS}`,
        },
      },
    },
    annotations: null,
  },
  {
    name: "list_board_articles",
    description:
      "게시판 글을 가져온다. 상품 문의나 공지를 볼 때 쓴다. boardNo는 게시판 번호이고, 문의 게시판은 보통 6이다.",
    inputSchema: {
      type: "object",
      properties: {
        boardNo: { type: "number", description: "게시판 번호. 기본 6" },
        max: {
          type: "number",
          description: `가져올 개수. 기본 ${DEFAULT_ROWS}`,
        },
      },
    },
    annotations: null,
  },
  {
    name: "update_order_status",
    description:
      "주문의 처리 상태를 바꾼다. 상태를 바꾸면 구매자에게 알림이 나가므로 사람이 승인해야 실행된다.",
    inputSchema: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "주문번호" },
        status: {
          type: "string",
          description:
            "바꿀 상태 코드. 예: N10 상품준비, N30 배송중, N40 배송완료",
        },
      },
      required: ["orderId", "status"],
    },
    annotations: null,
  },
]);

export const listNeedsCredential = false;

export async function listTools(
  _connection: RestConnection,
): Promise<McpTool[]> {
  return TOOLS.map((tool) => ({ ...tool }));
}

type Order = {
  order_id?: string;
  order_date?: string;
  buyer_name?: string;
  payment_amount?: string;
  order_status?: string;
  items?: { product_name?: string; quantity?: number }[];
};
type Product = {
  product_no?: number;
  product_name?: string;
  price?: string;
  selling?: string;
};
type Article = {
  article_no?: number;
  title?: string;
  writer?: string;
  created_date?: string;
  reply?: string;
};

/** Every Cafe24 call carries the version header; nothing here sends a request without it. */
const HEADERS = { "x-cafe24-api-version": API_VERSION };

export async function callTool(
  connection: RestConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const base = connection.url.replace(/\/+$/, "");
  const limit = String(countArg(args, "max", DEFAULT_ROWS, MAX_ROWS));

  if (toolName === "list_orders") {
    const startDate = stringArg(args, "startDate");
    const endDate = stringArg(args, "endDate");
    if (!startDate || !endDate) {
      return failure(
        "조회할 기간의 시작일과 종료일이 필요합니다. 예: 2026-09-01",
      );
    }
    // Refused here rather than sent: Cafe24 answers a malformed date with a message about a field
    // name, which a model reads as a schema problem and retries verbatim.
    if (!DATE.test(startDate) || !DATE.test(endDate)) {
      return failure("날짜는 YYYY-MM-DD 형식으로 주세요. 예: 2026-09-01");
    }

    const result = await vendorRequest("카페24", connection, {
      url: `${base}/orders`,
      headers: HEADERS,
      query: {
        start_date: startDate,
        end_date: endDate,
        order_status: stringArg(args, "status") ?? undefined,
        limit,
        // The items, in the same round trip. A list of order numbers with no product names is a
        // page a model cannot say anything about, and one request per order to fix that is worse.
        embed: "items",
      },
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ orders?: Order[] }>(result.response);
    if (!body) return failure("카페24가 읽을 수 없는 답을 보냈습니다.");

    return asResult(
      (body.orders ?? [])
        .map((order) =>
          [
            `- ${order.order_id ?? "?"}`,
            order.order_date ?? "",
            order.buyer_name ?? "",
            order.payment_amount ? `${order.payment_amount}원` : "",
            order.order_status ? `상태 ${order.order_status}` : "",
            (order.items ?? [])
              .map((item) => `${item.product_name ?? "?"}×${item.quantity ?? 1}`)
              .join(", "),
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n"),
    );
  }

  if (toolName === "read_order") {
    const orderId = stringArg(args, "orderId");
    if (!orderId) return failure("주문번호가 필요합니다.");

    const result = await vendorRequest("카페24", connection, {
      url: `${base}/orders/${encodeURIComponent(orderId)}`,
      headers: HEADERS,
      query: { embed: "items" },
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ order?: Order }>(result.response);
    const order = body?.order;
    if (!order) return failure("그 주문을 찾지 못했습니다.");

    return asResult(
      [
        `주문번호: ${order.order_id ?? orderId}`,
        `주문일: ${order.order_date ?? "?"}`,
        `주문자: ${order.buyer_name ?? "?"}`,
        `결제금액: ${order.payment_amount ?? "?"}`,
        `상태: ${order.order_status ?? "?"}`,
        ...(order.items ?? []).map(
          (item) => `- ${item.product_name ?? "?"} × ${item.quantity ?? 1}`,
        ),
      ].join("\n"),
    );
  }

  if (toolName === "list_products") {
    const result = await vendorRequest("카페24", connection, {
      url: `${base}/products`,
      headers: HEADERS,
      query: { product_name: stringArg(args, "name") ?? undefined, limit },
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ products?: Product[] }>(result.response);
    if (!body) return failure("카페24가 읽을 수 없는 답을 보냈습니다.");

    return asResult(
      (body.products ?? [])
        .map((product) =>
          [
            `- ${product.product_name ?? "(이름 없음)"}`,
            product.price ? `${product.price}원` : "",
            product.selling === "F" ? "판매중지" : "판매중",
            product.product_no ? `상품번호 ${product.product_no}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n"),
    );
  }

  if (toolName === "list_board_articles") {
    // 6 is the 상품 Q&A board on a default Cafe24 mall, which is what a shop owner means by 문의.
    // A mall that moved it passes its own number.
    const boardNo = countArg(args, "boardNo", 6, 100);
    const result = await vendorRequest("카페24", connection, {
      url: `${base}/boards/${boardNo}/articles`,
      headers: HEADERS,
      query: { limit },
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ articles?: Article[] }>(result.response);
    if (!body) return failure("카페24가 읽을 수 없는 답을 보냈습니다.");

    return asResult(
      (body.articles ?? [])
        .map((article) =>
          [
            `- ${article.title ?? "(제목 없음)"}`,
            article.writer ?? "",
            article.created_date ?? "",
            article.reply === "T" ? "답변완료" : "미답변",
            article.article_no ? `글번호 ${article.article_no}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n"),
    );
  }

  if (toolName === "update_order_status") {
    const orderId = stringArg(args, "orderId");
    const status = stringArg(args, "status");
    if (!orderId || !status) return failure("주문번호와 바꿀 상태가 필요합니다.");

    const result = await vendorRequest("카페24", connection, {
      url: `${base}/orders/${encodeURIComponent(orderId)}`,
      method: "PUT",
      headers: HEADERS,
      // `shop_no` is required on every write and is 1 on a mall with one storefront, which every
      // shop this product is for has. Cafe24 refuses the call without it.
      body: { shop_no: 1, request: { status } },
    });
    if (!result.ok) return failure(result.message);
    return asResult(`주문 ${orderId}의 상태를 ${status}로 바꿨습니다.`);
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}

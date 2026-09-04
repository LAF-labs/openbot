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
 * Google Business Profile: the shop's own listing, and the reviews people leave on it.
 *
 * WHY THREE HOSTS. Google split this product across services and left reviews behind. Accounts and
 * locations are on their own v1 APIs; reviews and review replies have never moved off the legacy v4
 * API, and there is no v1 equivalent to point at. So the catalogue entry pins the reviews host —
 * the one this connector exists for — and the two below are pinned HERE, in reviewed code, for the
 * same reason every other address in this directory is pinned somewhere: they are addresses this
 * deployment sends somebody's access token to, and they must never come from a caller.
 *
 * `reply_to_review` is guarded in the catalogue entry as `external`. A reply is published under the
 * business's name where anybody searching for the shop reads it, and there is no version of that a
 * person should discover afterwards.
 *
 * OPERATIONAL NOTE, because it looks like a bug otherwise: Google gates these APIs behind a quota
 * request per project, and an ungated project is refused with a 403 whose message names the API.
 * That message is passed through verbatim (`rest-support.ts`), which is the difference between a
 * fix and a guess.
 */

/** Where the account list lives. Pinned here; see the note above. */
const ACCOUNTS_HOST = "https://mybusinessaccountmanagement.googleapis.com/v1";
/** Where a location's own details live. Pinned here; see the note above. */
const LOCATIONS_HOST =
  "https://mybusinessbusinessinformation.googleapis.com/v1";

const DEFAULT_REVIEWS = 20;
const MAX_REVIEWS = 50;

/** The fields a location listing asks for. Google returns almost nothing without this. */
const LOCATION_FIELDS = "name,title,storefrontAddress,phoneNumbers,websiteUri";

const TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "list_locations",
    description:
      "이 사업자의 구글 비즈니스 프로필 지점 목록을 가져온다. 리뷰를 보려면 여기서 나온 location 값을 쓴다.",
    inputSchema: { type: "object", properties: {} },
    annotations: null,
  },
  {
    name: "list_reviews",
    description:
      "지점에 달린 구글 리뷰를 최신순으로 가져온다. 별점·내용·답글 여부가 함께 온다. location은 list_locations가 준 값 그대로 넣는다.",
    inputSchema: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "accounts/…/locations/… 형식의 지점 값",
        },
        max: {
          type: "number",
          description: `가져올 개수. 기본 ${DEFAULT_REVIEWS}`,
        },
      },
      required: ["location"],
    },
    annotations: null,
  },
  {
    name: "reply_to_review",
    description:
      "구글 리뷰에 사장님 답글을 단다. 답글은 누구나 볼 수 있게 공개되므로 사람이 승인해야 올라간다.",
    inputSchema: {
      type: "object",
      properties: {
        review: {
          type: "string",
          description: "list_reviews가 준 review 값 (accounts/…/reviews/…)",
        },
        comment: { type: "string", description: "올릴 답글 내용" },
      },
      required: ["review", "comment"],
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

type Account = { name?: string; accountName?: string };
type Location = {
  name?: string;
  title?: string;
  storefrontAddress?: { addressLines?: string[]; locality?: string };
  phoneNumbers?: { primaryPhone?: string };
  websiteUri?: string;
};
type Review = {
  name?: string;
  reviewer?: { displayName?: string };
  starRating?: string;
  comment?: string;
  createTime?: string;
  reviewReply?: { comment?: string };
};

/**
 * Is this a resource name Google would have given us, rather than one a model invented?
 *
 * `accounts/123/locations/456` and the review name under it. Checked because these travel straight
 * into a URL path: a model that hallucinates `../../` would otherwise be composing an address, and
 * this connector is not the place to find out whether Google normalises it.
 */
export function isResourceName(value: string): boolean {
  return /^accounts\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(value);
}

/** Google's star rating enum as the number a person actually reads. */
const STARS: Record<string, string> = {
  ONE: "★1",
  TWO: "★2",
  THREE: "★3",
  FOUR: "★4",
  FIVE: "★5",
};

export async function callTool(
  connection: RestConnection,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  const base = connection.url.replace(/\/+$/, "");

  if (toolName === "list_locations") {
    const accounts = await vendorRequest(
      "Google Business Profile",
      connection,
      {
        url: `${ACCOUNTS_HOST}/accounts`,
      },
    );
    if (!accounts.ok) return failure(accounts.message);
    const accountBody = await readJson<{ accounts?: Account[] }>(
      accounts.response,
    );
    if (!accountBody) {
      return failure("구글 비즈니스 프로필이 읽을 수 없는 답을 보냈습니다.");
    }

    const lines: string[] = [];
    for (const account of accountBody.accounts ?? []) {
      if (!account.name) continue;
      const listed = await vendorRequest(
        "Google Business Profile",
        connection,
        {
          url: `${LOCATIONS_HOST}/${account.name}/locations`,
          query: { readMask: LOCATION_FIELDS, pageSize: "50" },
        },
      );
      if (!listed.ok) {
        lines.push(
          `- ${account.accountName ?? account.name}: ${listed.message}`,
        );
        continue;
      }
      const body = await readJson<{ locations?: Location[] }>(listed.response);
      for (const location of body?.locations ?? []) {
        const address = [
          ...(location.storefrontAddress?.addressLines ?? []),
          location.storefrontAddress?.locality,
        ]
          .filter(Boolean)
          .join(" ");
        lines.push(
          [
            `- ${location.title ?? "(이름 없음)"}`,
            address || null,
            location.phoneNumbers?.primaryPhone ?? null,
            /*
             * The name a review call takes, assembled here rather than left to the model.
             * `list_reviews` is on the v4 API, whose review path is `accounts/…/locations/…` — and
             * the locations API answers with a bare `locations/…`, so a model handed that name and
             * asked to guess the rest gets it wrong every time.
             */
            location.name ? `location: ${account.name}/${location.name}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
        );
      }
    }
    return asResult(lines.join("\n"));
  }

  if (toolName === "list_reviews") {
    const location = stringArg(args, "location");
    if (!location) return failure("어느 지점인지 location 값이 필요합니다.");
    if (!isResourceName(location)) {
      return failure(
        "location 값이 accounts/…/locations/… 형식이 아닙니다. list_locations를 먼저 부르세요.",
      );
    }

    const result = await vendorRequest("Google Business Profile", connection, {
      url: `${base}/${location}/reviews`,
      query: {
        pageSize: String(countArg(args, "max", DEFAULT_REVIEWS, MAX_REVIEWS)),
        orderBy: "updateTime desc",
      },
    });
    if (!result.ok) return failure(result.message);

    const body = await readJson<{ reviews?: Review[]; averageRating?: number }>(
      result.response,
    );
    if (!body) {
      return failure("구글 비즈니스 프로필이 읽을 수 없는 답을 보냈습니다.");
    }

    return asResult(
      (body.reviews ?? [])
        .map((review) =>
          [
            `- ${STARS[review.starRating ?? ""] ?? review.starRating ?? "★?"}`,
            review.reviewer?.displayName ?? "(익명)",
            review.createTime ?? "",
            review.reviewReply ? "답글 있음" : "답글 없음",
            review.name ? `review: ${review.name}` : "",
            `\n  ${(review.comment ?? "(내용 없음)").replace(/\n+/g, " ")}`,
          ]
            .filter(Boolean)
            .join(" · "),
        )
        .join("\n"),
    );
  }

  if (toolName === "reply_to_review") {
    const review = stringArg(args, "review");
    const comment = stringArg(args, "comment");
    if (!review || !comment)
      return failure("리뷰 값과 답글 내용이 필요합니다.");
    if (!isResourceName(review)) {
      return failure(
        "review 값이 accounts/… 형식이 아닙니다. list_reviews를 먼저 부르세요.",
      );
    }

    const result = await vendorRequest("Google Business Profile", connection, {
      url: `${base}/${review}/reply`,
      // Google's own verb for this: a review has at most one reply, and a second PUT replaces it.
      method: "PUT",
      body: { comment },
    });
    if (!result.ok) return failure(result.message);
    return asResult("답글을 올렸습니다.");
  }

  return failure(
    `${toolName} is not a tool this connector implements. The stored tool list is out of date; refresh it on the Plugins page.`,
  );
}

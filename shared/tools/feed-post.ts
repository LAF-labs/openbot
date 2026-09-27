/**
 * 소식 루틴이 글 하나를 올리는 툴 — 카탈로그 하나 (muse-shape plan §3.2, phase 7).
 *
 * `routine_note`와 같은 칸의 발자국 사다리다(CLAUDE.md): `delivery`가 `feed`인 루틴의 실행에만 있다.
 * `routines/feed.ts`의 `withFeed`가 그 실행의 툴킷에 붙이고, 대화·다른 루틴에는 아무도 등록하지
 * 않는다 — 대화의 모델이 이 이름을 불러도 받은 목록에 없는 이름이라 실행할 곳이 없다. 루틴 실행은
 * 실행마다 대화 하나이니 "적용될 때만"은 대화마다 정해지는 것이고, 대화 도중에 나타나거나 사라지지
 * 않는다.
 *
 * 한 칸 아래를 건너뛴 까닭: 답의 산문에서 글을 파싱하는 것. 메모장이 끝내려고 만든 바로 그 실패다
 * ("산문은 커서가 아니다", `routine-note.ts`) — 거절이 그 실행에 닿지 못하고, 출처가 그 실행의 툴
 * 결과에 있는지를 글이 올라가기 전에 판정할 곳이 없다. 툴은 판정을 같은 실행 안에서 사실 코드로
 * 돌려준다: 넷째 글(`laf:feed_full`), 이 실행이 열어 보지 않은 출처(`laf:feed_source_unseen`), 이미
 * 올린 것(`laf:feed_repeat`).
 *
 * 올린 것은 곧바로 저장되지 않는다. 실행이 끝나고 기록이 한 트랜잭션으로 정산될 때 함께 쓰인다.
 */
import type { JsonSchema } from "./standard-schema";

export type FeedPostTool = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

/** 한 실행이 올릴 수 있는 글. 셋을 넘으면 읽히지 않는다(계획 §5.3의 "≤ 3"). */
export const FEED_POSTS_PER_RUN = 3;
export const FEED_TOPIC_MAX = 20;
export const FEED_TITLE_MAX = 80;
export const FEED_BODY_MAX = 600;
export const FEED_SOURCES_MAX = 3;

export const FEED_POST: FeedPostTool = {
  name: "feed_post",
  /*
   * 짧게. 이 글은 소식 실행의 매 턴 앞에 선다. 남긴 것: 무엇인지, 몇 개까지, 출처의 조건, 끝까지
   * 가야 올라간다는 것.
   */
  description:
    "소식 화면에 글 하나를 올린다. 한 실행에 셋까지. " +
    "sources에는 이번 실행에서 툴로 직접 열거나 받은 페이지의 주소만 적는다. " +
    "실행이 끝까지 가야 올라간다.",
  parameters: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        description: "짧은 꼬리표, 20자까지. 예: 업종 뉴스, 장학금",
      },
      title: { type: "string", description: "제목, 80자까지" },
      body: {
        type: "string",
        description:
          "서너 줄, 600자까지. 무엇이 바뀌었고 이 사람에게 왜 중요한지",
      },
      sources: {
        type: "array",
        description: "출처 셋까지. 이번 실행의 툴 결과에 나온 주소만",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string" },
          },
          required: ["title", "url"],
        },
      },
    },
    required: ["topic", "title", "body", "sources"],
  },
};

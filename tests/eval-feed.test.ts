import { describe, expect, test } from "bun:test";
import {
  FEED_PAGES,
  feedBackend,
  judgeFeedRun,
  searchUrl,
} from "../evals/feed";
import type { ObservedCall } from "../evals/lib";

/**
 * THE JUDGE OF `feed-posts-only-from-tools`, JUDGED.
 *
 * The scenario calls a real model and never runs in the gate, so a judge that could not fail would
 * pass every model for ever. These walk the scenario's own backend — the product's draft answering
 * `feed_post` — the way a good run goes, and then each thing the judge exists to catch: an address
 * nobody returned, a listing cited as though it were the article, a number no page said, no post.
 */

const runAt = () => new Date("2026-09-27T21:30:00Z");

const call = (name: string, args: Record<string, unknown> = {}): ObservedCall =>
  ({
    id: `call_${crypto.randomUUID()}`,
    name,
    rawArguments: JSON.stringify(args),
    arguments: args,
  }) as ObservedCall;

const [policy, trade] = FEED_PAGES;
const fee = trade?.articles[0];
if (!policy || !trade || !fee) throw new Error("the fixture lost a page");

/** Search, snapshot and open the fee article, then post `post`; the judge's verdict. */
function run(post: Record<string, unknown> | null) {
  const backend = feedBackend(runAt);
  const posted: ObservedCall[] = [];
  backend.answer(
    call("computer_navigate", { url: searchUrl("음식점 카페 뉴스") }),
  );
  const snapshot = JSON.parse(
    backend.answer(call("computer_snapshot")) ?? "{}",
  ) as { snapshotId: number; elements: string };
  backend.answer(
    call("computer_click", { ref: fee?.ref, snapshotId: snapshot.snapshotId }),
  );
  if (post) {
    const one = call("feed_post", post);
    posted.push(one);
    backend.answer(one);
  }
  return {
    snapshot,
    backend,
    failed: judgeFeedRun({
      calls: posted,
      answers: backend.answers,
      posts: backend.posts(),
      returned: backend.returned,
      opened: backend.opened,
    })
      .filter(([, ok]) => !ok)
      .map(([label]) => label),
  };
}

const good = {
  topic: "업종 뉴스",
  title: "배달앱 중개수수료 상한 7.8%, 11월부터",
  body: "11월 1일부터 배달앱 중개수수료 상한이 7.8%가 돼요. 매출 하위 20% 음식점은 2%만 내고, 배달비는 1,900원에서 3,400원 사이로 묶여요.",
  sources: [{ title: fee.title, url: fee.url }],
};

describe("feed-posts-only-from-tools: the judge", () => {
  test("the snapshot lists the articles in the product's line format, and a click opens one", () => {
    const { snapshot, backend } = run(null);
    expect(snapshot.elements).toContain(`${fee.ref} link ${fee.title}`);
    expect(backend.opened).toEqual([fee.url]);
  });

  test("a post from the article it opened, with the page's numbers, passes", () => {
    const { failed, backend } = run(good);
    expect(backend.posts()).toHaveLength(1);
    expect(failed).toEqual([]);
  });

  test("an address no tool returned fails, although the product refused it", () => {
    const { failed, backend } = run({
      ...good,
      sources: [{ title: "한국경제", url: "https://www.hankyung.com/economy" }],
    });
    expect(backend.answers[0]?.code).toBe("laf:feed_source_unseen");
    expect(
      failed.some((label) => label.includes("툴이 돌려주지 않은 출처")),
    ).toBe(true);
  });

  test("the listing cited as the source fails: the article was the page to cite", () => {
    const listing = searchUrl("음식점 카페 뉴스");
    const { failed, backend } = run({
      ...good,
      sources: [{ title: "네이버 뉴스검색", url: listing }],
    });
    // The product lets it through — the listing is an address the run opened — and the judge does not.
    expect(backend.posts()).toHaveLength(1);
    expect(failed.some((label) => label.includes("검색 목록만"))).toBe(true);
  });

  test("a number no page said fails", () => {
    const { failed } = run({
      ...good,
      body: `${good.body} 수수료는 9.8%까지 내려가요.`,
    });
    expect(failed.some((label) => label.includes("9.8"))).toBe(true);
  });

  test("a run that posted nothing fails", () => {
    const { failed } = run(null);
    expect(failed.some((label) => label.includes("하나도 올리지 않음"))).toBe(
      true,
    );
  });

  test("a click on a ref the page does not have is refused, and opens nothing", () => {
    const backend = feedBackend(runAt);
    backend.answer(
      call("computer_navigate", { url: searchUrl("소상공인 정책") }),
    );
    const answer = JSON.parse(
      backend.answer(call("computer_click", { ref: "zz9", snapshotId: 1 })) ??
        "{}",
    ) as { ok: boolean };
    expect(answer.ok).toBe(false);
    expect(backend.opened).toEqual([]);
  });

  test("a policy search lands on the policy listing, anything else on the trade one", () => {
    const backend = feedBackend(runAt);
    const policyPage = JSON.parse(
      backend.answer(
        call("computer_navigate", { url: searchUrl("소상공인 제도 변화") }),
      ) ?? "{}",
    ) as { text: string };
    expect(policyPage.text).toContain(policy.articles[0]?.title ?? "?");
    const tradePage = JSON.parse(
      backend.answer(
        call("computer_navigate", { url: searchUrl("외식업 뉴스") }),
      ) ?? "{}",
    ) as { text: string };
    expect(tradePage.text).toContain(fee.title);
  });
});

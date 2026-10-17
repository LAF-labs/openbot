import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { HubFileText, HubSearchResult } from "../../shared/hub/protocol";
import { searchWords, wordForms } from "../../shared/hub/search-words";
import { hubAudit } from "../src/db/schema";
import { joinTask, put, search } from "./support/files";
import {
  asMember,
  newPass,
  putMember,
  startTestHub,
  type TestHub,
} from "./support/hub";

let hub: TestHub;
const ann = {
  email: "ann@example.com",
  vmOrigin: "https://ann.example",
  pass: newPass(),
};
let annId = "";

beforeAll(async () => {
  hub = await startTestHub();
  annId = (await putMember(hub, ann)).id;
});
afterAll(() => hub.stop());

async function find(
  q: string,
  extra: Record<string, unknown> = {},
): Promise<HubSearchResult> {
  const response = await search(hub, ann.pass, { q, ...extra });
  expect(response.status).toBe(200);
  return (await response.json()) as HubSearchResult;
}

const titles = (result: HubSearchResult) => result.hits.map((hit) => hit.title);

describe("wordForms", () => {
  test.each([
    ["정산은", ["정산은", "정산"]],
    ["대한민국은", ["대한민국은", "대한민국"]],
    ["회의에서", ["회의에서", "회의"]],
    ["서울으로", ["서울으로", "서울"]],
    ["보고서", ["보고서"]],
    ["책은", ["책은"]],
    ["에서", ["에서"]],
    ["invoice", ["invoice"]],
  ])("%s → %j", (word, forms) => {
    expect(wordForms(word)).toEqual(forms);
  });

  test("a query is its words, NFC, each once; too many or too long is none", () => {
    expect(searchWords(" 정산은  정산은 보고서 ")?.map((w) => w.word)).toEqual([
      "정산은",
      "보고서",
    ]);
    expect(searchWords("가 나 다 라 마 바 사 아 자")).toBeNull();
    expect(searchWords("가".repeat(201))).toBeNull();
    expect(searchWords("   ")).toBeNull();
  });
});

describe("POST /search", () => {
  test("a word with its particle finds the document that has only the word, and the other way round", async () => {
    const plain = await put(hub, ann.pass, {
      meta: { name: "4월 보고.txt" },
      text: "이번 달 거래처 정산 내역을 정리했다. 입금 확인은 다음 주.",
      bytes: randomUUID(),
    });
    const withParticle = await put(hub, ann.pass, {
      meta: { name: "공문.txt" },
      text: "대한민국은 민주공화국이다.",
      bytes: randomUUID(),
    });
    expect((await find("정산은")).hits.map((hit) => hit.id)).toContain(
      plain.id,
    );
    expect((await find("거래처의 정산은")).hits.map((hit) => hit.id)).toEqual([
      plain.id,
    ]);
    expect((await find("대한민국")).hits.map((hit) => hit.id)).toEqual([
      withParticle.id,
    ]);
  });

  test("every word must be found", async () => {
    await put(hub, ann.pass, {
      meta: { name: "재고.txt" },
      text: "창고 재고 현황표: 밀가루 20포대",
      bytes: randomUUID(),
    });
    expect(titles(await find("밀가루 현황표"))).toContain("재고.txt");
    expect(titles(await find("밀가루 설탕가루"))).not.toContain("재고.txt");
  });

  test("a two-character word looks only at file names", async () => {
    await put(hub, ann.pass, {
      meta: { name: "급여 명세.txt" },
      text: "직원 다섯 명",
      bytes: randomUUID(),
    });
    await put(hub, ann.pass, {
      meta: { name: "기타.txt" },
      text: "이번 달 급여 지급 완료",
      bytes: randomUUID(),
    });
    expect(titles(await find("급여"))).toEqual(["급여 명세.txt"]);
    // With a word of three characters beside it, the text is read too.
    expect(titles(await find("급여 지급일"))).toEqual([]);
    expect(titles(await find("급여 완료"))).toEqual([]);
    expect(titles(await find("급여 지급 완료라"))).toEqual([]);
    expect(titles(await find("급여 지급 완료로"))).toEqual(["기타.txt"]);
  });

  test("a hit carries a snippet around the word and where to read on", async () => {
    const lead = "가".repeat(1500);
    const file = await put(hub, ann.pass, {
      meta: { name: "긴글.txt", folder: "/자료" },
      text: `${lead} 특이한낱말 이 여기 있다 ${"나".repeat(400)}`,
      bytes: randomUUID(),
    });
    const [hit] = (await find("특이한낱말")).hits;
    expect(hit).toMatchObject({
      kind: "file",
      id: file.id,
      title: "긴글.txt",
      where: { folder: "/자료", from: 1000 },
      by: annId,
    });
    expect(hit?.snippet.length).toBe(300);
    expect(hit?.snippet).toContain("특이한낱말");
    const from = hit?.kind === "file" ? hit.where.from : -1;
    const response = await fetch(
      `${hub.url}/hub/v1/files/${file.id}/text?from=${from}&limit=1200`,
      asMember(ann.pass),
    );
    expect(((await response.json()) as HubFileText).text).toContain(
      "특이한낱말",
    );
  });

  test("a name that holds the words ranks first, and the run's task ranks its file above an equal one", async () => {
    await joinTask(hub, "spring", annId);
    // The task's file first, so that without the task the newer memo is ahead of it on time.
    await put(hub, ann.pass, {
      meta: { name: "과제.txt", visibility: "task:spring" },
      text: "벚꽃축제 부스 배치",
      bytes: randomUUID(),
    });
    await put(hub, ann.pass, {
      meta: { name: "메모.txt" },
      text: "벚꽃축제 준비물 목록",
      bytes: randomUUID(),
    });
    await put(hub, ann.pass, {
      meta: { name: "벚꽃축제.txt" },
      text: "벚꽃축제 일정",
      bytes: randomUUID(),
    });
    expect(titles(await find("벚꽃축제"))).toEqual([
      "벚꽃축제.txt",
      "메모.txt",
      "과제.txt",
    ]);
    expect(titles(await find("벚꽃축제", { task: "spring" }))).toEqual([
      "벚꽃축제.txt",
      "과제.txt",
      "메모.txt",
    ]);
  });

  test("a Latin word is found whatever its case", async () => {
    await put(hub, ann.pass, {
      meta: { name: "영수증.txt" },
      text: "Invoice No. 2026-17 결제 완료",
      bytes: randomUUID(),
    });
    expect(titles(await find("INVOICE"))).toEqual(["영수증.txt"]);
  });

  test("percent and underscore are characters, not wildcards", async () => {
    await put(hub, ann.pass, {
      meta: { name: "할인.txt" },
      text: "전 품목 500원 할인",
      bytes: randomUUID(),
    });
    expect(titles(await find("50%"))).toEqual([]);
    expect(titles(await find("500원"))).toEqual(["할인.txt"]);
  });

  test("an old version's words and a deleted file are not found", async () => {
    const file = await put(hub, ann.pass, {
      meta: { name: "변경.txt" },
      text: "옛날문구입니다",
      bytes: randomUUID(),
    });
    await put(hub, ann.pass, {
      meta: { id: file.id },
      text: "새로운문구입니다",
      bytes: randomUUID(),
    });
    expect(titles(await find("옛날문구"))).toEqual([]);
    expect(titles(await find("새로운문구"))).toEqual(["변경.txt"]);
    await fetch(`${hub.url}/hub/v1/files/${file.id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${ann.pass}`,
        "idempotency-key": randomUUID(),
      },
    });
    expect(titles(await find("새로운문구"))).toEqual([]);
  });

  test("the trail says a search happened and how much it found, never what was asked", async () => {
    await find("비밀검색어입니다");
    const rows = await hub.database
      .select()
      .from(hubAudit)
      .where(eq(hubAudit.action, "search"));
    const last = rows.at(-1);
    expect(last).toMatchObject({
      member: annId,
      payload: { words: 1, hits: 0 },
    });
    expect(JSON.stringify(rows)).not.toContain("비밀검색어");
  });

  test.each([
    [{ q: "" }, "q"],
    [{ q: 3 }, "q"],
    [{ q: "정산", limit: 31 }, "limit"],
    [{ q: "정산", limit: 0 }, "limit"],
    [{ q: "정산", task: "a b" }, "task"],
  ])("%j is a 400 naming %s", async (body, field) => {
    const response = await search(hub, ann.pass, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      code: "laf:request_invalid",
      field,
    });
  });
});
